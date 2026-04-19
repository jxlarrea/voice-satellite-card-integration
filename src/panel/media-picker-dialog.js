/**
 * Media picker dialog
 *
 * Custom tree browser over the HA media_source API.  Opens a modal
 * overlay listing the children of the current media_content_id;
 * clicking a folder drills in, clicking a playable file selects it
 * and closes.  A "Select this folder" button lets users pick a
 * folder (for screensaver folder cycling).
 *
 * Uses raw WebSocket calls (`media_source/browse_media`) rather than
 * HA's internal `<ha-media-player-browse>` element so we don't depend
 * on lazy-loadable components whose import path changes across HA
 * versions.
 */

const ROOT_ID = '';

/**
 * Derive the parent folder URI for a media-source path by stripping
 * the last path segment.  Trailing slashes are removed — HA's
 * media_source/browse_media rejects URIs with trailing slashes on
 * some sources.  Returns '' when the URI already points at a domain
 * root, signalling "open at ROOT".
 */
export function deriveParentMediaId(id) {
  if (!id) return '';
  const s = id.endsWith('/') ? id.slice(0, -1) : id;
  const protoEnd = s.indexOf('://');
  const lastSlash = s.lastIndexOf('/');
  // lastSlash must be strictly past the "://" separator for there to
  // be a path segment we can strip.
  if (protoEnd < 0 || lastSlash <= protoEnd + 2) return '';
  return s.slice(0, lastSlash);
}

/**
 * Sign a relative HA path so an <img> can load it.  Thumbnails from
 * media_source/browse_media come back as /api/media_player_proxy/...
 * paths that need an authSig query param before HA will serve them.
 * Absolute URLs pass through unchanged.
 */
async function signThumbnail(hass, raw) {
  if (!raw) return null;
  if (/^https?:/i.test(raw)) return raw;
  try {
    const res = await hass.connection.sendMessagePromise({
      type: 'auth/sign_path',
      path: raw,
      expires: 3600,
    });
    const base = hass.hassUrl ? hass.hassUrl() : '';
    return base.replace(/\/$/, '') + (res?.path || '');
  } catch (_) {
    return null;
  }
}

