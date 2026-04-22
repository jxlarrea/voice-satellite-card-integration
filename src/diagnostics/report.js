/**
 * Diagnostics report formatter.
 *
 * Produces a markdown block suitable for pasting into a GitHub issue.
 * Called from the panel's "Copy report" button.
 */

import { VERSION } from '../constants.js';

const STATUS_ICON = {
  pass: 'OK',
  warn: 'WARN',
  fail: 'FAIL',
  info: 'INFO',
  skip: 'SKIP',
};

export function buildMarkdownReport(report) {
  if (!report) return '';
  const { summary, results, generatedAt } = report;
  const lines = [];
  lines.push('### Voice Satellite diagnostics');
  lines.push('');
  lines.push(`- Bundle version: ${VERSION}`);
  lines.push(`- Generated: ${new Date(generatedAt).toISOString()}`);
  lines.push(`- URL: ${safeUrl()}`);
  lines.push(`- User agent: ${navigator.userAgent}`);
  lines.push(`- Summary: ${summary.pass} pass / ${summary.warn} warn / ${summary.fail} fail / ${summary.skip} skip (of ${summary.total})`);
  lines.push('');

  const byCategory = groupBy(results, (r) => r.category || 'Other');
  for (const [category, rows] of byCategory) {
    lines.push(`#### ${category}`);
    lines.push('');
    for (const r of rows) {
      const icon = STATUS_ICON[r.status] || r.status;
      lines.push(`- **[${icon}] ${r.title}**`);
      if (r.detail) lines.push(`  - ${r.detail}`);
      if (r.remediation && (r.status === 'fail' || r.status === 'warn')) {
        lines.push(`  - Fix: ${r.remediation}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

function groupBy(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function safeUrl() {
  try {
    const u = new URL(window.location.href);
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch (_) {
    return '(unknown)';
  }
}
