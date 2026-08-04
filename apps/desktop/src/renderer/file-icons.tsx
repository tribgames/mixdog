// File-type icon grammar (VS Code Seti palette over lucide glyphs): the icon
// carries the LANGUAGE color while the filename carries git-status color —
// exactly VS Code SCM's split.
import {
  Braces,
  Database,
  FileArchive,
  FileCode,
  FileImage,
  FileText,
  FileTerminal,
  FileType,
  Settings,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// Seti theme accent palette.
const SETI = {
  blue: "#519aba",
  yellow: "#cbcb41",
  orange: "#e37933",
  green: "#8dc149",
  purple: "#a074c4",
  red: "#cc3e44",
  pink: "#f55385",
  grey: "#8a9199",
} as const;

interface FileTypeIcon {
  Icon: LucideIcon;
  color: string;
}

const BY_EXTENSION: Record<string, FileTypeIcon> = {
  ts: { Icon: FileCode, color: SETI.blue },
  tsx: { Icon: FileCode, color: SETI.blue },
  mts: { Icon: FileCode, color: SETI.blue },
  cts: { Icon: FileCode, color: SETI.blue },
  js: { Icon: FileCode, color: SETI.yellow },
  jsx: { Icon: FileCode, color: SETI.yellow },
  mjs: { Icon: FileCode, color: SETI.yellow },
  cjs: { Icon: FileCode, color: SETI.yellow },
  json: { Icon: Braces, color: SETI.yellow },
  jsonc: { Icon: Braces, color: SETI.yellow },
  css: { Icon: FileCode, color: SETI.blue },
  scss: { Icon: FileCode, color: SETI.pink },
  less: { Icon: FileCode, color: SETI.blue },
  html: { Icon: FileCode, color: SETI.orange },
  htm: { Icon: FileCode, color: SETI.orange },
  vue: { Icon: FileCode, color: SETI.green },
  svelte: { Icon: FileCode, color: SETI.orange },
  md: { Icon: FileText, color: SETI.blue },
  mdx: { Icon: FileText, color: SETI.blue },
  txt: { Icon: FileText, color: SETI.grey },
  yml: { Icon: Settings, color: SETI.purple },
  yaml: { Icon: Settings, color: SETI.purple },
  toml: { Icon: Settings, color: SETI.grey },
  ini: { Icon: Settings, color: SETI.grey },
  env: { Icon: Settings, color: SETI.yellow },
  py: { Icon: FileCode, color: SETI.blue },
  rb: { Icon: FileCode, color: SETI.red },
  go: { Icon: FileCode, color: SETI.blue },
  rs: { Icon: FileCode, color: SETI.orange },
  java: { Icon: FileCode, color: SETI.red },
  kt: { Icon: FileCode, color: SETI.purple },
  c: { Icon: FileCode, color: SETI.blue },
  h: { Icon: FileCode, color: SETI.purple },
  cpp: { Icon: FileCode, color: SETI.blue },
  hpp: { Icon: FileCode, color: SETI.purple },
  cs: { Icon: FileCode, color: SETI.green },
  swift: { Icon: FileCode, color: SETI.orange },
  php: { Icon: FileCode, color: SETI.purple },
  lua: { Icon: FileCode, color: SETI.blue },
  sql: { Icon: Database, color: SETI.pink },
  db: { Icon: Database, color: SETI.grey },
  sh: { Icon: FileTerminal, color: SETI.green },
  bash: { Icon: FileTerminal, color: SETI.green },
  ps1: { Icon: FileTerminal, color: SETI.blue },
  bat: { Icon: FileTerminal, color: SETI.grey },
  cmd: { Icon: FileTerminal, color: SETI.grey },
  png: { Icon: FileImage, color: SETI.purple },
  jpg: { Icon: FileImage, color: SETI.purple },
  jpeg: { Icon: FileImage, color: SETI.purple },
  gif: { Icon: FileImage, color: SETI.purple },
  webp: { Icon: FileImage, color: SETI.purple },
  ico: { Icon: FileImage, color: SETI.purple },
  svg: { Icon: FileImage, color: SETI.pink },
  woff: { Icon: FileType, color: SETI.red },
  woff2: { Icon: FileType, color: SETI.red },
  ttf: { Icon: FileType, color: SETI.red },
  zip: { Icon: FileArchive, color: SETI.grey },
  gz: { Icon: FileArchive, color: SETI.grey },
  tar: { Icon: FileArchive, color: SETI.grey },
  lock: { Icon: Settings, color: SETI.grey },
};

const BY_BASENAME: Record<string, FileTypeIcon> = {
  "package.json": { Icon: Braces, color: SETI.red },
  "tsconfig.json": { Icon: Braces, color: SETI.blue },
  dockerfile: { Icon: Settings, color: SETI.blue },
  makefile: { Icon: Settings, color: SETI.orange },
  ".gitignore": { Icon: Settings, color: SETI.grey },
  ".gitattributes": { Icon: Settings, color: SETI.grey },
  license: { Icon: FileText, color: SETI.yellow },
  "license.md": { Icon: FileText, color: SETI.yellow },
  "readme.md": { Icon: FileText, color: SETI.blue },
};

const DEFAULT_ICON: FileTypeIcon = { Icon: FileText, color: "var(--mx-icon-muted)" };

export function fileTypeIcon(path: string): FileTypeIcon {
  const slash = path.replace(/\\/g, "/").lastIndexOf("/");
  const base = (slash >= 0 ? path.slice(slash + 1) : path).toLowerCase();
  const named = BY_BASENAME[base];
  if (named) return named;
  const dot = base.lastIndexOf(".");
  const extension = dot >= 0 ? base.slice(dot + 1) : "";
  return BY_EXTENSION[extension] ?? DEFAULT_ICON;
}
