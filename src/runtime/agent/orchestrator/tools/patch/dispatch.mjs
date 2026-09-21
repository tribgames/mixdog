// apply_patch dispatch: the native engine (proofs, snapshots and report in
// dispatch/*.mjs), the JS engine fallback, and failure-context formatting.

import { readFileSync, lstatSync, statSync, realpathSync, mkdirSync } from 'node:fs';
import { capturePreMutationStats, nativeEncodingError, predictBodyProofs } from './dispatch/native-proofs.mjs';
import { invalidateNativeCaches, recordNativeSnapshots, writtenNativeEntries } from './dispatch/native-snapshots.mjs';
import { formatNativeSummary, traceNativeApply } from './dispatch/native-report.mjs';
import { unlink } from 'node:fs/promises';
import { dirname as pathDirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  normalizeOutputPath,
  invalidateBuiltinResultCache,
  recordReadSnapshotForPath,
  clearReadSnapshotForPath,
} from '../builtin.mjs';
import { atomicWrite } from '../builtin/atomic-write.mjs';
import { isSpecialFileStat } from '../builtin/device-paths.mjs';
import { hashText } from '../builtin/hash-utils.mjs';
import { markCodeGraphDirtyPaths } from '../code-graph-state.mjs';
import {
  classifyEntry,
  stripDiffPrefix,
  resolveEntryPath,
  parsedEntryResolvedPath,
  countHunkChanges,
  pathKey,
} from './paths.mjs';
import { NATIVE_PATCH_TRANSPORT_DEAD, runServerApply, scheduleNativePatchIdleClose } from './native-server.mjs';
import {
  extractNativeFailurePath,
  nativeFailureMatchesEntry,
  findFirstFailingUnifiedHunk,
  findUnifiedHunkMatch,
  collectUnifiedNewLines,
  collectUnifiedOpEntries,
  terminatorsForUnifiedOps,
  localTerminatorForWindow,
  assertSafeReplacementPlan,
  firstFailingUnifiedHunkLineDetail,
  firstMeaningfulUnifiedHunkLine,
  firstMeaningfulUnifiedEntryLine,
  compactPatchPreviewLine,
  formatPatchSourceExcerpt,
  nearestPatchLineHint,
  normalizeTypographic,
  splitBufferLinesForPatch,
  splitTextLinesForPatch,
  cloneTextLinesForPatch,
  spliceTextLinesForPatch,
  joinTextLinesForPatch,
  setFinalNewlineForPatch,
  detectDominantEol,
  decodePatchTargetBuffer,
  encodePatchTargetContent,
} from './matcher.mjs';

function formatNativeFailureContext(parsed, basePath, failedPath = '', options = {}) {
  const entries = Array.isArray(parsed) ? parsed : [];
  const entry =
    entries.find(
      (candidate) => classifyEntry(candidate) !== 'create' && nativeFailureMatchesEntry(candidate, failedPath)
    ) || entries.find((candidate) => classifyEntry(candidate) !== 'create');
  const headerName = entry?.oldFileName;
  const displayPath = headerName ? normalizeOutputPath(stripDiffPrefix(headerName)) : '';
  const fuzz = Number.isFinite(options?.fuzz) && options.fuzz > 0 ? Math.floor(options.fuzz) : 0;
  let sourceLines = null;
  let sourceByteLines = null;
  try {
    const fullPath = resolveEntryPath(basePath, entry.oldFileName);
    const raw = readFileSync(fullPath); // Buffer — no 'utf8' decode
    sourceByteLines = splitBufferLinesForPatch(raw);
    sourceLines = splitTextLinesForPatch(raw.toString('utf8'));
  } catch {}
  const failingHunk = sourceByteLines ? findFirstFailingUnifiedHunk(entry, sourceByteLines, fuzz) : null;
  const failingDetail =
    failingHunk && sourceByteLines ? firstFailingUnifiedHunkLineDetail(sourceByteLines, failingHunk) : null;
  const expected =
    failingDetail || firstMeaningfulUnifiedHunkLine(failingHunk) || firstMeaningfulUnifiedEntryLine(entry);
  if (!entry || !expected?.line) return '';
  const expectedText = JSON.stringify(compactPatchPreviewLine(expected.line));
  let nearest = '';
  let normalizeHint = '';
  if (sourceLines) {
    nearest = nearestPatchLineHint(sourceLines, expected.line, expected.preferredLine);
    const wantNorm = normalizeTypographic(expected.line);
    if (wantNorm) {
      for (let i = 0; i < sourceLines.length; i++) {
        if (sourceLines[i] === expected.line) break; // exact match exists; not a normalization issue
        if (sourceLines[i].trim() !== expected.line.trim() && normalizeTypographic(sourceLines[i]) === wantNorm) {
          normalizeHint = `context matches after Unicode normalization at line ${i + 1} — source may contain typographic dashes/quotes/NBSP`;
          break;
        }
      }
    }
  }
  return ` expected first old/context line${displayPath ? ` in ${displayPath}` : ''}: ${expectedText}${nearest ? `; ${nearest}` : ''}${normalizeHint ? `; ${normalizeHint}` : ''}; use exact current lines, no stubs.`;
}

