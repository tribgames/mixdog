// Transcript route identity is separate from the human-readable model label.
// These pure helpers keep live rows, persisted messages and restored rows on
// the same field contract without rewriting older display-only transcripts.
import { displayModelName } from './model-display.mjs';
import { routineTriggerField } from './routine-trigger.mjs';

export function transcriptRouteMetadataFields(value) {
  if (!value || typeof value !== 'object') return {};
  return {
    ...(typeof value.modelId === 'string' && value.modelId ? { modelId: value.modelId } : {}),
    ...(typeof value.model === 'string' && value.model ? { model: value.model } : {}),
    ...(typeof value.provider === 'string' && value.provider ? { provider: value.provider } : {}),
    ...(typeof value.agent === 'string' && value.agent ? { agent: value.agent } : {}),
  };
}

export function createTranscriptRouteMetadata(session, route = {}, at = Date.now()) {
  const provider = String(session?.provider || route.provider || '').trim();
  const modelId = String(session?.model || route.model || '').trim();
  const model = displayModelName(modelId, provider);
  const agent = String(route.workflow?.name || route.workflow?.id || '').trim();
  return { at, ...transcriptRouteMetadataFields({ modelId, model, provider, agent }) };
}

const ATTACHMENT_ID = /^[a-f0-9]{64}$/;
const ATTACHMENT_KINDS = new Set(['image', 'file', 'text']);

/**
 * The attachments a user message carries (`meta.transcript.attachments`):
 * `[{ id, attachmentRef, kind, name, mimeType, size }]`, the id being the
 * content hash under which the attachment store keeps the bytes. Anything that
 * is not a well-formed record is dropped, so a row never names an id the store
 * could not hold. Each record repeats the hash under `attachmentRef` — the
 * key the store's census marks as referenced.
 */
export function normalizeMessageAttachments(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    const id = typeof raw?.id === 'string' ? raw.id : '';
    if (!ATTACHMENT_ID.test(id) || seen.has(id) || out.length >= 64) continue;
    seen.add(id);
    out.push({
      id,
      attachmentRef: id,
      kind: ATTACHMENT_KINDS.has(raw.kind) ? raw.kind : 'file',
      name: String(raw.name || 'attachment').slice(0, 200),
      mimeType: String(raw.mimeType || 'application/octet-stream').slice(0, 100),
      size: Number.isFinite(Number(raw.size)) && Number(raw.size) >= 0 ? Number(raw.size) : 0,
    });
  }
  return out;
}

/**
 * Who a user-kind row came from, as the row's own fields: the sender, the
 * submitting device and the bot that sent it. One definition for the delivered
 * steering row and the still-queued one, so both render the same.
 */
export function transcriptSourceFields(value) {
  if (!value || typeof value !== 'object') return {};
  return {
    ...(typeof value.sender === 'string' && value.sender ? { sender: value.sender } : {}),
    ...(typeof value.device === 'string' && value.device ? { device: value.device } : {}),
    ...(typeof value.fromAgent === 'string' && value.fromAgent ? { fromAgent: value.fromAgent } : {}),
  };
}

/** A new stable message id (`meta.transcript.messageId`). */
export function newTranscriptMessageId() {
  return `msg_${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
}

export const stableMessageId = (value) => (typeof value === 'string' && value ? value : newTranscriptMessageId());

// Every persisted prompt/reply carries a stable `messageId` from creation on.
// Compaction rewrites copy `meta`, so the id survives them; the display-only
// compaction archive and a live view tell dropped rows from rewritten ones
// by it. A surface that drew the row first passes its id in.
export function persistedUserTranscriptMetadata(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    messageId: stableMessageId(value.messageId),
    ...(typeof value.attemptId === 'string' && value.attemptId ? { attemptId: value.attemptId } : {}),
    ...(Number.isFinite(Number(value.at)) ? { at: Number(value.at) } : {}),
    ...transcriptRouteMetadataFields(value),
    // Sender, the submitting device (host-stamped display name) and the bot
    // that sent this message to this session (agent-task-sessions.mjs).
    ...transcriptSourceFields(value),
    // Bot-to-bot chain position of a bot's message (session-runtime/bot-hops.mjs).
    ...(Number.isInteger(value.hop) && value.hop > 0 ? { hop: value.hop } : {}),
    // The turn's change-record key (the outer prompt id), so a restored user
    // row still addresses its turn's Undo/Reapply.
    ...(typeof value.checkpointId === 'string' && value.checkpointId ? { checkpointId: value.checkpointId } : {}),
    // Every submission a merged queued batch delivered as this turn.
    ...submissionIdsField(value.submissionIds),
    // The executions a woken batch delivered (session-flow/drain.mjs): the
    // provenance a task session's report follows (agent-task-sessions.mjs).
    ...consumedExecutionIdsField(value.consumedExecutionIds),
    ...attachmentsField(value.attachments),
    // A routine fire delivered as this turn (routine-trigger.mjs).
    ...routineTriggerField(value),
  };
}

function submissionIdsField(value) {
  const ids = Array.isArray(value) ? value.filter((id) => typeof id === 'string' && id) : [];
  return ids.length ? { submissionIds: ids } : {};
}

// Positions are kept: a null stands for a delivered entry that named no execution.
function consumedExecutionIdsField(value) {
  if (!Array.isArray(value) || !value.length) return {};
  return { consumedExecutionIds: value.map((id) => (typeof id === 'string' && id ? id : null)) };
}

function attachmentsField(value) {
  const attachments = normalizeMessageAttachments(value);
  return attachments.length ? { attachments } : {};
}

/** The `attachments` field of a transcript row (absent when there are none). */
export function transcriptAttachmentFields(value) {
  return attachmentsField(value?.attachments);
}

const REACTOR_ID = /^[A-Za-z0-9._-]{1,80}$/;

/**
 * The bots' reactions on a user message (`meta.transcript.reactions`):
 * `[{ agentId, emoji, at }]`, one per bot, in the order they were left.
 * Malformed entries and a bot's repeats are dropped.
 */
export function normalizeMessageReactions(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const raw of value) {
    const agentId = typeof raw?.agentId === 'string' ? raw.agentId : '';
    const emoji = typeof raw?.emoji === 'string' ? raw.emoji : '';
    if (!REACTOR_ID.test(agentId) || !emoji || emoji.length > 16 || out.some((entry) => entry.agentId === agentId)) {
      continue;
    }
    out.push({ agentId, emoji, ...(Number.isFinite(raw.at) ? { at: raw.at } : {}) });
  }
  return out;
}

/** The `reactions` field of a transcript row (absent when there are none). */
export function transcriptReactionsField(value) {
  const reactions = normalizeMessageReactions(value?.reactions);
  return reactions.length ? { reactions } : {};
}

export function persistedAssistantTranscriptMetadata(value, fallbackAt = Date.now()) {
  if (!value || typeof value !== 'object') return null;
  const candidateAt = Number(value.assistantAt);
  const assistantAt = Number.isFinite(candidateAt) && candidateAt > 0 ? candidateAt : fallbackAt;
  value.assistantAt = assistantAt;
  value.assistantMessageId = stableMessageId(value.assistantMessageId);
  return {
    messageId: value.assistantMessageId,
    at: assistantAt,
    ...(typeof value.attemptId === 'string' && value.attemptId ? { attemptId: value.attemptId } : {}),
    ...transcriptRouteMetadataFields(value),
  };
}
