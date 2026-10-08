import {
  FEEDBACK_ATTACHMENT_MAX_BYTES,
  FEEDBACK_ATTACHMENT_MAX_COUNT,
  FEEDBACK_ATTACHMENT_MAX_TOTAL_BYTES,
  normalizeFeedbackAttachments as normalizeSharedAttachments,
} from '../../../relay/lib/feedback-attachments.mjs';

export { FEEDBACK_ATTACHMENT_MAX_BYTES, FEEDBACK_ATTACHMENT_MAX_COUNT, FEEDBACK_ATTACHMENT_MAX_TOTAL_BYTES };

/** `data` is strict raw base64 (no data: prefix) of a PNG, JPEG or WebP image. */
export interface DesktopFeedbackAttachment {
  name: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  data: string;
}

export function normalizeFeedbackAttachments(value: unknown): DesktopFeedbackAttachment[] {
  return normalizeSharedAttachments(value);
}

/** Only explicitly entered feedback leaves the app; no session or log data. */
export interface DesktopFeedbackInput {
  id: string;
  kind: 'bug' | 'suggestion' | 'other';
  message: string;
  replyTo?: string;
  attachments?: DesktopFeedbackAttachment[];
}

/** Receipt confirms durable acceptance, not delivery to the recipient's inbox. */
export interface DesktopFeedbackReceipt {
  id: string;
  status: 'accepted';
}

export const FEEDBACK_REPLY_EMAIL_PATTERN = /^[^\s@<>(),;:\\"]+@[^\s@<>(),;:\\"]+\.[^\s@<>(),;:\\"]+$/;

export function normalizeDesktopFeedback(value: unknown): DesktopFeedbackInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Feedback is invalid.');
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.id) ||
    (input.kind !== 'bug' && input.kind !== 'suggestion' && input.kind !== 'other') ||
    typeof input.message !== 'string' ||
    !input.message.trim() ||
    input.message.trim().length > 8_000
  ) {
    throw new TypeError('Feedback is invalid.');
  }
  if (input.replyTo !== undefined && typeof input.replyTo !== 'string') {
    throw new TypeError('Reply email is invalid.');
  }
  const replyTo = typeof input.replyTo === 'string' ? input.replyTo.trim() : '';
  if (replyTo && (replyTo.length > 254 || !FEEDBACK_REPLY_EMAIL_PATTERN.test(replyTo))) {
    throw new TypeError('Reply email is invalid.');
  }
  const attachments = normalizeFeedbackAttachments(input.attachments);
  return {
    id: input.id.toLowerCase(),
    kind: input.kind as DesktopFeedbackInput['kind'],
    message: input.message.trim(),
    ...(replyTo ? { replyTo } : {}),
    ...(attachments.length ? { attachments } : {}),
  };
}
