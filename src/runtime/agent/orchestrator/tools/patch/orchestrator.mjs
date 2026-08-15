// apply_patch top-level orchestration: UI-diff side-channel, input salvage,
// mutation-route planning, V4A conversion wiring, native dispatch, and the
// executePatchTool entry point + replay capture. Moved verbatim from
// patch.mjs; control flow and output are unchanged.

import { chmodSync, existsSync, statSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname as pathDirname, resolve as pathResolve, relative as pathRelative, isAbsolute, join as pathJoin } from 'node:path';
import { parsePatch } from 'diff';
import { getAbortSignalForSession } from '../../session/abort-lookup.mjs';
import {
  clearReadSnapshotForPath,
  invalidateBuiltinResultCache,
  normalizeOutputPath,
  withBuiltinPathLocks,
} from '../builtin.mjs';
import { withAdvisoryLocks } from '../builtin/advisory-lock.mjs';
import { getPluginData } from '../../config.mjs';
import { markCodeGraphDirtyPaths } from '../code-graph-state.mjs';
import { recordTurnDiffChanges } from '../../../../shared/turn-snapshot.mjs';
import { prepareInput, isV4APatchInput, hasUnifiedBareV4AHunk, canFallbackCountedUnified, parseV4APatch, parseUnifiedBareV4APatch, parseUnifiedCountedAsV4APatch, isCompactedPlaceholderPatch, salvageV4AOpening } from './parsing.mjs';
import {
  resolveBasePath,
  resolveEntryPath,
  resolveV4AEntryPath,
  parsedEntryResolvedPath,
  isResolvedPathOutsideBase,
  splitParsedModifyWaves,
  renderParsedUnifiedPatch,
  rewriteHeaderPaths,
  preValidateNativeBatch,
  classifyEntry,
  stripDiffPrefix,
} from './paths.mjs';
import { ensureNativePatchBinaryAvailable } from './native-server.mjs';
import { assertPathReachable } from '../builtin/fs-reachability.mjs';
import { findBySuffixStrip, findFileByBasename } from '../builtin/path-diagnostics.mjs';
import { resolveReadPathRedirect } from '../builtin/snapshot-store.mjs';
import { dispatchNativePatch, dispatchJsPatchEntries } from './dispatch.mjs';
import {
  planV4ARenameSections,
  applyV4ARenameSections,
  formatV4ARenameSuccessLines,
  convertV4ASectionsToUnifiedPatch,
  isV4ARenameSection,
  drainV4AAmbiguityNotices,
} from './v4a-convert.mjs';

function isPatchErrorText(text) {
  return /^Error:/i.test(String(text ?? '').trimStart());
}

// convertV4ASectionsToUnifiedPatch may emit nothing when every hunk is a
// unique-new-side no-op. `diff.parsePatch` turns a blank body into a junk
// entry with no path; treat that as "no applicable hunks".
function parseConvertedUnifiedPatch(unified) {
  const text = prepareInput(unified);
  if (!String(text).trim()) return [];
  return (parsePatch(text) || []).filter((entry) => entry?.oldFileName || entry?.newFileName);
}

