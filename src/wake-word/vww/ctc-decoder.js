/**
 * v16+ CTC decoder for vsWakeWord.
 *
 * The CTC model outputs (T_out, vocab_size) frame-level log-probabilities
 * instead of a single binary wake/no-wake probability.  This decoder:
 *   1. Greedy-decodes the flat output into a phoneme ID sequence
 *      (per-frame argmax, collapse consecutive duplicates, drop blanks).
 *   2. Substring-matches the result against the wake-word phoneme
 *      target(s) declared in the manifest's `ctc` block.
 *   3. Returns a 0/1 score: 1 if any target matches (within
 *      `max_edit_distance` edits, default 1), 0 otherwise.
 *
 * The 0/1 score plugs straight into the existing VwwBackend gates
 * (cutoff, borderline-confirm, required_hits) - any threshold in (0, 1)
 * triggers on match and ignores misses.  Identical inference cost to
 * binary CNN; only the output interpretation differs.
 */

/**
 * @typedef {Object} CtcConfig
 * @property {number} vocab_size
 * @property {number} blank_id
 * @property {number} pad_id
 * @property {number} word_sep_id
 * @property {number[][]} wake_word_targets   accepted phoneme-ID sequences
 * @property {number} [max_edit_distance]     default 1
 * @property {number[]} [target_max_edit_distance] per-target override
 * @property {string[]} [inventory]           id -> phoneme symbol (for logs)
 */


