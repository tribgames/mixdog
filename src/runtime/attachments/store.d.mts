export function readAttachmentBuffer(value: string | { attachmentRef?: string }): Buffer;
export function isPermanentAttachmentError(error: unknown): boolean;
export function isAttachmentReference(value: unknown): boolean;
