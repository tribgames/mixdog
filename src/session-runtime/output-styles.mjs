// Output-style catalog + metadata parsing. Roots are injected so this module
// stays free of the runtime's path constants.
import { basename, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { clean } from './session-text.mjs';
import { readJsonSafe } from './fs-utils.mjs';

const OUTPUT_STYLE_ORDER = ['default', 'simple', 'minimal', 'oneline'];
const OUTPUT_STYLE_ALIASES = new Map([
  ['compact', 'default'],
  ['normal', 'default'],
  ['extreme', 'minimal'],
  ['extremesimple', 'minimal'],
  ['extreme-simple', 'minimal'],
  ['extreme_simple', 'minimal'],
  ['mono', 'oneline'],
  ['oneline', 'oneline'],
  ['one-line', 'oneline'],
  ['one_line', 'oneline'],
]);

export function normalizeOutputStyleId(value) {
  const raw = clean(value).toLowerCase();
  if (!raw) return '';
  const slug = raw.replace(/[_\s]+/g, '-').replace(/^-+|-+$/g, '');
  const compact = slug.replace(/[_.-]+/g, '');
  if (OUTPUT_STYLE_ALIASES.has(slug)) return OUTPUT_STYLE_ALIASES.get(slug);
  if (OUTPUT_STYLE_ALIASES.has(compact)) return OUTPUT_STYLE_ALIASES.get(compact);
  return /^[a-z0-9.-]+$/.test(slug) ? slug : '';
}

function outputStyleCompactKey(value) {
  return normalizeOutputStyleId(value).replace(/[_.-]+/g, '');
}

function titleCaseOutputStyle(id) {
  return clean(id)
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

function readOutputStyleMetadata(filePath, source) {
  let raw = '';
  try { raw = readFileSync(filePath, 'utf8'); } catch { return null; }
  const meta = parseOutputStyleFrontmatter(raw);
  const fileId = normalizeOutputStyleId(basename(filePath).replace(/\.md$/i, ''));
  const id = normalizeOutputStyleId(meta.name) || fileId;
  if (!id) return null;
  const aliases = clean(meta.aliases)
    .split(',')
    .map((value) => normalizeOutputStyleId(value))
    .filter(Boolean);
  const label = clean(meta.title || meta.label) || titleCaseOutputStyle(id);
  return {
    id,
    label,
    description: clean(meta.description),
    aliases,
    source,
  };
}

export function listOutputStyleCatalog(rootDir, dataDir) {
  const byId = new Map();
  const dirs = [
    { dir: join(rootDir, 'output-styles'), source: 'builtin' },
    { dir: join(dataDir, 'output-styles'), source: 'user' },
  ];
  for (const { dir, source } of dirs) {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      const style = readOutputStyleMetadata(join(dir, entry.name), source);
      if (style) byId.set(style.id, style);
    }
  }
  return [...byId.values()].sort((a, b) => {
    const ai = OUTPUT_STYLE_ORDER.indexOf(a.id);
    const bi = OUTPUT_STYLE_ORDER.indexOf(b.id);
    if (ai !== bi) return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
    return a.label.localeCompare(b.label, 'en', { sensitivity: 'base' });
  });
}

export function findOutputStyle(value, styles) {
  const id = normalizeOutputStyleId(value);
  const compact = outputStyleCompactKey(value);
  if (!id && !compact) return null;
  return (styles || []).find((style) => {
    if (style.id === id || outputStyleCompactKey(style.id) === compact) return true;
    if (outputStyleCompactKey(style.label) === compact) return true;
    return (style.aliases || []).some((alias) => alias === id || outputStyleCompactKey(alias) === compact);
  }) || null;
}

function configuredOutputStyleValue(dataDir) {
  const unified = readJsonSafe(join(dataDir, 'mixdog-config.json')) || {};
  return clean(unified.outputStyle || (unified.agent && unified.agent.outputStyle) || 'default') || 'default';
}

export function outputStyleStatus(rootDir, dataDir) {
  const styles = listOutputStyleCatalog(rootDir, dataDir);
  const configured = configuredOutputStyleValue(dataDir);
  const current = findOutputStyle(configured, styles)
    || findOutputStyle('default', styles)
    || styles[0]
    || { id: 'default', label: 'Default', description: '', aliases: [], source: 'builtin' };
  return { configured, current, styles };
}
