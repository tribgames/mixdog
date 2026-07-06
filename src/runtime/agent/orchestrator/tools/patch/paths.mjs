// Path resolution / entry classification helpers for apply_patch. Moved
// verbatim from patch.mjs; path/diff semantics unchanged.

import { existsSync, realpathSync } from 'node:fs';
import { resolve as pathResolve, relative as pathRelative, isAbsolute, dirname as pathDirname } from 'node:path';
import {
  normalizeInputPath,
  normalizeOutputPath,
  resolveAgainstCwd,
} from '../builtin.mjs';
import { assertPathReachable, assertPathsReachable } from '../builtin/fs-reachability.mjs';
import { nativePatchEnabled, nativePatchBinPath } from './native-server.mjs';
import { DEV_NULL } from './constants.mjs';

// Strip the leading `a/` or `b/` prefix that `diff -u` / git emit by
// default, plus timestamp suffixes (`\t2024-...`) that some tools append
// to header lines. parsePatch already splits the name from the header
// so timestamps land in `oldHeader` / `newHeader`, but be defensive.
export function stripDiffPrefix(name) {
  if (!name) return name;
  if (isAbsolute(name) || /^[A-Za-z]:[\\/]/.test(name)) return name;
  const m = /^[ab]\/(.+)$/.exec(name);
  return m ? m[1] : name;
}

export function resolveEntryPath(basePath, rawName) {
  const stripped = stripDiffPrefix(rawName);
  const norm = normalizeInputPath(stripped);
  return isAbsolute(norm) ? pathResolve(norm) : resolveAgainstCwd(norm, basePath);
}

// V4A section paths are real repository paths and never carry the unified
// diff `a/`·`b/` prefix, so resolution must NOT apply stripDiffPrefix — a
// legitimate top-level `a/` or `b/` directory would otherwise be silently
// rewritten to its child, reading/writing the wrong file.
export function resolveV4AEntryPath(basePath, rawName) {
  const norm = normalizeInputPath(rawName);
  return isAbsolute(norm) ? pathResolve(norm) : resolveAgainstCwd(norm, basePath);
}

export function resolveBasePath(cwd, basePath) {
  if (basePath == null || basePath === '') return cwd;
  const norm = normalizeInputPath(basePath);
  return isAbsolute(norm) ? pathResolve(norm) : resolveAgainstCwd(norm, cwd);
}

export function isResolvedPathOutsideBase(fullPath, basePath) {
  // Realpath-resolve so a symlink INSIDE base that points outside is caught:
  // a lexical relative check only sees the pre-resolution path. Resolve the
  // nearest existing ancestor (create-mode leaves don't exist yet) on both
  // sides, then compare.
  const realBase = realpathNearestExistingAncestor(pathResolve(basePath));
  const realFull = realpathNearestExistingAncestor(pathResolve(fullPath));
  const rel = pathRelative(realBase, realFull).replace(/\\/g, '/');
  // rel === '' means realFull IS realBase — e.g. a create-mode target whose
  // nearest existing ancestor is base itself, or a direct child. That is
  // inside base, so pass. Only reject an absolute rel (different root/drive)
  // or one that escapes via '..'.
  if (rel === '') return false;
  if (isAbsolute(rel)) return true;
  return rel.split(/[\\/]+/).some((part) => part === '..');
}

// Categorise the per-file entry. A unified diff can describe:
//   - modify   : both files named, oldFileName exists on disk
//   - create   : oldFileName === /dev/null (or file doesn't exist + hunks start at 0)
//   - delete   : newFileName === /dev/null
export function classifyEntry(entry) {
  const oldIsNull = DEV_NULL.test(entry.oldFileName || '');
  const newIsNull = DEV_NULL.test(entry.newFileName || '');
  if (oldIsNull && !newIsNull) return 'create';
  if (!oldIsNull && newIsNull) return 'delete';
  return 'modify';
}


export function parsedEntryResolvedPath(entry, basePath) {
  const kind = classifyEntry(entry);
  const headerName = kind === 'create' ? entry.newFileName : entry.oldFileName;
  return resolveEntryPath(basePath, headerName);
}

function parsedEntryTargetKey(entry, basePath) {
  if (classifyEntry(entry) !== 'modify') return '';
  const headerName = entry.oldFileName || entry.newFileName;
  if (!headerName || DEV_NULL.test(headerName)) return '';
  const fullPath = resolveEntryPath(basePath, headerName);
  return process.platform === 'win32' ? fullPath.toLowerCase() : fullPath;
}