export class CtcDecoder {
  /**
   * @param {CtcConfig} ctcConfig         from manifest.ctc
   * @param {number[]} outputShape        e.g. [1, 49, 52]
   */
  constructor(ctcConfig, outputShape) {
    if (!ctcConfig) throw new Error('CtcDecoder requires manifest.ctc block');
    this.vocabSize = ctcConfig.vocab_size | 0;
    this.blankId = (ctcConfig.blank_id != null) ? ctcConfig.blank_id : 1;
    this.padId = (ctcConfig.pad_id != null) ? ctcConfig.pad_id : 0;
    this.wordSepId = (ctcConfig.word_sep_id != null) ? ctcConfig.word_sep_id : 2;
    this.maxEditDistance = (ctcConfig.max_edit_distance != null) ? ctcConfig.max_edit_distance : 1;
    const targetMaxEd = Array.isArray(ctcConfig.target_max_edit_distance)
      ? ctcConfig.target_max_edit_distance
      : [];
    // trail_tolerance: when >=0, the wake-word window must end within
    // this many phonemes of the end of the decode (i.e. wake word at
    // or near the trailing edge of the decoded sequence).  Kills FPs
    // where TV speech contains wake-shape embedded mid-utterance with
    // many trailing phonemes after.  -1 = disabled (any window pos
    // accepted), 0 = exact end only, 3 = ~150ms of trailing noise ok.
    this.trailTolerance = (ctcConfig.wake_word_trail_tolerance != null)
      ? (ctcConfig.wake_word_trail_tolerance | 0)
      : -1;
    // Per-matched-phoneme confidence gate.  When the matcher finds a
    // wake-shape match, it computes the mean argmax-logit over the
    // matched phonemes and rejects the match if it falls below this
    // threshold.  Catches the v18 "model hallucinates clean wake-shape
    // phonemes from non-wake audio" FP class: those hallucinated
    // matches have systematically lower argmax confidence than
    // legitimate wake-word frames.  Confidence is the RAW LOGIT at
    // the argmax position (the model has no LogSoftmax for WebGPU
    // compat).  Negative-infinity (default) disables the gate.
    this.minMatchedConfidence = (ctcConfig.min_matched_confidence != null)
      ? Number(ctcConfig.min_matched_confidence)
      : -Infinity;
    this.targets = (ctcConfig.wake_word_targets || []).map((t) => t.slice());
    this.targetMaxEditDistance = this.targets.map((_, ti) => {
      const value = Number(targetMaxEd[ti]);
      return Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : (this.maxEditDistance | 0);
    });
    const targetMinConf = Array.isArray(ctcConfig.target_min_matched_confidence)
      ? ctcConfig.target_min_matched_confidence
      : [];
    this.targetMinMatchedConfidence = this.targets.map((_, ti) => {
      const value = Number(targetMinConf[ti]);
      return Number.isFinite(value) ? value : this.minMatchedConfidence;
    });
    this.hasConfidenceGate = (
      Number.isFinite(this.minMatchedConfidence)
      || this.targetMinMatchedConfidence.some((value) => Number.isFinite(value))
    );
    this.targetBytes = this.targets.map((t) => Uint8Array.from(t));
    // Per-target anchor positions.  Listed positions MUST appear in the
    // decoded window with the same phoneme (no substitution/insertion/
    // deletion at those positions); standard Levenshtein applies to the
    // segments between anchors.  Empty/missing per-target array = no
    // anchors (legacy behaviour).  Used to forbid substitutions at the
    // wake-discriminating phonemes (e.g. the "n" + first vowel of "nabu"
    // in "ok nabu") that edit-distance-only matching would tolerate as
    // a single ed=1 substitution.
    const rawAnchors = ctcConfig.wake_word_target_anchors || [];
    this.targetAnchors = this.targets.map((_, ti) => {
      const a = rawAnchors[ti];
      return Array.isArray(a) ? a.slice().sort((x, y) => x - y) : [];
    });
    this.anyAnchors = this.targetAnchors.some((a) => a.length > 0);
    const groups = buildTargetGroupIds(ctcConfig, this.targets, this.wordSepId);
    this.targetGroupIds = groups.ids;
    this.targetGroupSizes = groups.sizes;
    this.inventory = ctcConfig.inventory || null;
    // Cross-window stream matching ("okay <pause> nabu" fix).  The
    // 1300 ms window cannot contain the phrase when the inter-word
    // pause is long: the prefix slides out before the suffix completes,
    // so every per-window decode sees only fragments (n ɑ ː b u ː,
    // ed=3) and can never match.  streamUpdate() stitches per-frame
    // argmax slices from consecutive windows into one rolling frame
    // stream; streamAnalyze() decodes that stream and applies the SAME
    // matcher, making the phrase span limited by the buffer (~2.5 s)
    // instead of the window.  Slices are taken `streamLagFrames` before
    // the window edge because emissions only appear once a phoneme has
    // enough right-context inside the window - so stream matches land
    // ~lag*frameMs (~400 ms) later than per-window matches.  Benchmarked
    // on v120: zero added FP over 14.5 h of continuous speech.
    this._streamState = null;
    // T_out from output shape: shape is (B, T_out, V).  We only ever
    // run B=1 inference, so dims are [1, T_out, V].
    if (!Array.isArray(outputShape) || outputShape.length !== 3) {
      throw new Error(`CtcDecoder: expected 3D output shape, got ${JSON.stringify(outputShape)}`);
    }
    this.tOut = outputShape[1];
    if (outputShape[2] !== this.vocabSize) {
      throw new Error(
        `CtcDecoder: output dim ${outputShape[2]} != vocab_size ${this.vocabSize}`,
      );
    }
  }

  /**
   * Enable cross-window stream matching.  Called by the inference
   * engine when manifest.runtime.stream_match is not disabled.
   * @param {object} opts {windowSamples, bufferMs, lagFrames, windowMs}
   */
  enableStreamMatch(opts) {
    const windowMs = Number(opts.windowMs) || 1300;
    const frameMs = windowMs / this.tOut;
    const lag = Math.min(
      Math.max(4, Math.floor(Number(opts.lagFrames ?? 20))),
      this.tOut - 2,
    );
    this._streamState = {
      frameSamples: Math.max(1, Math.round(Number(opts.windowSamples) / this.tOut)),
      frameMs,
      lag,
      bufFrames: Math.max(this.tOut, Math.round(Number(opts.bufferMs ?? 2500) / frameMs)),
      ids: [],
      logits: [],
      sampleAcc: 0,
      bootstrapped: false,
      matchStreak: 0,
    };
  }

