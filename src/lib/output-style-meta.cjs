// Output-style metadata contract: id normalization, frontmatter parsing,
// catalog ordering, and lookup. Required by the CJS rules builder (prompt
// injection) and imported by the ESM session runtime (pickers, config), so one
// schema governs both instead of two parallel copies drifting apart.
//
// Frontmatter schema for `output-styles/<id>.md`:
//   name                — canonical id (defaults to the file name)
//   title | label       — display label (defaults to a title-cased id)
//   description         — one-line picker text
//   aliases             — comma-separated alternate ids; the only alias source
//   partial             — true hides the file from the selectable catalog
//   keep-shared-format  — false replaces common.md instead of extending it
'use strict';

const DEFAULT_OUTPUT_STYLE_ID = 'simple';
const SHARED_FORMAT_PARTIAL_ID = 'common';
// Catalog order: deepest first, then unknown/custom styles by label.
const OUTPUT_STYLE_ORDER = ['detailed', 'simple', 'minimal', 'extreme-minimal'];

/** Slug form of a style id. Aliases live in frontmatter, never in code. */
function normalizeOutputStyleId(value) {
  const slug = String(value ?? '').trim().toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return /^[a-z0-9.-]+$/.test(slug) ? slug : '';
}

/** Separator-insensitive key so `one-line`, `one_line`, and `oneline` match. */
function outputStyleCompactKey(value) {
  return normalizeOutputStyleId(value).replace(/[_.-]+/g, '');
}

function titleCaseOutputStyle(id) {
  return String(id || '')
    .split(/[_.-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ') || 'Default';
}

function parseOutputStyleFrontmatter(markdown) {
  const match = String(markdown || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta = {};
  if (!match) return meta;
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (!kv) continue;
    meta[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return meta;
}

function outputStyleFlag(value, fallback) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (/^(?:true|1|yes|on)$/.test(raw)) return true;
  if (/^(?:false|0|no|off)$/.test(raw)) return false;
  return fallback;
}

/**
 * Frontmatter → catalog entry. Returns null for `partial: true` files (the
 * shared format partial) and for files with no usable id.
 */
function outputStyleMetaFromMarkdown(markdown, fileName) {
  const meta = parseOutputStyleFrontmatter(markdown);
  const fileId = normalizeOutputStyleId(String(fileName || '').replace(/\.md$/i, ''));
  // `common.md` is always the shared format partial (a user override may omit
  // the `partial` flag); it never becomes a selectable style.
  if (fileId === SHARED_FORMAT_PARTIAL_ID || outputStyleFlag(meta.partial, false)) return null;
  const id = normalizeOutputStyleId(meta.name) || fileId;
  if (!id) return null;
  return {
    id,
    label: String(meta.title || meta.label || '').trim() || titleCaseOutputStyle(id),
    description: String(meta.description || '').trim(),
    aliases: String(meta.aliases || '').split(',')
      .map((alias) => normalizeOutputStyleId(alias))
      .filter(Boolean),
    // Built-in and custom styles both inherit the shared format partial; a
    // style opts out only by declaring `keep-shared-format: false`.
    keepSharedFormat: outputStyleFlag(meta['keep-shared-format'], true),
  };
}

function sortOutputStyles(styles) {
  return [...(styles || [])].sort((a, b) => {
    const ai = OUTPUT_STYLE_ORDER.indexOf(a.id);
    const bi = OUTPUT_STYLE_ORDER.indexOf(b.id);
    if (ai !== bi) return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
    return a.label.localeCompare(b.label, 'en', { sensitivity: 'base' });
  });
}

/** Resolve an id, label, or frontmatter alias, ignoring separators and case. */
function matchOutputStyle(value, styles) {
  const id = normalizeOutputStyleId(value);
  const compact = outputStyleCompactKey(value);
  if (!id && !compact) return null;
  return (styles || []).find((style) => {
    if (style.id === id || outputStyleCompactKey(style.id) === compact) return true;
    if (outputStyleCompactKey(style.label) === compact) return true;
    return (style.aliases || []).some((alias) => alias === id || outputStyleCompactKey(alias) === compact);
  }) || null;
}

module.exports = {
  DEFAULT_OUTPUT_STYLE_ID,
  SHARED_FORMAT_PARTIAL_ID,
  OUTPUT_STYLE_ORDER,
  normalizeOutputStyleId,
  outputStyleCompactKey,
  titleCaseOutputStyle,
  parseOutputStyleFrontmatter,
  outputStyleFlag,
  outputStyleMetaFromMarkdown,
  sortOutputStyles,
  matchOutputStyle,
};
