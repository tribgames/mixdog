// sweep/sub-agent-retention.mjs
// Retention of finished sub-agent sessions: the agent-only children (Worker,
// Reviewer, ...) a Lead's agents spawn, each its own stored session. The idle
// sweep names every sub-agent record with its STORED activity time (the clock
// survives restarts); a tree — a top sub-agent under a Lead with every
// sub-agent below it — is archived once each member is idle
// SUB_AGENT_ARCHIVE_AFTER_MS and deleted once each is idle
// SUB_AGENT_DELETE_AFTER_MS. Otherwise the whole tree stays as it is.
// Never a member: a root Lead, a task session from `session create`, a bot
// home chat or a group room's log/member session.
import { agentParentIds, isAgentOnlySession, isRootLeadSession } from '../../store-summary-visibility.mjs';
import { probePath, PROBE_PRESENT } from '../fs-probe.mjs';
import { sessionPath } from '../session-paths.mjs';
import { _queueSummaryIndexPrune } from '../summary-cache.mjs';
import { deleteSession } from '../session-delete.mjs';
import { readSweepRecord } from './sweep-record.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
export const SUB_AGENT_ARCHIVE_AFTER_MS = 3 * DAY_MS;
export const SUB_AGENT_DELETE_AFTER_MS = 30 * DAY_MS;
const PERMANENT_ID = /^sess_(?:home|room|rmem)_/;
// The desktop change an automatic archive applies: that one session, no
// cascade (an explicit archive of a parent takes its sub-agents along).
export const SUB_AGENT_AUTO_ARCHIVE = Object.freeze({ archived: true, cascade: false });

const positive = (value) => (Number(value) > 0 ? Number(value) : 0);

/** Last activity of a stored record: its last conversation turn (`lastUsedAt`;
 *  `updatedAt` also moves on detach/resume bookkeeping) or its heartbeat. */
export function subAgentActivityAt(doc) {
  return Math.max(
    positive(doc?.lastUsedAt) || positive(doc?.updatedAt) || positive(doc?.createdAt),
    positive(doc?.lastHeartbeatAt)
  );
}

/** `{ id, parentIds, lastActive }` for a sub-agent record (open or closed);
 *  null for anything else. `parentIds` are the owner and parent links the
 *  record names (agentParentIds), the same ones an archive cascade follows. */
export function subAgentMember(id, doc) {
  if (!doc || PERMANENT_ID.test(id) || doc.taskOrigin) return null;
  if (isRootLeadSession(doc) || !isAgentOnlySession(doc)) return null;
  return { id, parentIds: agentParentIds({ ...doc, id }), lastActive: subAgentActivityAt(doc) };
}

/** The members grouped into trees: members joined by any owner/parent link
 *  between them (a link to a non-member joins nothing), each tree listing a
 *  top member (no member parent) first and its members below in link order. */
export function subAgentTrees(members) {
  const byId = new Map(members.map((member) => [member.id, member]));
  const links = new Map(members.map((member) => [member.id, new Set()]));
  const hasMemberParent = new Set();
  for (const member of members) {
    for (const parent of (member.parentIds || []).filter((parentId) => byId.has(parentId))) {
      links.get(member.id).add(parent);
      links.get(parent).add(member.id);
      hasMemberParent.add(member.id);
    }
  }
  const seen = new Set();
  const trees = [];
  for (const start of [...members.filter((m) => !hasMemberParent.has(m.id)), ...members]) {
    if (seen.has(start.id)) continue;
    const tree = [start];
    seen.add(start.id);
    for (let index = 0; index < tree.length; index++) {
      for (const id of links.get(tree[index].id)) {
        if (seen.has(id)) continue;
        seen.add(id);
        tree.push(byId.get(id));
      }
    }
    trees.push(tree);
  }
  return trees;
}

/** The stored activity time of `id` now; null when its record cannot be read. */
function storedActivityAt(id) {
  const path = sessionPath(id);
  const probe = probePath(path);
  if (probe.state !== PROBE_PRESENT) return null;
  const record = readSweepRecord(id, path, probe);
  return record?.id === id ? subAgentActivityAt(record.doc) : null;
}

/**
 * Archives or deletes each idle tree. A tree with a member running here
 * (`isSessionLive`), or one whose stored activity moved since the sweep read
 * it, is left alone. An archive goes through the desktop's archive flag
 * (`setSidebar(id, SUB_AGENT_AUTO_ARCHIVE)`: exactly the members not yet
 * archived, never a cascade past them — needs
 * `isArchived`, the desktop's flags); a deleted member that was archived loses
 * its flag (`{ forgotten: true }`). Returns `{ archived, deleted }` (ids).
 */
export async function applySubAgentRetention(
  members,
  { isSessionLive = null, isArchived = null, setSidebar = null, now = Date.now() } = {}
) {
  const archived = [];
  const deleted = [];
  for (const tree of subAgentTrees(members)) {
    // A member of unknown age (no valid stored timestamp) keeps its tree.
    if (!tree.every((member) => Number.isFinite(member.lastActive) && member.lastActive > 0)) continue;
    const idle = now - Math.max(...tree.map((member) => member.lastActive));
    const expired = idle >= SUB_AGENT_DELETE_AFTER_MS;
    if (!expired && (idle < SUB_AGENT_ARCHIVE_AFTER_MS || !isArchived)) continue;
    if (tree.some((member) => isSessionLive?.(member.id))) continue;
    if (tree.some((member) => storedActivityAt(member.id) !== member.lastActive)) continue;
    if (expired) {
      for (const { id } of tree.toReversed()) {
        try {
          if (deleteSession(id, { deferSummaryUpdate: true, isSessionLive, legacyOwnerVeto: true })) deleted.push(id);
        } catch {
          /* kept; the next pass decides again */
        }
      }
      continue;
    }
    for (const { id } of tree) {
      if (isArchived(id)) continue;
      try {
        await setSidebar(id, SUB_AGENT_AUTO_ARCHIVE);
        archived.push(id);
      } catch {
        /* not archived; the next pass decides again */
      }
    }
  }
  if (deleted.length) _queueSummaryIndexPrune(new Set(deleted));
  for (const id of deleted) {
    if (!isArchived?.(id)) continue;
    try {
      await setSidebar(id, { forgotten: true });
    } catch {
      /* a stale archive stamp hides nothing */
    }
  }
  return { archived, deleted };
}