// Dispatch the (already validated, header-rewritten) patch to the native
// engine. Throws on any native error; on success returns the formatted
// human-readable response string. Never silently falls back to JS — the
// caller MUST surface throws as `Error: ...` strings.
export async function dispatchNativePatch({
  entries,
  basePath,
  nativePatchStr,
  fuzz,
  rejectPartial,
  dryRun,
  readStateScope,
  signal,
  parsed,
}) {
  const nativeStart = performance.now();
  const encodingError = nativeEncodingError(entries);
  if (encodingError) return `Error: ${encodingError}`;
  const preMutationStats = dryRun ? new Map() : capturePreMutationStats(entries);
  // The JS engine predicts the post-apply hash for the body-knowledge proof.
  const predictAppliedHash = (entry, text) => {
    const parsedEntry = findParsedForRow(entry, parsed, basePath);
    if (!parsedEntry) return null;
    const updated = applyUnifiedHunksToLines(splitTextLinesForPatch(text), parsedEntry.hunks || [], {
      fuzz: Number.isFinite(fuzz) ? fuzz : 0,
      displayPath: entry.displayPath,
      eol: detectDominantEol(text),
    });
    return hashText(joinTextLinesForPatch(updated));
  };
  const bodyProofs = dryRun ? new Map() : predictBodyProofs(entries, readStateScope, predictAppliedHash);
  const failureContext = (failedPath) => formatNativeFailureContext(parsed, basePath, failedPath, { fuzz });
  let stats;
  try {
    stats = await runServerApply(basePath, nativePatchStr, { fuzz, rejectPartial, dryRun, signal });
  } catch (err) {
    scheduleNativePatchIdleClose();
    // A create-only patch is idempotent as a full-content declaration. If two
    // native server attempts die during transport (for example under host
    // pressure), the JS engine can safely finish the same requested bytes:
    // absent targets are created and a target written by the uncertain first
    // attempt is replaced with identical desired content. Updates/deletes stay
    // fail-closed because replay after an uncertain write is not idempotent.
    if (
      err?.code === NATIVE_PATCH_TRANSPORT_DEAD &&
      entries.length > 0 &&
      entries.every((entry) => entry.kind === 'create')
    ) {
      const recovered = await dispatchJsPatchEntries({
        rows: entries,
        parsed,
        basePath,
        dryRun,
        fuzzy: fuzz > 0,
        readStateScope,
      });
      if (!/^Error:/i.test(String(recovered || '').trimStart())) {
        return `${recovered}\n[native transport unavailable; create-only patch completed with the JS engine]`;
      }
    }
    const msg = err?.message || String(err);
    return `Error: native patch failed — ${msg}${failureContext(extractNativeFailurePath(msg, parsed))}`;
  }
  const writtenEntries = writtenNativeEntries(entries, stats);
  const timings = { invalidateMs: 0, dirtyMs: 0, snapshotMs: 0, totalJsMs: 0 };
  if (!dryRun) {
    Object.assign(timings, invalidateNativeCaches(writtenEntries.map((entry) => entry.fullPath)));
    const snapshotStart = performance.now();
    recordNativeSnapshots(writtenEntries, stats, { readStateScope, preMutationStats, bodyProofs });
    timings.snapshotMs = performance.now() - snapshotStart;
  }
  timings.totalJsMs = performance.now() - nativeStart;
  traceNativeApply({ writtenEntries, stats, dryRun, timings });
  scheduleNativePatchIdleClose();
  return formatNativeSummary({ writtenEntries, stats, dryRun, failureContext });
}

