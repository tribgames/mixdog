// Execution-path selection: the model-visible default validates the complete
// patch before writing (Codex batch); a standalone V4A move takes the atomic
// rename executor, and a multi-file model-surface patch or an explicit
// ordered/sequence mode takes the ordered section sequence.
import { isV4APatchInput, parseV4APatch } from '../parsing.mjs';
import { pathKey, resolveV4AEntryPath } from '../paths.mjs';
import { rewriteV4AReadRedirects } from '../read-redirects.mjs';
import { isV4ARenameSection } from '../v4a-convert.mjs';

export function selectApplyPatchRoute({ args, patchStr, requestedFormat, basePath, readStateScope }) {
  let preParsedV4ASections = null;
  if (isV4APatchInput(patchStr, requestedFormat)) {
    try {
      preParsedV4ASections = rewriteV4AReadRedirects(parseV4APatch(patchStr), basePath, readStateScope);
    } catch {
      // The selected execution path reports the authoritative parse error.
    }
  }
  // The freeform tool surface intentionally exposes only the patch body, not
  // internal mode switches. Route a standalone move to the existing atomic
  // rename executor automatically so the advertised `*** Move to:` grammar is
  // actually callable. Mixed patches stay ordered and tell the caller to retry
  // the move as its own section.
  const modelSurfaceRenameOnly = preParsedV4ASections?.length === 1 && isV4ARenameSection(preParsedV4ASections[0]);
  const modelSurfaceFilePartial =
    Array.isArray(preParsedV4ASections) &&
    !preParsedV4ASections.some(isV4ARenameSection) &&
    new Set(preParsedV4ASections.map((section) => pathKey(resolveV4AEntryPath(basePath, section.path)))).size > 1;
  // The model-visible default matches Codex: validate the complete patch before
  // writing and reject duplicate targets. Ordered partial application remains
  // an internal compatibility mode only.
  const patchMode = String(args?.mode || '').toLowerCase();
  const orderedSequenceMode = args?.sequence === true || ['ordered', 'sequence'].includes(patchMode);
  return {
    preParsedV4ASections,
    useSequence: (orderedSequenceMode || modelSurfaceFilePartial) && !modelSurfaceRenameOnly,
    // A model-surface multi-file patch keeps going past a rejected file and
    // merges repeated sections per file; explicit ordered mode does neither.
    filePartial: modelSurfaceFilePartial && !orderedSequenceMode,
  };
}
