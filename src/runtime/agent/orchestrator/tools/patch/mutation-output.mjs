// Mutation-route planning and the model-surface output wrapper shared by the
// Codex batch and the ordered sequence.
import { hasUnifiedBareV4AHunk, isV4APatchInput } from './parsing.mjs';
import { drainV4AAmbiguityNotices } from './v4a-convert.mjs';

export function planApplyPatchMutationRoute(_args, patchStr, requestedFormat) {
  const v4aInput =
    isV4APatchInput(patchStr, requestedFormat) || (requestedFormat !== 'unified' && hasUnifiedBareV4AHunk(patchStr));
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
export function wrapPatchMutationOutput(text, _plan, _extras = {}) {
  // Per-file success rows already identify the edits; retain warnings/errors.
  text = text.replace(/^Applied \d+ Files? \((?:Native|JS)\)\r?\n(?= {2}OK )/gm, '');
  // Non-fatal duplicate-context notices ride the success output: the edit
  // landed at the first match (spec), and the caller learns in the same turn
  // that another location was possible.
  const notices = drainV4AAmbiguityNotices();
  if (notices.length === 0) return text;
  return `${text}\n${notices.map((notice) => `⚠️ ${notice}`).join('\n')}`;
}