// Group parsed entries into sequential application "waves". When a file is
// listed as a modify target N times, occurrence i is placed in wave i, so
// each duplicate block applies against the on-disk result of the previous
// one — the native engine re-reads the file per apply() call, giving true
// sequential semantics ("block 2 against block 1's output"). Unique and
// non-modify entries always land in wave 0.
//
// Genuinely unsupported same-path combos (a create/delete mixed with any
// other block for that path) cannot be sequenced and throw with guidance to
// merge hunks into one block or send separate apply_patch calls.
export function splitParsedModifyWaves(parsed, basePath) {
  const entries = Array.isArray(parsed) ? parsed : [];
  const kindsByPath = new Map();
  for (const entry of entries) {
    const kind = classifyEntry(entry);
    const headerName = kind === 'create' ? entry.newFileName : entry.oldFileName;
    if (!headerName || DEV_NULL.test(headerName)) continue;
    const full = resolveEntryPath(basePath, headerName);
    const key = process.platform === 'win32' ? full.toLowerCase() : full;
    const rec = kindsByPath.get(key) || { kinds: [], headerName };
    rec.kinds.push(kind);
    kindsByPath.set(key, rec);
  }
  for (const { kinds, headerName } of kindsByPath.values()) {
    if (kinds.length > 1 && kinds.some((k) => k !== 'modify')) {
      const display = normalizeOutputPath(stripDiffPrefix(headerName));
      throw new Error(
        `apply_patch: unsupported duplicate target ${display} — a create/delete block cannot `
        + 'be combined with other blocks for the same path. Merge the hunks into one block or '
        + 'send separate apply_patch calls.',
      );
    }
  }
  // Split into contiguous sequential groups that PRESERVE the patch's block
  // listing order: accumulate blocks until a target path would repeat within
  // the current group, then start a new group beginning with that block.
  // Every group holds unique targets (the native batch stays valid) and
  // groups apply in listed order, so the effective apply order — and thus the
  // set of committed blocks at any failure point — equals the on-wire order.
  const groups = [];
  let current = [];
  let currentKeys = new Set();
  for (const entry of entries) {
    const key = parsedEntryTargetKey(entry, basePath);
    if (key && currentKeys.has(key)) {
      groups.push(current);
      current = [];
      currentKeys = new Set();
    }
    current.push(entry);
    if (key) currentKeys.add(key);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function headerRelFromBase(basePath, absNorm) {
  const rel = pathRelative(pathResolve(basePath), pathResolve(absNorm)).replace(/\\/g, '/');
  if (!rel || isAbsolute(rel)) return null;
  return rel;
}

function unifiedRange(start, lines) {
  const s = Math.max(0, Number(start) || 0);
  const n = Math.max(0, Number(lines) || 0);
  return `${s},${n}`;
}

export function renderParsedUnifiedPatch(parsed) {
  const out = [];
  for (const entry of parsed || []) {
    out.push(`--- ${entry.oldFileName || '/dev/null'}`);
    out.push(`+++ ${entry.newFileName || '/dev/null'}`);
    for (const hunk of entry.hunks || []) {
      const section = hunk.section ? ` ${hunk.section}` : '';
      out.push(`@@ -${unifiedRange(hunk.oldStart, hunk.oldLines)} +${unifiedRange(hunk.newStart, hunk.newLines)} @@${section}`);
      for (const line of hunk.lines || []) out.push(line);
    }
  }
  return `${out.join('\n')}\n`;
}

// Count how many source lines a hunk consumes vs produces so we can
// surface a concise `lines_changed` figure without re-diffing.
export function countHunkChanges(hunks) {
  let added = 0;
  let removed = 0;
  for (const h of hunks || []) {
    for (const line of h.lines || []) {
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
    }
  }
  return { added, removed };
}

// Header-shape pre-validator: missing or /dev/null target path only.
// Lexical `..` and out-of-base absolutes resolve via resolveEntryPath;
// write permission is enforced at the hook layer, not here.
function nativeHeaderSupported(entry) {
  const kind = classifyEntry(entry);
  const headerName = kind === 'create' ? entry.newFileName : entry.oldFileName;
  return !!(headerName && !DEV_NULL.test(headerName));
}

// Resolve `absPath` via fs.realpathSync, walking up to the nearest existing
// ancestor when the leaf does not yet exist (e.g. a create-mode target).
// Returns the resolved real path, or the lexically-resolved path if no
// ancestor can be realpath'd.
export function realpathNearestExistingAncestor(absPath) {
  let cur = pathResolve(absPath);
  while (true) {
    try {
      return realpathSync(cur);
    } catch {
      const parent = pathDirname(cur);
      if (!parent || parent === cur) return cur;
      cur = parent;
    }
  }
}

// Pre-validator (throws): walks every parsed entry and enforces
//   - native engine is enabled
//   - native binary exists on disk
//   - each header has a usable target path (shape only)
//   - no duplicate target paths in the patch (case-insensitive on win32)
// Returns the list of normalized entry rows the dispatcher uses to format
// output, plus the header-rewrite map for absolute-path normalization.
export async function preValidateNativeBatch(parsed, basePath) {
  if (!nativePatchEnabled()) {
    throw new Error('apply_patch: native engine disabled via MIXDOG_PATCH_NATIVE; set it to "auto" or "1" to apply patches.');
  }
  const binPath = nativePatchBinPath();
  if (!existsSync(binPath)) {
    throw new Error(`apply_patch: native patch binary not found at ${binPath}; build native/mixdog-patch or fetch the prebuilt before invoking apply_patch.`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('apply_patch: patch contained no file sections');
  }
  await assertPathReachable(basePath);
  const reachabilityPaths = [];
  for (const entry of parsed) {
    for (const which of ['oldFileName', 'newFileName']) {
      const checkName = entry[which];
      if (!checkName || DEV_NULL.test(checkName)) continue;
      reachabilityPaths.push(resolveEntryPath(basePath, checkName));
    }
  }
  await assertPathsReachable(reachabilityPaths);
  const entries = [];
  const seenPaths = new Set();
  const headerRewrites = [];
  for (const entry of parsed) {
    const kind = classifyEntry(entry);
    const headerName = kind === 'create' ? entry.newFileName : entry.oldFileName;
    if (!nativeHeaderSupported(entry)) {
      throw new Error(
        'apply_patch: a file section header could not be parsed (no target path). '
        + 'Each section must start with a valid header: `*** Update File: <path>` / '
        + '`*** Add File: <path>` / `*** Delete File: <path>` (V4A), or a '
        + '`--- a/<path>` + `+++ b/<path>` pair (unified). Wrap multi-hunk V4A '
        + 'edits in a `*** Begin Patch` / `*** End Patch` envelope and pass format:"v4a".',
      );
    }
    if (kind !== 'delete' && !(entry.hunks?.length > 0)) {
      const display = headerName ? normalizeOutputPath(stripDiffPrefix(headerName)) : '(unknown)';
      throw new Error(`apply_patch: entry ${display} has no hunks — patch header malformed (use \`@@ -A,B +C,D @@\` per hunk).`);
    }
    const fullPath = resolveEntryPath(basePath, headerName);
    const pathKey = process.platform === 'win32' ? fullPath.toLowerCase() : fullPath;
    if (seenPaths.has(pathKey)) {
      const display = normalizeOutputPath(stripDiffPrefix(headerName));
      throw new Error(`apply_patch: duplicate target ${display} — patch lists the same path twice.`);
    }
    seenPaths.add(pathKey);
    const displayPath = normalizeOutputPath(stripDiffPrefix(headerName));
    const { added, removed } = countHunkChanges(entry.hunks);
    entries.push({
      kind,
      fullPath,
      displayPath,
      added,
      removed,
      hunks: entry.hunks?.length || 0,
      linesChanged: added + removed,
    });
    // Absolute-form headers must be rewritten to paths relative to basePath
    // (including `..` segments for out-of-base targets) before the native
    // server, which joins headers to basePath, sees them.
    for (const which of ['oldFileName', 'newFileName']) {
      const raw = entry[which];
      if (!raw || DEV_NULL.test(raw)) continue;
      const stripped = stripDiffPrefix(raw);
      const norm = normalizeInputPath(stripped);
      if (!isAbsolute(norm) && !/^[A-Za-z]:[\\/]/.test(norm)) continue;
      if (isResolvedPathOutsideBase(pathResolve(norm), basePath)) continue;
      const rel = headerRelFromBase(basePath, norm);
      if (!rel || rel.startsWith('..')) continue;
      headerRewrites.push({ from: raw, to: rel });
    }
  }
  return { entries, headerRewrites };
}

// Rewrite ONLY the file-section header lines (`--- old`/`+++ new`) that
// precede each hunk so the native server, which joins headers to
// basePath, never sees an absolute header. A hunk DELETION line is `-`
// + content, so a deleted line whose body text is `-- C:/...` renders as
// `--- C:/...`; track hunk-body state by consuming each `@@ -a,b +c,d @@`
// header's declared line counts so only lines outside any hunk body are
// eligible for rewrite.
export function rewriteHeaderPaths(patchStr, headerRewrites) {
  if (!headerRewrites || headerRewrites.length === 0) return patchStr;
  const lines = patchStr.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('@@ ')) {
      const m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      let oldRem = m && m[1] !== undefined ? Number(m[1]) : 1;
      let newRem = m && m[2] !== undefined ? Number(m[2]) : 1;
      i++;
      while (i < lines.length && (oldRem > 0 || newRem > 0)) {
        const body = lines[i];
        const c = body.charAt(0);
        if (c === ' ') { oldRem--; newRem--; }
        else if (c === '-') { oldRem--; }
        else if (c === '+') { newRem--; }
        else if (c === '\\') { /* "\ No newline at end of file" marker */ }
        else break;
        i++;
      }
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const prefix = line.slice(0, 4);
      const rest = line.slice(4);
      const tabIdx = rest.indexOf('\t');
      const pathPart = tabIdx === -1 ? rest : rest.slice(0, tabIdx);
      const suffix = tabIdx === -1 ? '' : rest.slice(tabIdx);
      for (const { from, to } of headerRewrites) {
        if (pathPart === from) {
          lines[i] = `${prefix}${to}${suffix}`;
          break;
        }
      }
    }
    i++;
  }
  return lines.join('\n');
}
