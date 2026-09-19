// Batch pre-passes that run before any call executes: intra-turn duplicate
// detection (computed before startEagerRun so eager dispatch skips the
// duplicates too), one-call-per-turn Computer Use blocking, and same-anchor
// edit batch grouping.
import { canonicalizeBuiltinToolName, isBuiltinTool } from '../../tools/builtin.mjs';
import { _intraTurnSig } from '../loop/tool-classify.mjs';
import { isSingleCallPerTurnTool, isToolCallDedupEligible } from '../loop/tool-helpers.mjs';

export function planToolBatch(calls, tools) {
  return {
    ...intraTurnDuplicates(calls, tools),
    ...singleCallBlocks(calls),
    editSeqGroups: editSequenceGroups(calls),
  };
}

// Two tool_use blocks with identical (name, args) inside the SAME assistant
// turn: re-executing wastes tokens. Restricted to tools with
// `readOnlyHint:true` plus result-dedup eligibility — loader calls are
// read-only-dispatchable but must execute to report state.
function intraTurnDuplicates(calls, tools) {
  const duplicateCallIds = new Set();
  const dupFirstId = new Map();
  const firstIdBySig = new Map();
  for (const c of calls) {
    if (!c?.id) continue;
    if (!isToolCallDedupEligible(c.name, tools)) {
      firstIdBySig.clear();
      continue;
    }
    const sig = _intraTurnSig(c.name, c.arguments);
    const first = firstIdBySig.get(sig);
    if (first === undefined) {
      firstIdBySig.set(sig, c.id);
    } else {
      duplicateCallIds.add(c.id);
      dupFirstId.set(c.id, first);
    }
  }
  return { duplicateCallIds, dupFirstId };
}

// Stateful Computer Use calls are one-at-a-time. This pre-pass covers
// non-streaming providers while eager-dispatch applies the same guard
// before streamed calls can execute.
function singleCallBlocks(calls) {
  const singleCallBlockedIds = new Set();
  const singleCallFirstIdByName = new Map();
  for (const c of calls) {
    if (!c?.id || !isSingleCallPerTurnTool(c.name)) continue;
    const firstId = singleCallFirstIdByName.get(c.name);
    if (firstId === undefined) singleCallFirstIdByName.set(c.name, c.id);
    else singleCallBlockedIds.add(c.id);
  }
  return { singleCallBlockedIds, singleCallFirstIdByName };
}

// One-shot sequential occupation for same-anchor edit batches: when one
// assistant turn issues N `edit` calls with the SAME file_path+old_string
// (replace_all=false) and N DISTINCT new_strings, the batch as a whole is
// unambiguous — "k-th call → k-th occurrence in document order", the same
// contract apply_patch hunks already have. Members are serialized by the
// eager editBarrier; the serial body re-executes an ambiguity-rejected
// member with the remaining-occurrence count and the str-replace adapter
// consumes the FIRST remaining occurrence. A single ambiguous call (no
// batch siblings) keeps the strict reject.
function editSequenceGroups(calls) {
  const counts = new Map();
  for (const c of calls) {
    if (!isBuiltinTool(c?.name) || canonicalizeBuiltinToolName(c.name) !== 'edit') continue;
    const a = c?.arguments;
    if (!a || typeof a.file_path !== 'string' || typeof a.old_string !== 'string') continue;
    const replaceAll = a.replace_all === true || String(a.replace_all || '').toLowerCase() === 'true';
    if (!a.old_string || replaceAll) continue;
    const key = editSeqKey(a);
    const group = counts.get(key) || { total: 0, newStrings: new Set() };
    group.total += 1;
    group.newStrings.add(String(a.new_string ?? ''));
    counts.set(key, group);
  }
  const groups = new Map();
  for (const [key, group] of counts) {
    if (group.total >= 2 && group.newStrings.size === group.total) {
      groups.set(key, { total: group.total, applied: 0 });
    }
  }
  return groups;
}

function editSeqKey(args) {
  return `${args.file_path}\u0000${args.old_string}`;
}

export function editSeqGroupFor(plan, call) {
  if (plan.editSeqGroups.size === 0 || call?.name !== 'edit') return null;
  const a = call?.arguments;
  if (!a || typeof a.file_path !== 'string' || typeof a.old_string !== 'string') return null;
  return plan.editSeqGroups.get(editSeqKey(a)) || null;
}
