/**
 * Group-room rows into a room's log session (`sess_room_<id>`,
 * session/agent-room.mjs). The desktop host drives the room and posts each row
 * here; the row is appended to the stored session (never a turn: a room log
 * runs none) and shown at once in a runtime hosting it. A row id is its
 * message id, so a retried post adds nothing. A user row's files are taken in
 * here exactly as a chat prompt's are at submit (session-turns.mjs): the bytes
 * go to the attachment store once, and the row keeps their references.
 * Posts into one log run one at a time, so no two posts overwrite each other.
 */
import {
  normalizeRoomRow,
  roomIdOfSession,
  roomMemberOfSession,
  roomRowItem,
  roomRowMessage,
} from '../runtime/agent/orchestrator/session/agent-room.mjs';
import { reactInSession } from '../runtime/agent/orchestrator/session/message-reactions.mjs';
import { artifactRecords } from '../runtime/shared/handoff-artifacts.mjs';
import { collectTurnArtifacts, sessionRoots, turnSlice } from './handoff-attachments.mjs';
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

/** A member's speech with the files its turn produced taken in: `artifactsFrom`
 *  `{ sessionId, since }` names the member's own session in this room and when
 *  its turn started; the files inside that session's folders are stored and
 *  ride on the row as references (handoff-attachments.mjs). */
function speechWithArtifacts(row, roomId, loadSession, log) {
  const from =
    row?.kind === 'speech' && row.artifactsFrom && typeof row.artifactsFrom === 'object' ? row.artifactsFrom : null;
  if (!from) return row;
  const { artifactsFrom: _from, ...rest } = row;
  const member = roomMemberOfSession(String(from.sessionId || ''));
  if (!member || member.roomId !== roomId || member.agentId !== row.speaker) return rest;
  try {
    const session = loadSession(from.sessionId);
    const messages = turnSlice(session?.messages, { since: Number(from.since) || 0 });
    const { files } = collectTurnArtifacts(messages, { cwd: session?.cwd, roots: sessionRoots(session) });
    return { ...rest, ...storedFileFields(files) };
  } catch (error) {
    log(`the files of ${from.sessionId} could not be taken in: ${error?.message || error}`);
    return rest;
  }
}

/** A row's `{ parts, attachments }` for the stored files among `files`
 *  (handoff-attachments.mjs collectTurnArtifacts); none when none is stored. */
function storedFileFields(files) {
  const stored = (Array.isArray(files) ? files : []).filter((file) => file?.id);
  if (!stored.length) return {};
  return {
    parts: stored.map((file) => ({
      type: file.kind === 'image' ? 'image' : file.kind === 'text' ? 'text' : 'file',
      attachmentRef: file.id,
      ...(file.kind === 'text' ? { textKind: 'file' } : {}),
      mimeType: file.mimeType,
      filename: file.name,
      sizeBytes: file.size,
    })),
    attachments: artifactRecords(stored),
  };
}

export function createAgentRoomDelivery({ loadSession, saveSession, live = agentHomeLiveSurface, log = () => {} }) {
  const tails = new Map(); // log session → its last post
  /** Run `post` after every earlier post into `sessionId`. */
  function serialized(sessionId, post) {
    const run = (tails.get(sessionId) || Promise.resolve()).then(post);
    const tail = run.catch(() => {});
    tails.set(sessionId, tail);
    void tail.then(() => {
      if (tails.get(sessionId) === tail) tails.delete(sessionId);
    });
    return run;
  }

  /** Append the normalized rows `build(session)` gives to the stored log
   *  `sessionId`; runs inside `serialized`, so no other post overlaps it. */
  async function commit(sessionId, build) {
    const session = loadSession(sessionId);
    if (!session || session.closed === true) throw new Error(`session ${sessionId} is not available`);
    if (!Array.isArray(session.messages)) session.messages = [];
    const kept = build(session);
    const messages = kept.map((row) => roomRowMessage(row));
    const posted = new Set(session.messages.map((message) => message?.meta?.transcript?.messageId).filter(Boolean));
    // An id seen earlier in this batch counts as posted too: one row, once.
    const fresh = messages.filter((message) => {
      const { messageId } = message.meta.transcript;
      if (posted.has(messageId)) return false;
      posted.add(messageId);
      return true;
    });
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

  /** Append `rows` to the log of `sessionId`; resolves `{ added, rows }`: how
   *  many were new, and every row as stored (files as references, no bytes).
   *  The post takes its place in the queue before the files are taken in, so
   *  a later post cannot overtake it while they are. */
  async function append(sessionId, rows) {
    const roomId = roomIdOfSession(sessionId);
    if (!roomId) throw new TypeError('not a group-room session');
    return serialized(sessionId, async () => {
      const prepared = (
        await Promise.all(
          (Array.isArray(rows) ? rows : []).map((row) => storedRow(speechWithArtifacts(row, roomId, loadSession, log)))
        )
      ).map((row) => normalizeRoomRow(row));
      return commit(sessionId, () => prepared);
    });
  }

  /** A member's reaction (`change`: message-reactions.mjs reactToMessage's,
   *  members never repeating one another's emoji) on a user row of the log
   *  `sessionId`, in line with the posts; a room open in a window shows it at
   *  once. Resolves reactToMessage's result. */
  async function react(sessionId, change) {
    if (!roomIdOfSession(sessionId)) throw new TypeError('not a group-room session');
    return serialized(sessionId, async () => {
      const session = loadSession(sessionId);
      if (!session || session.closed === true) throw new Error(`session ${sessionId} is not available`);
      const result = reactInSession(session, { ...change, othersKeep: true });
      if (!result.changed) return result;
      await saveSession(session);
      try {
        live()?.react?.(sessionId, result.messageId, result.reactions);
      } catch (error) {
        log(`live reaction in ${sessionId} failed: ${error?.message || error}`);
      }
      return result;
    });
  }
  return { append, react };
}

let processDelivery = null;
/** The process's one delivery. The initialization promise is cached before it
 *  is awaited, so concurrent first callers share one instance (one `tails`
 *  queue per log); a failed import is not cached. */
function roomDelivery() {
  processDelivery ??= import('../runtime/agent/orchestrator/session/store.mjs')
    .then(({ loadSession, saveSessionAsync }) =>
      createAgentRoomDelivery({
        loadSession,
        saveSession: (session) => saveSessionAsync(session, { expectedGeneration: session.generation }),
        log: (line) => process.stderr.write(`mixdog rooms: ${line}\n`),
      })
    )
    .catch((error) => {
      processDelivery = null;
      throw error;
    });
  return processDelivery;
}

/** Daemon entry: post `rows` into the room log `sessionId`. */
export async function appendRoomRows(sessionId, rows) {
  return (await roomDelivery()).append(sessionId, rows);
}

/** Daemon entry: a member's reaction on a user row of the room log `sessionId`. */
export async function reactInRoom(sessionId, change) {
  return (await roomDelivery()).react(sessionId, change);
}
