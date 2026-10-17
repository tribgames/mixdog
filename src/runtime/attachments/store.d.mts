export function readAttachmentBuffer(value: string | { attachmentRef?: string }): Buffer;
export function isPermanentAttachmentError(error: unknown): boolean;
export function isAttachmentReference(value: unknown): boolean;
export interface MessageAttachment {
  id: string;
  attachmentRef: string;
  kind: 'image' | 'file' | 'text';
  name: string;
  mimeType: string;
  size: number;
}
export function attachmentsForIntake(prompt: unknown, options?: unknown): MessageAttachment[];