  /**
   * Append this window's fresh argmax frames to the rolling stream.
   * @param {Float32Array} flatLogProbs  full window output (T_out * V)
   * @param {number} newSamples          audio samples appended since the
   *                                     previous inference call
   */
  streamUpdate(flatLogProbs, newSamples) {
    const st = this._streamState;
    if (!st) return;
    const T = this.tOut;
    const V = this.vocabSize;
    st.sampleAcc += Math.max(0, newSamples | 0);
    let newFrames = Math.floor(st.sampleAcc / st.frameSamples);
    if (newFrames <= 0 && st.bootstrapped) return;
    st.sampleAcc -= newFrames * st.frameSamples;

    const pushFrame = (t) => {
      let bestI = 0;
      let bestV = -Infinity;
      const base = t * V;
      for (let v = 0; v < V; v++) {
        const lv = flatLogProbs[base + v];
        if (lv > bestV) { bestV = lv; bestI = v; }
      }
      st.ids.push(bestI);
      st.logits.push(bestV);
    };

    if (!st.bootstrapped) {
      for (let t = 0; t < T - st.lag; t++) pushFrame(t);
      st.bootstrapped = true;
    } else {
      newFrames = Math.min(newFrames, T - st.lag);
      for (let t = T - st.lag - newFrames; t < T - st.lag; t++) pushFrame(t);
    }
    const excess = st.ids.length - st.bufFrames;
    if (excess > 0) {
      st.ids.splice(0, excess);
      st.logits.splice(0, excess);
    }
  }

  /**
   * Decode the rolling stream and run the standard matcher on it.
   * Returns the same shape as analyzeWithConfidence() plus
   * {stream: true}.  After a few consecutive matched calls the buffer
   * is consumed so one utterance cannot re-fire after the runtime
   * cooldown expires while its frames are still in the buffer.
   */
  streamAnalyze() {
    const st = this._streamState;
    if (!st || st.ids.length === 0) return null;
    const ids = [];
    const confidence = [];
    let i = 0;
    const n = st.ids.length;
    while (i < n) {
      const tok = st.ids[i];
      let j = i;
      let sum = 0;
      while (j < n && st.ids[j] === tok) { sum += st.logits[j]; j++; }
      if (tok !== this.blankId && tok !== this.padId) {
        ids.push(tok);
        confidence.push(sum / (j - i));
      }
      i = j;
    }
    const match = this.acceptedMatch(ids, confidence);
    if (match.matched) {
      st.matchStreak += 1;
      if (st.matchStreak >= 4) {
        st.ids.length = 0;
        st.logits.length = 0;
        st.matchStreak = 0;
      }
    } else {
      st.matchStreak = 0;
    }
    return {
      stream: true,
      decoded: ids,
      matched: match.matched,
      matchedTargetIndex: match.targetIndex,
      matchedTargetGroupIndex: match.targetGroupIndex,
      matchedTargetGroupSize: match.targetGroupSize,
      matchedConfidence: match.confidence,
      minEditDistance: match.editDistance,
    };
  }

  /**
   * Greedy CTC decode from a flat (T_out * vocab_size) buffer.
   * Returns the phoneme ID sequence (blanks + duplicates removed).
   */
  greedyDecode(flatLogProbs) {
    const T = this.tOut;
    const V = this.vocabSize;
    const out = [];
    let prev = -1;
    for (let t = 0; t < T; t++) {
      let bestI = 0;
      let bestV = -Infinity;
      const base = t * V;
      for (let v = 0; v < V; v++) {
        const lv = flatLogProbs[base + v];
        if (lv > bestV) { bestV = lv; bestI = v; }
      }
      if (bestI !== prev && bestI !== this.blankId && bestI !== this.padId) {
        out.push(bestI);
      }
      prev = bestI;
    }
    return out;
  }