function patchPathKey(fullPath) {
  const value = String(fullPath || '');
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function uniqueExistingPatchTarget(basePath, requestedFullPath) {
  // Auto-relocation is only valid for a missing target lexically inside the
  // patch root. An explicit outside-root path must never be pulled back into
  // the project merely because a basename happens to match.
  const rel = pathRelative(pathResolve(basePath), pathResolve(requestedFullPath));
  if (isAbsolute(rel) || rel.split(/[\\/]+/).some((part) => part === '..')) return null;
  const asFile = (candidate) => {
    if (!candidate) return null;
    const fullPath = isAbsolute(candidate) ? pathResolve(candidate) : pathResolve(basePath, candidate);
    try { return statSync(fullPath).isFile() ? fullPath : null; } catch { return null; }
  };
  const suffix = asFile(findBySuffixStrip(basePath, requestedFullPath));
  if (suffix) return suffix;
  const basenameHits = findFileByBasename(basePath, requestedFullPath, { limit: 2 });
  return basenameHits.length === 1 ? asFile(basenameHits[0]) : null;
}

function redirectedPatchPath(requestedFullPath, readStateScope, basePath) {
  // A newly-created exact requested path always wins over an older redirect.
  if (!requestedFullPath || existsSync(requestedFullPath)) return requestedFullPath;
  const redirected = resolveReadPathRedirect(requestedFullPath, readStateScope);
  if (redirected && existsSync(redirected)) return redirected;
  return uniqueExistingPatchTarget(basePath, requestedFullPath) || requestedFullPath;
}

function patchHeaderPathForResolved(basePath, fullPath) {
  const rel = pathRelative(pathResolve(basePath), pathResolve(fullPath));
  if (rel && !isAbsolute(rel) && !rel.split(/[\\/]+/).some((part) => part === '..')) {
    return rel.replace(/\\/g, '/');
  }
  return fullPath;
}

function rewriteV4AReadRedirects(sections, basePath, readStateScope) {
  return (sections || []).map((section) => {
    if (!section || section.kind === 'add' || !section.path) return section;
    const requested = resolveV4AEntryPath(basePath, section.path);
    const redirected = redirectedPatchPath(requested, readStateScope, basePath);
    if (patchPathKey(redirected) === patchPathKey(requested)) return section;
    return { ...section, path: patchHeaderPathForResolved(basePath, redirected) };
  });
}

function rewriteParsedReadRedirects(parsed, basePath, readStateScope) {
  return (parsed || []).map((entry) => {
    const kind = classifyEntry(entry);
    if (kind === 'create' || !entry?.oldFileName) return entry;
    const requested = resolveEntryPath(basePath, entry.oldFileName);
    const redirected = redirectedPatchPath(requested, readStateScope, basePath);
    if (patchPathKey(redirected) === patchPathKey(requested)) return entry;
    const rewritten = {
      ...entry,
      oldFileName: patchHeaderPathForResolved(basePath, redirected),
    };
    if (kind === 'modify' && entry.newFileName) {
      const newRequested = resolveEntryPath(basePath, entry.newFileName);
      if (patchPathKey(newRequested) === patchPathKey(requested)) {
        rewritten.newFileName = rewritten.oldFileName;
      }
    }
    return rewritten;
  });
}

// Pre-patch snapshot of every path this operation may touch: the bytes and
// mode of each existing target, or an "absent" marker. Restoring them undoes
// the whole batch. Hostile concurrent replacement of a path between capture
// and restore is out of scope.
function capturePatchRollbackState(paths) {
  return paths.map((fullPath) => {
    let stat;
    try {
      stat = statSync(fullPath);
    } catch (err) {
      if (err?.code === 'ENOENT') return { fullPath, existed: false, content: null, mode: null };
      throw new Error(`apply_patch: rollback snapshot target unreadable: ${normalizeOutputPath(fullPath)} (${err?.code || err?.message || String(err)})`);
    }
    if (!stat.isFile()) throw new Error(`apply_patch: rollback snapshot target is not a regular file: ${normalizeOutputPath(fullPath)}`);
    return { fullPath, existed: true, content: readFileSync(fullPath), mode: stat.mode };
  });
}

function restorePatchRollbackState(snapshots, readStateScope) {
  const errors = [];
  const paths = [];
  for (const snapshot of snapshots) {
    const display = normalizeOutputPath(snapshot.fullPath);
    try {
      if (snapshot.existed) {
        mkdirSync(pathDirname(snapshot.fullPath), { recursive: true });
        writeFileSync(snapshot.fullPath, snapshot.content);
        if (snapshot.mode != null) chmodSync(snapshot.fullPath, snapshot.mode);
      } else if (existsSync(snapshot.fullPath)) {
        rmSync(snapshot.fullPath, { force: true });
      } else {
        continue; // nothing written, nothing to undo
      }
      paths.push(snapshot.fullPath);
    } catch (err) {
      errors.push(`${display} — ${err?.message || String(err)}`);
    }
  }
  invalidateBuiltinResultCache(paths);
  markCodeGraphDirtyPaths(paths);
  for (const fullPath of paths) clearReadSnapshotForPath(fullPath, readStateScope);
  return errors;
}

// Apply one "wave" (a set of unique-target parsed entries) via the native
// (+ JS out-of-base) split. Returns { executor, text } on success or
// { executor, error } so the caller decides whether earlier waves already
// committed to disk. Extracted verbatim from the inline applyWave closure so
// both the default wave loop and sequence mode share identical apply
// semantics.
async function applyParsedWave({ parsed: wparsed, entries: wentries, headerRewrites: whr }, basePath, opts) {
  const { fuzz, rejectPartial, dryRun, fuzzy, readStateScope, abortSignal } = opts;
  const insideEntries = wentries.filter((entry) => !isResolvedPathOutsideBase(entry.fullPath, basePath));
  const outsideEntries = wentries.filter((entry) => isResolvedPathOutsideBase(entry.fullPath, basePath));
  const parsedInside = (wparsed || []).filter(
    (entry) => !isResolvedPathOutsideBase(parsedEntryResolvedPath(entry, basePath), basePath),
  );
  const executor = outsideEntries.length > 0
    ? (insideEntries.length > 0 ? 'native+js-patch' : 'js-patch')
    : 'native-patch';
  const resultParts = [];
  if (insideEntries.length > 0) {
    const nativePatchStr = rewriteHeaderPaths(renderParsedUnifiedPatch(parsedInside), whr);
    const nativeResult = await dispatchNativePatch({
      entries: insideEntries,
      basePath,
      nativePatchStr,
      fuzz,
      rejectPartial,
      dryRun,
      readStateScope,
      signal: abortSignal,
      parsed: parsedInside,
    });
    if (isPatchErrorText(nativeResult)) return { executor, error: nativeResult };
    resultParts.push(nativeResult);
  }
  if (outsideEntries.length > 0) {
    // Out-of-base targets are applied via the JS dispatcher (no base-path
    // confinement); write permission is enforced at the hook layer.
    const jsResult = await dispatchJsPatchEntries({
      rows: outsideEntries,
      parsed: wparsed,
      basePath,
      dryRun,
      fuzzy,
      readStateScope,
    });
    if (isPatchErrorText(jsResult)) return { executor, error: jsResult };
    resultParts.push(jsResult);
  }
  return { executor, text: resultParts.join('\n') };
}

// Default ordered section mode. Apply each file section in listed order,
// converting every V4A section against the CURRENT on-disk state (i.e. after
// all earlier sections have committed), and stop at the first section that
// fails. Reports applied / failed / skipped reflecting true disk state.
async function applyPatchSequence(patchStr, requestedFormat, basePath, ctx) {
  const {
    v4aConvertOpts, dryRun, fuzz, fuzzy, rejectPartial,
    readStateScope, abortSignal, mutationPlan,
    toolCallId, sessionId,
  } = ctx;

  // Build the ordered section "units". Each unit resolves its own parsed
  // unified entry lazily via buildParsed(), so a V4A section is converted
  // only when it is its turn — against disk mutated by the earlier sections.
  const units = [];
  // Build a per-section unit from a V4A-style section. Conversion is deferred
  // into buildParsed() so each section is resolved against the disk state the
  // earlier sections left behind — a later section that fails to convert/apply
  // never blocks the earlier ones from committing (ordered-stop). This is
  // shared by the V4A path AND the bare-@@/counted-unified fallbacks, so those
  // salvageable formats keep ordered-stop instead of aborting whole-patch.
  const pushSectionUnit = (section) => {
    const displayPath = normalizeOutputPath(section.path);
    const fullPath = resolveV4AEntryPath(basePath, section.path);
    // A V4A rename cannot be sequenced, but ordered-stop requires we still
    // apply every section BEFORE it and surface the rename as the failed
    // section — never abort before earlier sections commit. Defer the
    // rejection into buildParsed() so the loop marks it failed and keeps
    // earlier commits.
    if (isV4ARenameSection(section)) {
      units.push({
        displayPath,
        fullPath,
        buildParsed: async () => {
          throw new Error('sequence mode does not support V4A rename (*** Move to:) sections; apply the rename in a separate non-sequence patch');
        },
      });
      return;
    }
    units.push({
      displayPath,
      fullPath,
      // Honor reject_partial via v4aConvertOpts: a bad hunk throws under
      // reject_partial=true (section fails → sequence stops) but is recorded in
      // rejectedHunks and skipped under reject_partial=false.
      buildParsed: async () => {
        const unified = await convertV4ASectionsToUnifiedPatch([section], basePath, v4aConvertOpts);
        return parseConvertedUnifiedPatch(unified);
      },
    });
  };
  if (isV4APatchInput(patchStr, requestedFormat)) {
    let allSections;
    try {
      allSections = rewriteV4AReadRedirects(
        parseV4APatch(patchStr),
        basePath,
        readStateScope,
      );
    } catch (err) {
      throw new Error(`apply_patch: V4A parse failed — ${err?.message || String(err)}`);
    }
    for (const section of allSections) pushSectionUnit(section);
  } else if (requestedFormat !== 'unified' && hasUnifiedBareV4AHunk(patchStr)) {
    // Bare `@@` V4A hunks in a unified body: parse to sections and defer each
    // section's conversion into its own unit (ordered-stop preserved) rather
    // than converting the whole patch up front.
    let sections;
    try {
      sections = rewriteV4AReadRedirects(
        parseUnifiedBareV4APatch(patchStr),
        basePath,
        readStateScope,
      );
    } catch (err) {
      throw new Error(`apply_patch: bare @@ parse failed — ${err?.message || String(err)}`);
    }
    for (const section of sections) pushSectionUnit(section);
  } else {
    let parsed = null;
    let countedSections = null;
    try {
      parsed = parsePatch(prepareInput(patchStr));
    } catch (err) {
      if (!canFallbackCountedUnified(patchStr, requestedFormat, err)) {
        throw new Error(`apply_patch: parse failed — ${err?.message || String(err)}; prefer V4A envelope for multi-hunk edits (no @@ line counts)`);
      }
      // Counted-unified (`@@ -a,b +c,d @@`) that parsePatch rejects: parse to
      // V4A-style sections and defer per-section conversion — same ordered-stop
      // guarantee as the V4A path (no whole-patch up-front convert).
      try {
        countedSections = rewriteV4AReadRedirects(
          parseUnifiedCountedAsV4APatch(patchStr),
          basePath,
          readStateScope,
        );
      } catch (fallbackErr) {
        throw new Error(`apply_patch: parse failed — ${err?.message || String(err)}; V4A fallback failed — ${fallbackErr?.message || String(fallbackErr)}`);
      }
    }
    if (countedSections) {
      for (const section of countedSections) pushSectionUnit(section);
    } else {
      parsed = rewriteParsedReadRedirects(parsed, basePath, readStateScope);
      for (const entry of parsed || []) {
        const kind = classifyEntry(entry);
        const headerName = kind === 'create' ? entry.newFileName : entry.oldFileName;
        if (!headerName) {
          throw new Error(
            'apply_patch: a file section header could not be parsed (no target path) — the patch body is not a valid diff. '
            + 'Each section must start with `*** Update File: <path>` / `*** Add File: <path>` / `*** Delete File: <path>` '
            + '(V4A, wrapped in `*** Begin Patch` / `*** End Patch`), or a `--- a/<path>` + `+++ b/<path>` pair (unified).',
          );
        }
        units.push({
          displayPath: normalizeOutputPath(stripDiffPrefix(headerName || '')),
          fullPath: parsedEntryResolvedPath(entry, basePath),
          buildParsed: async () => [entry],
        });
      }
    }
  }
  if (units.length === 0) return 'Error: patch contained no file sections';

  try {
    await ensureNativePatchBinaryAvailable();
  } catch (err) {
    return `Error: ${err?.message || String(err)}`;
  }

  const lockPaths = [...new Set(units.map((u) => u.fullPath))];
  const waveOpts = { fuzz, rejectPartial, dryRun, fuzzy, readStateScope, abortSignal };

  return withBuiltinPathLocks(lockPaths, () =>
    withAdvisoryLocks(lockPaths, async () => {
      let uiBeforeSnapshots = [];
      if (!dryRun && toolCallId && sessionId) {
        try {
          uiBeforeSnapshots = capturePatchRollbackState(lockPaths);
        } catch {
          uiBeforeSnapshots = [];
        }
      }
      const applied = [];
      const skipped = [];
      let failed = null;
      let failedIndex = -1;
      let executor = 'native-patch';
      for (let i = 0; i < units.length; i++) {
        const unit = units[i];
        if (failed) { skipped.push(unit.displayPath); continue; }
        if (abortSignal?.aborted) {
          failed = { displayPath: unit.displayPath, error: 'Error: apply_patch aborted' };
          failedIndex = i;
          continue;
        }
        let parsed;
        try {
          parsed = await unit.buildParsed();
        } catch (err) {
          failed = { displayPath: unit.displayPath, error: `Error: ${err?.message || String(err)}` };
          failedIndex = i;
          continue;
        }
        if (!Array.isArray(parsed) || parsed.length === 0) {
          // Section produced no applicable hunks (all skipped / no-op). Nothing
          // to commit; record and continue.
          applied.push({ displayPath: unit.displayPath, text: `(no changes) ${unit.displayPath}` });
          continue;
        }
        let wave;
        try {
          const { entries, headerRewrites } = await preValidateNativeBatch(parsed, basePath);
          wave = { parsed, entries, headerRewrites };
        } catch (err) {
          failed = { displayPath: unit.displayPath, error: `Error: ${err?.message || String(err)}` };
          failedIndex = i;
          continue;
        }
        const res = await applyParsedWave(wave, basePath, waveOpts);
        executor = res.executor;
        if (res.error) {
          failed = { displayPath: unit.displayPath, error: res.error };
          failedIndex = i;
          continue;
        }
        applied.push({ displayPath: unit.displayPath, text: res.text });
      }

      const verb = dryRun ? 'validated' : 'applied';
      const dryNote = (dryRun && units.length > 1)
        ? '\n(dry_run: each section validated against unchanged disk; a section depending on an earlier section\'s edits may report a false failure)'
        : '';
      const appliedTexts = applied.map((a) => a.text).filter(Boolean).join('\n');
      // reject_partial=false may have skipped individual V4A hunks in ANY
      // already-processed section; surface them in BOTH the success and failure
      // reports so the reported disk state stays complete even when a later
      // section fails.
      const rejected = Array.isArray(v4aConvertOpts?.rejectedHunks) ? v4aConvertOpts.rejectedHunks : [];
      const rejectedTail = rejected.length > 0
        ? '\n' + [
          '',
          `hunk-level rejected (rejectPartial=false, V4A): ${rejected.length}`,
          ...rejected.map((r) => `  REJECT ${r.file || '(unknown)'} — ${String(r.reason || '').split(';')[0].trim()}`),
        ].join('\n')
        : '';
      if (!failed) {
        if (!dryRun && uiBeforeSnapshots.length > 0) {
          registerCommittedPatchUiDiff({
            callId: toolCallId,
            sessionId,
            basePath,
            beforeSnapshots: uiBeforeSnapshots,
            paths: lockPaths,
          });
        }
        const head = `apply_patch: ${verb} ${units.length} section(s)`;
        const body = (appliedTexts ? `${head}\n${appliedTexts}` : head) + dryNote + rejectedTail;
        return wrapPatchMutationOutput(body, mutationPlan, { executor });
      }
      const failMsg = failed.error.replace(/^Error:\s*/, '');
      if (
        !dryRun
        && uiBeforeSnapshots.length > 0
        && applied.length > 0
      ) {
        registerCommittedPatchUiDiff({
          callId: toolCallId,
          sessionId,
          basePath,
          beforeSnapshots: uiBeforeSnapshots,
          paths: lockPaths,
        });
      }
      const committedPhrase = dryRun
        ? `${applied.length} earlier section(s) were validated`
        : `${applied.length} earlier section(s) were applied to disk (committed) and left in place`;
      const lines = [
        `Error: apply_patch sequence stopped at section ${failedIndex + 1}/${units.length} (${failed.displayPath}); `
          + `${committedPhrase}; ${skipped.length} later section(s) were skipped (not attempted).`,
      ];
      if (!dryRun) {
        lines.push('Retry only the failed and skipped sections; do not resend committed sections.');
      }
      if (appliedTexts) {
        lines.push(`--- ${dryRun ? 'validated' : 'applied (committed to disk)'} ---`, appliedTexts);
      }
      lines.push(`--- failed section: ${failed.displayPath} ---`, failMsg);
      if (skipped.length > 0) {
        lines.push(`--- skipped (not attempted): ${skipped.join(', ')} ---`);
      }
      return wrapPatchMutationOutput(lines.join('\n') + dryNote + rejectedTail, mutationPlan, { executor });
    }));
}

const APPLY_PATCH_UI_DIFF_MAX_CHARS = 64 * 1024;
// Reject oversized patch bodies before parse / native Buffer.from
// (native-server.mjs Buffer.from(patchText)). A few MB covers any legitimate
// multi-file edit; past this it is a runaway / accidental blob.
const APPLY_PATCH_MAX_BYTES = 8 * 1024 * 1024;
const APPLY_PATCH_UI_DIFF_REGISTRY_MAX = 64;
const _applyPatchUiDiffByCallId = new Map();

function registerApplyPatchUiDiff(callId, diff) {
  if (!callId || typeof diff !== 'string') return;
  let text = diff;
  if (text.length > APPLY_PATCH_UI_DIFF_MAX_CHARS) {
    text = `${text.slice(0, APPLY_PATCH_UI_DIFF_MAX_CHARS)}\n… [diff truncated for display]`;
  }
  if (_applyPatchUiDiffByCallId.size >= APPLY_PATCH_UI_DIFF_REGISTRY_MAX) {
    const oldest = _applyPatchUiDiffByCallId.keys().next().value;
    if (oldest !== undefined) _applyPatchUiDiffByCallId.delete(oldest);
  }
  _applyPatchUiDiffByCallId.set(callId, text);
}

export function takeApplyPatchUiDiff(callId) {
  if (!callId) return null;
  if (!_applyPatchUiDiffByCallId.has(callId)) return null;
  const value = _applyPatchUiDiffByCallId.get(callId);
  _applyPatchUiDiffByCallId.delete(callId);
  return value;
}

function snapshotByPath(snapshots) {
  return new Map((snapshots || []).map((snapshot) => [
    patchPathKey(snapshot.fullPath),
    snapshot,
  ]));
}

function registerCommittedPatchUiDiff({
  callId,
  sessionId,
  basePath,
  beforeSnapshots,
  paths,
  renameSections = [],
}) {
  if (!callId || !sessionId || !Array.isArray(beforeSnapshots) || beforeSnapshots.length === 0) return;
  try {
    const afterSnapshots = capturePatchRollbackState(paths);
    const beforeByPath = snapshotByPath(beforeSnapshots);
    const afterByPath = snapshotByPath(afterSnapshots);
    const renamedPaths = new Set();
    const changes = [];
    for (const section of renameSections || []) {
      const sourcePath = resolveV4AEntryPath(basePath, section.path);
      const destinationPath = resolveV4AEntryPath(basePath, section.movePath);
      const sourceKey = patchPathKey(sourcePath);
      const destinationKey = patchPathKey(destinationPath);
      const before = beforeByPath.get(sourceKey);
      const after = afterByPath.get(destinationKey);
      changes.push({
        path: sourcePath,
        displayPath: patchHeaderPathForResolved(basePath, sourcePath),
        newPath: destinationPath,
        newDisplayPath: patchHeaderPathForResolved(basePath, destinationPath),
        before: before?.existed ? before.content : null,
        after: after?.existed ? after.content : null,
      });
      renamedPaths.add(sourceKey);
      renamedPaths.add(destinationKey);
    }
    for (const fullPath of paths || []) {
      const key = patchPathKey(fullPath);
      if (renamedPaths.has(key)) continue;
      const before = beforeByPath.get(key);
      const after = afterByPath.get(key);
      changes.push({
        path: fullPath,
        displayPath: patchHeaderPathForResolved(basePath, fullPath),
        before: before?.existed ? before.content : null,
        after: after?.existed ? after.content : null,
      });
    }
    const turnDiff = recordTurnDiffChanges(sessionId, changes);
    registerApplyPatchUiDiff(callId, turnDiff);
  } catch {
    // Review collection is a side channel and must never affect committed
    // apply_patch success/failure semantics.
  }
}

function planApplyPatchMutationRoute(args, patchStr, requestedFormat) {
  const v4aInput = isV4APatchInput(patchStr, requestedFormat)
    || (requestedFormat !== 'unified' && hasUnifiedBareV4AHunk(patchStr));
  return {
    sourceTool: 'apply_patch',
    engine: v4aInput ? 'v4a-patch' : 'unified-patch',
    reason: 'direct',
  };
}

// Model-surface success outputs deliberately DROP the `mutation_route:`
// diagnostic header (the surface stays `Success. Updated the following files:`).
// Errors were never wrapped, the UI diff side-channel is independent, and no
// script/UI parses the header — measured saving ~30 tokens x ~125 successful
// patch calls/day. Route diagnostics stay available via plan/extras callers.
function wrapPatchMutationOutput(text, _plan, _extras = {}) {
  // Non-fatal duplicate-context notices ride the success output: the edit
  // landed at the first match (spec), and the caller learns in the same turn
  // that another location was possible.
  const notices = drainV4AAmbiguityNotices();
  if (notices.length === 0) return text;
  return `${text}\n${notices.map((notice) => `⚠️ ${notice}`).join('\n')}`;
}

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
      try { fileKey = resolveV4AEntryPath(basePath, target); } catch { continue; }
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
      } catch { continue; }
      const hunk = section.hunks[0];
      const newSide = (hunk.lines || [])
        .filter((l) => l && (l[0] === ' ' || l[0] === '+'))
        .map((l) => l.slice(1));
      if (!newSide.length) continue;
      let at = -1;
      outer: for (let i = 0; i + newSide.length <= fileLines.length; i++) {
        for (let k = 0; k < newSide.length; k++) {
          if (fileLines[i + k] !== newSide[k]) continue outer;
        }
        at = i; break;
      }
      if (at < 0) continue;
      const shown = Math.min(newSide.length, POST_PATCH_EXCERPT_MAX_LINES);
      const rows = [];
      for (let i = 0; i < shown; i++) {
        rows.push(`${String(at + i + 1).padStart(5, ' ')}| ${fileLines[at + i]}`);
      }
      if (newSide.length > shown) rows.push('     | …');
      const more = section.hunks.length > 1 ? ` (+${section.hunks.length - 1} more hunk${section.hunks.length > 2 ? 's' : ''})` : '';
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

