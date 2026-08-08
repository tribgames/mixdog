import { explicitEditorLanguageIdForPath } from "./editor-languages";

const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  pdf: "application/pdf",
  json: "application/json",
  jsonl: "application/json",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  md: "text/markdown",
  mdx: "text/markdown",
  txt: "text/plain",
  log: "text/plain",
  js: "text/javascript",
  jsx: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "text/typescript",
  tsx: "text/typescript",
  css: "text/css",
  html: "text/html",
  htm: "text/html",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  webm: "video/webm",
  mov: "video/quicktime",
});

/** Files whose primary useful representation in Mixdog is editable text.
 *  Binary documents/media stay with the OS even when Monaco could decode
 *  arbitrary bytes into replacement characters. */
export function isLocalTextFilePath(path: string): boolean {
  const name = String(path || "").split(/[\\/]/).at(-1)?.toLocaleLowerCase() || "";
  if (!name) return false;
  // The generated editor registry is the authority for every language,
  // filename and glob Monaco understands. Plain .txt and conventional
  // extensionless project docs intentionally fall back to plaintext.
  return explicitEditorLanguageIdForPath(path) !== undefined
    || name.endsWith(".txt")
    || /^(?:readme|license|notice|changelog)(?:[-_.].*)?$/.test(name);
}

export function localFileMimeTypeForPath(path: string): string {
  const name = String(path || "").split(/[\\/]/).at(-1) || "";
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "application/octet-stream";
  return MIME_TYPES[name.slice(dot + 1).toLocaleLowerCase()] || "application/octet-stream";
}
