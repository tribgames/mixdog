// One "wave" of parsed entries (unique targets) applied through the native +
// JS writer split. Both the Codex batch and the ordered sequence share these
// apply semantics.
import { parsePatch } from 'diff';
import { throwIfAborted } from '../../../../shared/abort-race.mjs';
import { symlinkWriteTarget } from '../builtin/atomic-write.mjs';
import { patchContentEditRefusal } from './content-guard.mjs';
import {
  commitDeleteQuarantine,
  createDeleteQuarantine,
  deleteNeedsQuarantine,
  formatQuarantinedDeletes,
  quarantineDeleteTargets,
} from './delete-quarantine.mjs';
import { dispatchNativePatch, dispatchJsPatchEntries } from './dispatch.mjs';
import { patchTargetUsesUtf16 } from './matcher.mjs';
import { nativePatchSessionSatisfiesContract } from './native-server.mjs';
import { prepareInput } from './parsing.mjs';
import {
  classifyEntry,
  isResolvedPathOutsideBase,
  parsedEntryResolvedPath,
  pathKey,
  renderParsedUnifiedPatch,
  rewriteHeaderPaths,
} from './paths.mjs';

export function isPatchErrorText(text) {
  return /^Error:/i.test(String(text ?? '').trimStart());
}

// convertV4ASectionsToUnifiedPatch may emit nothing when every hunk is a
// unique-new-side no-op. `diff.parsePatch` turns a blank body into a junk
// entry with no path; treat that as "no applicable hunks".
export function parseConvertedUnifiedPatch(unified) {
  const text = prepareInput(unified);
  if (!String(text).trim()) return [];
  return (parsePatch(text) || []).filter((entry) => entry?.oldFileName || entry?.newFileName);
}