  /**
   * Like greedyDecode but also computes per-emitted-phoneme mean
   * argmax-logit (the "confidence" the model had at each chosen
   * phoneme).  Used by the runtime confidence gate.  Returns
   * { ids: number[], confidence: number[] } - both arrays same length.
   *
   * The confidence value is the RAW LOGIT at the argmax position
   * averaged across the run of frames that emitted the phoneme.  The
   * exported model has no LogSoftmax (WebGPU op compatibility), so
   * these are raw logits not log-probabilities, but they still rank
   * correctly: higher = more confident in chosen phoneme.
   */
  greedyDecodeWithConfidence(flatLogProbs) {
    const T = this.tOut;
    const V = this.vocabSize;
    const ids = [];
    const confidence = [];
    // First pass: per-frame argmax + max-logit.  Then walk runs to
    // collapse duplicates and average logits per emitted phoneme.
    const argmaxIds = new Int32Array(T);
    const argmaxLogits = new Float32Array(T);
    for (let t = 0; t < T; t++) {
      let bestI = 0;
      let bestV = -Infinity;
      const base = t * V;
      for (let v = 0; v < V; v++) {
        const lv = flatLogProbs[base + v];
        if (lv > bestV) { bestV = lv; bestI = v; }
      }
      argmaxIds[t] = bestI;
      argmaxLogits[t] = bestV;
    }
    let i = 0;
    while (i < T) {
      const tok = argmaxIds[i];
      let j = i;
      let sum = 0;
      while (j < T && argmaxIds[j] === tok) {
        sum += argmaxLogits[j];
        j++;
      }
      if (tok !== this.blankId && tok !== this.padId) {
        ids.push(tok);
        confidence.push(sum / (j - i));
      }
      i = j;
    }
    return { ids, confidence };
  }

