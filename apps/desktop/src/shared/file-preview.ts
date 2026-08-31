export type DesktopFilePreviewKind = 'image' | 'pdf' | 'audio' | 'video';

export interface DesktopFilePreviewType {
  kind: DesktopFilePreviewKind;
  mime: string;
}

const FILE_PREVIEW_TYPES: Readonly<Record<string, DesktopFilePreviewType>> = Object.freeze({
  png: { kind: 'image', mime: 'image/png' },
  jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
  jfif: { kind: 'image', mime: 'image/jpeg' },
  gif: { kind: 'image', mime: 'image/gif' },
  webp: { kind: 'image', mime: 'image/webp' },
  avif: { kind: 'image', mime: 'image/avif' },
  svg: { kind: 'image', mime: 'image/svg+xml' },
  bmp: { kind: 'image', mime: 'image/bmp' },
  ico: { kind: 'image', mime: 'image/x-icon' },
  pdf: { kind: 'pdf', mime: 'application/pdf' },
  mp3: { kind: 'audio', mime: 'audio/mpeg' },
  wav: { kind: 'audio', mime: 'audio/wav' },
  ogg: { kind: 'audio', mime: 'audio/ogg' },
  oga: { kind: 'audio', mime: 'audio/ogg' },
  opus: { kind: 'audio', mime: 'audio/ogg' },
  m4a: { kind: 'audio', mime: 'audio/mp4' },
  aac: { kind: 'audio', mime: 'audio/aac' },
  flac: { kind: 'audio', mime: 'audio/flac' },
  mp4: { kind: 'video', mime: 'video/mp4' },
  m4v: { kind: 'video', mime: 'video/x-m4v' },
  webm: { kind: 'video', mime: 'video/webm' },
  ogv: { kind: 'video', mime: 'video/ogg' },
  mov: { kind: 'video', mime: 'video/quicktime' },
});

// Documents with no browser-native viewer at all. They reach a preview through
// a LibreOffice conversion in the runtime, which owns the authoritative list
// and refuses anything else; this copy only decides whether the editor offers
// the attempt instead of the binary-file notice.
const DOCUMENT_PREVIEW_FORMATS: ReadonlySet<string> = new Set([
  'docx', 'doc', 'docm', 'dotx', 'rtf', 'odt',
  'xlsx', 'xls', 'xlsm', 'ods',
  'pptx', 'ppt', 'pptm', 'odp',
]);

function fileExtension(path: string): string {
  const name = String(path || '').split(/[\\/]/).at(-1) || '';
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLocaleLowerCase();
}

/** The convertible document format for this filename, or '' when none. */
export function documentPreviewFormatForPath(path: string): string {
  const extension = fileExtension(path);
  return DOCUMENT_PREVIEW_FORMATS.has(extension) ? extension : '';
}

/** Browser-native read-only preview support, selected by the final extension. */
export function filePreviewTypeForPath(path: string): DesktopFilePreviewType | null {
  const extension = fileExtension(path);
  return extension ? FILE_PREVIEW_TYPES[extension] ?? null : null;
}
