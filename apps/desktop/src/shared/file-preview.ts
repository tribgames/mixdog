import { localFileOpener } from './local-files';
import { fileExtension } from './file-extension';
import { IMAGE_TYPES } from './image-types.generated';

export type DesktopFilePreviewKind = 'image' | 'pdf' | 'audio' | 'video';

interface DesktopFilePreviewType {
  kind: DesktopFilePreviewKind;
  mime: string;
}

// Which image extensions a browser previews is the generated table's `browserDraws`; the media types are its own.
const IMAGE_PREVIEW_TYPES: Readonly<Record<string, DesktopFilePreviewType>> = Object.fromEntries(
  IMAGE_TYPES.filter((type) => type.browserDraws).map((type) => [type.extension, { kind: 'image', mime: type.mime }]),
) as Record<string, DesktopFilePreviewType>;

const FILE_PREVIEW_TYPES: Readonly<Record<string, DesktopFilePreviewType>> = Object.freeze({
  ...IMAGE_PREVIEW_TYPES,
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
  'docx',
  'doc',
  'docm',
  'dotx',
  'rtf',
  'odt',
  'xlsx',
  'xls',
  'xlsm',
  'ods',
  'pptx',
  'ppt',
  'pptm',
  'odp',
]);

/** The convertible document format for this filename, or '' when none. */
export function documentPreviewFormatForPath(path: string): string {
  const extension = fileExtension(path);
  return DOCUMENT_PREVIEW_FORMATS.has(extension) ? extension : '';
}

/** Browser-native read-only preview support, selected by the final extension. */
export function filePreviewTypeForPath(path: string): DesktopFilePreviewType | null {
  const extension = fileExtension(path);
  return extension && Object.hasOwn(FILE_PREVIEW_TYPES, extension) ? FILE_PREVIEW_TYPES[extension] : null;
}

/** Everything the editor can show (native previews, convertible Office documents,
 *  text) stays inside; the OS allowlist decides the rest.
 *  Scripts, shortcuts, unknown binaries and macro-enabled documents never auto-launch. */
export function editorFileOpener(path: string): 'editor' | 'os' {
  return filePreviewTypeForPath(path) || documentPreviewFormatForPath(path) ? 'editor' : localFileOpener(path);
}