// Apply one wave via the native (+ JS out-of-base) split. Returns
// { executor, text } on success or { executor, error } so the caller decides
// whether earlier waves already committed to disk.
//
// `opts.deleteQuarantine` (from a batch owner with rollback) receives the
// quarantine moves of never-snapshotted deletes and commits them itself;
// without one, the wave commits its own moves once they all succeeded.
export async function applyParsedWave({ parsed: allParsed, entries: allEntries, headerRewrites: whr }, basePath, opts) {
  const { fuzz, rejectPartial, dryRun, fuzzy, readStateScope, abortSignal, deleteQuarantine = null } = opts;
  throwIfAborted(abortSignal);
  // Content edits of binary/oversized files are refused before any write.
  for (const entry of allEntries) {
    if (entry.kind !== 'modify') continue;
    const refusal = patchContentEditRefusal(entry.fullPath, entry.displayPath);
    if (refusal) return { executor: 'js-patch', error: `Error: ${refusal}` };
  }
  // Deletes whose bytes are never snapshotted run last, as quarantine moves.
  const protectedDeletes = dryRun
    ? []
    : allEntries.filter((entry) => entry.kind === 'delete' && deleteNeedsQuarantine(entry.fullPath, deleteQuarantine));
  const protectedKeys = new Set(protectedDeletes.map((entry) => pathKey(entry.fullPath)));
  const wentries = allEntries.filter((entry) => !protectedKeys.has(pathKey(entry.fullPath)));
  const wparsed = (allParsed || []).filter(
    (entry) => !protectedKeys.has(pathKey(parsedEntryResolvedPath(entry, basePath)))
  );
  // Create entries use the JS atomic writer even inside the base path. Its
  // expected-absent snapshot makes Add File create-only under external races;
  // the native patch engine intentionally supports overwrite-style additions.
  // Route by the codec actually DETECTED, not by BOM presence: a BOM-less
  // UTF-16 file reaching the UTF-8 native engine came back as mixed
  // UTF-16/UTF-8 bytes. Any UTF-16 target (BOM or not) takes the JS writer,
  // which decodes and re-encodes with that exact codec; undecidable files stay
  // native, where the encoding gate refuses them before any write. Deletes
  // touch no bytes and stay native.
  //
  // The engine-contract gate is the same protection for a STALE artifact: a
  // binary that predates this build's byte-fidelity contract is not used at
  // all — everything takes the JS writer instead.
  const engineContractOk = await nativePatchSessionSatisfiesContract();
  throwIfAborted(abortSignal);
  // Codec routing only concerns entries that REWRITE bytes; a delete does not.
  // An unverified engine, however, must receive no work at all — deletes
  // included — so the whole wave takes the JS writer.
  const codecNeedsJs = (fullPath, kind) => kind !== 'create' && kind !== 'delete' && patchTargetUsesUtf16(fullPath);
  // A symlinked target takes the JS writer too: the native engine renames its
  // output over the path it was handed, which would replace the link with a
  // regular file. The JS writer resolves the link and rewrites the file it
  // points at. Delete is exempt — removing the link itself is correct there.
  const symlinkNeedsJs = (fullPath, kind) =>
    kind !== 'create' && kind !== 'delete' && symlinkWriteTarget(fullPath) !== null;
  // Each decision costs a whole-file read (codec sniff) plus an lstat, and the
  // three filters below classify the same targets, so route once per target.
  const jsWriterRouting = new Map();
  const needsJsWriter = (fullPath, kind) => {
    if (!engineContractOk) return true;
    const routeKey = `${kind}\u0000${fullPath}`;
    let decided = jsWriterRouting.get(routeKey);
    if (decided === undefined) {
      decided = codecNeedsJs(fullPath, kind) || symlinkNeedsJs(fullPath, kind);
      jsWriterRouting.set(routeKey, decided);
    }
    return decided;
  };
  const nativeEntries = wentries.filter(
    (entry) =>
      entry.kind !== 'create' &&
      !isResolvedPathOutsideBase(entry.fullPath, basePath) &&
      !needsJsWriter(entry.fullPath, entry.kind)
  );
  const jsEntries = wentries.filter(
    (entry) =>
      entry.kind === 'create' ||
      isResolvedPathOutsideBase(entry.fullPath, basePath) ||
      needsJsWriter(entry.fullPath, entry.kind)
  );
  const parsedInside = (wparsed || []).filter(
    (entry) =>
      classifyEntry(entry) !== 'create' &&
      !isResolvedPathOutsideBase(parsedEntryResolvedPath(entry, basePath), basePath) &&
      !needsJsWriter(parsedEntryResolvedPath(entry, basePath), classifyEntry(entry))
  );
  let executor = 'native-patch';
  if (jsEntries.length > 0 || nativeEntries.length === 0) {
    executor = nativeEntries.length > 0 ? 'native+js-patch' : 'js-patch';
  }
  const resultParts = [];
  if (nativeEntries.length > 0) {
    const nativePatchStr = rewriteHeaderPaths(renderParsedUnifiedPatch(parsedInside), whr);
    const nativeResult = await dispatchNativePatch({
      entries: nativeEntries,
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
  if (jsEntries.length > 0) {
    // Create-only and out-of-base targets use the JS dispatcher. Out-of-base
    // write permission is enforced at the hook layer.
    const jsResult = await dispatchJsPatchEntries({
      rows: jsEntries,
      parsed: wparsed,
      basePath,
      dryRun,
      fuzzy,
      readStateScope,
      signal: abortSignal,
    });
    if (isPatchErrorText(jsResult)) return { executor, error: jsResult };
    resultParts.push(jsResult);
  }
  if (protectedDeletes.length > 0) {
    const quarantine = deleteQuarantine || createDeleteQuarantine();
    try {
      quarantineDeleteTargets(quarantine, protectedDeletes, { readStateScope });
    } catch (err) {
      return { executor, error: `Error: ${err?.message || String(err)}` };
    }
    const leftovers = deleteQuarantine ? [] : commitDeleteQuarantine(quarantine);
    resultParts.push(formatQuarantinedDeletes(protectedDeletes, leftovers));
  }
  return { executor, text: resultParts.join('\n') };
}
