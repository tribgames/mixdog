import { fileExtension } from './file-extension';

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
  const extension = fileExtension(path);
  if (!extension) return 'application/octet-stream';
  return Object.hasOwn(MIME_TYPES, extension) ? MIME_TYPES[extension] : 'application/octet-stream';
}

// Documents/media/archives open directly; executable packages require an
// explicit Mixdog confirmation before main hands them to the OS. OS launch
// prompts are not a security boundary (locally created EXEs may show none).
const EXECUTABLE_PACKAGE_EXTENSIONS = ['exe', 'msi', 'msix', 'msixbundle', 'appx', 'appxbundle', 'dmg', 'pkg', 'app'];
const FILE_LAUNCH_EXTENSIONS = new Set([
  ...EXECUTABLE_PACKAGE_EXTENSIONS,
  'com',
  'scr',
  'bat',
  'cmd',
  'ps1',
  'vbs',
  'vbe',
  'js',
  'jse',
  'wsf',
  'wsh',
  'hta',
  'lnk',
  'url',
  'appref-ms',
  'scf',
  'sh',
  'command',
  'desktop',
  'appimage',
]);

export type FileLaunchConfirmation = { confirmationPath: string };

/** Also applies to the editor's explicit "open externally" action. */
export function requiresFileLaunchConfirmation(path: string): boolean {
  return FILE_LAUNCH_EXTENSIONS.has(fileExtension(path));
}

// Scripts and shortcuts still default to the editor, never to execution.
const OS_DOCUMENT_EXTENSIONS = new Set([
  ...EXECUTABLE_PACKAGE_EXTENSIONS,
  'zip',
  '7z',
  'rar',
  'iso',
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
  'svg',
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

// Web pages a chat link shows in the session's browser pane (served over
// loopback by main), rather than as source in the editor.
const WEB_PAGE_EXTENSIONS = new Set(['html', 'htm']);

export function isLocalWebPage(path: string): boolean {
  return WEB_PAGE_EXTENSIONS.has(fileExtension(path));
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

const COLON_LOCATION = /:(\d+)(?::(\d+))?(?:-(\d+))?$/;
const HASH_LOCATION = /#L(\d+)(?:C(\d+))?(?:-L?(\d+)(?:C(\d+))?)?$/i;

const isPosition = (value: string | undefined): boolean => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0;
};

/** A recognised suffix with a non-positive/unsafe number or a reversed range
 *  is invalid: the suffix is dropped and the file opens at its top. */
function locationOf(
  path: string,
  line: string,
  column: string | undefined,
  endLine: string | undefined,
  endColumn: string | undefined
): LocalFileLocation {
  const sameLine = endLine === undefined || Number(endLine) === Number(line);
  const valid =
    isPosition(line) &&
    (column === undefined || isPosition(column)) &&
    (endLine === undefined || (isPosition(endLine) && Number(endLine) >= Number(line))) &&
    (endColumn === undefined ||
      (isPosition(endColumn) && (!sameLine || column === undefined || Number(endColumn) >= Number(column))));
  if (!valid) return { path };
  return { path, line: Number(line), ...(column !== undefined ? { column: Number(column) } : {}) };
}

/** Split a file link into its path and the `path:12`, `path:12:4`,
 *  `path:12-20`, `path#L12`, `path#L12C4` or `path#L12-L20` location it
 *  carries (a range opens at its first line). A drive letter (`C:/…`) is
 *  never mistaken for a line number. */
export function parseLocalFileLocation(href: string): LocalFileLocation {
  const raw = String(href || '').trim();
  const hash = HASH_LOCATION.exec(raw);
  if (hash) return locationOf(raw.slice(0, hash.index), hash[1], hash[2], hash[3], hash[4]);
  const colon = COLON_LOCATION.exec(raw);
  if (colon && colon.index > 0 && !/^[a-z]$/i.test(raw.slice(0, colon.index))) {
    // `path:12-20` ends on a line; `path:12:4-9` ends on a column of line 12.
    const rangeIsLines = colon[2] === undefined;
    return locationOf(
      raw.slice(0, colon.index),
      colon[1],
      colon[2],
      rangeIsLines ? colon[3] : undefined,
      rangeIsLines ? undefined : colon[3]
    );
  }
  return { path: raw };
}
