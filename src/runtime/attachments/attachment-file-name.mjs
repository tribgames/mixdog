/**
 * The file name an attachment gets when it is copied out of the
 * content-addressed store for the PC's own programs (a site's file chooser,
 * office/pdf tools, a copy): the name it was attached under, made safe for a
 * path, with an extension that matches its type. A phone sends a name the PC
 * file system may refuse, or none at all.
 */
import { extname } from 'node:path';

const MAX_NAME_LENGTH = 120;
const MAX_EXTENSION_LENGTH = 16;
const RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

const OOXML = 'application/vnd.openxmlformats-officedocument';

// `strict` types name their bytes' format, so an extension that disagrees (a
// photo the phone re-encoded to JPEG but still called `.heic`) gets the right
// one appended. Other types only supply an extension when the name has none:
// text/plain also covers `.py`, `.log`, ...
const MIME_EXTENSIONS = new Map([
  ['image/png', { exts: ['.png'], strict: true }],
  ['image/jpeg', { exts: ['.jpg', '.jpeg', '.jpe', '.jfif'], strict: true }],
  ['image/gif', { exts: ['.gif'], strict: true }],
  ['image/webp', { exts: ['.webp'], strict: true }],
  ['image/bmp', { exts: ['.bmp'], strict: true }],
  ['image/tiff', { exts: ['.tif', '.tiff'], strict: true }],
  ['image/heic', { exts: ['.heic'], strict: true }],
  ['image/heif', { exts: ['.heif'], strict: true }],
  ['image/svg+xml', { exts: ['.svg'], strict: true }],
  ['application/pdf', { exts: ['.pdf'], strict: true }],
  [`${OOXML}.wordprocessingml.document`, { exts: ['.docx'], strict: true }],
  [`${OOXML}.spreadsheetml.sheet`, { exts: ['.xlsx'], strict: true }],
  [`${OOXML}.presentationml.presentation`, { exts: ['.pptx'], strict: true }],
  ['application/msword', { exts: ['.doc'], strict: true }],
  ['application/vnd.ms-excel', { exts: ['.xls'], strict: true }],
  ['application/vnd.ms-powerpoint', { exts: ['.ppt'], strict: true }],
  ['text/plain', { exts: ['.txt'], strict: false }],
  ['text/markdown', { exts: ['.md'], strict: false }],
  ['text/csv', { exts: ['.csv'], strict: false }],
  ['text/tab-separated-values', { exts: ['.tsv'], strict: false }],
  ['text/html', { exts: ['.html'], strict: false }],
  ['application/json', { exts: ['.json'], strict: false }],
  ['application/zip', { exts: ['.zip'], strict: false }],
  ['application/x-hwp', { exts: ['.hwp'], strict: false }],
]);

function safeBaseName(name) {
  return (
    String(name || '')
      .split(/[\\/]/)
      .pop()
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is stripped.
      .replace(/[\u0000-\u001f<>:"|?*]+/g, '-')
      .replace(/^[\s.]+|[\s.]+$/g, '')
  );
}

/** `name` as a safe file name carrying the extension `mimeType` calls for;
 *  `fallback` stands in for a missing name. */
export function attachmentFileName(name, mimeType = '', fallback = 'attachment') {
  let base = safeBaseName(name) || fallback;
  if (RESERVED_DEVICE_NAME.test(base)) base = `_${base}`;
  const rule = MIME_EXTENSIONS.get(
    String(mimeType || '')
      .split(';')[0]
      .trim()
      .toLowerCase()
  );
  // An extension longer than this is just part of the name, not an extension.
  let keep = extname(base);
  if (keep.length > MAX_EXTENSION_LENGTH) keep = '';
  const ext = keep.toLowerCase();
  if (rule && (ext ? rule.strict && !rule.exts.includes(ext) : true)) {
    // Appended: the stem is cut to leave room, so the type's extension survives.
    keep = rule.exts[0];
    return base.slice(0, MAX_NAME_LENGTH - keep.length) + keep;
  }
  return base.length <= MAX_NAME_LENGTH ? base : base.slice(0, MAX_NAME_LENGTH - keep.length) + keep;
}
