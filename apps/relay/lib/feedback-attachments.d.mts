export interface FeedbackAttachment {
  name: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  data: string;
}
export const FEEDBACK_ATTACHMENT_MAX_COUNT: 3;
export const FEEDBACK_ATTACHMENT_MAX_BYTES: 2097152;
export const FEEDBACK_ATTACHMENT_MAX_TOTAL_BYTES: 6291456;
export const FEEDBACK_ATTACHMENT_MAX_NAME_CHARS: 100;
export const FEEDBACK_ATTACHMENT_MIME_TYPES: readonly string[];
export function feedbackAttachmentBytes(attachments: readonly FeedbackAttachment[]): number;
export function normalizeFeedbackAttachments(value: unknown): FeedbackAttachment[];