// Which side of the hunk, if any, carries an explicit
// `\ No newline at end of file` marker. Both transitions must be honoured:
// a marker on the NEW side drops the terminator, a marker on the OLD side
// only (patch re-adds it) restores one.
function unifiedHunkEofIntent(hunk) {
  let lastSide = null;
  let oldNoNewline = false;
  let newNoNewline = false;
  for (const raw of hunk?.lines || []) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const tag = raw[0];
    if (tag === '\\') {
      if (lastSide === 'context') {
        oldNoNewline = true;
        newNoNewline = true;
      } else if (lastSide === 'old') oldNoNewline = true;
      else if (lastSide === 'new') newNoNewline = true;
      continue;
    }
    if (tag === ' ') lastSide = 'context';
    else if (tag === '-') lastSide = 'old';
    else if (tag === '+') lastSide = 'new';
    else lastSide = null;
  }
  return { oldNoNewline, newNoNewline };
}

// Same recovery shape the native failure path emits: expected line, nearest
// candidate, and a bounded verbatim excerpt of the current file.
function unifiedHunkMissMessage(displayPath, hunk, sourceLines) {
  const detail = firstFailingUnifiedHunkLineDetail(sourceLines, hunk) || firstMeaningfulUnifiedHunkLine(hunk);
  const expected = detail?.line || '';
  const preferred = Number.isFinite(detail?.preferredLine) ? detail.preferredLine : 0;
  const nearest = expected ? nearestPatchLineHint(sourceLines, expected, preferred) : '';
  const excerpt = formatPatchSourceExcerpt(sourceLines, preferred, (hunk?.lines || []).length);
  return (
    `apply_patch: hunk context not found in ${displayPath}` +
    (expected ? `; expected first old/context line: ${JSON.stringify(compactPatchPreviewLine(expected))}` : '') +
    (nearest ? `; ${nearest}` : '') +
    '; use exact current lines, no stubs.' +
    excerpt
  );
}

// Apply already-parsed UNIFIED hunks with their declared coordinates: each
// hunk is first tried at its own `@@` position and only then fuzz-matched
// forward, mirroring the native engine. Insert-only hunks (`-N,0`) land at
// their declared index (end-of-file for a converted V4A addition) and never
// advance the cursor, so a later hunk can still resolve before them. The plan
// is validated for overlaps/equal starts BEFORE any mutation, then applied in
// descending order so earlier positions stay valid.
function applyUnifiedHunksToLines(sourceLines, hunks, { fuzz, displayPath, eol }) {
  const lines = cloneTextLinesForPatch(sourceLines, eol);
  const replacements = [];
  let minStartIdx = 0;
  for (const hunk of hunks || []) {
    const match = findUnifiedHunkMatch(lines, hunk, minStartIdx, fuzz);
    if (!match) throw new Error(unifiedHunkMissMessage(displayPath, hunk, lines));
    const { newLines } = collectUnifiedNewLines(hunk);
    const intent = unifiedHunkEofIntent(hunk);
    replacements.push({
      start: match.start,
      oldLen: match.end - match.start,
      newLines,
      // Op sequence of THIS hunk: the only sound source for terminator
      // inheritance (context keeps its own, an add takes the delete it
      // replaces). Content alignment cannot express interior context or moves.
      ops: collectUnifiedOpEntries(hunk),
      intent,
      atEof: match.end >= lines.length,
    });
    minStartIdx = Math.max(minStartIdx, match.end);
  }
  replacements.sort((a, b) => a.start - b.start);
  assertSafeReplacementPlan(replacements, `apply_patch: ${displayPath}`);
  for (let i = replacements.length - 1; i >= 0; i--) {
    const rep = replacements[i];
    const oldTerms = Array.isArray(lines.terminators) ? lines.terminators.slice(rep.start, rep.start + rep.oldLen) : [];
    const newTerms = terminatorsForUnifiedOps(
      rep.ops,
      oldTerms,
      localTerminatorForWindow(lines, rep.start, rep.oldLen)
    );
    spliceTextLinesForPatch(lines, rep.start, rep.oldLen, rep.newLines, newTerms);
    // Explicit markers win in BOTH directions; a hunk that is silent about the
    // terminator leaves the file's existing state untouched (native parity).
    if (!rep.atEof) continue;
    if (rep.intent.newNoNewline) setFinalNewlineForPatch(lines, false);
    else if (rep.intent.oldNoNewline) setFinalNewlineForPatch(lines, true);
  }
  return lines;
}

