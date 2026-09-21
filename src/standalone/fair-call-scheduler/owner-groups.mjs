/**
 * fair-call-scheduler/owner-groups.mjs — per-owner queues and the fairness
 * arithmetic over them: weighted queue shares, the largest borrower to evict
 * from, and smooth weighted round-robin selection.
 */
import { positiveInt } from '../../runtime/shared/numbers.mjs';

function ownerId(value) {
  const clean = String(value || '').trim();
  return clean ? clean.slice(0, 240) : 'anonymous';
}

export function createOwnerGroups({ maxQueued, ownerFloor }) {
  const groups = new Map();

  function groupFor(owner, weight = 1) {
    const id = ownerId(owner);
    let group = groups.get(id);
    if (!group) {
      group = {
        owner: id,
        weight: positiveInt(weight, 1),
        current: 0,
        active: 0,
        queue: [],
      };
      groups.set(id, group);
    } else if (weight !== undefined) {
      group.weight = positiveInt(weight, group.weight);
    }
    return group;
  }

  function maybeDeleteGroup(group) {
    if (group && group.active === 0 && group.queue.length === 0) groups.delete(group.owner);
  }

  function queuedGroups(extra = null) {
    const out = [];
    for (const group of groups.values()) {
      if (group.queue.length > 0 || group === extra) out.push(group);
    }
    if (extra && !out.includes(extra)) out.push(extra);
    return out;
  }

  /** The other owner holding the longest queue above the floor, if any. */
  function largestBorrower(incoming) {
    let borrower = null;
    for (const group of groups.values()) {
      if (group === incoming || group.queue.length <= ownerFloor) continue;
      if (!borrower || group.queue.length > borrower.queue.length) borrower = group;
    }
    return borrower;
  }

  function hasCompetitor(group) {
    return queuedGroups(group).some((candidate) => candidate !== group && candidate.queue.length > 0);
  }

  function fairQueueLimit(group) {
    const contenders = queuedGroups(group);
    if (contenders.length <= 1) return maxQueued;
    const totalWeight = contenders.reduce((sum, candidate) => sum + candidate.weight, 0);
    return Math.max(ownerFloor, Math.floor((maxQueued * group.weight) / Math.max(1, totalWeight)));
  }

  function pickGroup() {
    const ready = queuedGroups();
    if (ready.length === 0) return null;
    const totalWeight = ready.reduce((sum, group) => sum + group.weight, 0);
    let chosen = null;
    for (const group of ready) {
      group.current += group.weight;
      if (!chosen || group.current > chosen.current) chosen = group;
    }
    chosen.current -= totalWeight;
    return chosen;
  }

  return {
    all: () => groups.values(),
    groupFor,
    maybeDeleteGroup,
    largestBorrower,
    hasCompetitor,
    fairQueueLimit,
    pickGroup,
  };
}
