// Output-style catalog for pickers and config. Roots are injected so this
// module stays free of the runtime's path constants; the metadata contract
// (ids, frontmatter, ordering, lookup) lives in ../lib/output-style-meta.cjs,
// shared with the CJS rules builder that injects the style into the prompt.
import { join } from 'node:path';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { clean } from './session-text.mjs';
import { readJsonSafe } from './fs-utils.mjs';
import {
  DEFAULT_OUTPUT_STYLE_ID,
  matchOutputStyle,
  normalizeOutputStyleId,
  outputStyleMetaFromMarkdown,
  sortOutputStyles,
  titleCaseOutputStyle,
} from '../lib/output-style-meta.cjs';

export { normalizeOutputStyleId };

function computeOutputStyleMetadata(filePath, fileName, source) {
  let raw = '';
  try { raw = readFileSync(filePath, 'utf8'); } catch { return null; }
  const meta = outputStyleMetaFromMarkdown(raw, fileName);
  if (!meta) return null;
  // Picker/IPC shape stays metadata-only: keep-shared-format is a prompt-build
  // concern and never crosses the wire.
  return {
    id: meta.id,
    label: meta.label,
    description: meta.description,
    aliases: meta.aliases,
    source,
  };
}

// Per-file metadata cache keyed by path + mtime, and a per-directory listing
// cache keyed by dir mtime — repeated catalog reads skip readdir/readFile when
// nothing changed. File content edits (unchanged dir mtime) are still caught by
// the per-file mtime check.
const styleFileCache = new Map();
function readOutputStyleMetadata(filePath, fileName, source) {
  let mtimeMs = 0;
  try { mtimeMs = statSync(filePath).mtimeMs; } catch { mtimeMs = 0; }
  const hit = styleFileCache.get(filePath);
  if (hit && hit.mtimeMs === mtimeMs) return hit.value;
  const value = computeOutputStyleMetadata(filePath, fileName, source);
  styleFileCache.set(filePath, { mtimeMs, value });
  return value;
}

const styleDirCache = new Map();
function listStyleDirFiles(dir, fresh = false) {
  let mtimeMs = 0;
  try { mtimeMs = statSync(dir).mtimeMs; } catch { return null; }
  if (!fresh) {
    const hit = styleDirCache.get(dir);
    if (hit && hit.mtimeMs === mtimeMs) return hit.files;
  }
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => entry.name);
  styleDirCache.set(dir, { mtimeMs, files });
  return files;
}

export function listOutputStyleCatalog(rootDir, dataDir, { fresh = false } = {}) {
  const byId = new Map();
  const dirs = [
    { dir: join(rootDir, 'output-styles'), source: 'builtin' },
    { dir: join(dataDir, 'output-styles'), source: 'user' },
  ];
  for (const { dir, source } of dirs) {
    // Forced-fresh (e.g. setOutputStyle) bypasses the dir-listing cache so a
    // just-added/removed .md is always seen; per-file metadata still reuses the
    // path+mtime cache below.
    const files = listStyleDirFiles(dir, fresh);
    if (!files) continue;
    for (const name of files) {
      const style = readOutputStyleMetadata(join(dir, name), name, source);
      if (style) byId.set(style.id, style);
    }
  }
  return sortOutputStyles([...byId.values()]);
}

export function findOutputStyle(value, styles) {
  return matchOutputStyle(value, styles);
}

// Root `outputStyle` is the only configured location; the retired
// `agent.outputStyle` key is dropped by config canonicalization.
function configuredOutputStyleValue(dataDir) {
  const unified = readJsonSafe(join(dataDir, 'mixdog-config.json')) || {};
  return clean(unified.outputStyle) || DEFAULT_OUTPUT_STYLE_ID;
}

export function outputStyleStatus(rootDir, dataDir, { fresh = false } = {}) {
  const styles = listOutputStyleCatalog(rootDir, dataDir, { fresh });
  const configured = configuredOutputStyleValue(dataDir);
  const current = findOutputStyle(configured, styles)
    || findOutputStyle(DEFAULT_OUTPUT_STYLE_ID, styles)
    || styles[0]
    || {
      id: DEFAULT_OUTPUT_STYLE_ID,
      label: titleCaseOutputStyle(DEFAULT_OUTPUT_STYLE_ID),
      description: '',
      aliases: [],
      source: 'builtin',
    };
  return { configured, current, styles };
}
