import type { DesktopFolderEntry } from "../shared/contract";

export const DETAILS_SIZES = { compact: 24, small: 28, medium: 36 } as const;
export const GRID_SIZES = {
  small: { tile: 84, height: 100, icon: 40 },
  medium: { tile: 108, height: 124, icon: 56 },
  large: { tile: 152, height: 172, icon: 96 },
} as const;
export type DetailsSizeKind = keyof typeof DETAILS_SIZES;
export type GridSizeKind = keyof typeof GRID_SIZES;
export const GROUP_HEADER_HEIGHT = 34;

export function pathSepOf(path: string): string {
  return path.includes("\\") ? "\\" : "/";
}

export function joinFolderPath(dir: string, name: string): string {
  const sep = pathSepOf(dir);
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

export function parentFolderPath(path: string): string {
  const sep = pathSepOf(path);
  const trimmed = path.length > 3 && path.endsWith(sep) ? path.slice(0, -1) : path;
  const cut = trimmed.lastIndexOf(sep);
  if (cut <= 0) return trimmed;
  const parent = trimmed.slice(0, cut);
  return /^[A-Za-z]:$/.test(parent) ? parent + sep : parent;
}

export function breadcrumbSegments(path: string): Array<{ label: string; path: string }> {
  const sep = pathSepOf(path);
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const rows: Array<{ label: string; path: string }> = [];
  let accumulated = "";
  for (const part of parts) {
    if (!accumulated) {
      accumulated = /^[A-Za-z]:$/.test(part)
        ? part + sep
        : path.startsWith(sep) ? sep + part : part;
    } else {
      accumulated = accumulated.endsWith(sep) ? accumulated + part : accumulated + sep + part;
    }
    rows.push({ label: part, path: accumulated });
  }
  return rows;
}

export function entryExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

const TYPE_NAMES: Record<string, string> = {
  txt: "Text Document", md: "Markdown Document", pdf: "PDF Document",
  doc: "Microsoft Word Document", docx: "Microsoft Word Document",
  xls: "Microsoft Excel Worksheet", xlsx: "Microsoft Excel Worksheet",
  ppt: "Microsoft PowerPoint Presentation", pptx: "Microsoft PowerPoint Presentation",
  hwp: "HWP Document", png: "PNG Image", jpg: "JPEG Image", jpeg: "JPEG Image",
  gif: "GIF Image", webp: "WebP Image", bmp: "BMP Image", svg: "SVG Image",
  ico: "Icon", mp3: "MP3 Audio", wav: "WAV Audio", flac: "FLAC Audio",
  mp4: "MP4 Video", mkv: "MKV Video", mov: "QuickTime Video", avi: "AVI Video",
  zip: "Compressed (zipped) Folder", "7z": "7-Zip Archive", rar: "RAR Archive",
  exe: "Application", msi: "Windows Installer Package", dll: "Application Extension",
  lnk: "Shortcut", url: "Internet Shortcut", bat: "Windows Batch File",
  ps1: "PowerShell Script", sh: "Shell Script", json: "JSON File",
  js: "JavaScript File", ts: "TypeScript File", tsx: "TypeScript JSX File",
  jsx: "JavaScript JSX File", html: "HTML Document", css: "CSS Document",
  ini: "Configuration Settings", log: "Log File", sys: "System File",
  tmp: "Temporary File", xml: "XML File", yml: "YAML File",
  yaml: "YAML File", csv: "CSV File",
};

export function entryTypeLabel(entry: DesktopFolderEntry): string {
  if (entry.dir) return "File folder";
  const ext = entryExt(entry.name);
  return TYPE_NAMES[ext] ?? (ext ? `${ext.toUpperCase()} File` : "File");
}

export function folderBaseName(path: string): string {
  const sep = pathSepOf(path);
  const trimmed = path.endsWith(sep) ? path.slice(0, -1) : path;
  return trimmed.slice(trimmed.lastIndexOf(sep) + 1);
}

export type FolderUndoAction =
  | { kind: "rename"; from: string; to: string }
  | { kind: "move"; moved: Array<{ from: string; to: string }> }
  | { kind: "remove"; paths: string[] };

export function formatByteSize(value: number): string {
  const size = Math.max(0, value);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatFolderSize(entry: DesktopFolderEntry): string {
  return entry.dir ? "" : formatByteSize(entry.size);
}

export function formatFolderDate(mtimeMs: number): string {
  if (!mtimeMs) return "";
  const date = new Date(mtimeMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function errorText(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause || "Operation failed.");
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "");
}

export function folderListingErrorText(cause: unknown): string {
  const message = errorText(cause);
  if (/\b(?:EPERM|EACCES)\b|access (?:is )?denied/i.test(message)) return "Access denied.";
  if (/\b(?:ENOENT|ENODEV|ENXIO)\b/i.test(message)) return "This location is unavailable.";
  return "Couldn't open this folder.";
}

function timeSpanLabel(mtimeMs: number): { text: string; index: number } {
  if (!mtimeMs) return { text: "A long time ago", index: 0 };
  const now = new Date();
  const time = new Date(mtimeMs);
  const dayMs = 86_400_000;
  const dayOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const weekOf = (d: Date) => {
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    start.setDate(start.getDate() - start.getDay());
    return start.getTime();
  };
  const nowDay = dayOf(now);
  const timeDay = dayOf(time);
  if (timeDay > nowDay) return { text: "Future", index: 1_000_000_006 };
  if (timeDay === nowDay) return { text: "Today", index: 1_000_000_005 };
  if (nowDay - timeDay === dayMs) return { text: "Yesterday", index: 1_000_000_004 };
  const diffDays = Math.floor((nowDay - timeDay) / dayMs);
  if (diffDays <= 7 && weekOf(time) === weekOf(now)) {
    return { text: "Earlier this week", index: 1_000_000_003 };
  }
  if (diffDays <= 14 && weekOf(time) === weekOf(now) - 7 * dayMs) {
    return { text: "Last week", index: 1_000_000_002 };
  }
  if (now.getFullYear() === time.getFullYear() && now.getMonth() === time.getMonth()) {
    return { text: "Earlier this month", index: 1_000_000_001 };
  }
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  if (lastMonth.getFullYear() === time.getFullYear() && lastMonth.getMonth() === time.getMonth()) {
    return { text: "Last month", index: 1_000_000_000 };
  }
  if (now.getFullYear() === time.getFullYear()) {
    return { text: "Earlier this year", index: 10_000_001 };
  }
  if (now.getFullYear() - 1 === time.getFullYear()) {
    return { text: "Last year", index: 10_000_000 };
  }
  return { text: String(time.getFullYear()), index: time.getFullYear() };
}

const SIZE_GROUPS: Array<{ size: number; text: string }> = [
  { size: 5_000_000_000, text: "Huge (5 GB +)" },
  { size: 1_000_000_000, text: "Very large (1 - 5 GB)" },
  { size: 128_000_000, text: "Large (128 MB - 1 GB)" },
  { size: 1_000_000, text: "Medium (1 - 128 MB)" },
  { size: 16_000, text: "Small (16 KB - 1 MB)" },
];

function sizeGroupLabel(entry: DesktopFolderEntry): { text: string; index: number } {
  if (entry.dir) return { text: "Folders", index: 1_000_000_010 };
  for (let i = 0; i < SIZE_GROUPS.length; i++) {
    if (entry.size > SIZE_GROUPS[i].size) {
      return { text: SIZE_GROUPS[i].text, index: SIZE_GROUPS.length - i };
    }
  }
  return { text: "Tiny (0 - 16 KB)", index: 0 };
}

export type FolderSortKey = "name" | "date" | "type" | "size";
export type FolderGroupKey = "none" | FolderSortKey;
export type FolderViewMode = "grid" | "details";

function groupLabelFor(entry: DesktopFolderEntry, option: FolderGroupKey): {
  text: string;
  index: number;
} {
  switch (option) {
    case "name": {
      const initial = entry.name.trim().charAt(0).toUpperCase() || "#";
      return { text: /[0-9]/.test(initial) ? "0-9" : initial, index: 0 };
    }
    case "date": return timeSpanLabel(entry.mtimeMs);
    case "size": return sizeGroupLabel(entry);
    case "type": return { text: entryTypeLabel(entry), index: entry.dir ? 1 : 0 };
    default: return { text: "", index: 0 };
  }
}

export interface FolderGroup {
  key: string;
  text: string;
  index: number;
  items: DesktopFolderEntry[];
}

export function buildGroups(
  sorted: DesktopFolderEntry[],
  option: FolderGroupKey,
): FolderGroup[] {
  if (option === "none") {
    return [{ key: "", text: "", index: 0, items: sorted }];
  }
  const byKey = new Map<string, FolderGroup>();
  for (const entry of sorted) {
    const label = groupLabelFor(entry, option);
    let group = byKey.get(label.text);
    if (!group) {
      group = { key: label.text, text: label.text, index: label.index, items: [] };
      byKey.set(label.text, group);
    }
    group.items.push(entry);
  }
  const groups = [...byKey.values()];
  if (option === "date" || option === "size") {
    groups.sort((a, b) => b.index - a.index);
  } else {
    groups.sort((a, b) => (b.index - a.index)
      || a.text.localeCompare(b.text, undefined, { numeric: true }));
  }
  return groups;
}

export type RenderRow =
  | { kind: "header"; group: FolderGroup; collapsed: boolean }
  | { kind: "entry"; entry: DesktopFolderEntry }
  | { kind: "entries"; entries: DesktopFolderEntry[] };