const APPLY_PATCH_SCHEMA_KEYS = new Set(['patch', 'format', 'base_path', 'dry_run', 'reject_partial', 'fuzzy', 'sequence', 'mode']);
function salvageShatteredV4APatchArgs(args) {
  if (!args || typeof args !== 'object') return args;
  const rawPatch = typeof args.patch === 'string' ? args.patch : '';
  if (!rawPatch.startsWith('*** Begin Patch') || rawPatch.includes('\n') || rawPatch.includes('*** End Patch')) return args;
  const stray = Object.keys(args).filter((k) => !APPLY_PATCH_SCHEMA_KEYS.has(k));
  if (stray.length === 0) return args;
  const lines = [rawPatch];
  for (const key of Object.keys(args)) {
    if (APPLY_PATCH_SCHEMA_KEYS.has(key)) continue;
    lines.push(key);
    lines.push(String(args[key] ?? ''));
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const cleaned = {};
  for (const key of Object.keys(args)) if (APPLY_PATCH_SCHEMA_KEYS.has(key)) cleaned[key] = args[key];
  cleaned.patch = lines.join('\n');
  return cleaned;
}

function assertUniqueV4ASectionTargets(sections, basePath) {
  const seen = new Set();
  for (const section of sections || []) {
    if (!section || typeof section.path !== 'string' || !section.path) continue;
    const fullPath = resolveV4AEntryPath(basePath, section.path);
    const key = process.platform === 'win32' ? fullPath.toLowerCase() : fullPath;
    if (seen.has(key)) {
      throw new Error(`apply_patch: multiple operations target ${normalizeOutputPath(section.path)}`);
    }
    seen.add(key);
  }
}

async function apply_patch(args, cwd, options = {}) {
  args = salvageShatteredV4APatchArgs(args);
  let patchStr = typeof args?.patch === 'string' ? args.patch : '';
  patchStr = salvageV4AOpening(patchStr);
  if (!patchStr.trim()) {
    throw new Error('apply_patch: "patch" is required (unified diff or V4A patch string)');
  }
  if (isCompactedPlaceholderPatch(patchStr)) {
    throw new Error('patch body is a compacted-history placeholder ([mixdog compacted …]), not real patch content and cannot be executed. Re-read the current target file contents now, then construct and submit a fresh full patch from those contents. Do not reuse the marker, omit the patch argument, or reconstruct the old patch from history.');
  }
  const patchByteLen = Buffer.byteLength(patchStr, 'utf8');
  if (patchByteLen > APPLY_PATCH_MAX_BYTES) {
    throw new Error(`apply_patch: patch too large (${patchByteLen} bytes > ${APPLY_PATCH_MAX_BYTES} byte cap); split into smaller patches`);
  }
  const requestedFormat = String(args?.format || '').toLowerCase();
  if (requestedFormat && requestedFormat !== 'unified' && requestedFormat !== 'v4a') {
    throw new Error('apply_patch: "format" must be "unified" or "v4a"');
  }
  let mutationPlan = options?.mutationPlan || planApplyPatchMutationRoute(args, patchStr, requestedFormat);
  const readStateScope = options?.readStateScope ?? options?.sessionId ?? null;
  let abortSignal = options?.signal || options?.abortSignal || null;
  if (!abortSignal && options?.sessionId) {
    try { abortSignal = await getAbortSignalForSession(options.sessionId); } catch { abortSignal = null; }
  }
  if (abortSignal?.aborted) {
    throw new Error(abortSignal.reason?.message || abortSignal.reason || 'apply_patch aborted');
  }
  const basePath = resolveBasePath(cwd, args?.base_path);
  try {
    await assertPathReachable(basePath);
  } catch (err) {
    return `Error: ${err?.message || String(err)}`;
  }
  const rejectPartial = args?.reject_partial !== false;
  const dryRun = args?.dry_run === true;
  const fuzzy = args?.fuzzy !== false;
  const fuzz = fuzzy ? 2 : 0;

  let inputPatchStr = patchStr;
  const rejectedV4AHunks = [];
  const v4aConvertOpts = { rejectPartial, rejectedHunks: rejectedV4AHunks, fuzzy, dryRun, readStateScope };
  let preParsedV4ASections = null;
  if (isV4APatchInput(patchStr, requestedFormat)) {
    try {
      preParsedV4ASections = rewriteV4AReadRedirects(
        parseV4APatch(patchStr),
        basePath,
        readStateScope,
      );
    } catch {
      // The selected execution path reports the authoritative parse error.
    }
  }
  // The freeform tool surface intentionally exposes only the patch body, not
  // internal mode switches. Route a standalone move to the existing atomic
  // rename executor automatically so the advertised `*** Move to:` grammar is
  // actually callable. Mixed patches stay ordered and tell the caller to retry
  // the move as its own section.
  const modelSurfaceRenameOnly = preParsedV4ASections?.length === 1
    && isV4ARenameSection(preParsedV4ASections[0]);
  // The model-visible default matches Codex: validate the complete patch before
  // writing and reject duplicate targets. Ordered partial application remains
  // an internal compatibility mode only.
  const patchMode = String(args?.mode || '').toLowerCase();
  const orderedSequenceMode = args?.sequence === true
    || ['ordered', 'sequence'].includes(patchMode);
  if (orderedSequenceMode && !modelSurfaceRenameOnly) {
    const seqOut = await applyPatchSequence(patchStr, requestedFormat, basePath, {
      v4aConvertOpts, dryRun, fuzz, fuzzy, rejectPartial,
      readStateScope, abortSignal, mutationPlan,
      toolCallId: options?.toolCallId || null,
      sessionId: options?.sessionId || null,
    });
    return dryRun ? seqOut : appendPostPatchExcerpts(seqOut, patchStr, requestedFormat, basePath, readStateScope);
  }
  let v4aRenamePlan = null;
  if (isV4APatchInput(patchStr, requestedFormat)) {
    try {
      const allSections = preParsedV4ASections || rewriteV4AReadRedirects(
          parseV4APatch(patchStr),
          basePath,
          readStateScope,
        );
      assertUniqueV4ASectionTargets(allSections, basePath);
      v4aRenamePlan = await planV4ARenameSections(allSections, basePath);
      inputPatchStr = await convertV4ASectionsToUnifiedPatch(v4aRenamePlan.remainingSections, basePath, v4aConvertOpts);
      if (v4aRenamePlan.renameSections.length > 0) {
        mutationPlan = v4aRenamePlan.remainingSections.length > 0
          ? { sourceTool: 'apply_patch', engine: 'v4a-patch', reason: 'v4a-mixed' }
          : { sourceTool: 'apply_patch', engine: 'v4a-rename', reason: 'v4a-move' };
      }
    } catch (err) {
      throw new Error(`apply_patch: V4A parse failed — ${err?.message || String(err)}`);
    }
  } else if (requestedFormat !== 'unified' && hasUnifiedBareV4AHunk(patchStr)) {
    try {
      const sections = rewriteV4AReadRedirects(
        parseUnifiedBareV4APatch(patchStr),
        basePath,
        readStateScope,
      );
      inputPatchStr = await convertV4ASectionsToUnifiedPatch(sections, basePath, v4aConvertOpts);
    } catch (err) {
      throw new Error(`apply_patch: bare @@ parse failed — ${err?.message || String(err)}`);
    }
  }
  let normalizedPatchStr = prepareInput(inputPatchStr);
  const v4aRenameOnly = v4aRenamePlan?.renameSections?.length > 0 && v4aRenamePlan.remainingSections.length === 0;

  let parsed = [];
  if (!v4aRenameOnly) try {
    parsed = parsePatch(normalizedPatchStr);
  } catch (err) {
    if (!canFallbackCountedUnified(patchStr, requestedFormat, err)) {
      throw new Error(`apply_patch: parse failed — ${err?.message || String(err)}; prefer V4A envelope for multi-hunk edits (no @@ line counts)`);
    }
    try {
      const sections = rewriteV4AReadRedirects(
        parseUnifiedCountedAsV4APatch(patchStr),
        basePath,
        readStateScope,
      );
      inputPatchStr = await convertV4ASectionsToUnifiedPatch(sections, basePath, v4aConvertOpts);
      normalizedPatchStr = prepareInput(inputPatchStr);
      parsed = parsePatch(normalizedPatchStr);
      mutationPlan = {
        sourceTool: 'apply_patch',
        engine: 'v4a-patch',
        reason: 'unified-count-fallback',
      };
    } catch (fallbackErr) {
      throw new Error(`apply_patch: parse failed — ${err?.message || String(err)}; V4A fallback failed — ${fallbackErr?.message || String(fallbackErr)}`);
    }
  }
  if (!v4aRenameOnly) {
    parsed = rewriteParsedReadRedirects(parsed, basePath, readStateScope);
  }
  if (!v4aRenameOnly && (!Array.isArray(parsed) || parsed.length === 0)) {
    return 'Error: patch contained no file sections';
  }
  // Validate Codex's one-operation-per-target rule and build one batch.
  let parsedWaves = v4aRenameOnly ? [] : [parsed];
  if (!v4aRenameOnly) {
    try {
      parsedWaves = splitParsedModifyWaves(parsed, basePath);
    } catch (err) {
      return `Error: ${err?.message || String(err)}`;
    }
  }

  if (!v4aRenameOnly) {
    try {
      await ensureNativePatchBinaryAvailable();
    } catch (err) {
      return `Error: ${err?.message || String(err)}`;
    }
  }
  // Pre-validate each wave independently: a wave only ever holds unique
  // targets, so the native batch's per-file semantics stay intact.
  const waveDispatch = [];
  if (!v4aRenameOnly) {
    try {
      for (const wparsed of parsedWaves) {
        const { entries, headerRewrites } = await preValidateNativeBatch(wparsed, basePath);
        waveDispatch.push({ parsed: wparsed, entries, headerRewrites });
      }
    } catch (err) {
      return `Error: ${err?.message || String(err)}`;
    }
  }

  const _lockPaths = [
    ...new Set(waveDispatch.flatMap((wd) => wd.entries.map((entry) => entry.fullPath))),
    ...(v4aRenamePlan?.renameSections || []).flatMap((section) => {
      const src = resolveV4AEntryPath(basePath, section.path);
      const dest = resolveV4AEntryPath(basePath, section.movePath);
      return [src, dest];
    }),
  ];

  const runCodexBatch = async () => {
    let v4aRenameResults = [];
    if (v4aRenamePlan?.renameSections?.length) {
      v4aRenameResults = await applyV4ARenameSections(v4aRenamePlan.renameSections, basePath, v4aConvertOpts);
    }
    if (v4aRenameOnly) {
      const lines = formatV4ARenameSuccessLines(v4aRenameResults);
      if (lines.length === 0) return 'Error: patch contained no applicable file sections';
      return wrapPatchMutationOutput(`${lines.join('\n')}\n`, mutationPlan, { executor: 'v4a-rename' });
    }
    // Apply one wave (a set of unique targets) via applyParsedWave (native +
    // JS split). Returns { executor, text } on success or { executor, error }.
    const applyWave = (wave) => applyParsedWave(wave, basePath, { fuzz, rejectPartial, dryRun, fuzzy, readStateScope, abortSignal });

    const res = await applyWave(waveDispatch[0]);
    const executor = res.executor;
    if (res.error) return wrapPatchMutationOutput(res.error, mutationPlan, { executor });
    let combined = res.text;
    const renameLines = formatV4ARenameSuccessLines(v4aRenameResults);
    if (renameLines.length > 0 && !isPatchErrorText(combined)) {
      combined = `${renameLines.join('\n')}\n${combined}`;
    }
    if (!isPatchErrorText(combined) && rejectedV4AHunks.length > 0) {
      const tail = [
        '',
        `hunk-level rejected (rejectPartial=false, V4A): ${rejectedV4AHunks.length}`,
        ...rejectedV4AHunks.map((r) => `  REJECT ${r.file || '(unknown)'} — ${String(r.reason || '').split(';')[0].trim()}`),
      ];
      return wrapPatchMutationOutput(`${combined}\n${tail.join('\n')}`, mutationPlan, { executor });
    }
    return wrapPatchMutationOutput(combined, mutationPlan, { executor });
  };

  return withBuiltinPathLocks(_lockPaths, () =>
    withAdvisoryLocks(_lockPaths, async () => {
      // Codex mode applies the validated batch in one shot. A batch that mixes
      // native (in-base) with JS (out-of-base) entries commits the native
      // writes before the JS entries run. Snapshot every touched path up front
      // and restore it whenever the batch fails — by returned Error text OR by
      // a thrown error (V4A rename, persistence) — so mode:"atomic" really is
      // all-or-nothing instead of leaving an earlier commit in place.
      let rollbackSnapshots = [];
      if (!dryRun) {
        try {
          rollbackSnapshots = capturePatchRollbackState(_lockPaths);
        } catch (err) {
          return `Error: ${err?.message || String(err)}`;
        }
      }
      // Restoration errors are never swallowed: an incomplete rollback is
      // reported verbatim so the caller never reads a false all-or-nothing.
      const withRollback = (outcome) => {
        const rollbackErrors = restorePatchRollbackState(rollbackSnapshots, readStateScope);
        return {
          text: rollbackErrors.length === 0
            ? `${outcome}\n--- rolled back: every touched path was restored to its pre-patch state ---`
            : [outcome, '--- rollback incomplete ---', ...rollbackErrors].join('\n'),
          rollbackErrors,
        };
      };
      let outcome;
      try {
        outcome = await runCodexBatch();
      } catch (err) {
        // A thrown failure (e.g. V4A rename) took the same path to disk as a
        // returned one, so it takes the same path back out.
        if (dryRun) throw err;
        const rolledBack = withRollback(`Error: ${err?.message || String(err)}`);
        if (rolledBack.rollbackErrors.length > 0) {
          registerCommittedPatchUiDiff({
            callId: options?.toolCallId,
            sessionId: options?.sessionId,
            basePath,
            beforeSnapshots: rollbackSnapshots,
            paths: _lockPaths,
            renameSections: v4aRenamePlan?.renameSections,
          });
        }
        return rolledBack.text;
      }
      if (dryRun) return outcome;
      if (!isPatchErrorText(outcome)) {
        registerCommittedPatchUiDiff({
          callId: options?.toolCallId,
          sessionId: options?.sessionId,
          basePath,
          beforeSnapshots: rollbackSnapshots,
          paths: _lockPaths,
          renameSections: v4aRenamePlan?.renameSections,
        });
        return outcome;
      }
      const rolledBack = withRollback(outcome);
      if (rolledBack.rollbackErrors.length > 0) {
        registerCommittedPatchUiDiff({
          callId: options?.toolCallId,
          sessionId: options?.sessionId,
          basePath,
          beforeSnapshots: rollbackSnapshots,
          paths: _lockPaths,
          renameSections: v4aRenamePlan?.renameSections,
        });
      }
      return rolledBack.text;
    }));
}

export async function executePatchTool(name, args, cwd, options = {}) {
  return _executePatchTool(name, args, cwd, options);
}

function patchReplayDir() {
  const base = process.env.MIXDOG_PATCH_REPLAY_DIR
    || pathJoin(getPluginDataDir(), 'history', 'patch-replays');
  return base;
}

function getPluginDataDir() {
  try { return getPluginData(); } catch { /* fall through */ }
  return process.env.MIXDOG_DATA_DIR || pathJoin(process.env.USERPROFILE || process.env.HOME || '.', '.mixdog', 'data');
}

function patchTargetPaths(patchStr, basePath) {
  const out = [];
  const re = /^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm;
  let m;
  while ((m = re.exec(String(patchStr || '')))) {
    const rel = m[1].trim();
    if (rel) out.push(rel);
  }
  // A rename WRITES its destination, so the destination is a target too — the
  // write-root gate and the replay snapshot both need it.
  const mre = /^\*\*\* Move to:\s*(.+)$/gm;
  while ((m = mre.exec(String(patchStr || '')))) {
    const rel = m[1].trim();
    if (rel) out.push(rel);
  }
  const ure = /^\+\+\+ (?:b\/)?(.+)$/gm;
  while ((m = ure.exec(String(patchStr || '')))) {
    const rel = m[1].trim();
    if (rel && rel !== '/dev/null') out.push(rel);
  }
  return [...new Set(out)];
}

function maybeCapturePatchReplay(args, cwd, errorText) {
  // Default ON: every apply_patch failure is frozen for `npm run patch:replay`
  // (args + target-file snapshots). Set MIXDOG_PATCH_REPLAY_CAPTURE=0 to
  // disable. Retention is bounded below to the newest records.
  const _flag = String(process.env.MIXDOG_PATCH_REPLAY_CAPTURE ?? '1').trim().toLowerCase();
  if (_flag === '0' || _flag === 'false' || _flag === 'off') return;
  try {
    const patchStr = typeof args?.patch === 'string' ? args.patch : '';
    const basePath = pathResolve(String(args?.base_path || cwd || process.cwd()));
    const dir = patchReplayDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const rels = patchTargetPaths(patchStr, basePath);
    const files = {};
    for (const rel of rels) {
      try {
        const abs = isAbsolute(rel) ? rel : pathResolve(basePath, rel);
        // Never persist snapshots for targets outside basePath — a malicious
        // or malformed patch could otherwise exfiltrate arbitrary files.
        if (isResolvedPathOutsideBase(abs, basePath)) { files[rel] = null; continue; }
        files[rel] = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
      } catch { files[rel] = null; }
    }
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const record = {
      id,
      ts: Date.now(),
      tool: 'apply_patch',
      args: { patch: patchStr, base_path: args?.base_path ?? null, format: args?.format ?? null, dry_run: args?.dry_run ?? null, fuzzy: args?.fuzzy ?? null, reject_partial: args?.reject_partial ?? null },
      cwd: basePath,
      error_first_line: String(errorText || '').split('\n')[0].slice(0, 400),
      targets: rels,
      file_snapshots: files,
    };
    writeFileSync(pathJoin(dir, `${id}.json`), JSON.stringify(record, null, 2), { mode: 0o600 });
    // Retention: keep the newest 40 captures. The id prefix is Date.now() in
    // base36 (fixed width until ~2059), so a lexicographic sort is
    // chronological and the oldest records sort first.
    const _kept = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    for (const stale of _kept.slice(0, Math.max(0, _kept.length - 40))) {
      try { rmSync(pathJoin(dir, stale), { force: true }); } catch { /* best-effort */ }
    }
  } catch { /* capture is best-effort; never affect the tool result */ }
}

async function _executePatchTool(name, args, cwd, options = {}) {
  const effectiveCwd = cwd || process.cwd();
  switch (name) {
    case 'apply_patch': {
      let result;
      try {
        result = await apply_patch(args || {}, effectiveCwd, options);
      } catch (err) {
        const errText = `Error: ${err?.message || String(err)}`;
        maybeCapturePatchReplay(args, effectiveCwd, errText);
        return errText;
      }
      if (isPatchErrorText(String(result))) maybeCapturePatchReplay(args, effectiveCwd, String(result));
      if (typeof options?.onProgress === 'function') {
        try {
          const _body = String(result);
          if (!/^Error[\s:[]/.test(_body)) {
            if (args?.dry_run === true) options.onProgress('validated');
            else {
              const _m = /^(?:applied|checked)\s+(\d+)\b/m.exec(_body);
              const _n = _m ? Number(_m[1]) : (_body.match(/^\s*OK\s/gm) || []).length;
              options.onProgress(`applied ${_n} files`);
            }
          }
        } catch { /* best-effort */ }
      }
      return result;
    }
    default: throw new Error(`Unknown patch tool: ${name}`);
  }
}
