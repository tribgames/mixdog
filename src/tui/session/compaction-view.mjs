/**
 * src/tui/session/compaction-view.mjs - the visible transcript across a
 * compaction. The rows the compaction took out of the model context stay in
 * view, marked `archived` (display-only: greyed, no model-state actions), and
 * the completion row becomes the "compacted" divider at the boundary.
 *
 * The model transcript itself belongs to runtime.compact / the pre-send pass;
 * the durable copy of the dropped rows is the runtime's compaction archive.
 */
import { COMPACTION_DIVIDER_LABEL } from '../../runtime/agent/orchestrator/session/compaction-archive.mjs';

function isCompactionDivider(item) {
  return item?.kind === 'statusdone' && item.status === 'compacted';
}

function archivedItem(item) {
  if (!item || typeof item !== 'object' || item.archived === true || isCompactionDivider(item)) return item;
  return { ...item, archived: true };
}

/** `divider` (id, detail) as the compaction boundary row. Every path — manual,
 *  auto-clear, mid-turn — and the persisted archive carry the one compaction
 *  label; the stats stay in `detail`. */
function compactionDividerItem(item) {
  return {
    ...item,
    kind: 'statusdone',
    status: 'compacted',
    label: COMPACTION_DIVIDER_LABEL,
    at: item?.at ?? Date.now(),
  };
}

/** Row kinds a transcript message backs (prompt, reply, tool card). */
const MESSAGE_ROW_KINDS = new Set(['user', 'assistant', 'tool']);

const idSet = (values) => new Set(Array.isArray(values) ? values.filter((value) => value != null) : []);

/** The tool calls a tool row shows: its own call, a restored aggregate's
 *  calls, a live aggregate's members (whose ids are their call ids). */
function toolCallIdsOfItem(item) {
  if (item?.kind !== 'tool') return [];
  if (item.callId) return [String(item.callId)];
  if (Array.isArray(item.callIds) && item.callIds.length) return item.callIds.filter(Boolean).map(String);
  if (item.aggregate === true && Array.isArray(item.toolMembers)) {
    return item.toolMembers
      .map((member) => member?.id)
      .filter((id) => id != null)
      .map(String);
  }
  return [];
}

/**
 * Which rows a compaction took out of the model context, from the result or
 * event it reported:
 *  - `droppedIdentities` ({ messageIds, callIds }) — whenever supplied,
 *    whatever `droppedMessages` says — by id membership only:
 *    a tool row whose calls all left (or, without call ids, whose message
 *    id left); any other row with a message of its own (prompt, reply,
 *    notification, restored marker) whose message id left — a prompt,
 *    reply or tool row without an id stays live. Only a row with no
 *    message of its own (a live completion, notice or status row) follows
 *    its turn's prompt;
 *  - no identities and `droppedMessages: 0` (a rewrite-only pass): none;
 *  - neither (a source that reports nothing): every row.
 * Returns a predicate over the rows before the boundary, in order.
 */
export function compactionArchivedRows(result) {
  const identities = result?.droppedIdentities;
  // Identities decide when supplied: a kept message can still have lost
  // part of itself (its text, some calls) with no message fully dropped.
  // The count is only the fallback for a source without identities.
  if (!identities || typeof identities !== 'object') {
    const count = result?.droppedMessages;
    return count !== undefined && count !== null && !(Number(count) > 0) ? () => false : () => true;
  }
  const messageIds = idSet(identities.messageIds);
  const callIds = idSet(identities.callIds);
  let promptDropped = false;
  const predicate = (item) => {
    if (!item || typeof item !== 'object') return false;
    const calls = toolCallIdsOfItem(item);
    let dropped;
    if (calls.length) dropped = calls.every((id) => callIds.has(id));
    // A message-backed row is decided by its own id alone: one without an id
    // has no display identity in the result and stays live.
    else if (item.messageId || MESSAGE_ROW_KINDS.has(item.kind)) {
      dropped = Boolean(item.messageId) && messageIds.has(item.messageId);
    }
    // Only an auxiliary row (no message of its own) follows its turn.
    else return promptDropped;
    if (item.kind === 'user') promptDropped = dropped;
    return dropped;
  };
  // An aggregate row some of whose calls survive stays live, with its dropped
  // members marked archived (the restart path archives exactly those calls).
  predicate.markDroppedMembers = (item) => {
    if (item?.kind !== 'tool' || item.aggregate !== true || !Array.isArray(item.toolMembers)) return item;
    if (!item.toolMembers.some((member) => member?.id != null && callIds.has(String(member.id)))) return item;
    return {
      ...item,
      toolMembers: item.toolMembers.map((member) =>
        member?.id != null && callIds.has(String(member.id)) && member.archived !== true
          ? { ...member, archived: true }
          : member
      ),
    };
  };
  return predicate;
}

function classifiedRow(item, archived) {
  if (archived(item)) return archivedItem(item);
  return typeof archived.markDroppedMembers === 'function' ? archived.markDroppedMembers(item) : item;
}

/** Items with the rows before `boundary` (default: all) that `archived`
 *  selects marked archived, and the divider inserted at the boundary.
 *  Returns the next list and the divider's index. */
export function archiveItemsForCompaction(
  items,
  divider,
  boundary = null,
  { archived = () => true, archiveTail = false } = {}
) {
  const list = Array.isArray(items) ? items : [];
  const at = Number.isInteger(boundary) ? Math.max(0, Math.min(list.length, boundary)) : list.length;
  const next = list.slice(0, at).map((item) => classifiedRow(item, archived));
  next.push(compactionDividerItem(divider));
  // The current turn's rows after the boundary stay in place but are still
  // classified by the same result: what compaction explicitly dropped from
  // this turn (its tool calls) is archived, the rest stays live.
  for (let index = at; index < list.length; index += 1) {
    next.push(archiveTail ? classifiedRow(list[index], archived) : list[index]);
  }
  return { items: next, dividerIndex: at };
}

/** The runtime archive range a resumed session exposes to paged views
 *  (`transcriptArchive` state), or null. */
export function resumedTranscriptArchive(range) {
  const after = Number(range?.after);
  const before = Number(range?.before);
  if (!Number.isInteger(after) || !Number.isInteger(before) || before - 1 <= after) return null;
  return { after, before };
}
