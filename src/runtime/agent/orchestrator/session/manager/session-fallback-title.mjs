// manager/session-fallback-title.mjs
// Durable, transcript-independent fallback title: the first usable
// user-authored prompt, stored on `session.title` so the conversation keeps a
// name after compaction replaces the transcript. Leaf module (no session-crud
// import) so ask-turn-execute, compaction-runner and pre-send-compact can share it.
import { compactSessionTitle } from '../../runtime-core/session-title.mjs';
import { cleanSessionPreview, isSessionPreviewNoise, sessionMessageText } from '../../runtime-core/session-text.mjs';
import { IMPORTED_MESSAGE_SOURCE } from '../imported-message.mjs';
import { isActualUserInstructionMessage } from '../compact/messages.mjs';

const UNTITLED_PLACEHOLDER = /^untitled(?:\s+session)?$/i;
const MEDIA_PLACEHOLDER = /^\[(?:image|video|file)\]$/i;
// Attachment envelopes carry payloads, not prose: closed blocks, then a block
// that lost its closing tag (the rest of the text is payload), then bare
// self-closing tags. Stripped before truncation so a large payload cannot
// crowd the prompt out of the bounded source.
const ATTACHMENT_TAGS = 'file|attachment|document|image|video|pdf';
const ATTACHMENT_BLOCK = new RegExp(`<(${ATTACHMENT_TAGS})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi');
const ATTACHMENT_UNTERMINATED = new RegExp(`<(?:${ATTACHMENT_TAGS})\\b[^>]*>[\\s\\S]*$`, 'i');
const ATTACHMENT_SELF_CLOSING = new RegExp(`<(?:${ATTACHMENT_TAGS})\\b[^>]*\\/>`, 'gi');
const MEDIA_MARKER = /\[(?:Image|Video|File)(?:\s*#?\d+)?(?::[^\]\r\n]*)?\]/gi;

function stripAttachmentEnvelopes(text) {
  return text
    .replace(ATTACHMENT_BLOCK, ' ')
    .replace(ATTACHMENT_SELF_CLOSING, ' ')
    .replace(ATTACHMENT_UNTERMINATED, ' ')
    .replace(MEDIA_MARKER, ' ');
}

function isUsableTitle(title) {
  const text = String(title || '').trim();
  return !!text && !UNTITLED_PLACEHOLDER.test(text);
}

/** Bounded single-line title from user-authored text; '' when nothing usable. */
export function fallbackTitleFromText(content) {
  const raw = sessionMessageText(content);
  if (!raw || /^\s*reference files:/i.test(raw)) return '';
  const prose = stripAttachmentEnvelopes(raw);
  if (isSessionPreviewNoise(prose)) return '';
  const title = compactSessionTitle(cleanSessionPreview(prose, 4_000));
  return isUsableTitle(title) && !MEDIA_PLACEHOLDER.test(title) ? title : '';
}

/** A turn the human typed: provenance lives in `meta` (`source` of an injected
 *  goal/notification/compaction turn, `synthetic`), never on the message root. */
function isHumanAuthoredTurn(message) {
  if (message?.role !== 'user' || message.internal === true || message.synthetic === true) return false;
  const meta = message.meta;
  if (meta && typeof meta === 'object') {
    if (meta.synthetic === true) return false;
    if (meta.source && meta.source !== IMPORTED_MESSAGE_SOURCE) return false;
  }
  return isActualUserInstructionMessage(message);
}

/** Title from the first usable human user message of a transcript. */
export function fallbackTitleFromMessages(messages) {
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isHumanAuthoredTurn(message)) continue;
    const title = fallbackTitleFromText(message.content);
    if (title) return title;
  }
  return '';
}

/** Fills `session.title` only when missing. Never touches a locked (manual/AI)
 *  or generated title, and leaves generatedTitleStage unset so
 *  updateSessionGeneratedTitle can still upgrade it. The caller persists. */
export function applyFallbackSessionTitle(session, title) {
  if (!session || !isUsableTitle(title) || isUsableTitle(session.title)) return false;
  if (session.titleLocked === true || session.generatedTitleStage) return false;
  session.title = title;
  session.titleUpdatedAt = Date.now();
  return true;
}

export function backfillFallbackSessionTitle(session, messages) {
  if (!session || isUsableTitle(session.title)) return false;
  return applyFallbackSessionTitle(session, fallbackTitleFromMessages(messages));
}