  /**
   * True if any wake-word target appears as a substring of `decoded`
   * within max_edit_distance edits.  Fast path: exact substring via
   * Uint8Array compare.  Loose path: sliding edit-distance with a
   * WORD_SEP-strict substitution penalty (substitutions involving
   * WORD_SEP cost 2 instead of 1, effectively disallowing them
   * within ed<=1).  Without this, TV speech that decoded to
   * [o ʊ k e ɪ ː n ɑ ː b u ː] (length marker where WORD_SEP belongs)
   * matched canonical [o ʊ k e ɪ _ n ɑ ː b u ː] at ed=1 and fired.
   */
  acceptedMatch(decoded, confidence) {
    const miss = {
      matched: false,
      targetIndex: -1,
      targetGroupIndex: -1,
      targetGroupSize: 1,
      editDistance: Infinity,
      confidence: 0,
    };
    if (!decoded.length) return miss;
    const trailTol = this.trailTolerance;
    const hay = Uint8Array.from(decoded);
    const hasConfidence = (
      confidence != null
      && confidence.length === decoded.length
    );
    const minConfForTarget = (ti) => this.targetMinMatchedConfidence[ti] ?? this.minMatchedConfidence;
    // Helper: mean confidence over window [start, start+len)
    const meanConf = (start, len) => {
      if (!hasConfidence) return 0;
      let sum = 0;
      for (let k = 0; k < len; k++) sum += confidence[start + k];
      return sum / len;
    };
    const confOk = (ti, start, len) => {
      const minConf = minConfForTarget(ti);
      return !hasConfidence || !Number.isFinite(minConf) || meanConf(start, len) >= minConf;
    };
    let bestMatch = null;
    const considerMatch = (ti, start, len, ed) => {
      const conf = meanConf(start, len);
      if (
        bestMatch == null
        || ed < bestMatch.editDistance
        || (ed === bestMatch.editDistance && conf > bestMatch.confidence)
      ) {
        const group = this.targetGroupIds[ti] ?? ti;
        bestMatch = {
          matched: true,
          targetIndex: ti,
          targetGroupIndex: group,
          targetGroupSize: this.targetGroupSizes[group] ?? 1,
          editDistance: ed,
          confidence: conf,
          gateThreshold: minConfForTarget(ti),
        };
      }
    };
    // Exact-substring fast path.  When trailTol or confidence gate is
    // active, we need to know the match location, so loop occurrences.
    for (let ti = 0; ti < this.targetBytes.length; ti++) {
      const t = this.targetBytes[ti];
      let idx = 0;
      while (idx + t.length <= hay.length) {
        let match = true;
        for (let k = 0; k < t.length; k++) {
          if (hay[idx + k] !== t[k]) { match = false; break; }
        }
        if (match) {
          const trailing = hay.length - (idx + t.length);
          if ((trailTol < 0 || trailing <= trailTol) && confOk(ti, idx, t.length)) {
            considerMatch(ti, idx, t.length, 0);
          }
        }
        idx++;
      }
    }
    const ws = this.wordSepId;
    for (let ti = 0; ti < this.targets.length; ti++) {
      const max = this.targetMaxEditDistance[ti] ?? (this.maxEditDistance | 0);
      if (max <= 0) continue;
      const target = this.targets[ti];
      const anchors = this.targetAnchors[ti];
      const useAnchors = anchors && anchors.length > 0;
      const tlen = target.length;
      // Asymmetric window range: only allow windows >= tlen.  A window
      // SHORTER than the target means the decoded sequence is missing
      // a phoneme that the wake word requires - blocks "decoded missing
      // n" FPs.  Insertions/substitutions vs the target are still ok
      // (legitimate decoder noise on real utterances).
      const lo = tlen;
      const hi = tlen + max;
      for (let winLen = lo; winLen <= hi; winLen++) {
        if (winLen > decoded.length) continue;
        // End-anchor: when trailTol is set, only consider windows whose
        // end (i + winLen) is within trailTol of decoded.length.  Kills
        // FPs where the wake-shape is embedded mid-decode followed by
        // significant trailing speech (TV speech FP class).
        const startMin = (trailTol >= 0)
          ? Math.max(0, decoded.length - winLen - trailTol)
          : 0;
        const startMax = decoded.length - winLen;
        for (let i = startMin; i <= startMax; i++) {
          const ed = useAnchors
            ? editDistanceAnchored(decoded, i, winLen, target, anchors, ws)
            : editDistance(decoded, i, winLen, target, ws);
          if (ed <= max && confOk(ti, i, winLen)) {
            considerMatch(ti, i, winLen, ed);
          }
        }
      }
    }
    return bestMatch ?? miss;
  }

  matches(decoded, confidence) {
    return this.acceptedMatch(decoded, confidence).matched;
  }

  /**
   * One-call: decode the flat output and return a 0/1 score.
   * Wraps to fit VwwInference.processChunk's existing per-keyword
   * score interface.
   */
  score(flatLogProbs) {
    // Use the confidence-tracking decode path when the gate is
    // configured so matches() can apply the threshold.  When the gate
    // is disabled (default for old models), fall back to the cheap
    // greedy decode that skips per-frame confidence accounting.
    if (this.hasConfidenceGate) {
      const { ids, confidence } = this.greedyDecodeWithConfidence(flatLogProbs);
      return this.matches(ids, confidence) ? 1.0 : 0.0;
    }
    const decoded = this.greedyDecode(flatLogProbs);
    return this.matches(decoded) ? 1.0 : 0.0;
  }