/** Detect image files by MIME type or filename extension. */
function isImageItem(c) {
  if (!c || c.can_expand) return false;
  if (c.media_content_type && /^image\//i.test(c.media_content_type)) return true;
  if (c.media_content_id && /\.(jpe?g|png|gif|webp|bmp|avif|svg)(\?|$)/i.test(c.media_content_id)) return true;
  return false;
}

/**
 * For image items without a provided thumbnail, resolve their media
 * URL so the file itself can be used as the thumbnail.  Returns null
 * on failure; callers should fall back to the folder/file icon.
 */
async function resolveImageUrl(hass, mediaContentId) {
  try {
    const res = await hass.connection.sendMessagePromise({
      type: 'media_source/resolve_media',
      media_content_id: mediaContentId,
    });
    return res?.url || null;
  } catch (_) {
    return null;
  }
}

/** Resolve a child's thumbnail URL, falling back to the image itself for JPGs etc. */
async function resolveChildThumbnail(hass, child) {
  if (child.thumbnail) return signThumbnail(hass, child.thumbnail);
  if (isImageItem(child)) {
    const url = await resolveImageUrl(hass, child.media_content_id);
    if (url) return signThumbnail(hass, url);
  }
  return null;
}

/**
 * Open the picker.  Resolves with { media_content_id, title, is_folder }
 * on selection, or null if the user cancels.
 *
 * @param {object} hass        Home Assistant frontend object
 * @param {string} [initialId] media-source URI to start browsing from
 * @param {string} [title]     dialog title
 * @returns {Promise<{media_content_id: string, title: string, is_folder: boolean} | null>}
 */
export function openMediaPicker(hass, initialId = ROOT_ID, title = 'Select media') {
  const connection = hass.connection;
  return new Promise((resolve) => {
    const dialog = createDialog(title, hass);
    document.body.appendChild(dialog.root);

    let currentId = initialId || ROOT_ID;
    let currentTitle = 'Media';
    let currentCanPlay = false;
    let currentCanExpand = true;
    const crumbs = []; // { id, title }

    const close = (result) => {
      dialog.root.remove();
      resolve(result);
    };

    /**
     * Navigate to a media-source URI.
     * @param {string} id              media_content_id to browse
     * @param {{id:string,title:string}|null} [newCrumb]
     *   Optional crumb to push onto the trail *only if* the browse
     *   succeeds.  Pushing in the onClick handler caused stale entries
     *   to accumulate when the destination failed and we fell back to
     *   ROOT (e.g. a folder like "AI generated images" that errors).
     */
    async function browse(id, newCrumb = null) {
      dialog.setList([{ title: 'Loading...', disabled: true }]);
      let res;
      try {
        res = await connection.sendMessagePromise({
          type: 'media_source/browse_media',
          media_content_id: id || undefined,
        });
      } catch (e) {
        // Browsing failed.  Never push the stale crumb — the user
        // didn't actually arrive.  For drill-downs, show an inline
        // error + a Back row that refreshes the previous folder, and
        // disable the "Select this folder" action (nothing valid to
        // pick here).  For initial/back navigation, fall back to
        // ROOT so the user has somewhere to start.
        if (newCrumb) {
          dialog.setList(
            [{
              title: '← Back',
              subtitle: 'Return to previous folder',
              isBack: true,
              onClick: () => browse(currentId),
            }],
            `Could not open folder: ${e.message || 'Unknown error'}`,
          );
          dialog.selectBtn.disabled = true;
          dialog.selectBtn.style.visibility = 'hidden';
          return;
        }
        if (id !== ROOT_ID) return browse(ROOT_ID);
        dialog.setList([], `Error: ${e.message || e}`);
        dialog.selectBtn.disabled = true;
        dialog.selectBtn.style.visibility = 'hidden';
        return;
      }
      if (newCrumb) crumbs.push(newCrumb);
      currentId = res.media_content_id || id;
      currentTitle = res.title || 'Media';
      currentCanPlay = !!res.can_play;
      currentCanExpand = res.can_expand !== false;
      renderCrumbs();

      const children = res.children || [];
      const items = [];

      // "Back" row when inside a folder — goes up one level via the
      // crumb stack, or to the root when no crumbs exist (arrived
      // directly via initialId).
      if (currentId !== ROOT_ID) {
        items.push({
          title: '← Back',
          subtitle: 'Parent folder',
          isBack: true,
          onClick: () => {
            if (crumbs.length > 0) {
              const parent = crumbs.pop();
              browse(parent.id);
            } else {
              browse(ROOT_ID);
            }
          },
        });
      }

      for (let i = 0; i < children.length; i++) {
        const c = children[i];
        items.push({
          title: c.title || c.media_content_id,
          subtitle: c.can_expand ? 'Folder' : (c.media_content_type || ''),
          // Lazy-loaded thumbnail — the row observer fetches this
          // only when the row scrolls into view (see setList below).
          lazyThumbChild: c,
          media_content_id: c.media_content_id,
          can_play: !!c.can_play,
          can_expand: !!c.can_expand,
          onClick: () => {
            if (c.can_expand) {
              browse(c.media_content_id, { id: currentId, title: currentTitle });
            } else if (c.can_play) {
              close({
                media_content_id: c.media_content_id,
                title: c.title || c.media_content_id,
                is_folder: false,
              });
            }
          },
        });
      }

      const isEmpty = items.length === 0 || (items.length === 1 && items[0].isBack);
      dialog.setList(items, isEmpty ? 'This folder is empty.' : null);

      // Enable "Select this folder" only when we're inside something browseable
      // and the user is past the root (so they don't accidentally pick the root).
      const canPickFolder = currentCanExpand && currentId !== ROOT_ID;
      dialog.selectBtn.disabled = !canPickFolder;
      dialog.selectBtn.style.visibility = canPickFolder ? '' : 'hidden';
    }

    function renderCrumbs() {
      dialog.crumbs.innerHTML = '';
      const rootBtn = document.createElement('button');
      rootBtn.type = 'button';
      rootBtn.className = 'vs-mp-crumb';
      rootBtn.textContent = 'Media';
      rootBtn.addEventListener('click', () => {
        crumbs.length = 0;
        browse(ROOT_ID);
      });
      dialog.crumbs.appendChild(rootBtn);
      for (let i = 0; i < crumbs.length; i++) {
        const c = crumbs[i];
        dialog.crumbs.appendChild(sep());
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'vs-mp-crumb';
        btn.textContent = c.title;
        btn.addEventListener('click', () => {
          crumbs.length = i;
          browse(c.id);
        });
        dialog.crumbs.appendChild(btn);
      }
      if (currentId !== ROOT_ID && currentId !== (crumbs[crumbs.length - 1]?.id || ROOT_ID)) {
        dialog.crumbs.appendChild(sep());
        const span = document.createElement('span');
        span.className = 'vs-mp-crumb is-current';
        span.textContent = currentTitle;
        dialog.crumbs.appendChild(span);
      }
    }

    function sep() {
      const s = document.createElement('span');
      s.className = 'vs-mp-crumb-sep';
      s.textContent = '/';
      return s;
    }

    dialog.cancelBtn.addEventListener('click', () => close(null));
    dialog.backdrop.addEventListener('click', () => close(null));
    dialog.selectBtn.addEventListener('click', () => {
      close({
        media_content_id: currentId,
        title: currentTitle,
        is_folder: true,
      });
    });
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        close(null);
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);

    browse(currentId);
  });
}