function lstatRegularPatchFile(fullPath, displayPath) {
  const st = lstatSync(fullPath);
  if (isSpecialFileStat(st)) {
    throw new Error(
      `apply_patch: cannot patch special file (FIFO / character / block device / socket): ${normalizeOutputPath(displayPath)}`
    );
  }
  return st;
}

// A symlinked target is patched THROUGH the link. atomicWrite compares the
// live target with statSync, which FOLLOWS a leaf symlink, so the expected
// snapshot must be taken the same way: an lstat describes the LINK inode
// (size = target path length, its own mtime/ino) and can never equal the
// followed stat, which failed every patch aimed at a symlinked file with
// "changed on disk during the patch". Writing to the resolved real path also
// keeps the link intact — the atomic rename would otherwise replace the
// symlink itself with a regular file.
function resolvePatchWriteTarget(fullPath, displayPath, lst) {
  if (!lst?.isSymbolicLink?.()) return { writePath: fullPath, snapshotStat: lst };
  let writePath;
  let snapshotStat;
  try {
    writePath = realpathSync(fullPath);
    snapshotStat = statSync(fullPath);
  } catch (err) {
    throw new Error(
      `apply_patch: symlink target missing or unreadable: ${normalizeOutputPath(displayPath)}` +
        ` (${err?.code || err?.message || String(err)})`
    );
  }
  if (isSpecialFileStat(snapshotStat)) {
    throw new Error(
      `apply_patch: cannot patch special file (FIFO / character / block device / socket): ${normalizeOutputPath(displayPath)}`
    );
  }
  if (!snapshotStat.isFile()) {
    throw new Error(`apply_patch: symlink target is not a regular file: ${normalizeOutputPath(displayPath)}`);
  }
  return { writePath, snapshotStat };
}

function assertAddTargetAbsent(fullPath, displayPath) {
  try {
    lstatSync(fullPath);
    throw new Error(
      `apply_patch: Add File target already exists: ${normalizeOutputPath(displayPath)}; read it and use Update File instead`
    );
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    if (/^apply_patch:/.test(err?.message || '')) throw err;
    throw new Error(
      `apply_patch: create target unreadable: ${normalizeOutputPath(displayPath)} (${err?.code || err?.message || String(err)})`
    );
  }
}

function findParsedForRow(row, parsed, basePath) {
  const key = pathKey(row.fullPath);
  for (const entry of parsed || []) {
    if (pathKey(parsedEntryResolvedPath(entry, basePath)) === key) return entry;
  }
  return null;
}

