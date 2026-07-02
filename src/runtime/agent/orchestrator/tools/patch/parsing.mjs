// V4A + unified-as-V4A patch parsers and format-detection helpers. Moved
// verbatim from patch.mjs; parsing behavior (V4A/unified) is unchanged.

import { stripDiffPrefix } from './paths.mjs';
import {
  DEV_NULL,
  V4A_EOF_MARKER,
  V4A_MOVE_TO_PREFIX,
  UNIFIED_HUNK_HEADER_RE,
  UNIFIED_HUNK_HEADER_CAPTURE_RE,
} from './constants.mjs';

// Strip BOM + normalize CRLF→LF only. Idempotent and structural — no
// hunk metadata is rewritten.
export function prepareInput(patchStr) {
  return String(patchStr).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

export function isApplyPatchEnvelope(patchStr) {
  const text = prepareInput(patchStr).trimStart();
  return text.startsWith('*** Begin Patch')
    || text.startsWith('*** Add File:')
    || text.startsWith('*** Update File:')
    || text.startsWith('*** Delete File:');
}

export function isV4APatchInput(patchStr, format) {
  return String(format || '').toLowerCase() === 'v4a'
    || isApplyPatchEnvelope(patchStr);
}

export function hasUnifiedBareV4AHunk(patchStr) {
  const text = prepareInput(patchStr);
  if (!/^--- /m.test(text) || !/^\+\+\+ /m.test(text)) return false;
  return text.split('\n').some((line) => line.startsWith('@@') && !UNIFIED_HUNK_HEADER_RE.test(line));
}

export function isUnifiedHunkCountError(err) {
  const message = String(err?.message || err || '');
  return /Hunk at line .*more lines than expected|Hunk at line .*less lines than expected|expected \d+ old lines|line count did not match/i.test(message);
}

export function canFallbackCountedUnified(patchStr, requestedFormat, err) {
  if (requestedFormat === 'unified') return false;
  if (isV4APatchInput(patchStr, requestedFormat)) return false;
  const text = prepareInput(patchStr);
  return /^--- /m.test(text)
    && /^\+\+\+ /m.test(text)
    && UNIFIED_HUNK_HEADER_RE.test(text.split('\n').find((line) => line.startsWith('@@')) || '')
    && isUnifiedHunkCountError(err);
}

function stripPatchPathMetadata(rawPath) {
  let text = String(rawPath || '').trim();
  if (!text) return '';
  const tabIdx = text.indexOf('\t');
  if (tabIdx !== -1) text = text.slice(0, tabIdx).trimEnd();
  const quote = text[0];
  if ((quote === '"' || quote === "'") && text.length > 1) {
    const end = text.indexOf(quote, 1);
    if (end > 0) text = text.slice(1, end);
  }
  return text;
}

function stripV4APathHeader(line, prefix) {
  return stripPatchPathMetadata(String(line || '').slice(prefix.length));
}

export function normaliseV4APath(rawPath) {
  const p = stripPatchPathMetadata(rawPath);
  if (!p) return '';
  return p.replace(/^["']|["']$/g, '').replace(/\\/g, '/');
}

function normaliseV4AAnchor(rawAnchor) {
  return String(rawAnchor || '').replace(/\s*@@\s*$/, '').trim();
}

function stripV4AMovePathHeader(line) {
  return normaliseV4APath(String(line || '').slice(V4A_MOVE_TO_PREFIX.length));
}

export function isV4AEndOfFileMarker(rawLine) {
  return String(rawLine || '').trim() === V4A_EOF_MARKER;
}

function v4aEnsureUpdateHunk(current, pendingAnchors) {
  return { anchors: pendingAnchors.slice(), lines: [] };
}

function v4aPushBlankContextLine(currentHunk, pendingAnchors) {
  if (!currentHunk) currentHunk = v4aEnsureUpdateHunk(null, pendingAnchors);
  currentHunk.lines.push(' ');
  return currentHunk;
}

function v4aMarkHunkEndOfFile(currentHunk, finishHunk) {
  if (!currentHunk || currentHunk.lines.length === 0) {
    throw new Error('V4A update hunk does not contain any lines before *** End of File');
  }
  currentHunk.isEndOfFile = true;
  finishHunk();
}

// Split a patch string into lines, dropping the single trailing empty element
// produced by the patch's terminal newline. Invariant: a well-formed patch
// ends with "\n", so `"...\n".split("\n")` always yields a spurious final ""
// that is a line *terminator*, not a content line. Absorbing it as a blank
// context line corrupts the last hunk (phantom trailing "" in oldLines) and
// breaks anchoring whenever the matched source region is not followed by a
// blank line. A genuine trailing blank context line survives as the
// second-to-last element, so only the terminator artifact is removed.
function splitPatchLines(patchStr) {
  const lines = prepareInput(patchStr).split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function parseV4APatch(patchStr) {
  const lines = splitPatchLines(patchStr);
  const files = [];
  let current = null;
  let pendingAnchors = [];
  let currentHunk = null;

  const finishHunk = () => {
    if (!current || !currentHunk) return;
    if (currentHunk.lines.length > 0) current.hunks.push(currentHunk);
    currentHunk = null;
  };
  const finishFile = () => {
    finishHunk();
    current = null;
    pendingAnchors = [];
  };
  const startFile = (kind, path) => {
    finishFile();
    current = { kind, path: normaliseV4APath(path), hunks: [], lines: [], movePath: null };
    files.push(current);
  };

  for (const rawLine of lines) {
    if (rawLine === '*** Begin Patch' || rawLine === '*** End Patch') continue;
    if (rawLine.startsWith('*** Update File:')) {
      startFile('update', stripV4APathHeader(rawLine, '*** Update File:'));
      continue;
    }
    if (rawLine.startsWith('*** Add File:')) {
      startFile('add', stripV4APathHeader(rawLine, '*** Add File:'));
      continue;
    }
    if (rawLine.startsWith('*** Delete File:')) {
      startFile('delete', stripV4APathHeader(rawLine, '*** Delete File:'));
      continue;
    }
    if (!current) {
      throw new Error(`V4A patch line appears before a file header: ${rawLine}`);
    }
    if (current.kind === 'update' && rawLine.startsWith(V4A_MOVE_TO_PREFIX)) {
      if (current.movePath) {
        throw new Error(`V4A patch lists multiple ${V4A_MOVE_TO_PREFIX} directives for ${current.path}`);
      }
      const dest = stripV4AMovePathHeader(rawLine);
      if (!dest) throw new Error('V4A patch contains an empty move destination path');
      current.movePath = dest;
      continue;
    }
    if (current.kind === 'add') {
      current.lines.push(rawLine.startsWith('+') ? rawLine.slice(1) : rawLine);
      continue;
    }
    if (current.kind === 'delete') {
      continue;
    }
    if (rawLine === '') {
      if (currentHunk) currentHunk = v4aPushBlankContextLine(currentHunk, pendingAnchors);
      continue;
    }
    if (isV4AEndOfFileMarker(rawLine)) {
      v4aMarkHunkEndOfFile(currentHunk, finishHunk);
      currentHunk = null;
      continue;
    }
    if (rawLine.startsWith('@@')) {
      const anchor = normaliseV4AAnchor(rawLine.slice(2));
      if (currentHunk && currentHunk.lines.length > 0) finishHunk();
      pendingAnchors.push(anchor);
      currentHunk = { anchors: pendingAnchors.slice(), lines: [] };
      pendingAnchors = [];
      continue;
    }
    const tag = rawLine[0];
    if (tag !== ' ' && tag !== '-' && tag !== '+') {
      if (!currentHunk) currentHunk = v4aEnsureUpdateHunk(current, pendingAnchors);
      pendingAnchors = [];
      currentHunk.lines.push(` ${rawLine}`);
      continue;
    }
    if (!currentHunk) currentHunk = v4aEnsureUpdateHunk(current, pendingAnchors);
    currentHunk.lines.push(rawLine);
  }
  finishFile();
  const bad = files.find((file) => !file.path);
  if (bad) throw new Error('V4A patch contains an empty file path');
  if (files.length === 0) throw new Error('V4A patch contained no file sections');
  return files;
}

function stripUnifiedV4APathHeader(line, prefix) {
  return stripDiffPrefix(normaliseV4APath(String(line || '').slice(prefix.length)));
}

// Shared parser for unified-input -> V4A sections. The bare and counted
// fallbacks are byte-identical except for (a) the error label and (b) how an
// `@@` line yields its anchor: bare rejects counted headers and takes the raw
// tail; counted requires a counted header and takes its capture group. The
// difference is injected as `resolveAnchor`; everything else is shared.
function parseUnifiedAsV4APatch(patchStr, { label, resolveAnchor }) {
  const lines = splitPatchLines(patchStr);
  const files = [];
  let current = null;
  let pendingAnchors = [];
  let currentHunk = null;

  const finishHunk = () => {
    if (!current || !currentHunk) return;
    if (current.kind === 'update' && currentHunk.lines.length > 0) current.hunks.push(currentHunk);
    currentHunk = null;
  };
  const finishFile = () => {
    finishHunk();
    current = null;
    pendingAnchors = [];
  };
  const startFile = (oldPath, newPath) => {
    finishFile();
    const oldIsNull = DEV_NULL.test(oldPath || '');
    const newIsNull = DEV_NULL.test(newPath || '');
    const kind = oldIsNull ? 'add' : (newIsNull ? 'delete' : 'update');
    const path = kind === 'add' ? newPath : oldPath;
    current = { kind, path: normaliseV4APath(path), hunks: [], lines: [] };
    files.push(current);
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (rawLine.startsWith('diff --git ') || rawLine.startsWith('index ') || rawLine.startsWith('new file mode ') || rawLine.startsWith('deleted file mode ')) {
      continue;
    }
    if (rawLine.startsWith('--- ')) {
      const next = lines[i + 1] || '';
      if (next.startsWith('+++ ')) {
        startFile(stripUnifiedV4APathHeader(rawLine, '--- '), stripUnifiedV4APathHeader(next, '+++ '));
        i++;
        continue;
      }
      // A real unified file header `--- X` is ALWAYS immediately followed by a
      // `+++ Y` line. Without the pair, outside a file this is a malformed
      // patch (keep the diagnostic); INSIDE a file it is a hunk-body deletion
      // line whose content starts with `-- ` (rawLine `--- foo`) — fall through
      // to body handling instead of misreading it as a file header.
      if (!current) throw new Error(`${label} missing +++ header after: ${rawLine}`);
    }
    if (!current) continue;
    if (rawLine === '') {
      if (current.kind !== 'update') continue;
      if (currentHunk) currentHunk = v4aPushBlankContextLine(currentHunk, pendingAnchors);
      continue;
    }
    if (current.kind === 'update' && isV4AEndOfFileMarker(rawLine)) {
      v4aMarkHunkEndOfFile(currentHunk, finishHunk);
      currentHunk = null;
      continue;
    }
    if (rawLine.startsWith('@@')) {
      const anchor = resolveAnchor(rawLine);
      if (currentHunk && currentHunk.lines.length > 0) finishHunk();
      pendingAnchors.push(anchor);
      currentHunk = { anchors: pendingAnchors.slice(), lines: [] };
      pendingAnchors = [];
      continue;
    }
    if (current.kind === 'add') {
      if (rawLine[0] === '+') current.lines.push(rawLine.slice(1));
      continue;
    }
    if (current.kind === 'delete') {
      continue;
    }
    const tag = rawLine[0];
    if (tag !== ' ' && tag !== '-' && tag !== '+') {
      if (!currentHunk) currentHunk = v4aEnsureUpdateHunk(current, pendingAnchors);
      pendingAnchors = [];
      currentHunk.lines.push(` ${rawLine}`);
      continue;
    }
    if (!currentHunk) currentHunk = v4aEnsureUpdateHunk(current, pendingAnchors);
    currentHunk.lines.push(rawLine);
  }
  finishFile();
  const bad = files.find((file) => !file.path);
  if (bad) throw new Error(`${label} contains an empty file path`);
  if (files.length === 0) throw new Error(`${label} contained no file sections`);
  return files;
}

export function parseUnifiedBareV4APatch(patchStr) {
  return parseUnifiedAsV4APatch(patchStr, {
    label: 'unified bare patch',
    resolveAnchor: (rawLine) => {
      if (UNIFIED_HUNK_HEADER_RE.test(rawLine)) {
        throw new Error('unified bare patch cannot mix counted unified hunks with bare @@ anchors');
      }
      return normaliseV4AAnchor(rawLine.slice(2));
    },
  });
}

export function parseUnifiedCountedAsV4APatch(patchStr) {
  return parseUnifiedAsV4APatch(patchStr, {
    label: 'unified fallback',
    resolveAnchor: (rawLine) => {
      const match = UNIFIED_HUNK_HEADER_CAPTURE_RE.exec(rawLine);
      if (!match) throw new Error(`unified fallback requires counted hunk header: ${rawLine}`);
      return normaliseV4AAnchor(match[1] || '');
    },
  });
}