function createDialog(title, hass) {
  injectStylesOnce();

  // Shared across all setList calls in this dialog instance.
  let thumbObserver = null;
  // Tiny concurrency limiter so we don't flood HA with sign_path +
  // resolve_media calls when dozens of rows become visible at once.
  let activeLoads = 0;
  const MAX_CONCURRENT = 4;
  const loadQueue = [];
  function runNext() {
    while (activeLoads < MAX_CONCURRENT && loadQueue.length > 0) {
      const task = loadQueue.shift();
      activeLoads++;
      task().finally(() => {
        activeLoads--;
        runNext();
      });
    }
  }
  function scheduleLoad(task) {
    loadQueue.push(task);
    runNext();
  }

  const root = document.createElement('div');
  root.className = 'vs-mp-root';

  const backdrop = document.createElement('div');
  backdrop.className = 'vs-mp-backdrop';
  root.appendChild(backdrop);

  const panel = document.createElement('div');
  panel.className = 'vs-mp-panel';
  root.appendChild(panel);

  const header = document.createElement('div');
  header.className = 'vs-mp-header';
  const titleEl = document.createElement('div');
  titleEl.className = 'vs-mp-title';
  titleEl.textContent = title;
  header.appendChild(titleEl);
  panel.appendChild(header);

  const crumbs = document.createElement('div');
  crumbs.className = 'vs-mp-crumbs';
  panel.appendChild(crumbs);

  const list = document.createElement('div');
  list.className = 'vs-mp-list';
  panel.appendChild(list);

  const footer = document.createElement('div');
  footer.className = 'vs-mp-footer';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'vs-mp-btn is-ghost';
  cancelBtn.textContent = 'Cancel';
  footer.appendChild(cancelBtn);
  const spacer = document.createElement('div');
  spacer.style.flex = '1';
  footer.appendChild(spacer);
  const selectBtn = document.createElement('button');
  selectBtn.type = 'button';
  selectBtn.className = 'vs-mp-btn is-primary';
  selectBtn.textContent = 'Select this folder';
  selectBtn.disabled = true;
  footer.appendChild(selectBtn);
  panel.appendChild(footer);

  function setList(items, emptyMessage = null) {
    // Tear down previous observer and queue — rows from the prior
    // folder are about to be removed from the DOM.
    if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
    loadQueue.length = 0;

    list.innerHTML = '';

    if (hass && typeof IntersectionObserver !== 'undefined') {
      thumbObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const row = entry.target;
          thumbObserver.unobserve(row);
          const child = row._lazyChild;
          if (!child) continue;
          scheduleLoad(async () => {
            if (!document.contains(row)) return;
            const url = await resolveChildThumbnail(hass, child);
            if (!url || !document.contains(row)) return;
            const thumb = row.querySelector('.vs-mp-thumb');
            if (!thumb) return;
            thumb.innerHTML = '';
            const img = document.createElement('img');
            img.src = url;
            img.alt = '';
            thumb.appendChild(img);
          });
        }
      }, { root: list, rootMargin: '200px 0px' });
    }

    for (const item of items) {
      const row = document.createElement(item.disabled ? 'div' : 'button');
      if (!item.disabled) row.type = 'button';
      row.className = 'vs-mp-item' + (item.disabled ? ' is-disabled' : '');

      const thumb = document.createElement('div');
      thumb.className = 'vs-mp-thumb';
      if (item.isBack) {
        thumb.textContent = '↩';
      } else if (item.can_expand) {
        thumb.textContent = '📁';
      } else if (item.can_play) {
        thumb.textContent = '🎞';
      }
      row.appendChild(thumb);

      const text = document.createElement('div');
      text.className = 'vs-mp-text';
      const t1 = document.createElement('div');
      t1.className = 'vs-mp-item-title';
      t1.textContent = item.title;
      text.appendChild(t1);
      if (item.subtitle) {
        const t2 = document.createElement('div');
        t2.className = 'vs-mp-item-subtitle';
        t2.textContent = item.subtitle;
        text.appendChild(t2);
      }
      row.appendChild(text);

      if (!item.disabled && item.onClick) {
        row.addEventListener('click', item.onClick);
      }
      list.appendChild(row);

      // Lazy thumbnail: only fetch when the row scrolls into view,
      // and cap to MAX_CONCURRENT concurrent requests.
      if (item.lazyThumbChild && thumbObserver) {
        row._lazyChild = item.lazyThumbChild;
        thumbObserver.observe(row);
      }
    }

    if (emptyMessage) {
      const empty = document.createElement('div');
      empty.className = 'vs-mp-empty';
      empty.textContent = emptyMessage;
      list.appendChild(empty);
    }
  }

  return { root, backdrop, panel, crumbs, list, cancelBtn, selectBtn, setList };
}

