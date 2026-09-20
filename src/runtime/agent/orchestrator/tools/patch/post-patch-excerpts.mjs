// Post-patch excerpt: a successful patch result carries the changed span's
// CURRENT on-disk lines (numbered, verbatim). This embeds the follow-up
// look-up INSIDE the mutation turn — the next patch to the same region has
// byte-exact context in-session without spending a read/grep turn, which
// removes the fuel for stale-own-edit context misses (the measured top
// remaining failure class).
//
// REPEAT-GATED: batched one-shot patches (the common case under the
// all-edits-in-one-patch rule) rarely get a follow-up, so the FIRST patch of
// a file in a session appends nothing — zero cost. Only a repeat patch of
// the same file (the iterative fix-loop signal, exactly where stale-own-edit
// misses happen) pays for the excerpt.
import { readFileSync } from 'node:fs';
import { isV4APatchInput, parseV4APatch } from './parsing.mjs';
import { resolveV4AEntryPath } from './paths.mjs';
import { isPatchErrorText } from './wave.mjs';

const _patchedFilesByScope = new Map(); // scopeKey -> Map(fileKey -> ts)
const PATCHED_FILES_SCOPE_CAP = 64;
const PATCHED_FILES_PER_SCOPE_CAP = 300;
function _scopePatchedFiles(scopeKey) {
  let seen = _patchedFilesByScope.get(scopeKey);
  if (!seen) {
    seen = new Map();
    _patchedFilesByScope.set(scopeKey, seen);
    while (_patchedFilesByScope.size > PATCHED_FILES_SCOPE_CAP) {
      _patchedFilesByScope.delete(_patchedFilesByScope.keys().next().value);
    }
  }
  return seen;
}
const POST_PATCH_EXCERPT_MAX_FILES = 3;
const POST_PATCH_EXCERPT_MAX_LINES = 6;
const POST_PATCH_EXCERPT_MAX_CHARS = 700;

export function appendPostPatchExcerpts(outputText, patchStr, requestedFormat, basePath, readStateScope) {
  try {
    if (isPatchErrorText(outputText)) return outputText;
    if (!isV4APatchInput(patchStr, requestedFormat)) return outputText;
    const sections = parseV4APatch(patchStr).filter((s) => s.kind === 'update' && s.hunks?.length);
    if (!sections.length) return outputText;
    const seen = _scopePatchedFiles(String(readStateScope || 'global'));
    const repeats = [];
    for (const section of sections) {
      const target = section.movePath || section.path;
      let fileKey;
      try {
        fileKey = resolveV4AEntryPath(basePath, target);
      } catch {
        continue;
      }
      if (process.platform === 'win32') fileKey = fileKey.toLowerCase();
      if (seen.has(fileKey)) repeats.push(section);
      seen.set(fileKey, Date.now());
      while (seen.size > PATCHED_FILES_PER_SCOPE_CAP) seen.delete(seen.keys().next().value);
    }
    if (!repeats.length) return outputText;
    const chunks = [];
    let chars = 0;
    for (const section of repeats.slice(0, POST_PATCH_EXCERPT_MAX_FILES)) {
      const target = section.movePath || section.path;
      let fileLines;
      try {
        fileLines = readFileSync(resolveV4AEntryPath(basePath, target), 'utf8').replace(/\r\n/g, '\n').split('\n');
      } catch {
        continue;
      }
      const hunk = section.hunks[0];
      const newSide = (hunk.lines || []).filter((l) => l && (l[0] === ' ' || l[0] === '+')).map((l) => l.slice(1));
      if (!newSide.length) continue;
      let at = -1;
      outer: for (let i = 0; i + newSide.length <= fileLines.length; i++) {
        for (let k = 0; k < newSide.length; k++) {
          if (fileLines[i + k] !== newSide[k]) continue outer;
        }
        at = i;
        break;
      }
      if (at < 0) continue;
      const shown = Math.min(newSide.length, POST_PATCH_EXCERPT_MAX_LINES);
      const rows = [];
      for (let i = 0; i < shown; i++) {
        rows.push(`${String(at + i + 1).padStart(5, ' ')}| ${fileLines[at + i]}`);
      }
      if (newSide.length > shown) rows.push('     | …');
      const extraHunks = section.hunks.length - 1;
      const hunkNoun = extraHunks === 1 ? 'hunk' : 'hunks';
      const more = extraHunks > 0 ? ` (+${extraHunks} more ${hunkNoun})` : '';
      const block = `${String(target).replace(/\\/g, '/')} lines ${at + 1}-${at + shown}${more}:\n${rows.join('\n')}`;
      chars += block.length;
      if (chars > POST_PATCH_EXCERPT_MAX_CHARS) break;
      chunks.push(block);
    }
    if (!chunks.length) return outputText;
    return `${outputText}\npost-patch state (verbatim — use for follow-up patches):\n${chunks.join('\n')}`;
  } catch {
    return outputText;
  }
}
