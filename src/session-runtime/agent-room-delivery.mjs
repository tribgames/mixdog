/**
 * Group-room rows into a room's log session (`sess_room_<id>`,
 * session/agent-room.mjs). The desktop host drives the room and posts each row
 * here; the row is appended to the stored session (never a turn: a room log
 * runs none) and shown at once in a runtime hosting it. A row id is its
 * message id, so a retried post adds nothing. A user row's files are taken in
 * here exactly as a chat prompt's are at submit (session-turns.mjs): the bytes
 * go to the attachment store once, and the row keeps their references.
 */
import {
  normalizeRoomRow,
  roomIdOfSession,
  roomRowItem,
  roomRowMessage,
} from '../runtime/agent/orchestrator/session/agent-room.mjs';
import {
  attachmentsForIntake,
  isAttachmentReference,
  materializePromptSubmission,
  preparePromptSubmissionForProvider,
} from '../runtime/attachments/store.mjs';
import { promptContentImageMeta } from '../tui/session/queue-helpers.mjs';
import { agentHomeLiveSurface } from './agent-home-delivery.mjs';

/** A user row with its `upload` taken in: the files as stored references
 *  (`parts`), their attachment records and the bubble's image chips. */
async function storedRow(row) {
  const upload = row?.kind === 'user' && row.upload && typeof row.upload === 'object' ? row.upload : null;
  if (!upload) return row;
  const { upload: _upload, ...rest } = row;
  // The words ride along so the composer's text tokens find their pastes.
  const prompt = [{ type: 'text', text: String(row.text ?? '') }, ...(Array.isArray(upload.parts) ? upload.parts : [])];
  const intake = await preparePromptSubmissionForProvider(
    materializePromptSubmission(prompt, {
      ...(upload.pastedImages ? { pastedImages: upload.pastedImages } : {}),
      ...(upload.pastedTexts ? { pastedTexts: upload.pastedTexts } : {}),
    }),
    // Each member's own intake checks the PDF pages its provider takes.
    { nativePdf: false }
  );
  return {
    ...rest,
    parts: intake.prompt.filter((part) => isAttachmentReference(part) && (part.type !== 'text' || part.textKind)),
    attachments: attachmentsForIntake(intake.prompt, intake.options),
    images: promptContentImageMeta(intake.prompt, intake.options.pastedImages) ?? [],
  };
}

export function createAgentRoomDelivery({ loadSession, saveSession, live = agentHomeLiveSurface, log = () => {} }) {
  /** Append `rows` to the log of `sessionId`; resolves `{ added, rows }`: how
   *  many were new, and every row as stored (files as references, no bytes). */
  async function append(sessionId, rows) {
    if (!roomIdOfSession(sessionId)) throw new TypeError('not a group-room session');
    const kept = (await Promise.all((Array.isArray(rows) ? rows : []).map(storedRow))).map((row) =>
      normalizeRoomRow(row)
    );
    const messages = kept.map((row) => roomRowMessage(row));
    const session = loadSession(sessionId);
    if (!session || session.closed === true) throw new Error(`session ${sessionId} is not available`);
    if (!Array.isArray(session.messages)) session.messages = [];
    const posted = new Set(session.messages.map((message) => message?.meta?.transcript?.messageId).filter(Boolean));
    const fresh = messages.filter((message) => !posted.has(message.meta.transcript.messageId));
    if (!fresh.length) return { added: 0, rows: kept };
    session.messages.push(...fresh);
    session.updatedAt = Date.now();
    await saveSession(session);
    for (const message of fresh) {
      const { text, tone, room, messageId, attachments, images } = roomRowItem(message);
      try {
        live()?.notice?.(sessionId, { text, tone, room, messageId, attachments, images });
      } catch (error) {
        log(`live room row in ${sessionId} failed: ${error?.message || error}`);
      }
    }
    return { added: fresh.length, rows: kept };
  }
  return { append };
}

let processDelivery = null;
/** Daemon entry: post `rows` into the room log `sessionId`. */
export async function appendRoomRows(sessionId, rows) {
  if (!processDelivery) {
    const { loadSession, saveSessionAsync } = await import('../runtime/agent/orchestrator/session/store.mjs');
    processDelivery = createAgentRoomDelivery({
      loadSession,
      saveSession: (session) => saveSessionAsync(session, { expectedGeneration: session.generation }),
      log: (line) => process.stderr.write(`mixdog rooms: ${line}\n`),
    });
  }
  return processDelivery.append(sessionId, rows);
}