  /**
   * Rich one-call analysis for the test-session and inference layer.
   * Runs the confidence-tracking decode, finds the closest match
   * window (regardless of gate), computes both the matched-window
   * confidence (what the gate evaluates) and the total-decode
   * confidence.  Returns:
   *   {
   *     decoded: number[]            // phoneme IDs from greedy decode
   *     confidence: number[]         // per-emitted-phoneme mean argmax-logit
   *     matched: boolean             // matcher accepts (incl. gate)?
   *     minEditDistance: number      // closest ed found across all windows
   *     matchedConfidence: number    // mean conf over the closest-match
   *                                  // window (what the gate evaluates)
   *     totalConfidence: number      // mean conf over the full decode
   *     gateThreshold: number        // the active min_matched_confidence
   *                                  // (or -Infinity if gate disabled)
   *   }
   */
  analyzeWithConfidence(flatLogProbs) {
    const { ids, confidence } = this.greedyDecodeWithConfidence(flatLogProbs);
    const out = {
      decoded: ids,
      confidence,
      matched: false,
      minEditDistance: Infinity,
      matchedConfidence: 0,
      totalConfidence: 0,
      gateThreshold: this.minMatchedConfidence,
      matchedTargetIndex: -1,
      matchedTargetGroupIndex: -1,
      matchedTargetGroupSize: 1,
    };
    if (ids.length === 0) {
      return out;
    }
    let sumTotal = 0;
    for (let k = 0; k < confidence.length; k++) sumTotal += confidence[k];
    out.totalConfidence = sumTotal / confidence.length;

    // Find the closest-match window (lowest ed) across all targets, and
    // its mean confidence.  This is what the test-session displays even
    // when the matcher rejects (so the user can see why a near-miss was
    // close but failed).  Sweep mirrors matches()'s asymmetric +
    // trail-anchor logic so the closest reported match is one the
    // matcher would actually consider.
    const ws = this.wordSepId;
    const trailTol = this.trailTolerance;
    let bestEd = Infinity;
    let bestStart = -1;
    let bestLen = 0;
    let bestTargetIndex = -1;
    for (let ti = 0; ti < this.targets.length; ti++) {
      const max = this.targetMaxEditDistance[ti] ?? (this.maxEditDistance | 0);
      const target = this.targets[ti];
      const anchors = this.targetAnchors[ti];
      const useAnchors = anchors && anchors.length > 0;
      const tlen = target.length;
      const lo = tlen;
      const hi = tlen + max;
      for (let winLen = lo; winLen <= hi; winLen++) {
        if (winLen > ids.length) continue;
        const startMin = (trailTol >= 0)
          ? Math.max(0, ids.length - winLen - trailTol)
          : 0;
        const startMax = ids.length - winLen;
        for (let i = startMin; i <= startMax; i++) {
          const ed = useAnchors
            ? editDistanceAnchored(ids, i, winLen, target, anchors, ws)
            : editDistance(ids, i, winLen, target, ws);
          if (ed < bestEd) {
            bestEd = ed;
            bestStart = i;
            bestLen = winLen;
            bestTargetIndex = ti;
            if (bestEd === 0) break;
          }
        }
        if (bestEd === 0) break;
      }
      if (bestEd === 0) break;
    }
    out.minEditDistance = bestEd;
    if (bestStart >= 0 && bestLen > 0) {
      let sum = 0;
      for (let k = 0; k < bestLen; k++) sum += confidence[bestStart + k];
      out.matchedConfidence = sum / bestLen;
      out.gateThreshold = this.targetMinMatchedConfidence[bestTargetIndex] ?? this.minMatchedConfidence;
    }
    // Final matcher decision (applies confidence gate if configured)
    const accepted = this.acceptedMatch(ids, confidence);
    out.matched = accepted.matched;
    out.matchedTargetIndex = accepted.targetIndex;
    out.matchedTargetGroupIndex = accepted.targetGroupIndex ?? -1;
    out.matchedTargetGroupSize = accepted.targetGroupSize ?? 1;
    if (accepted.matched) {
      out.minEditDistance = accepted.editDistance;
      out.matchedConfidence = accepted.confidence;
      out.gateThreshold = accepted.gateThreshold ?? this.minMatchedConfidence;
    } else if (!Number.isFinite(out.minEditDistance)) {
      // Diagnostic only: strict production matching uses the asymmetric,
      // trail-anchored sweep above.  For near-miss logs/UI we still want
      // to show decodes that are close to the wake shape but were rejected
      // by strict runtime rules.
      out.minEditDistance = this.minEditDistanceToTargets(ids);
    }
    return out;
  }

