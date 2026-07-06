// apply_patch top-level orchestration: UI-diff side-channel, input salvage,
// mutation-route planning, V4A conversion wiring, native dispatch, and the
// executePatchTool entry point + replay capture. Moved verbatim from
// patch.mjs; control flow and output are unchanged.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve as pathResolve, isAbsolute, join as pathJoin } from 'node:path';
import { parsePatch } from 'diff';
import { getAbortSignalForSession } from '../../session/abort-lookup.mjs';
import { withBuiltinPathLocks } from '../builtin.mjs';
import { withAdvisoryLocks } from '../builtin/advisory-lock.mjs';
import { wrapMutationRouteOutput } from '../mutation-planner.mjs';
import { getPluginData } from '../../config.mjs';
import { prepareInput, isV4APatchInput, hasUnifiedBareV4AHunk, canFallbackCountedUnified, parseV4APatch, isCompactedPlaceholderPatch, salvageV4AOpening } from './parsing.mjs';
import {
  resolveBasePath,
  resolveV4AEntryPath,
  parsedEntryResolvedPath,
  isResolvedPathOutsideBase,
  splitParsedModifyWaves,
  renderParsedUnifiedPatch,
  rewriteHeaderPaths,
  preValidateNativeBatch,
} from './paths.mjs';
import { ensureNativePatchBinaryAvailable } from './native-server.mjs';
import { assertPathReachable } from '../builtin/fs-reachability.mjs';
import { dispatchNativePatch, dispatchJsPatchEntries } from './dispatch.mjs';
import { normalizeOutputPath } from '../builtin.mjs';
import {
  planV4ARenameSections,
  applyV4ARenameSections,
  formatV4ARenameSuccessLines,
  convertV4ASectionsToUnifiedPatch,
  convertUnifiedBareV4AToUnifiedPatch,
  convertUnifiedCountedToUnifiedPatchViaV4A,
} from './v4a-convert.mjs';

function isPatchErrorText(text) {
  return /^Error:/i.test(String(text ?? '').trimStart());
}

const APPLY_PATCH_UI_DIFF_MAX_CHARS = 64 * 1024;
// Reject oversized patch bodies before parse / native Buffer.from
// (native-server.mjs Buffer.from(patchText)). A few MB covers any legitimate
// multi-file edit; past this it is a runaway / accidental blob.
const APPLY_PATCH_MAX_BYTES = 8 * 1024 * 1024;
const APPLY_PATCH_UI_DIFF_REGISTRY_MAX = 64;
const _applyPatchUiDiffByCallId = new Map();

