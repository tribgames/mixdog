// Shipped definitions live in code; the data dir should hold only copies the
// user actually changed. This module holds the pieces shared by the startup
// migration (seeds.mjs), the editors, and scripts/build-shipped-history.mjs:
// content normalisation + hashing (so the generator and the runtime compare
// exactly the same thing), the shipped-history file, and the backup mover.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { readMarkdownDocument } from '../../runtime/shared/markdown-frontmatter.mjs';

export const SHIPPED_HISTORY_FILE = ['defaults', 'shipped-history.json'];
export const EMPTY_HISTORY = Object.freeze({ agents: {}, workflows: {}, outputStyles: {}, skills: {} });

// Leftovers from hand edits or editors that never belong to a definition.
const IGNORABLE_STRAY = /(\.(bak|orig|tmp)|~)$/i;
export const isIgnorableStray = (name) => IGNORABLE_STRAY.test(name);

const digest = (text) => createHash('sha256').update(text).digest('hex').slice(0, 32);

/** CRLF -> LF, trailing whitespace stripped per line and at the end. */
export function normalizeText(value) {
  return (Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? ''))
    .replace(/\r\n/g, '\n')
    .replace(/[^\S\n]+$/gm, '')
    .trimEnd();
}

export const hashText = (value) => digest(normalizeText(value));

const oneLine = (value) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Editable surface of an agent/workflow pack. `read(name)` returns the text of
 * a file in the pack or null. agent.json wins over frontmatter for
 * name/description, matching the loaders.
 */
export function packDefinitionFrom(read, entry, id = '') {
  let manifest = {};
  try {
    const parsed = JSON.parse(read('agent.json') || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) manifest = parsed;
  } catch {
    manifest = {};
  }
  const doc = readMarkdownDocument(read(oneLine(manifest.entry) || entry) || '');
  const body = normalizeText(doc.body);
  if (!body) return null;
  // Every other loader-visible field (frontmatter flags such as permission or
  // hidden, model/tool fields, manifest keys). An `id` equal to the directory
  // id and the default `entry` are what the loaders assume anyway, so they are
  // not differences.
  const sameId = (value) => String(value ?? '').trim().toLowerCase() === String(id).toLowerCase();
  const fields = {};
  for (const [key, value] of Object.entries(doc.frontmatter)) {
    if (key === 'name' || key === 'description' || (key === 'id' && sameId(value))) continue;
    fields[`frontmatter.${key}`] = String(value).trim();
  }
  for (const [key, value] of Object.entries(manifest)) {
    if (key === 'name' || key === 'description' || (key === 'id' && sameId(value))) continue;
    if (key === 'entry' && (oneLine(value) === entry || !oneLine(value))) continue;
    fields[`manifest.${key}`] = JSON.stringify(value);
  }
  return {
    name: oneLine(manifest.name || doc.frontmatter.name),
    description: oneLine(manifest.description || doc.frontmatter.description),
    body,
    fields,
  };
}

const fieldsKey = (fields) => JSON.stringify(Object.entries(fields || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** surfaceOnly: name/description/body, what the editors can express. */
export const hashDefinition = ({ name, description, body, fields }, { surfaceOnly = false } = {}) =>
  digest(
    JSON.stringify([oneLine(name), oneLine(description), normalizeText(body), surfaceOnly ? '' : fieldsKey(fields)])
  );

export function packDefinitionFromDir(dir, entry, id = '') {
  return packDefinitionFrom(
    (name) => {
      try {
        return readFileSync(join(dir, name), 'utf8');
      } catch {
        return null;
      }
    },
    entry,
    id
  );
}

export function packHashFromDir(dir, entry, id = '') {
  const definition = packDefinitionFromDir(dir, entry, id);
  return definition ? hashDefinition(definition) : null;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
// Anything that is not valid UTF-8 text hashes byte-for-byte.
const isBinary = (content) => {
  if (!Buffer.isBuffer(content)) return false;
  if (content.includes(0)) return true;
  try {
    utf8.decode(content);
    return false;
  } catch {
    return true;
  }
};

/**
 * files: [relative '/' path, Buffer|string][]; stray files are ignored. Text
 * files are normalised (CRLF/trailing space); binary files hash byte-for-byte.
 */
export function hashTree(files) {
  const lines = files
    .filter(([rel]) => !isIgnorableStray(rel.split('/').pop()))
    .map(([rel, content]) => `${rel}\0${isBinary(content) ? `b${digest(content)}` : hashText(content)}`)
    .sort();
  return digest(lines.join('\n'));
}

export function readTreeFiles(dir, prefix = '') {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...readTreeFiles(join(dir, entry.name), rel));
    else if (entry.isFile()) files.push([rel, readFileSync(join(dir, entry.name))]);
  }
  return files;
}

export function treeHashFromDir(dir) {
  try {
    return hashTree(readTreeFiles(dir));
  } catch {
    return null;
  }
}

export function fileHash(file) {
  try {
    return hashText(readFileSync(file));
  } catch {
    return null;
  }
}

export function loadShippedHistory(rootDir) {
  try {
    return { ...EMPTY_HISTORY, ...JSON.parse(readFileSync(join(rootDir, ...SHIPPED_HISTORY_FILE), 'utf8')) };
  } catch {
    return EMPTY_HISTORY;
  }
}

/** The copy must hold the entry file and nothing but editor files and ignorable strays. */
export function holdsOnlyEditorFiles(dir, allowed, entry) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return (
    entries.some((e) => e.isFile() && e.name === entry) &&
    entries.every((e) => e.isFile() && (allowed.includes(e.name) || isIgnorableStray(e.name)))
  );
}