  /**
   * Minimum edit distance from `decoded` (or any contiguous window of
   * it) to any wake-word target.  Used by the test-session diagnostic
   * to log near-miss decodes ("the model almost heard the wake word")
   * so the user can see which TV-speech phrases are getting close.
   * Returns Infinity for empty input.
   */
  minEditDistanceToTargets(decoded) {
    if (!decoded.length) return Infinity;
    const ws = this.wordSepId;
    let best = Infinity;
    for (const target of this.targets) {
      const tlen = target.length;
      const span = Math.max(2, Math.floor(tlen / 2));
      const lo = Math.max(1, tlen - span);
      const hi = tlen + span;
      for (let winLen = lo; winLen <= hi; winLen++) {
        if (winLen > decoded.length) continue;
        for (let i = 0; i <= decoded.length - winLen; i++) {
          const ed = editDistance(decoded, i, winLen, target, ws);
          if (ed < best) best = ed;
          if (best === 0) return 0;
        }
      }
    }
    return best;
  }

  /** Debug helper: render a decode as space-separated phoneme symbols.
   * Renders the WORD_SEP token as '_' instead of ' ' so the output
   * stays unambiguous when split on whitespace (HA log viewers collapse
   * consecutive spaces, which would hide the WORD_SEP and make a
   * decode look 1 token shorter than it actually is). */
  toPhonemes(ids) {
    if (!this.inventory) return ids.map((i) => String(i));
    return ids.map((i) => {
      if (i === this.wordSepId) return '_';
      return this.inventory[i] ?? `?${i}`;
    });
  }
}


function buildTargetGroupIds(ctcConfig, targets, wordSepId) {
  const raw = ctcConfig?.wake_word_target_groups;
  const ids = [];
  const labelToId = new Map();
  const idForLabel = (label) => {
    const key = String(label);
    if (!labelToId.has(key)) labelToId.set(key, labelToId.size);
    return labelToId.get(key);
  };

  if (Array.isArray(raw) && raw.length >= targets.length) {
    for (let i = 0; i < targets.length; i++) {
      const value = raw[i];
      ids[i] = value == null ? i : idForLabel(value);
    }
  } else {
    for (let i = 0; i < targets.length; i++) {
      const normalized = (targets[i] || [])
        .filter((id) => id !== wordSepId)
        .join(',');
      ids[i] = idForLabel(normalized || `target:${i}`);
    }
  }

  const sizes = [];
  for (const id of ids) sizes[id] = (sizes[id] || 0) + 1;
  return { ids, sizes };
}