function registerApplyPatchUiDiff(callId, diff) {
  if (!callId || typeof diff !== 'string' || !diff.trim()) return;
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
  const value = _applyPatchUiDiffByCallId.get(callId) || null;
  if (value != null) _applyPatchUiDiffByCallId.delete(callId);
  return value;
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

function wrapPatchMutationOutput(text, plan, extras = {}) {
  if (isPatchErrorText(text)) return text;
  return wrapMutationRouteOutput(text, plan, extras);
}

const APPLY_PATCH_SCHEMA_KEYS = new Set(['patch', 'format', 'base_path', 'dry_run', 'reject_partial', 'fuzzy']);
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

async function apply_patch(args, cwd, options = {}) {
  args = salvageShatteredV4APatchArgs(args);
  const patchStr = salvageV4AOpening((typeof args?.patch === 'string' ? args.patch : '').replace(/^\uFEFF/, ''));
  if (!patchStr.trim()) {
    throw new Error('apply_patch: "patch" is required (unified diff or V4A patch string)');
  }
  if (isCompactedPlaceholderPatch(patchStr)) {
    throw new Error('patch body is a compacted-history placeholder ([mixdog compacted …]), not real patch content. Re-read the target file span and write a fresh patch; never resubmit compacted output as new tool input.');
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
  let v4aRenamePlan = null;
  if (isV4APatchInput(patchStr, requestedFormat)) {
    try {
      const allSections = parseV4APatch(patchStr);
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
      inputPatchStr = await convertUnifiedBareV4AToUnifiedPatch(patchStr, basePath, v4aConvertOpts);
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
      inputPatchStr = await convertUnifiedCountedToUnifiedPatchViaV4A(patchStr, basePath, v4aConvertOpts);
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
  if (!v4aRenameOnly && (!Array.isArray(parsed) || parsed.length === 0)) {
    return 'Error: patch contained no file sections';
  }
  // Split duplicate modify-target blocks into sequential waves: occurrence i
  // of a path lands in wave i so each duplicate applies against the prior
  // wave's on-disk result. Non-duplicate patches yield exactly one wave, so
  // single-target behavior is unchanged.
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

  return withBuiltinPathLocks(_lockPaths, () =>
    withAdvisoryLocks(_lockPaths, async () => {
    let v4aRenameResults = [];
    if (v4aRenamePlan?.renameSections?.length) {
      v4aRenameResults = await applyV4ARenameSections(v4aRenamePlan.renameSections, basePath, v4aConvertOpts);
    }
    if (v4aRenameOnly) {
      const lines = formatV4ARenameSuccessLines(v4aRenameResults);
      if (lines.length === 0) return 'Error: patch contained no applicable file sections';
      return wrapPatchMutationOutput(`${lines.join('\n')}\n`, mutationPlan, { backend: 'v4a-rename' });
    }
    // Apply one wave (a set of unique targets) via the existing native(+js)
    // split. Returns { backend, text } on success or { backend, error } so the
    // caller can decide whether earlier waves already committed to disk.
    const applyWave = async ({ parsed: wparsed, entries: wentries, headerRewrites: whr }) => {
      const insideEntries = wentries.filter((entry) => !isResolvedPathOutsideBase(entry.fullPath, basePath));
      const outsideEntries = wentries.filter((entry) => isResolvedPathOutsideBase(entry.fullPath, basePath));
      const parsedInside = (wparsed || []).filter(
        (entry) => !isResolvedPathOutsideBase(parsedEntryResolvedPath(entry, basePath), basePath),
      );
      const backend = outsideEntries.length > 0
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
        if (isPatchErrorText(nativeResult)) return { backend, error: nativeResult };
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
        if (isPatchErrorText(jsResult)) return { backend, error: jsResult };
        resultParts.push(jsResult);
      }
      return { backend, text: resultParts.join('\n') };
    };

    // Duplicate-target blocks were split into contiguous sequential groups
    // (listed order preserved); apply them in order, each against the prior
    // group's on-disk result.
    const waveTexts = [];
    let backend = 'native-patch';
    // dry_run never writes, so a later group would validate against unchanged
    // disk and false-fail on any block that depends on an earlier edit. Only
    // the first group is validated under dry_run; the rest are reported as
    // unsimulated below (no false failures).
    const groupCount = (dryRun && waveDispatch.length > 1) ? 1 : waveDispatch.length;
    for (let w = 0; w < groupCount; w++) {
      const res = await applyWave(waveDispatch[w]);
      backend = res.backend;
      if (res.error) {
        if (w === 0) return wrapPatchMutationOutput(res.error, mutationPlan, { backend });
        // A later group failed. rejectPartial makes each group all-or-nothing,
        // so every block in groups 1..w is fully committed to disk and left in
        // place. List them all so the caller knows the true on-disk state.
        const failMsg = res.error.replace(/^Error:\s*/, '');
        const note = [
          `Error: apply_patch: a block failed in sequential group ${w + 1}/${waveDispatch.length}; every edit listed below was already applied to disk (writes committed) and left in place:`,
          waveTexts.join('\n'),
          '--- failing block ---',
          failMsg,
        ].join('\n');
        return wrapPatchMutationOutput(note, mutationPlan, { backend });
      }
      waveTexts.push(res.text);
    }

    let combined = waveTexts.join('\n');
    if (dryRun && waveDispatch.length > 1) {
      const skipped = [...new Set(
        waveDispatch.slice(1).flatMap((wd) => wd.entries.map((e) => e.displayPath)),
      )];
      combined += `\n(dry_run: only the first sequential group was validated against disk; blocks depending on earlier edits were not simulated: ${skipped.join(', ')})`;
    }
    const renameLines = formatV4ARenameSuccessLines(v4aRenameResults);
    if (renameLines.length > 0 && !isPatchErrorText(combined)) {
      combined = `${renameLines.join('\n')}\n${combined}`;
    }
    if (!isPatchErrorText(combined) && options?.toolCallId) {
      const allRewrites = waveDispatch.flatMap((wd) => wd.headerRewrites);
      registerApplyPatchUiDiff(options.toolCallId, rewriteHeaderPaths(normalizedPatchStr, allRewrites));
    }
    if (!isPatchErrorText(combined) && rejectedV4AHunks.length > 0) {
      const tail = [
        '',
        `hunk-level rejected (rejectPartial=false, V4A): ${rejectedV4AHunks.length}`,
        ...rejectedV4AHunks.map((r) => `  REJECT ${r.file || '(unknown)'} — ${String(r.reason || '').split(';')[0].trim()}`),
      ];
      return wrapPatchMutationOutput(`${combined}\n${tail.join('\n')}`, mutationPlan, { backend });
    }
    return wrapPatchMutationOutput(combined, mutationPlan, { backend });
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
  const ure = /^\+\+\+ (?:b\/)?(.+)$/gm;
  while ((m = ure.exec(String(patchStr || '')))) {
    const rel = m[1].trim();
    if (rel && rel !== '/dev/null') out.push(rel);
  }
  return [...new Set(out)];
}

function maybeCapturePatchReplay(args, cwd, errorText) {
  if (process.env.MIXDOG_PATCH_REPLAY_CAPTURE !== '1') return;
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