async function applyJsParsedEntry(entry, basePath, { dryRun, fuzzy, readStateScope }) {
  const kind = classifyEntry(entry);
  const headerName = kind === 'create' ? entry.newFileName : entry.oldFileName;
  const fullPath = resolveEntryPath(basePath, headerName);
  const displayPath = normalizeOutputPath(stripDiffPrefix(headerName));
  if (kind === 'create') {
    // Add File is create-only. atomicWrite checks the absent-target
    // expectation again so a file appearing after preflight is not replaced.
    assertAddTargetAbsent(fullPath, displayPath);
    const addedLines = [];
    for (const hunk of entry.hunks || []) {
      for (const line of hunk.lines || []) {
        if (line.startsWith('+')) addedLines.push(line.slice(1));
      }
    }
    const content = joinTextLinesForPatch(addedLines);
    if (!dryRun) {
      mkdirSync(pathDirname(fullPath), { recursive: true });
      try {
        await atomicWrite(fullPath, content, {
          sessionId: readStateScope,
          expectedTargetSnapshot: { exists: false },
        });
      } catch (err) {
        if (err?.code === 'ESTALE_TARGET') {
          throw new Error(
            `apply_patch: Add File target appeared during creation: ${normalizeOutputPath(displayPath)}; read it and use Update File instead`
          );
        }
        throw err;
      }
      invalidateBuiltinResultCache([fullPath]);
      markCodeGraphDirtyPaths([fullPath]);
      recordReadSnapshotForPath(fullPath, readStateScope, { source: 'apply_patch_js', isPartialView: false });
    }
    const { added, removed } = countHunkChanges(entry.hunks);
    return { kind, fullPath, displayPath, added, removed };
  }

  if (kind === 'delete') {
    lstatRegularPatchFile(fullPath, displayPath);
    if (!dryRun) {
      await unlink(fullPath);
      invalidateBuiltinResultCache([fullPath]);
      markCodeGraphDirtyPaths([fullPath]);
      clearReadSnapshotForPath(fullPath, readStateScope);
    }
    const { added, removed } = countHunkChanges(entry.hunks);
    return { kind, fullPath, displayPath, added, removed };
  }

  const preMutationStat = lstatRegularPatchFile(fullPath, displayPath);
  const { writePath, snapshotStat } = resolvePatchWriteTarget(fullPath, displayPath, preMutationStat);
  // Rewrite path: decode by BOM, re-encode into the same codec, and keep every
  // untouched line's own terminator (spliceTextLinesForPatch).
  // `toString('utf8')` here transcoded non-UTF-8 files and mangled UTF-16.
  const { text: rawText, enc: rawEnc } = decodePatchTargetBuffer(readFileSync(fullPath), displayPath);
  const sourceLines = splitTextLinesForPatch(rawText);
  const updatedLines = applyUnifiedHunksToLines(sourceLines, entry.hunks || [], {
    fuzz: fuzzy ? 2 : 0,
    displayPath,
    eol: detectDominantEol(rawText),
  });
  const content = encodePatchTargetContent(joinTextLinesForPatch(updatedLines), rawEnc);
  if (!dryRun) {
    // The expected-target snapshot closes the read→write window: if anything
    // rewrote this file after we read it, the write fails instead of silently
    // clobbering it (and instead of inheriting a stale "body delivered" claim).
    try {
      await atomicWrite(writePath, content, {
        sessionId: readStateScope,
        expectedTargetSnapshot: snapshotStat
          ? {
              exists: true,
              size: snapshotStat.size,
              mtimeMs: snapshotStat.mtimeMs,
              ctimeMs: snapshotStat.ctimeMs,
              ino: snapshotStat.ino,
            }
          : undefined,
      });
    } catch (err) {
      if (err?.code === 'ESTALE_TARGET') {
        throw new Error(
          `apply_patch: ${normalizeOutputPath(displayPath)} changed on disk during the patch; re-read it and retry`
        );
      }
      throw err;
    }
    const touchedPaths = writePath === fullPath ? [fullPath] : [fullPath, writePath];
    invalidateBuiltinResultCache(touchedPaths);
    markCodeGraphDirtyPaths(touchedPaths);
    recordReadSnapshotForPath(fullPath, readStateScope, {
      source: 'apply_patch_js',
      isPartialView: false,
      preMutationStat: snapshotStat,
    });
  }
  const { added, removed } = countHunkChanges(entry.hunks);
  return { kind, fullPath, displayPath, added, removed };
}

export async function dispatchJsPatchEntries({ rows, parsed, basePath, dryRun, fuzzy, readStateScope }) {
  const applied = [];
  for (const row of rows || []) {
    const entry = findParsedForRow(row, parsed, basePath);
    if (!entry) throw new Error(`apply_patch: missing parsed entry for ${row.displayPath}`);
    try {
      applied.push(await applyJsParsedEntry(entry, basePath, { dryRun, fuzzy, readStateScope }));
    } catch (err) {
      return `Error: ${err?.message || String(err)}`;
    }
  }
  const verbLabel = dryRun ? 'Checked' : 'Applied';
  const countLabel = (count, singular, plural = `${singular}s`) => `${count} ${count === 1 ? singular : plural}`;
  const kindLabel = (kind) => {
    const text = String(kind || '').trim();
    return text ? `${text.charAt(0).toUpperCase()}${text.slice(1).toLowerCase()}` : 'Update';
  };
  const lines = [`${verbLabel} ${countLabel(applied.length, 'File')} (JS)${dryRun ? ' Dry Run' : ''}`];
  for (const entry of applied) {
    const added = entry.added || 0;
    const removed = entry.removed || 0;
    const parts = [];
    if (added > 0) parts.push(`+${countLabel(added, 'Line')}`);
    if (removed > 0) parts.push(`-${countLabel(removed, 'Line')}`);
    const detail = parts.join(' · ');
    lines.push(
      detail
        ? `  OK ${kindLabel(entry.kind)} ${entry.displayPath} — ${detail}`
        : `  OK ${kindLabel(entry.kind)} ${entry.displayPath}`
    );
  }
  return lines.join('\n');
}
