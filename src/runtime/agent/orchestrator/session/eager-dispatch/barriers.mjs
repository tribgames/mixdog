// Intra-turn ordering barriers for eager calls. Calls execute in parallel
// except that same-file edits chain per path, repository-wide Git writes
// serialize against file edits, and shell waits for every earlier mutation
// and is skipped when one of them failed.
import { resolve as pathResolve } from 'node:path';
import { _isEditTool, _isGitMutationTool, _isMutationTool, _isShellTool } from '../loop/tool-classify.mjs';
import { classifyResultKind } from '../result-classification.mjs';
import { normalizeToolEnvelope } from '../tool-envelope.mjs';

function eagerSettlementFailed(settled) {
  if (!settled?.ok) return true;
  try {
    const normalized = normalizeToolEnvelope(settled.value);
    if (normalized.explicitFailure) return true;
    return classifyResultKind(normalized.result, normalized.explicitSuccess) === 'error';
  } catch {
    return true;
  }
}

const settledQuietly = (promise) =>
  promise.then(
    () => undefined,
    () => undefined
  );

export function createEagerBarriers({ cwd }) {
  // Cumulative success barrier for patches already emitted in this
  // assistant turn. Patches remain path-parallel with each other; a later
  // shell waits for all of them and is skipped if any patch failed.
  let patchBarrier = Promise.resolve({ failedPatchIds: [] });
  // Exact-string edits are single-replacement calls. Same-FILE edits in
  // one model turn must observe prior writes, so each target path keeps
  // its own barrier chain; DIFFERENT files stay parallel (a single global
  // chain here serialized every edit in the turn — user report: batched
  // multi-file edits ran one by one). An edit whose target path cannot be
  // determined serializes against every prior edit, and later edits on
  // any path wait for it (conservative fallback).
  const editBarriersByPath = new Map();
  let editBarrierPathless = Promise.resolve();
  // Git mutations have repository-wide effects. They wait for earlier
  // file edits, and later edits/shell verification wait for them.
  let gitMutationBarrier = Promise.resolve();

  const _editPathKey = (args) => {
    const raw = args && typeof args === 'object' ? (args.file_path ?? args.path ?? args.file) : null;
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) return null;
    try {
      // Case-folded + separator-normalized. Merging two spellings of
      // one file is required for correctness; merging two distinct
      // files can only over-serialize, never under-serialize.
      return pathResolve(cwd || '.', text)
        .replace(/\\/g, '/')
        .toLowerCase();
    } catch {
      return null;
    }
  };

  /** What this call must wait for before it executes. */
  function precedingFor(call) {
    const gitMutation = _isGitMutationTool(call.name, call.arguments);
    const mutation = _isMutationTool(call.name, call.arguments);
    const precedingPatches = _isShellTool(call.name) || gitMutation ? patchBarrier : null;
    const precedingGitMutation = _isShellTool(call.name) || mutation ? gitMutationBarrier : null;
    let precedingEdits = null;
    let editPathKey = null;
    if (_isEditTool(call.name)) {
      editPathKey = _editPathKey(call.arguments);
      precedingEdits = editPathKey
        ? Promise.all([editBarriersByPath.get(editPathKey), editBarrierPathless])
        : Promise.all([...editBarriersByPath.values(), editBarrierPathless]);
    }
    return { precedingEdits, precedingGitMutation, precedingPatches, editPathKey, gitMutation, mutation };
  }

  /** Awaits the preceding barriers; returns a skip settlement when an earlier
   *  mutation this call depends on failed, otherwise null. */
  async function waitForPreceding(call, { precedingEdits, precedingGitMutation, precedingPatches }) {
    if (precedingEdits) await precedingEdits;
    if (precedingGitMutation) await precedingGitMutation;
    if (!precedingPatches) return null;
    const patchState = await precedingPatches;
    if (patchState.failedPatchIds.length === 0) return null;
    return {
      ok: true,
      skipped: true,
      value: `[mutation-dependency-guard] \`${call.name}\` skipped because earlier mutation call(s) failed: ${patchState.failedPatchIds.join(', ')}; no verification ran.`,
    };
  }

  /** Chains this call's settlement into the barriers later calls wait on. */
  function register(call, entry, { editPathKey, gitMutation, mutation }) {
    if (_isEditTool(call.name)) {
      const settledEdit = settledQuietly(entry.promise);
      if (editPathKey) {
        editBarriersByPath.set(editPathKey, settledEdit);
      } else {
        // A pathless edit acts as a full barrier: it already waited
        // for every prior chain, so later edits on any path only
        // need to wait for it (they all await editBarrierPathless).
        const priorChains = [...editBarriersByPath.values(), editBarrierPathless];
        editBarrierPathless = settledQuietly(Promise.all([...priorChains, settledEdit]));
      }
    }
    if (mutation) {
      const precedingPatchState = patchBarrier;
      const currentPatch = entry.promise;
      patchBarrier = Promise.all([precedingPatchState, currentPatch]).then(([state, settled]) => ({
        failedPatchIds: eagerSettlementFailed(settled) ? [...state.failedPatchIds, call.id] : state.failedPatchIds,
      }));
    }
    if (gitMutation) {
      gitMutationBarrier = settledQuietly(entry.promise);
    }
  }

  return { precedingFor, waitForPreceding, register };
}