function injectStylesOnce() {
  if (document.getElementById('vs-mp-style')) return;
  const style = document.createElement('style');
  style.id = 'vs-mp-style';
  style.textContent = `
    .vs-mp-root { position: fixed; inset: 0; z-index: 2000; display: flex; align-items: center; justify-content: center; }
    .vs-mp-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.6); }
    .vs-mp-panel {
      position: relative; width: min(640px, 92vw); max-height: 82vh;
      display: flex; flex-direction: column;
      background: var(--ha-card-background, var(--card-background-color, #1c1c1e));
      color: var(--primary-text-color, #fff);
      border-radius: var(--ha-card-border-radius, 12px);
      border: 1px solid var(--divider-color, #333);
      box-shadow: 0 10px 40px rgba(0,0,0,0.5);
      overflow: hidden;
    }
    .vs-mp-header { padding: 14px 18px; border-bottom: 1px solid var(--divider-color, #333); }
    .vs-mp-title { font-size: 17px; font-weight: 500; }
    .vs-mp-crumbs { padding: 10px 18px; display: flex; flex-wrap: wrap; align-items: center; gap: 4px; font-size: 13px; color: var(--secondary-text-color, #999); border-bottom: 1px solid var(--divider-color, #333); }
    .vs-mp-crumb { background: transparent; border: none; color: var(--primary-color, #03a9f4); cursor: pointer; padding: 2px 4px; font: inherit; }
    .vs-mp-crumb:hover { text-decoration: underline; }
    .vs-mp-crumb.is-current { color: var(--primary-text-color, #fff); cursor: default; }
    .vs-mp-crumb-sep { color: var(--secondary-text-color, #666); }
    .vs-mp-list { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 0; }
    .vs-mp-item {
      width: 100%; display: flex; align-items: center; gap: 12px;
      padding: 10px 18px; background: transparent; border: none; text-align: left;
      color: inherit; font: inherit; cursor: pointer;
    }
    .vs-mp-item:hover { background: rgba(255,255,255,0.06); }
    .vs-mp-item.is-disabled { cursor: default; color: var(--secondary-text-color, #999); }
    .vs-mp-thumb {
      width: 44px; height: 44px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
      background: var(--secondary-background-color, #2c2c2e); border-radius: 6px; overflow: hidden; font-size: 22px;
    }
    .vs-mp-thumb img { width: 100%; height: 100%; object-fit: cover; }
    .vs-mp-text { flex: 1; min-width: 0; }
    .vs-mp-item-title { font-size: 14px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .vs-mp-item-subtitle { font-size: 12px; color: var(--secondary-text-color, #999); margin-top: 2px; }
    .vs-mp-empty {
      padding: 40px 20px;
      text-align: center;
      font-size: 13px;
      font-style: italic;
      color: var(--secondary-text-color, #999);
    }
    .vs-mp-footer { display: flex; padding: 12px 18px; gap: 8px; border-top: 1px solid var(--divider-color, #333); }
    .vs-mp-btn {
      padding: 8px 16px; border-radius: 8px; font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; border: none;
    }
    .vs-mp-btn.is-ghost { background: transparent; color: var(--primary-text-color, #fff); border: 1px solid var(--divider-color, #444); }
    .vs-mp-btn.is-ghost:hover { background: rgba(255,255,255,0.06); }
    .vs-mp-btn.is-primary { background: var(--primary-color, #03a9f4); color: #fff; }
    .vs-mp-btn.is-primary:hover:not(:disabled) { opacity: 0.88; }
    .vs-mp-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  `;
  document.head.appendChild(style);
}
