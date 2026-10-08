// Media limits shared by prompt intake, tools, MCP results, and provider
// lowering. One source keeps every path agreeing on what a file may be.

/** Largest PDF sent as a native document block or accepted at intake. */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
/** Most pages a native PDF block may carry; providers reject more. */
export const MAX_PDF_PAGES = 100;
/** Largest single blob the attachment store accepts. */
export const MAX_ATTACHMENT_BLOB_BYTES = 64 * 1024 * 1024;
/** Largest raw image a tool result may carry (fits the store and provider caps). */
export const MAX_IMAGE_BYTES = 48 * 1024 * 1024;
/** Raster image types every provider accepts as an image block. */
export const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');

/** True when the bytes start with the %PDF- header. */
export function isPdfBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= PDF_MAGIC.length && buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}