/**
 * Editor save of a pack whose definition equals the shipped one: no user copy
 * should exist, so the item keeps following the shipped version. An existing
 * copy (only editor files, a tombstone, strays) moves into a backup. Returns
 * true when the save was absorbed; false means the caller writes the copy.
 */
export function absorbSaveEqualToShipped({ rootDir, dataDir, dir, id, entry, files, definition }) {
  // The editor only expresses name/description/body; the shipped fields it
  // cannot see keep applying because no copy is written.
  const shipped = packDefinitionFromDir(join(rootDir, dir, id), entry, id);
  if (!shipped || hashDefinition(definition, { surfaceOnly: true }) !== hashDefinition(shipped, { surfaceOnly: true })) {
    return false;
  }
  const copy = join(dataDir, dir, id);
  if (!existsSync(copy)) return true;
  const allowed = [...files, '.deleted'];
  const clean = readdirSync(copy, { withFileTypes: true }).every(
    (e) => e.isFile() && (allowed.includes(e.name) || isIgnorableStray(e.name))
  );
  if (!clean) return false;
  // A real existing definition must match the shipped hidden fields exactly
  // (an empty set included); a tombstone-only state has no definition to compare.
  const existing = packDefinitionFromDir(copy, entry, id);
  if (existing && fieldsKey(existing.fields || {}) !== fieldsKey(shipped.fields)) return false;
  return makeBackup(dataDir).move(copy);
}

// Bump to re-run the history-based retirement for every install.
export const SEPARATION_VERSION = 1;
export const HISTORY_MARKER_FILE = '.shipped-history-retired';

/** Identity of the history retirement: separation version + history content. */
export const historyStamp = (rootDir) =>
  `${SEPARATION_VERSION}:${digest(JSON.stringify(loadShippedHistory(rootDir)))}`;

/**
 * Lazily-created `<dataDir>/backups/defaults-separation-<timestamp>` folder.
 * Moved entries keep their data-dir-relative path; nothing is deleted.
 */
export function makeBackup(dataDir) {
  let root = null;
  let failures = 0;
  // Atomic create: an existing backup folder is never reused.
  const claimRoot = () => {
    const base = join(dataDir, 'backups', `defaults-separation-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    mkdirSync(join(dataDir, 'backups'), { recursive: true });
    for (let n = 1; ; n += 1) {
      const candidate = n === 1 ? base : `${base}-${n}`;
      try {
        mkdirSync(candidate);
        return candidate;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
  };
  const freeDest = (wanted) => {
    let dest = wanted;
    for (let n = 2; existsSync(dest); n += 1) dest = `${wanted}.${n}`;
    return dest;
  };
  return {
    get root() {
      return root;
    },
    get failures() {
      return failures;
    },
    /** Moves `target` into the backup; returns false if it could not be moved. */
    move(target) {
      if (!existsSync(target)) return true;
      try {
        root ??= claimRoot();
        const dest = freeDest(join(root, relative(dataDir, target)));
        mkdirSync(dirname(dest), { recursive: true });
        try {
          renameSync(target, dest);
        } catch {
          cpSync(target, dest, { recursive: true, force: false, errorOnExist: true });
          rmSync(target, { recursive: true, force: true });
        }
        return true;
      } catch {
        // best-effort; a stuck copy simply keeps shadowing until moved by hand
        failures += 1;
        return false;
      }
    },
  };
}
