import type { Range } from "monaco-editor";

import type { DesktopEditorBackup } from "../shared/contract";
import type { DesktopFilePreviewKind } from "../shared/file-preview";
import type { EditorOutlineItem } from "./editor-language-store";
import { CALL_HIERARCHY_LAYOUT_KEY } from "./editor-monaco-providers";
import { recordOf } from "./editor-lsp-conversion";

export interface FilePreview {
  url: string;
  kind: DesktopFilePreviewKind;
  mime: string;
  mtimeMs: number;
  size: number;
}

export function parseEditorQuickDiffStripes(diffText: string) {
  const stripes: Array<{ line: number; kind: "add" | "mod" | "del" }> = [];
  let newLine = 0;
  let plus: number[] = [];
  let minus = 0;
  const flush = () => {
    const paired = Math.min(minus, plus.length);
    for (let index = 0; index < plus.length; index += 1) {
      stripes.push({ line: plus[index], kind: index < paired ? "mod" : "add" });
    }
    if (minus > paired) {
      stripes.push({ line: Math.max(1, plus.at(-1) ?? newLine), kind: "del" });
    }
    plus = [];
    minus = 0;
  };
  for (const raw of String(diffText || "").split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      flush();
      newLine = Number(hunk[1]) - 1;
      continue;
    }
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("+")) {
      newLine += 1;
      plus.push(newLine);
      continue;
    }
    if (raw.startsWith("-")) {
      minus += 1;
      continue;
    }
    flush();
    if (raw.startsWith(" ")) newLine += 1;
  }
  flush();
  return stripes;
}

export interface CallHierarchyLayout {
  ratio: number;
  height: number;
}

export interface CallHierarchyPreview {
  itemKey: string;
  relPath: string;
  content: string;
  languageId: string;
  line: number;
  ranges: Range[];
  loading: boolean;
  error: string;
}

export interface EditorRecovery extends DesktopEditorBackup {
  diskChanged: boolean;
  restored: boolean;
}

export interface EditorFileHandle {
  save(): Promise<boolean>;
  discard(): Promise<void>;
}

export interface BreadcrumbPickerAnchor {
  x: number;
  y: number;
  width: number;
  maxHeight: number;
  sourceIndex: number;
}

export interface BreadcrumbFileItem {
  name: string;
  dir: boolean;
  relPath: string;
}

export type BreadcrumbPickerState =
  | {
      kind: "files";
      anchor: BreadcrumbPickerAnchor;
      directory: string;
      selectedRelPath: string;
      rows: BreadcrumbFileItem[];
      activeIndex: number;
      loading: boolean;
      error: string;
    }
  | {
      kind: "symbols";
      anchor: BreadcrumbPickerAnchor;
      rows: EditorOutlineItem[];
      activeIndex: number;
    };

export function breadcrumbPickerAnchor(
  node: HTMLElement,
  sourceIndex: number,
): BreadcrumbPickerAnchor {
  const rect = node.getBoundingClientRect();
  const maxInnerWidth = Math.max(240, window.innerWidth - 8);
  const width = Math.min(maxInnerWidth, Math.max(240, window.innerWidth / 4.17));
  const x = Math.max(4, Math.min(rect.left, window.innerWidth - width - 4));
  const y = rect.bottom + 8;
  return {
    x,
    y,
    width,
    maxHeight: Math.max(80, Math.min(window.innerHeight * 0.7, 300, window.innerHeight - y - 30)),
    sourceIndex,
  };
}

export function editorLanguageLabel(languageId: string): string {
  switch (languageId) {
    case "typescript": return "TypeScript";
    case "javascript": return "JavaScript";
    case "plaintext": return "Plain Text";
    case "json": return "JSON";
    case "html": return "HTML";
    case "css": return "CSS";
    case "cpp": return "C++";
    default:
      return languageId
        ? languageId[0].toLocaleUpperCase() + languageId.slice(1)
        : "Plain Text";
  }
}

export function readCallHierarchyLayout(): CallHierarchyLayout {
  try {
    const value = recordOf(JSON.parse(window.localStorage.getItem(CALL_HIERARCHY_LAYOUT_KEY) || "{}"));
    return {
      ratio: Math.max(0.35, Math.min(0.85, Number(value?.ratio) || 0.7)),
      height: Math.max(8, Math.min(40, Number(value?.height) || 17)),
    };
  } catch {
    return { ratio: 0.7, height: 17 };
  }
}