function containsExact(haystack, needle) {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  const last = haystack.length - needle.length;
  outer: for (let i = 0; i <= last; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}


function editDistance(haystack, haystackStart, haystackLen, target, wordSepId = -1) {
  // Modified Levenshtein: ALL edits involving the WORD_SEP token cost
  // 2 instead of 1 (substitution, insertion, or deletion).  This locks
  // in the wake-word's structural word boundaries - random speech with
  // a different pause pattern cannot match at ed<=1 by adding/removing
  // a single word boundary.  v18 production FP'd on
  // [o ʊ k e ɪ _ n ɑ ː _ b u ː _ j] matching "ok nabu" (12) target at
  // ed=1 via WORD_SEP deletion at position 9; the symmetric penalty
  // makes that deletion cost 2 and pushes the match to ed=2.
  const m = haystackLen;
  const n = target.length;
  // Cost helper: deleting/inserting a WORD_SEP costs 2, anything else 1
  const tokCost = (t) => (wordSepId >= 0 && t === wordSepId) ? 2 : 1;
  if (m === 0) {
    let s = 0;
    for (let j = 0; j < n; j++) s += tokCost(target[j]);
    return s;
  }
  if (n === 0) {
    let s = 0;
    for (let i = 0; i < m; i++) s += tokCost(haystack[haystackStart + i]);
    return s;
  }
  let prev = new Int32Array(n + 1);
  let curr = new Int32Array(n + 1);
  // First-row init mirrors the per-token insertion cost
  prev[0] = 0;
  for (let j = 1; j <= n; j++) prev[j] = prev[j - 1] + tokCost(target[j - 1]);
  for (let i = 1; i <= m; i++) {
    const hi = haystack[haystackStart + i - 1];
    const delHi = tokCost(hi);
    curr[0] = prev[0] + delHi;
    for (let j = 1; j <= n; j++) {
      const tj = target[j - 1];
      let subCost;
      if (hi === tj) {
        subCost = 0;
      } else if (wordSepId >= 0 && (hi === wordSepId || tj === wordSepId)) {
        subCost = 2;
      } else {
        subCost = 1;
      }
      const ins = curr[j - 1] + tokCost(tj);
      const del = prev[j] + delHi;
      const sub = prev[j - 1] + subCost;
      curr[j] = Math.min(ins, del, sub);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}


/**
 * Anchored edit distance.  `anchors` is a sorted-ascending array of
 * indices into `target` whose phonemes MUST appear in the haystack
 * window in order (left-to-right, greedy first match per anchor).  The
 * segments of (target, haystack) between consecutive anchors are then
 * scored with the regular editDistance() and summed.  If any anchor
 * phoneme isn't found in the remaining haystack, returns Infinity
 * (matcher rejection).
 *
 * Effect: substitutions / insertions / deletions are FORBIDDEN at the
 * anchor positions, but stay free everywhere else.  Used to require
 * the wake-discriminating phonemes (e.g. the "n" + first vowel of
 * "nabu" in "ok nabu") while still tolerating decoder noise in less
 * critical positions.  Surgically rejects FPs that swap the critical
 * "n" for another consonant (e.g. decoded "o ʊ k e ɪ _ ɪ ɑ ː b u"
 * matching the canonical "o ʊ k e ɪ _ n ɑ ː b u" at ed=1).
 */
function editDistanceAnchored(haystack, haystackStart, haystackLen, target, anchors, wordSepId = -1) {
  if (!anchors || anchors.length === 0) {
    return editDistance(haystack, haystackStart, haystackLen, target, wordSepId);
  }
  const winEnd = haystackStart + haystackLen;

  // Locate each anchor phoneme in the haystack window, left-to-right.
  const anchorHayPos = new Array(anchors.length);
  let searchStart = haystackStart;
  for (let ai = 0; ai < anchors.length; ai++) {
    const want = target[anchors[ai]];
    let found = -1;
    for (let k = searchStart; k < winEnd; k++) {
      if (haystack[k] === want) { found = k; break; }
    }
    if (found < 0) return Infinity;
    anchorHayPos[ai] = found;
    searchStart = found + 1;
  }

  // Sum editDistance on the segments between anchors.  Each segment is
  // (haystack[hSeg], target[tSeg]) with boundaries skipping the anchor
  // phoneme itself (matched exactly, cost 0).
  let total = 0;
  let prevTargetEnd = 0;
  let prevHayEnd = haystackStart;
  for (let ai = 0; ai < anchors.length; ai++) {
    const hSegLen = anchorHayPos[ai] - prevHayEnd;
    const tSeg = target.slice(prevTargetEnd, anchors[ai]);
    total += editDistance(haystack, prevHayEnd, hSegLen, tSeg, wordSepId);
    prevTargetEnd = anchors[ai] + 1;
    prevHayEnd = anchorHayPos[ai] + 1;
  }
  // Tail segment after last anchor.
  const tTail = target.slice(prevTargetEnd);
  const hTailLen = winEnd - prevHayEnd;
  total += editDistance(haystack, prevHayEnd, hTailLen, tTail, wordSepId);
  return total;
}
