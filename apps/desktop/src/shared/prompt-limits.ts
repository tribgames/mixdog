// Prompt attachment limits shared by the composer (which must never accept
// more than this) and the IPC validator (which enforces it).
export const MAX_PROMPT_FILES = 8;
export const MAX_PROMPT_IMAGES = 8;
export const MAX_PROMPT_IMAGE_BASE64_LENGTH = 16_000_000;
// The composer's own 30M budget is the tighter one; IPC enforces the same value
// so nothing the composer accepts can be rejected downstream.
export const MAX_PROMPT_IMAGE_BASE64_TOTAL = 30_000_000;
export const PROMPT_IMAGE_MIME_PATTERN = /^image\/(?:png|jpe?g|gif|webp)$/i;
// One file part: 20 MiB of bytes is 27,962,028 base64 characters.
export const MAX_PROMPT_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_PROMPT_FILE_BASE64_LENGTH = 28_000_000;
export const MAX_PROMPT_FILE_BASE64_TOTAL = 28_000_000;
export const MAX_PROMPT_FILE_MIME_LENGTH = 128;

export const PDF_MIME_TYPE = 'application/pdf';

/** OOXML extension → MIME type the runtime converts to extracted text. */
export const OFFICE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
};

export const OFFICE_MIME_TYPES: readonly string[] = Object.values(OFFICE_MIME_BY_EXTENSION);

/** Legacy binary Office extension → the OOXML extension to save as. */
export const LEGACY_OFFICE_REPLACEMENT: Readonly<Record<string, string>> = {
  doc: '.docx',
  xls: '.xlsx',
  ppt: '.pptx',
};

/** Canonical-case MIME type for a supported prompt file type (matched
 *  case-insensitively, parameters ignored), else ''. */
export function canonicalPromptFileMimeType(mimeType: string): string {
  const base = String(mimeType || '').split(';', 1)[0].trim().toLowerCase();
  if (base === PDF_MIME_TYPE) return PDF_MIME_TYPE;
  return OFFICE_MIME_TYPES.find((candidate) => candidate.toLowerCase() === base) || '';
}
