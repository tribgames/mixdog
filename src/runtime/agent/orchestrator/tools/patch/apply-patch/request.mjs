// apply_patch request intake: argument salvage, body/format validation, the
// abort signal, base path and the option flags every execution path shares.
import { getAbortSignalForSession } from '../../../session/abort-lookup.mjs';
import { planApplyPatchMutationRoute } from '../mutation-output.mjs';
import { isCompactedPlaceholderPatch, salvageV4AOpening } from '../parsing.mjs';
import { resolveBasePath } from '../paths.mjs';

// Reject oversized patch bodies before parse / native Buffer.from
// (native-server.mjs Buffer.from(patchText)). A few MB covers any legitimate
// multi-file edit; past this it is a runaway / accidental blob.
const APPLY_PATCH_MAX_BYTES = 8 * 1024 * 1024;

const APPLY_PATCH_SCHEMA_KEYS = new Set([
  'patch',
  'format',
  'base_path',
  'dry_run',
  'reject_partial',
  'fuzzy',
  'sequence',
  'mode',
]);

// A V4A body whose newlines were shattered into stray top-level keys is
// re-joined in key order; every schema key is kept as-is.
function salvageShatteredV4APatchArgs(args) {
  if (!args || typeof args !== 'object') return args;
  const rawPatch = typeof args.patch === 'string' ? args.patch : '';
  if (!rawPatch.startsWith('*** Begin Patch') || rawPatch.includes('\n') || rawPatch.includes('*** End Patch'))
    return args;
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

export async function resolveApplyPatchRequest(rawArgs, cwd, options = {}) {
  const args = salvageShatteredV4APatchArgs(rawArgs);
  let patchStr = typeof args?.patch === 'string' ? args.patch : '';
  patchStr = salvageV4AOpening(patchStr);
  if (!patchStr.trim()) {
    throw new Error('apply_patch: "patch" is required (unified diff or V4A patch string)');
  }
  if (isCompactedPlaceholderPatch(patchStr)) {
    throw new Error(
      'patch body is a compacted-history placeholder ([mixdog compacted …]), not patch content. Submit real patch text; do not reuse or reconstruct the marker.'
    );
  }
  const patchByteLen = Buffer.byteLength(patchStr, 'utf8');
  if (patchByteLen > APPLY_PATCH_MAX_BYTES) {
    throw new Error(
      `apply_patch: patch too large (${patchByteLen} bytes > ${APPLY_PATCH_MAX_BYTES} byte cap); split into smaller patches`
    );
  }
  const requestedFormat = String(args?.format || '').toLowerCase();
  if (requestedFormat && requestedFormat !== 'unified' && requestedFormat !== 'v4a') {
    throw new Error('apply_patch: "format" must be "unified" or "v4a"');
  }
  const mutationPlan = options?.mutationPlan || planApplyPatchMutationRoute(args, patchStr, requestedFormat);
  const readStateScope = options?.readStateScope ?? options?.sessionId ?? null;
  let abortSignal = options?.signal || options?.abortSignal || null;
  if (!abortSignal && options?.sessionId) {
    try {
      abortSignal = await getAbortSignalForSession(options.sessionId);
    } catch {
      abortSignal = null;
    }
  }
  if (abortSignal?.aborted) {
    throw new Error(abortSignal.reason?.message || abortSignal.reason || 'apply_patch aborted');
  }
  const basePath = resolveBasePath(cwd, args?.base_path);
  const fuzzy = args?.fuzzy !== false;
  return {
    args,
    patchStr,
    requestedFormat,
    mutationPlan,
    readStateScope,
    abortSignal,
    basePath,
    rejectPartial: args?.reject_partial !== false,
    dryRun: args?.dry_run === true,
    fuzzy,
    fuzz: fuzzy ? 2 : 0,
  };
}
