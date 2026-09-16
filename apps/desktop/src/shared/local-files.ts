const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  json: 'application/json',
  jsonl: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  md: 'text/markdown',
  mdx: 'text/markdown',
  txt: 'text/plain',
  log: 'text/plain',
  js: 'text/javascript',
  jsx: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  css: 'text/css',
  html: 'text/html',
  htm: 'text/html',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  mov: 'video/quicktime',
});

/** Files whose primary useful representation in Mixdog is editable text.
 *  Binary documents/media stay with the OS even when Monaco could decode
 *  arbitrary bytes into replacement characters. */
export function localFileMimeTypeForPath(path: string): string {
  const name =
    String(path || '')
      .split(/[\\/]/)
      .at(-1) || '';
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return 'application/octet-stream';
  return MIME_TYPES[name.slice(dot + 1).toLocaleLowerCase()] || 'application/octet-stream';
}

// Binary documents and media that only an OS-associated app can show. Chat
// output is untrusted, so this is the ONLY set that may launch another
// program; everything else (source, markdown, data files) opens in Mixdog's
// own editor, which never executes anything.
const OS_DOCUMENT_EXTENSIONS = new Set([
  'pptx',
  'ppt',
  'pdf',
  'docx',
  'doc',
  'dotx',
  'xlsx',
  'xls',
  'rtf',
  'odt',
  'ods',
  'odp',
  'png',
  'jpg',
  'jpeg',
  'jfif',
  'gif',
  'webp',
  'avif',
  'bmp',
  'tif',
  'tiff',
  'ico',
  'mp3',
  'wav',
  'ogg',
  'flac',
  'm4a',
  'mp4',
  'm4v',
  'mov',
  'webm',
  'mkv',
]);

type LocalFileOpener = 'editor' | 'os';
/** What the main process did with a chat link: launched the OS app for a
 *  document, opened a folder in the file manager, or handed a text file back
 *  for Mixdog's editor without launching anything. */
export type LocalLinkOpened = 'file' | 'folder' | 'editor';

export function isOsDocumentExtension(extension: string): boolean {
  return OS_DOCUMENT_EXTENSIONS.has(
    String(extension || '')
      .replace(/^\./, '')
      .toLocaleLowerCase()
  );
}

function fileExtension(path: string): string {
  const name =
    String(path || '')
      .split(/[\\/]/)
      .at(-1) || '';
  const dot = name.lastIndexOf('.');
  return dot < 0 || dot === name.length - 1 ? '' : name.slice(dot + 1).toLocaleLowerCase();
}

/** Which surface a chat file link opens: Mixdog's editor or the OS default app. */
export function localFileOpener(path: string): LocalFileOpener {
  return OS_DOCUMENT_EXTENSIONS.has(fileExtension(path)) ? 'os' : 'editor';
}

/** A trailing separator names a folder; `output/report` without one is
 *  undecidable until the main process stats it. */
export function localLinkKind(path: string): 'folder' | 'file' | 'unknown' {
  const target = String(path || '').trim();
  if (/[\\/]$/.test(target)) return 'folder';
  return fileExtension(target) ? 'file' : 'unknown';
}

interface LocalFileLocation {
  path: string;
  line?: number;
  column?: number;
}

const COLON_LOCATION = /:(\d+)(?::(\d+))?(?:-\d+)?$/;
const HASH_LOCATION = /#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/i;

/** Split a file link into its path and the `path:12`, `path:12:4`,
 *  `path:12-20`, `path#L12`, `path#L12C4` or `path#L12-L20` location it
 *  carries (a range opens at its first line). A drive letter (`C:/…`) is
 *  never mistaken for a line number. */
export function parseLocalFileLocation(href: string): LocalFileLocation {
  const raw = String(href || '').trim();
  const hash = HASH_LOCATION.exec(raw);
  if (hash) {
    return {
      path: raw.slice(0, hash.index),
      line: Number(hash[1]),
      ...(hash[2] ? { column: Number(hash[2]) } : {}),
    };
  }
  const colon = COLON_LOCATION.exec(raw);
  if (colon && colon.index > 0 && !/^[a-z]$/i.test(raw.slice(0, colon.index))) {
    return {
      path: raw.slice(0, colon.index),
      line: Number(colon[1]),
      ...(colon[2] ? { column: Number(colon[2]) } : {}),
    };
  }
  return { path: raw };
}
