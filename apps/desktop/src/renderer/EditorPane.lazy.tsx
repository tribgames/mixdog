// VSCode-style file editor tab (Monaco), modeled on orca's editor surface:
// local monaco bundle, per-path models (dirty buffers survive tab switches),
// Ctrl+S save, and VSCode's changed-on-disk rule — clean buffer auto-reloads,
// dirty buffer shows a Reload / Keep bar instead of silently clobbering.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Editor from "@monaco-editor/react";
import {
  Braces,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  File as FileIcon,
  Folder,
  FolderOpen,
  Save,
  Undo2,
  X,
} from "lucide-react";
import { monaco, resolveThemeColor } from "./monaco-setup";
import { ProgressSpinner } from "./ProgressSpinner";
// Monaco caches glyph metrics at mount. If the mono face lands AFTER a cold
// editor measured against Consolas (boot restore, first open on a cold
// cache), the paint swaps but the layout keeps stale widths — cursor and
// text visibly jump (user: 폰트가 움직이며 크게 튄다). One remeasure when
// the face settles realigns every open editor.
let monoRemeasureArmed = false;
const MIXDOG_EDITOR_SCROLLBAR = {
  arrowSize: 0,
  verticalScrollbarSize: 14,
  horizontalScrollbarSize: 12,
} as const;
const QUICK_DIFF_COLOR_TOKENS = {
  add: ["--mx-editor-diff-add", "#487e02", "#48985d"],
  mod: ["--mx-editor-diff-mod", "#1b81a8", "#2090d3"],
  del: ["--mx-editor-diff-del", "#f14c4c", "#b5200d"],
} as const;
function colorWithAlpha(color: string, alpha: string): string {
  const hex = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(color);
  return hex ? `#${hex[1]}${alpha}` : color;
}
function armMonoFontRemeasure() {
  if (monoRemeasureArmed) return;
  monoRemeasureArmed = true;
  const remeasure = () => {
    try { monaco.editor.remeasureFonts(); } catch { /* cosmetic */ }
  };
  try {
    // One fonts.load() alone raced the @font-face registration: called before
    // the face exists it resolves EMPTY and never fires again, so Monaco kept
    // fallback metrics while painting the arrived webfont — intermittent
    // garbled/overlapping text (user: 간헐적으로 생텍스트처럼 깨진다). Cover
    // every arrival path: explicit load, whole-set readiness, and any late
    // subset/instance load.
    void document.fonts.load('400 13px "JetBrains Mono Variable"')
      .then(remeasure)
      .catch(() => undefined);
    void document.fonts.ready.then(remeasure).catch(() => undefined);
    document.fonts.addEventListener?.("loadingdone", remeasure);
  } catch { /* font readiness stays cosmetic */ }
}
import {
  cancelLayoutFrame,
  scheduleLayoutFrame,
} from "./interaction-frame-scheduler";
import {
  nextEditorLayoutDimension,
  type EditorLayoutDimension,
} from "./editor-layout";
// @ts-expect-error Monaco's public API can run commands but its VS Code-compatible
// Peek submenu registry is intentionally internal and ships without declarations.
import { MenuId, MenuRegistry } from "monaco-editor/esm/vs/platform/actions/common/actions.js";
// @ts-expect-error See the menu-registry import above.
import { ContextKeyExpr } from "monaco-editor/esm/vs/platform/contextkey/common/contextkey.js";
import type {
  DesktopApi,
  DesktopEditorBackup,
  DesktopEditorSettings,
  DesktopLspCapabilities,
  DesktopLspRequestMethod,
  DesktopLspServerState,
  DesktopTextFileEncoding,
  DesktopWorkspaceTextWrite,
} from "../shared/contract";
import {
  filePreviewTypeForPath,
  type DesktopFilePreviewKind,
} from "../shared/file-preview";
import {
  editorLanguageIdForPath,
  explicitEditorLanguageIdForPath,
} from "../shared/editor-languages";
import {
  parseCodeGraphLocations,
  parseCodeGraphSymbols,
  type EditorCodeGraphMode,
  type EditorGraphLocation,
} from "./editor-code-graph";
import {
  applyLspTextEdits,
  clearActiveEditorDocument,
  ensureEditorLanguageStore,
  getEditorLanguageSnapshot,
  setActiveEditorDocument,
  setActiveEditorPosition,
  setEditorOutline,
  setNativeEditorProblems,
  subscribeEditorLanguageStore,
  type EditorOutlineItem,
} from "./editor-language-store";
import {
  editorAnsiDecorationPlan,
  isAnsiOutputPath,
  visibleEditorAnsiText,
} from "./editor-ansi";
import { useForegroundMedia } from "./media-lifecycle";
import {
  normalizeEditorModelText,
  resolveEditorBackup,
  takeEditorFileLoad,
  type EditorFileLoad as FileLoad,
} from "./editor-file-loader";
import { DEFAULT_DESKTOP_EDITOR_SETTINGS } from "../shared/editor-settings";
import {
  ensureEditorLoad,
  reportEditorLoadStage,
} from "./renderer-load-metrics";

interface FilePreview {
  url: string;
  kind: DesktopFilePreviewKind;
  mime: string;
  mtimeMs: number;
  size: number;
}

interface EditorGraphContext {
  projectPath: string;
  relPath: string;
  api?: DesktopApi;
  codeGraph?: (mode: EditorCodeGraphMode, query: string) => Promise<string>;
  onOpenAt?: (rel: string, line: number) => void;
  requestLsp?: (method: DesktopLspRequestMethod, params?: Record<string, unknown>) => Promise<unknown>;
  applyWorkspaceEdit?: (edit: unknown, confirmationLabel?: string) => Promise<boolean>;
  lspCapabilities?: DesktopLspCapabilities;
  onOutline?: (rows: EditorOutlineItem[]) => void;
  onLanguageError?: (message: string) => void;
  startCallHierarchy?: () => void;
}

interface EditorGraphContextRef {
  current: EditorGraphContext;
}

const graphContextsByModel = new Map<string, EditorGraphContextRef>();
const graphContextsByEditor = new WeakMap<
  import("monaco-editor").editor.ICodeEditor,
  EditorGraphContextRef
>();
const graphProviderLanguages = new Set<string>();
const lspReadyLanguages = new Set<string>();
const lspCapabilitiesByLanguage = new Map<string, DesktopLspCapabilities>();
const lspProviderFeaturesByLanguage = new Map<string, Set<string>>();
let graphEditorOpenerInstalled = false;
let lspWorkspaceEditCommandInstalled = false;
let lspCodeActionCommandInstalled = false;
let lspCommandInstalled = false;
const APPLY_LSP_WORKSPACE_EDIT = "mixdog.editor.applyLspWorkspaceEdit";
const APPLY_LSP_CODE_ACTION = "mixdog.editor.applyLspCodeAction";
const EXECUTE_LSP_COMMAND = "mixdog.editor.executeLspCommand";
const PEEK_CALL_HIERARCHY = "editor.showCallHierarchy";
const HAS_CALL_HIERARCHY = "editorHasCallHierarchyProvider";
const EDITOR_VIEW_STATE_KEY = "mixdog.desktop-editor-view-state.v1";
const CALL_HIERARCHY_LAYOUT_KEY = "callHierarchyPeekLayout";
const CALL_HIERARCHY_DIRECTION_KEY = "callHierarchy/defaultDirection";
type EditorViewState = import("monaco-editor").editor.ICodeEditorViewState;
const editorViewStates = new Map<string, { state: EditorViewState; touchedAt: number }>();
let editorViewStatesLoaded = false;
let focusedGraphEditor: import("monaco-editor").editor.ICodeEditor | null = null;
let callHierarchyMenuInstalled = false;
const FORMAT_DOCUMENT_WITH = "editor.action.formatDocument.multiple";

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
    if (hunk) { flush(); newLine = Number(hunk[1]) - 1; continue; }
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("+")) { newLine += 1; plus.push(newLine); continue; }
    if (raw.startsWith("-")) { minus += 1; continue; }
    flush();
    if (raw.startsWith(" ")) newLine += 1;
  }
  flush();
  return stripes;
}

interface CallHierarchyLayout {
  ratio: number;
  height: number;
}

interface CallHierarchyPreview {
  itemKey: string;
  relPath: string;
  content: string;
  languageId: string;
  line: number;
  ranges: import("monaco-editor").Range[];
  loading: boolean;
  error: string;
}

interface EditorRecovery extends DesktopEditorBackup {
  diskChanged: boolean;
  restored: boolean;
}

interface EditorFileHandle {
  save(): Promise<boolean>;
  discard(): Promise<void>;
}

interface BreadcrumbPickerAnchor {
  x: number;
  y: number;
  width: number;
  maxHeight: number;
  sourceIndex: number;
}

interface BreadcrumbFileItem {
  name: string;
  dir: boolean;
  relPath: string;
}

type BreadcrumbPickerState =
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

function breadcrumbPickerAnchor(
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

function editorLanguageLabel(languageId: string): string {
  switch (languageId) {
    case "typescript": return "TypeScript";
    case "javascript": return "JavaScript";
    case "plaintext": return "Plain Text";
    case "json": return "JSON";
    case "html": return "HTML";
    case "css": return "CSS";
    case "cpp": return "C++";
    default: return languageId ? languageId[0].toLocaleUpperCase() + languageId.slice(1) : "Plain Text";
  }
}

function readCallHierarchyLayout(): CallHierarchyLayout {
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

function ensureCallHierarchyMenu(): void {
  if (callHierarchyMenuInstalled) return;
  callHierarchyMenuInstalled = true;
  for (const item of MenuRegistry.getMenuItems(MenuId.EditorContext)) {
    if ("command" in item && item.command.id === "editor.action.quickOutline") {
      item.when = ContextKeyExpr.false();
    }
  }
  monaco.editor.registerCommand(PEEK_CALL_HIERARCHY, () => {
    const context = focusedGraphEditor
      ? graphContextsByEditor.get(focusedGraphEditor)?.current
      : undefined;
    context?.startCallHierarchy?.();
  });
  monaco.editor.addKeybindingRule({
    keybinding: monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyH,
    command: PEEK_CALL_HIERARCHY,
    when: HAS_CALL_HIERARCHY,
  });
  const available = ContextKeyExpr.has(HAS_CALL_HIERARCHY);
  MenuRegistry.appendMenuItem(MenuId.EditorContextPeek, {
    group: "navigation",
    order: 1000,
    command: {
      id: PEEK_CALL_HIERARCHY,
      title: "Peek Call Hierarchy",
      precondition: available,
    },
    when: available,
  });
  monaco.editor.registerCommand(FORMAT_DOCUMENT_WITH, () => {
    void focusedGraphEditor?.getAction("editor.action.formatDocument")?.run();
  });
  const multipleFormatters = ContextKeyExpr.has("editorHasMultipleDocumentFormattingProvider");
  MenuRegistry.appendMenuItem(MenuId.EditorContext, {
    group: "1_modification",
    order: 1.3,
    command: {
      id: FORMAT_DOCUMENT_WITH,
      title: "Format Document With...",
      precondition: multipleFormatters,
    },
    when: multipleFormatters,
  });
}

function loadEditorViewStates(): void {
  if (editorViewStatesLoaded) return;
  editorViewStatesLoaded = true;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(EDITOR_VIEW_STATE_KEY) || "[]") as unknown;
    if (!Array.isArray(parsed)) return;
    for (const row of parsed.slice(-100)) {
      if (!Array.isArray(row) || typeof row[0] !== "string" || !row[1] || typeof row[1] !== "object") continue;
      editorViewStates.set(row[0], {
        state: row[1] as EditorViewState,
        touchedAt: Number(row[2]) || 0,
      });
    }
  } catch {
    // View state is a convenience; malformed storage starts clean.
  }
}

function readEditorViewState(path: string): EditorViewState | null {
  loadEditorViewStates();
  return editorViewStates.get(path)?.state ?? null;
}

function writeEditorViewState(path: string, state: EditorViewState): void {
  loadEditorViewStates();
  editorViewStates.set(path, { state, touchedAt: Date.now() });
  const entries = [...editorViewStates.entries()]
    .sort((left, right) => left[1].touchedAt - right[1].touchedAt)
    .slice(-100);
  editorViewStates.clear();
  for (const entry of entries) editorViewStates.set(entry[0], entry[1]);
  try {
    window.localStorage.setItem(EDITOR_VIEW_STATE_KEY, JSON.stringify(
      entries.map(([key, value]) => [key, value.state, value.touchedAt]),
    ));
  } catch {
    // Storage quota/privacy mode must never block editor disposal.
  }
}

function normalizedFilePath(value: string): string {
  return String(value || "").replace(/\\/g, "/").replace(/^\/([A-Za-z]:\/)/, "$1").replace(/\/+$/, "");
}

function graphTargetUri(
  model: import("monaco-editor").editor.ITextModel,
  context: EditorGraphContext,
  location: EditorGraphLocation,
): import("monaco-editor").Uri {
  if (normalizedFilePath(location.rel) === normalizedFilePath(context.relPath)) return model.uri;
  return monaco.Uri.file(`${normalizedFilePath(context.projectPath)}/${normalizedFilePath(location.rel)}`);
}

function graphLocationRange(
  location: EditorGraphLocation,
  wordLength: number,
): import("monaco-editor").Range {
  const column = Math.max(1, location.column);
  return new monaco.Range(
    Math.max(1, location.line),
    column,
    Math.max(1, location.endLine),
    location.endLine === location.line ? column + Math.max(1, wordLength) : 1,
  );
}

function symbolKind(kind: string): import("monaco-editor").languages.SymbolKind {
  switch (kind.toLowerCase()) {
    case "class": return monaco.languages.SymbolKind.Class;
    case "interface": return monaco.languages.SymbolKind.Interface;
    case "function": return monaco.languages.SymbolKind.Function;
    case "method": return monaco.languages.SymbolKind.Method;
    case "constructor": return monaco.languages.SymbolKind.Constructor;
    case "enum": return monaco.languages.SymbolKind.Enum;
    case "property": return monaco.languages.SymbolKind.Property;
    case "module":
    case "namespace": return monaco.languages.SymbolKind.Module;
    case "type": return monaco.languages.SymbolKind.Struct;
    default: return monaco.languages.SymbolKind.Variable;
  }
}

function lspSymbolKind(value: unknown): import("monaco-editor").languages.SymbolKind {
  const kinds = monaco.languages.SymbolKind;
  switch (Number(value)) {
    case 1: return kinds.File;
    case 2: return kinds.Module;
    case 3: return kinds.Namespace;
    case 4: return kinds.Package;
    case 5: return kinds.Class;
    case 6: return kinds.Method;
    case 7: return kinds.Property;
    case 8: return kinds.Field;
    case 9: return kinds.Constructor;
    case 10: return kinds.Enum;
    case 11: return kinds.Interface;
    case 12: return kinds.Function;
    case 13: return kinds.Variable;
    case 14: return kinds.Constant;
    case 15: return kinds.String;
    case 16: return kinds.Number;
    case 17: return kinds.Boolean;
    case 18: return kinds.Array;
    case 19: return kinds.Object;
    case 20: return kinds.Key;
    case 21: return kinds.Null;
    case 22: return kinds.EnumMember;
    case 23: return kinds.Struct;
    case 24: return kinds.Event;
    case 25: return kinds.Operator;
    case 26: return kinds.TypeParameter;
    default: return kinds.Variable;
  }
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function lspPosition(position: import("monaco-editor").Position): Record<string, number> {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

function monacoRange(value: unknown): import("monaco-editor").Range | null {
  const range = recordOf(value);
  const start = recordOf(range?.start);
  const end = recordOf(range?.end);
  if (!start || !end) return null;
  return new monaco.Range(
    Math.max(1, Number(start.line) + 1),
    Math.max(1, Number(start.character) + 1),
    Math.max(1, Number(end.line) + 1),
    Math.max(1, Number(end.character) + 1),
  );
}

function lspUriInProject(uriValue: unknown, context: EditorGraphContext): import("monaco-editor").Uri | null {
  if (typeof uriValue !== "string" || !uriValue) return null;
  try {
    const uri = monaco.Uri.parse(uriValue);
    const root = normalizedFilePath(context.projectPath).toLocaleLowerCase();
    const target = normalizedFilePath(uri.fsPath).toLocaleLowerCase();
    if (target !== root && !target.startsWith(`${root}/`)) return null;
    return uri;
  } catch {
    return null;
  }
}

function lspLocations(
  value: unknown,
  context: EditorGraphContext,
): import("monaco-editor").languages.Location[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const rows: import("monaco-editor").languages.Location[] = [];
  for (const item of values) {
    const record = recordOf(item);
    if (!record) continue;
    const uri = lspUriInProject(record.uri ?? record.targetUri, context);
    const range = monacoRange(record.range ?? record.targetSelectionRange ?? record.targetRange);
    if (uri && range) rows.push({ uri, range });
  }
  return rows;
}

interface EditorCallHierarchyItem {
  key: string;
  name: string;
  detail: string;
  uri: string;
  line: number;
  selectionRange: import("monaco-editor").Range;
  previewUri: string;
  previewRanges: import("monaco-editor").Range[];
  raw: Record<string, unknown>;
}

function lspCallHierarchyItem(
  value: unknown,
  context: EditorGraphContext,
): EditorCallHierarchyItem | null {
  const record = recordOf(value);
  if (!record) return null;
  const uri = lspUriInProject(record.uri, context);
  const selection = monacoRange(record.selectionRange ?? record.range);
  if (!uri || !selection || typeof record.name !== "string") return null;
  return {
    key: `${uri.toString()}:${selection.startLineNumber}:${record.name}`,
    name: record.name,
    detail: typeof record.detail === "string" ? record.detail : "",
    uri: uri.toString(),
    line: selection.startLineNumber,
    selectionRange: selection,
    previewUri: uri.toString(),
    previewRanges: [selection],
    raw: record,
  };
}

function markupText(value: unknown): string {
  if (typeof value === "string") return value;
  const record = recordOf(value);
  if (typeof record?.value === "string") return record.value;
  if (typeof record?.language === "string" && typeof record?.value === "string") {
    return `\`\`\`${record.language}\n${record.value}\n\`\`\``;
  }
  if (Array.isArray(value)) return value.map(markupText).filter(Boolean).join("\n\n");
  return "";
}

function completionKind(value: unknown): import("monaco-editor").languages.CompletionItemKind {
  const kinds = monaco.languages.CompletionItemKind;
  switch (Number(value)) {
    case 2: return kinds.Method;
    case 3: return kinds.Function;
    case 4: return kinds.Constructor;
    case 5: return kinds.Field;
    case 6: return kinds.Variable;
    case 7: return kinds.Class;
    case 8: return kinds.Interface;
    case 9: return kinds.Module;
    case 10: return kinds.Property;
    case 12: return kinds.Value;
    case 13: return kinds.Enum;
    case 14: return kinds.Keyword;
    case 15: return kinds.Snippet;
    case 17: return kinds.File;
    case 18: return kinds.Reference;
    case 21: return kinds.Constant;
    case 22: return kinds.Struct;
    case 23: return kinds.Event;
    case 24: return kinds.Operator;
    case 25: return kinds.TypeParameter;
    default: return kinds.Text;
  }
}

function lspRange(range: import("monaco-editor").IRange): Record<string, unknown> {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
  };
}

function monacoPosition(value: unknown): import("monaco-editor").Position | null {
  const position = recordOf(value);
  if (!position) return null;
  const line = Number(position.line);
  const character = Number(position.character);
  if (!Number.isFinite(line) || !Number.isFinite(character)) return null;
  return new monaco.Position(Math.max(1, line + 1), Math.max(1, character + 1));
}

function lspTextEdits(value: unknown): import("monaco-editor").languages.TextEdit[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = recordOf(item);
    const range = monacoRange(row?.range);
    return range && typeof row?.newText === "string"
      ? [{ range, text: row.newText }]
      : [];
  });
}

function lspCommand(
  value: unknown,
  modelUri: string,
): import("monaco-editor").languages.Command | undefined {
  const command = recordOf(value);
  if (!command || typeof command.command !== "string") return undefined;
  return {
    id: EXECUTE_LSP_COMMAND,
    title: typeof command.title === "string" ? command.title : command.command,
    arguments: [modelUri, command],
  };
}

function signatureHelpFromLsp(
  value: unknown,
): import("monaco-editor").languages.SignatureHelp | null {
  const help = recordOf(value);
  if (!help || !Array.isArray(help.signatures)) return null;
  const signatures = help.signatures.flatMap((raw) => {
    const signature = recordOf(raw);
    if (!signature || typeof signature.label !== "string") return [];
    const parameters = (Array.isArray(signature.parameters) ? signature.parameters : [])
      .flatMap((parameter) => {
        const row = recordOf(parameter);
        const rawLabel = row?.label;
        const label = typeof rawLabel === "string"
          ? rawLabel
          : Array.isArray(rawLabel) && rawLabel.length === 2
            ? [Number(rawLabel[0]), Number(rawLabel[1])] as [number, number]
            : null;
        if (label === null) return [];
        return [{
          label,
          documentation: markupText(row?.documentation) || undefined,
        }];
      });
    return [{
      label: signature.label,
      documentation: markupText(signature.documentation) || undefined,
      parameters,
      activeParameter: Number.isFinite(Number(signature.activeParameter))
        ? Number(signature.activeParameter)
        : undefined,
    }];
  });
  if (!signatures.length) return null;
  return {
    signatures,
    activeSignature: Math.max(0, Number(help.activeSignature) || 0),
    activeParameter: Math.max(0, Number(help.activeParameter) || 0),
  };
}

function linkedEditingWordPattern(value: unknown): RegExp | undefined {
  if (typeof value !== "string" || !value || value.length > 1_024) return undefined;
  try {
    return new RegExp(value);
  } catch {
    return undefined;
  }
}

function semanticTokenData(value: unknown): Uint32Array {
  return Uint32Array.from(
    (Array.isArray(value) ? value : [])
      .slice(0, 1_000_000)
      .map((entry) => Math.max(0, Number(entry) || 0)),
  );
}

function lspDocumentSymbols(
  model: import("monaco-editor").editor.ITextModel,
  value: unknown,
  context: EditorGraphContext,
): { symbols: import("monaco-editor").languages.DocumentSymbol[]; outline: EditorOutlineItem[] } {
  const symbols: import("monaco-editor").languages.DocumentSymbol[] = [];
  const outline: EditorOutlineItem[] = [];
  const visit = (rows: unknown, level: number, target: import("monaco-editor").languages.DocumentSymbol[]) => {
    if (!Array.isArray(rows)) return;
    rows.forEach((item, index) => {
      const record = recordOf(item);
      if (!record) return;
      const location = recordOf(record.location);
      const uri = location ? lspUriInProject(location.uri, context) : model.uri;
      if (uri && uri.toString() !== model.uri.toString()) return;
      const range = monacoRange(record.range ?? location?.range);
      const selectionRange = monacoRange(record.selectionRange ?? record.range ?? location?.range) ?? range;
      if (!range || !selectionRange) return;
      const name = typeof record.name === "string" ? record.name : "symbol";
      const detail = typeof record.detail === "string" ? record.detail : "";
      const row: import("monaco-editor").languages.DocumentSymbol = {
        name,
        detail,
        kind: lspSymbolKind(record.kind),
        tags: [],
        range,
        selectionRange,
        children: [],
      };
      target.push(row);
      outline.push({
        key: `${model.uri.toString()}:${selectionRange.startLineNumber}:${index}:${name}`,
        projectPath: context.projectPath,
        relPath: context.relPath,
        uri: model.uri.toString(),
        name,
        detail,
        kind: String(record.kind || ""),
        line: selectionRange.startLineNumber,
        column: selectionRange.startColumn,
        endLine: range.endLineNumber,
        level,
      });
      visit(record.children, level + 1, row.children!);
    });
  };
  visit(value, 0, symbols);
  return { symbols, outline };
}

type ParsedCodeGraphSymbol = ReturnType<typeof parseCodeGraphSymbols>[number];

function codeGraphOutlineItems(
  model: import("monaco-editor").editor.ITextModel,
  context: EditorGraphContext,
  sourceRows: readonly ParsedCodeGraphSymbol[],
): EditorOutlineItem[] {
  const rows = [...sourceRows].sort((left, right) =>
    left.line - right.line || right.endLine - left.endLine || left.name.localeCompare(right.name));
  const parents: Array<{ endLine: number }> = [];
  return rows.slice(0, 200).map((row, index) => {
    const line = Math.min(model.getLineCount(), Math.max(1, row.line));
    const endLine = Math.min(model.getLineCount(), Math.max(line, row.endLine));
    while (parents.length && line > parents.at(-1)!.endLine) parents.pop();
    const level = parents.length;
    if (endLine > line) parents.push({ endLine });
    return {
      key: `${model.uri.toString()}:${line}:${index}:${row.name}`,
      projectPath: context.projectPath,
      relPath: context.relPath,
      uri: model.uri.toString(),
      name: row.name,
      detail: row.kind,
      kind: row.kind,
      line,
      column: 1,
      endLine,
      level,
    };
  });
}

type WorkspaceEditGroup = {
  edits: Array<Record<string, unknown>>;
  /** LSP documentChanges version — equals the monaco model versionId our
   *  didOpen/didChange sync reports, so stale edits are detectable. */
  version: number | null;
};

function workspaceEditGroups(value: unknown): Map<string, WorkspaceEditGroup> {
  const edit = recordOf(value);
  if (!edit) throw new Error("Language server returned an invalid workspace edit.");
  const groups = new Map<string, WorkspaceEditGroup>();
  const append = (uri: string, edits: unknown, version: number | null = null) => {
    if (!Array.isArray(edits)) return;
    const group = groups.get(uri) ?? { edits: [], version: null };
    for (const row of edits) {
      const record = recordOf(row);
      if (record?.range && typeof record.newText === "string") group.edits.push(record);
    }
    if (version !== null) group.version = version;
    groups.set(uri, group);
  };
  const changes = recordOf(edit.changes);
  if (changes) {
    for (const [uri, edits] of Object.entries(changes)) append(uri, edits);
  }
  if (Array.isArray(edit.documentChanges)) {
    for (const change of edit.documentChanges) {
      const record = recordOf(change);
      if (!record) continue;
      if (record.kind || record.oldUri || record.newUri) {
        throw new Error("Create, rename, and delete workspace edits require explicit file confirmation.");
      }
      const document = recordOf(record.textDocument);
      if (typeof document?.uri === "string") {
        append(document.uri, record.edits,
          typeof document.version === "number" ? document.version : null);
      }
    }
  }
  if (groups.size > 100
    || [...groups.values()].reduce((sum, group) => sum + group.edits.length, 0) > 10_000) {
    throw new Error("Language server workspace edit is too large.");
  }
  return groups;
}

async function applyLspWorkspaceEdit(
  context: EditorGraphContext,
  value: unknown,
  confirmationLabel?: string,
): Promise<boolean> {
  const api = context.api;
  if (!api?.readProjectFile || !api.writeProjectFile) return false;
  const groups = workspaceEditGroups(value);
  const editCount = [...groups.values()].reduce((sum, group) => sum + group.edits.length, 0);
  if (confirmationLabel && groups.size > 1
    && !window.confirm(`${confirmationLabel} will update ${editCount} locations in ${groups.size} files. Continue?`)) {
    return false;
  }
  const modelEdits: Array<{
    model: import("monaco-editor").editor.ITextModel;
    edits: Array<Record<string, unknown>>;
  }> = [];
  const writes: DesktopWorkspaceTextWrite[] = [];
  for (const [uriValue, group] of groups) {
    const edits = group.edits;
    const uri = lspUriInProject(uriValue, context);
    if (!uri) throw new Error("Language server edit escaped the project.");
    const root = normalizedFilePath(context.projectPath);
    const target = normalizedFilePath(uri.fsPath);
    const relPath = target.slice(root.length).replace(/^\/+/, "");
    if (!relPath) throw new Error("Language server targeted the project directory.");
    const model = monaco.editor.getModels().find((candidate) => {
      const owner = graphContextsByModel.get(candidate.uri.toString())?.current;
      return owner?.projectPath.replace(/[\\/]+/g, "/").toLocaleLowerCase()
        === context.projectPath.replace(/[\\/]+/g, "/").toLocaleLowerCase()
        && owner.relPath.replace(/\\/g, "/").toLocaleLowerCase() === relPath.toLocaleLowerCase();
    });
    if (model) {
      // Stale-edit guard: the server computed these ranges against the
      // version our didOpen/didChange sync reported (= monaco versionId).
      // Applying them onto a document that moved on (fast typing, an agent
      // rewriting the file) interleaves lines and splits words — observed as
      // scrambled "restored" backups (user report).
      if (group.version !== null && model.getVersionId() !== group.version) {
        throw new Error("The document changed while the language server prepared this edit. Try again.");
      }
      modelEdits.push({ model, edits });
      continue;
    }
    const loaded = await api.readProjectFile(context.projectPath, relPath);
    if (loaded.binary || loaded.tooLarge) {
      throw new Error(`Workspace edit cannot safely change ${relPath}.`);
    }
    writes.push({
      relPath,
      expectedContent: loaded.content,
      content: applyLspTextEdits(loaded.content, edits),
    });
  }
  if (writes.length) {
    if (api.lspApplyWorkspaceEdit) {
      await api.lspApplyWorkspaceEdit(context.projectPath, writes);
    } else {
      for (const write of writes) {
        await api.writeProjectFile(
          context.projectPath,
          write.relPath,
          write.content,
          write.expectedContent,
        );
      }
    }
  }
  for (const entry of modelEdits) {
    const lineCount = entry.model.getLineCount();
    const operations = entry.edits.map((edit) => {
      const range = monacoRange(edit.range);
      if (!range) throw new Error("Language server returned an invalid text range.");
      // Bounds sanity for version-less edits: a range beyond the current
      // document is certainly stale and must not scramble the model.
      if (range.startLineNumber > lineCount + 1 || range.endLineNumber > lineCount + 1) {
        throw new Error("Language server edit targets a stale document position. Try again.");
      }
      return { range, text: String(edit.newText ?? ""), forceMoveMarkers: true };
    });
    entry.model.pushEditOperations([], operations, () => null);
  }
  return true;
}

function claimLspProviderFeature(languageId: string, feature: string): boolean {
  const registered = lspProviderFeaturesByLanguage.get(languageId) ?? new Set<string>();
  if (registered.has(feature)) return false;
  registered.add(feature);
  lspProviderFeaturesByLanguage.set(languageId, registered);
  return true;
}

function ensureGraphProviders(languageId: string): void {
  if (!graphProviderLanguages.has(languageId)) {
    graphProviderLanguages.add(languageId);
    monaco.languages.registerDefinitionProvider(languageId, {
      async provideDefinition(model, position, token) {
        const context = graphContextsByModel.get(model.uri.toString())?.current;
        const word = model.getWordAtPosition(position)?.word;
        if (!context || !word || token.isCancellationRequested) return [];
        try {
          if (context.requestLsp) {
            const locations = lspLocations(await context.requestLsp(
              "textDocument/definition",
              { position: lspPosition(position) },
            ), context);
            if (locations.length) return locations;
          }
          if (!context.codeGraph) return [];
          const rows = parseCodeGraphLocations(await context.codeGraph("find_symbol", word));
          if (token.isCancellationRequested) return [];
          return rows.slice(0, 20).map((location) => ({
            uri: graphTargetUri(model, context, location),
            range: graphLocationRange(location, word.length),
          }));
        } catch {
          return [];
        }
      },
    });
    monaco.languages.registerReferenceProvider(languageId, {
      async provideReferences(model, position, _referenceContext, token) {
        const context = graphContextsByModel.get(model.uri.toString())?.current;
        const word = model.getWordAtPosition(position)?.word;
        if (!context || !word || token.isCancellationRequested) return [];
        try {
          if (context.requestLsp) {
            const locations = lspLocations(await context.requestLsp(
              "textDocument/references",
              { position: lspPosition(position), context: { includeDeclaration: true } },
            ), context);
            if (locations.length) return locations;
          }
          if (!context.codeGraph) return [];
          const rows = parseCodeGraphLocations(await context.codeGraph("references", word));
          if (token.isCancellationRequested) return [];
          return rows.slice(0, 100).map((location) => ({
            uri: graphTargetUri(model, context, location),
            range: graphLocationRange(location, word.length),
          }));
        } catch {
          return [];
        }
      },
    });
    monaco.languages.registerDocumentSymbolProvider(languageId, {
      async provideDocumentSymbols(model, token) {
        const context = graphContextsByModel.get(model.uri.toString())?.current;
        if (!context || token.isCancellationRequested) return [];
        try {
          if (context.requestLsp) {
            const converted = lspDocumentSymbols(
              model,
              await context.requestLsp("textDocument/documentSymbol"),
              context,
            );
            if (converted.symbols.length) {
              context.onOutline?.(converted.outline);
              return converted.symbols;
            }
          }
          if (!context.codeGraph) return [];
          const rows = parseCodeGraphSymbols(await context.codeGraph("symbols", context.relPath));
          if (token.isCancellationRequested) return [];
          const symbols = rows.slice(0, 200).map((row) => {
            const line = Math.min(model.getLineCount(), Math.max(1, row.line));
            const endLine = Math.min(model.getLineCount(), Math.max(line, row.endLine));
            const selectionColumn = Math.max(1, model.getLineContent(line).indexOf(row.name) + 1);
            return {
              name: row.name,
              detail: row.kind,
              kind: symbolKind(row.kind),
              tags: [],
              range: new monaco.Range(line, 1, endLine, model.getLineMaxColumn(endLine)),
              selectionRange: new monaco.Range(
                line,
                selectionColumn,
                line,
                Math.min(model.getLineMaxColumn(line), selectionColumn + row.name.length),
              ),
            };
          });
          context.onOutline?.(codeGraphOutlineItems(model, context, rows));
          return symbols;
        } catch {
          return [];
        }
      },
    });
  }
  if (lspReadyLanguages.has(languageId)) {
    const capabilities = lspCapabilitiesByLanguage.get(languageId);
    if (capabilities?.typeDefinition && claimLspProviderFeature(languageId, "typeDefinition")) {
      monaco.languages.registerTypeDefinitionProvider(languageId, {
        async provideTypeDefinition(model, position) {
          const context = graphContextsByModel.get(model.uri.toString())?.current;
          if (!context?.requestLsp || !context.lspCapabilities?.typeDefinition) return [];
          return lspLocations(await context.requestLsp(
            "textDocument/typeDefinition",
            { position: lspPosition(position) },
          ), context);
        },
      });
    }
    if (capabilities?.declaration && claimLspProviderFeature(languageId, "declaration")) {
      monaco.languages.registerDeclarationProvider(languageId, {
        async provideDeclaration(model, position) {
          const context = graphContextsByModel.get(model.uri.toString())?.current;
          if (!context?.requestLsp || !context.lspCapabilities?.declaration) return [];
          return lspLocations(await context.requestLsp(
            "textDocument/declaration",
            { position: lspPosition(position) },
          ), context);
        },
      });
    }
    if (capabilities?.implementation && claimLspProviderFeature(languageId, "implementation")) {
      monaco.languages.registerImplementationProvider(languageId, {
        async provideImplementation(model, position) {
          const context = graphContextsByModel.get(model.uri.toString())?.current;
          if (!context?.requestLsp || !context.lspCapabilities?.implementation) return [];
          return lspLocations(await context.requestLsp(
            "textDocument/implementation",
            { position: lspPosition(position) },
          ), context);
        },
      });
    }
    if (capabilities?.completion && claimLspProviderFeature(languageId, "completion")) {
      const completionPayloads = new WeakMap<object, {
        modelUri: string;
        raw: Record<string, unknown>;
      }>();
      monaco.languages.registerCompletionItemProvider(languageId, {
        triggerCharacters: capabilities.completionTriggerCharacters,
        async provideCompletionItems(model, position) {
          const context = graphContextsByModel.get(model.uri.toString())?.current;
          if (!context?.requestLsp || !context.lspCapabilities?.completion) return { suggestions: [] };
          const result = await context.requestLsp("textDocument/completion", {
            position: lspPosition(position),
            context: { triggerKind: 1 },
          });
          const record = recordOf(result);
          const items = Array.isArray(result) ? result : Array.isArray(record?.items) ? record.items : [];
          const word = model.getWordUntilPosition(position);
          const fallbackRange = new monaco.Range(
            position.lineNumber,
            word.startColumn,
            position.lineNumber,
            word.endColumn,
          );
          return {
            suggestions: items.slice(0, 500).flatMap((item) => {
              const row = recordOf(item);
              if (!row) return [];
              const textEdit = recordOf(row.textEdit);
              const range = monacoRange(textEdit?.range ?? textEdit?.replace) ?? fallbackRange;
              const rawLabel = recordOf(row.label)?.label ?? row.label;
              const label = typeof rawLabel === "string" ? rawLabel : "";
              if (!label) return [];
              const suggestion: import("monaco-editor").languages.CompletionItem = {
                label,
                kind: completionKind(row.kind),
                detail: typeof row.detail === "string" ? row.detail : undefined,
                documentation: markupText(row.documentation) || undefined,
                insertText: String(textEdit?.newText ?? row.insertText ?? label),
                insertTextRules: Number(row.insertTextFormat) === 2
                  ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                  : undefined,
                sortText: typeof row.sortText === "string" ? row.sortText : undefined,
                filterText: typeof row.filterText === "string" ? row.filterText : undefined,
                commitCharacters: Array.isArray(row.commitCharacters)
                  ? row.commitCharacters.filter((entry): entry is string => typeof entry === "string")
                  : undefined,
                additionalTextEdits: lspTextEdits(row.additionalTextEdits),
                command: lspCommand(row.command, model.uri.toString()),
                preselect: row.preselect === true,
                tags: row.deprecated === true || (Array.isArray(row.tags) && row.tags.includes(1))
                  ? [monaco.languages.CompletionItemTag.Deprecated]
                  : undefined,
                range,
              };
              completionPayloads.set(suggestion, {
                modelUri: model.uri.toString(),
                raw: row,
              });
              return [suggestion];
            }),
          };
        },
        async resolveCompletionItem(item) {
          const payload = completionPayloads.get(item);
          const context = payload
            ? graphContextsByModel.get(payload.modelUri)?.current
            : undefined;
          if (!payload || !context?.requestLsp || !context.lspCapabilities?.completionResolve) {
            return item;
          }
          const resolved = recordOf(await context.requestLsp("completionItem/resolve", payload.raw));
          if (!resolved) return item;
          return {
            ...item,
            detail: typeof resolved.detail === "string" ? resolved.detail : item.detail,
            documentation: markupText(resolved.documentation) || item.documentation,
          };
        },
      });
    }
    if (capabilities?.signatureHelp && claimLspProviderFeature(languageId, "signatureHelp")) {
      monaco.languages.registerSignatureHelpProvider(languageId, {
        signatureHelpTriggerCharacters: capabilities.signatureHelpTriggerCharacters,
        signatureHelpRetriggerCharacters: capabilities.signatureHelpRetriggerCharacters,
        async provideSignatureHelp(model, position, token, helpContext) {
          const context = graphContextsByModel.get(model.uri.toString())?.current;
          if (!context?.requestLsp || !context.lspCapabilities?.signatureHelp
            || token.isCancellationRequested) return null;
          const result = signatureHelpFromLsp(await context.requestLsp(
            "textDocument/signatureHelp",
            {
              position: lspPosition(position),
              context: {
                triggerKind: Number(helpContext.triggerKind),
                triggerCharacter: helpContext.triggerCharacter,
                isRetrigger: helpContext.isRetrigger,
                activeSignatureHelp: helpContext.activeSignatureHelp,
              },
            },
          ));
          return result ? { value: result, dispose() {} } : null;
        },
      });
    }
    if (capabilities?.hover && claimLspProviderFeature(languageId, "hover")) {
      monaco.languages.registerHoverProvider(languageId, {
        async provideHover(model, position) {
          const context = graphContextsByModel.get(model.uri.toString())?.current;
          if (!context?.requestLsp || !context.lspCapabilities?.hover) return null;
          const result = recordOf(await context.requestLsp(
            "textDocument/hover",
            { position: lspPosition(position) },
          ));
          const contents = markupText(result?.contents);
          if (!contents) return null;
          return {
            contents: [{ value: contents }],
            range: monacoRange(result?.range) ?? undefined,
          };
        },
      });
    }
    if (capabilities?.documentHighlight
      && claimLspProviderFeature(languageId, "documentHighlight")) {
      monaco.languages.registerDocumentHighlightProvider(languageId, {
        async provideDocumentHighlights(model, position, token) {
          const context = graphContextsByModel.get(model.uri.toString())?.current;
          if (!context?.requestLsp || !context.lspCapabilities?.documentHighlight
            || token.isCancellationRequested) return [];
          const result = await context.requestLsp(
            "textDocument/documentHighlight",
            { position: lspPosition(position) },
          );
          return (Array.isArray(result) ? result : []).flatMap((item) => {
            const row = recordOf(item);
            const range = monacoRange(row?.range);
            return range ? [{
              range,
              kind: Math.max(0, Math.min(2, (Number(row?.kind) || 1) - 1)),
            }] : [];
          });
        },
      });
    }
    if (capabilities?.linkedEditingRange
      && claimLspProviderFeature(languageId, "linkedEditingRange")) {
      monaco.languages.registerLinkedEditingRangeProvider(languageId, {
        async provideLinkedEditingRanges(model, position, token) {
          const context = graphContextsByModel.get(model.uri.toString())?.current;
          if (!context?.requestLsp || !context.lspCapabilities?.linkedEditingRange
            || token.isCancellationRequested) return null;
          const result = recordOf(await context.requestLsp(
            "textDocument/linkedEditingRange",
            { position: lspPosition(position) },
          ));
          const ranges = (Array.isArray(result?.ranges) ? result.ranges : [])
            .flatMap((item) => {
              const range = monacoRange(item);
              return range ? [range] : [];
            });
          return ranges.length ? {
            ranges,
            wordPattern: linkedEditingWordPattern(result?.wordPattern),
          } : null;
        },
      });
    }
    if (capabilities?.codeLens && claimLspProviderFeature(languageId, "codeLens")) {
      const codeLensPayloads = new WeakMap<object, { modelUri: string; raw: Record<string, unknown> }>();
      const toCodeLens = (
        modelUri: string,
        raw: Record<string, unknown>,
      ): import("monaco-editor").languages.CodeLens | null => {
        const range = monacoRange(raw.range);
        if (!range) return null;
        const lens: import("monaco-editor").languages.CodeLens = {
          range,
          command: lspCommand(raw.command, modelUri),
        };
        codeLensPayloads.set(lens, { modelUri, raw });
        return lens;
      };
      monaco.languages.registerCodeLensProvider(languageId, {
        async provideCodeLenses(model, token) {
          const context = graphContextsByModel.get(model.uri.toString())?.current;
          if (!context?.requestLsp || !context.lspCapabilities?.codeLens
            || token.isCancellationRequested) return { lenses: [], dispose() {} };
          const result = await context.requestLsp("textDocument/codeLens");
          return {
            lenses: (Array.isArray(result) ? result : []).flatMap((item) => {
              const row = recordOf(item);
              const lens = row ? toCodeLens(model.uri.toString(), row) : null;
              return lens ? [lens] : [];
            }),
            dispose() {},
          };
        },
        async resolveCodeLens(_model, lens) {
          const payload = codeLensPayloads.get(lens);
          const context = payload
            ? graphContextsByModel.get(payload.modelUri)?.current
            : undefined;
          if (!payload || !context?.requestLsp || !context.lspCapabilities?.codeLensResolve) {
            return lens;
          }
          const resolved = recordOf(await context.requestLsp("codeLens/resolve", payload.raw));
          return resolved ? toCodeLens(payload.modelUri, resolved) ?? lens : lens;
        },
      });
    }
    if (capabilities?.rename && claimLspProviderFeature(languageId, "rename")) {
      monaco.languages.registerRenameProvider(languageId, {
        async resolveRenameLocation(model, position) {
          const context = graphContextsByModel.get(model.uri.toString())?.current;
          const word = model.getWordAtPosition(position);
          if (!context?.requestLsp || !word) return null;
          if (!context.lspCapabilities?.prepareRename) {
            return {
              range: new monaco.Range(
                position.lineNumber,
                word.startColumn,
                position.lineNumber,
                word.endColumn,
              ),
              text: word.word,
            };
          }
          const result = await context.requestLsp(
            "textDocument/prepareRename",
            { position: lspPosition(position) },
          );
          const record = recordOf(result);
          const range = monacoRange(record?.range ?? result);
          return range
            ? { range, text: String(record?.placeholder ?? word.word) }
            : null;
        },
        async provideRenameEdits(model, position, newName) {
          const context = graphContextsByModel.get(model.uri.toString())?.current;
          if (!context?.requestLsp || !context.applyWorkspaceEdit) {
            return { edits: [], rejectReason: "Language server is unavailable." };
          }
          const edit = await context.requestLsp("textDocument/rename", {
            position: lspPosition(position),
            newName,
          });
          if (!edit || !await context.applyWorkspaceEdit(edit, "Rename")) {
            return { edits: [], rejectReason: "Rename was canceled or could not be applied safely." };
          }
          return { edits: [] };
        },
      });
    }
    if (capabilities?.codeAction && claimLspProviderFeature(languageId, "codeAction")) {
      const actionPayloads = new WeakMap<object, { modelUri: string; raw: Record<string, unknown> }>();
      const toCodeAction = (
        modelUri: string,
        row: Record<string, unknown>,
      ): import("monaco-editor").languages.CodeAction | null => {
        const title = typeof row.title === "string" ? row.title : "";
        if (!title) return null;
        const disabled = recordOf(row.disabled);
        const action: import("monaco-editor").languages.CodeAction = {
          title,
          kind: typeof row.kind === "string" ? row.kind : "quickfix",
          isPreferred: row.isPreferred === true,
          disabled: typeof disabled?.reason === "string" ? disabled.reason : undefined,
          command: {
            id: APPLY_LSP_CODE_ACTION,
            title,
            arguments: [modelUri, row],
          },
        };
        actionPayloads.set(action, { modelUri, raw: row });
        return action;
      };
      monaco.languages.registerCodeActionProvider(languageId, {
        async provideCodeActions(model, range, actionContext) {
          const context = graphContextsByModel.get(model.uri.toString())?.current;
          if (!context?.requestLsp || !context.lspCapabilities?.codeAction) {
            return { actions: [], dispose() {} };
          }
          const diagnostics = actionContext.markers.map((marker) => {
            const code = typeof marker.code === "object" ? marker.code.value : marker.code;
            return {
              range: {
                start: { line: marker.startLineNumber - 1, character: marker.startColumn - 1 },
                end: { line: marker.endLineNumber - 1, character: marker.endColumn - 1 },
              },
              severity: marker.severity >= monaco.MarkerSeverity.Error ? 1
                : marker.severity >= monaco.MarkerSeverity.Warning ? 2 : 3,
              message: marker.message,
              ...(marker.source ? { source: marker.source } : {}),
              ...(code !== undefined ? { code } : {}),
            };
          });
          const only = actionContext.only;
          const result = await context.requestLsp("textDocument/codeAction", {
            range: {
              start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
              end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
            },
            context: {
              diagnostics,
              ...(only ? { only: [only] } : {}),
              triggerKind: Number(actionContext.trigger),
            },
          });
          const rows = Array.isArray(result) ? result : [];
          return {
            actions: rows.slice(0, 100).flatMap((item) => {
              const row = recordOf(item);
              const action = row ? toCodeAction(model.uri.toString(), row) : null;
              return action ? [action] : [];
            }),
            dispose() {},
          };
        },
        async resolveCodeAction(action) {
          const payload = actionPayloads.get(action);
          const context = payload
            ? graphContextsByModel.get(payload.modelUri)?.current
            : undefined;
          if (!payload || !context?.requestLsp || !context.lspCapabilities?.codeActionResolve) return action;
          const resolved = recordOf(await context.requestLsp("codeAction/resolve", payload.raw));
          return resolved ? toCodeAction(payload.modelUri, resolved) ?? action : action;
        },
      }, {
        providedCodeActionKinds: capabilities.codeActionKinds.length
          ? capabilities.codeActionKinds
          : ["quickfix", "refactor", "source"],
      });
    }
    if (capabilities?.formatting && claimLspProviderFeature(languageId, "formatting")) {
      monaco.languages.registerDocumentFormattingEditProvider(languageId, {
        async provideDocumentFormattingEdits(model, options) {
          const context = graphContextsByModel.get(model.uri.toString())?.current;
          if (!context?.requestLsp || !context.lspCapabilities?.formatting) return [];
          const result = await context.requestLsp("textDocument/formatting", { options });
          return (Array.isArray(result) ? result : []).flatMap((item) => {
            const row = recordOf(item);
            const range = monacoRange(row?.range);
            return range && typeof row?.newText === "string" ? [{ range, text: row.newText }] : [];
          });
        },
      });
    }
    if (capabilities?.rangeFormatting && claimLspProviderFeature(languageId, "rangeFormatting")) {
      monaco.languages.registerDocumentRangeFormattingEditProvider(languageId, {
        async provideDocumentRangeFormattingEdits(model, range, options) {
          const context = graphContextsByModel.get(model.uri.toString())?.current;
          if (!context?.requestLsp || !context.lspCapabilities?.rangeFormatting) return [];
          const result = await context.requestLsp("textDocument/rangeFormatting", {
            range: {
              start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
              end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
            },
            options,
          });
          return (Array.isArray(result) ? result : []).flatMap((item) => {
            const row = recordOf(item);
            const editRange = monacoRange(row?.range);
            return editRange && typeof row?.newText === "string"
              ? [{ range: editRange, text: row.newText }]
              : [];
          });
        },
      });
    }
    if (capabilities?.onTypeFormatting
      && claimLspProviderFeature(languageId, "onTypeFormatting")) {
      monaco.languages.registerOnTypeFormattingEditProvider(languageId, {
        autoFormatTriggerCharacters: capabilities.onTypeFormattingTriggerCharacters,
        async provideOnTypeFormattingEdits(model, position, ch, options, token) {
          const context = graphContextsByModel.get(model.uri.toString())?.current;
          if (!context?.requestLsp || !context.lspCapabilities?.onTypeFormatting
            || token.isCancellationRequested) return [];
          return lspTextEdits(await context.requestLsp(
            "textDocument/onTypeFormatting",
            { position: lspPosition(position), ch, options },
          ));
        },
      });
    }
    if (capabilities?.documentLink && claimLspProviderFeature(languageId, "documentLink")) {
      const linkPayloads = new WeakMap<object, { modelUri: string; raw: Record<string, unknown> }>();
      const toLink = (
        modelUri: string,
        raw: Record<string, unknown>,
      ): import("monaco-editor").languages.ILink | null => {
        const range = monacoRange(raw.range);
        if (!range) return null;
        const link: import("monaco-editor").languages.ILink = {
          range,
          url: typeof raw.target === "string" ? raw.target : undefined,
          tooltip: typeof raw.tooltip === "string" ? raw.tooltip : undefined,
        };
        linkPayloads.set(link, { modelUri, raw });
        return link;
      };
      monaco.languages.registerLinkProvider(languageId, {
        async provideLinks(model, token) {
          const context = graphContextsByModel.get(model.uri.toString())?.current;
          if (!context?.requestLsp || !context.lspCapabilities?.documentLink
            || token.isCancellationRequested) return { links: [], dispose() {} };
          const result = await context.requestLsp("textDocument/documentLink");
          return {
            links: (Array.isArray(result) ? result : []).flatMap((item) => {
              const row = recordOf(item);
              const link = row ? toLink(model.uri.toString(), row) : null;
              return link ? [link] : [];
            }),
            dispose() {},
          };
        },
        async resolveLink(link) {
          const payload = linkPayloads.get(link);
          const context = payload
            ? graphContextsByModel.get(payload.modelUri)?.current
            : undefined;
          if (!payload || !context?.requestLsp || !context.lspCapabilities?.documentLinkResolve) {
            return link;
          }
          const resolved = recordOf(await context.requestLsp("documentLink/resolve", payload.raw));
          return resolved ? toLink(payload.modelUri, resolved) ?? link : link;
        },
      });
    }
    if (capabilities?.documentColor && claimLspProviderFeature(languageId, "documentColor")) {
      monaco.languages.registerColorProvider(languageId, {
        async provideDocumentColors(model, token) {
          const context = graphContextsByModel.get(model.uri.toString())?.current;
          if (!context?.requestLsp || !context.lspCapabilities?.documentColor
            || token.isCancellationRequested) return [];
          const result = await context.requestLsp("textDocument/documentColor");
          return (Array.isArray(result) ? result : []).flatMap((item) => {
            const row = recordOf(item);
            const color = recordOf(row?.color);
            const range = monacoRange(row?.range);
            return range && color ? [{
              range,
              color: {
                red: Math.max(0, Math.min(1, Number(color.red) || 0)),
                green: Math.max(0, Math.min(1, Number(color.green) || 0)),
                blue: Math.max(0, Math.min(1, Number(color.blue) || 0)),
                alpha: Math.max(0, Math.min(1, Number(color.alpha) || 0)),
              },
            }] : [];
          });
        },
        async provideColorPresentations(model, colorInfo, token) {
          const context = graphContextsByModel.get(model.uri.toString())?.current;
          if (!context?.requestLsp || !context.lspCapabilities?.documentColor
            || token.isCancellationRequested) return [];
          const result = await context.requestLsp("textDocument/colorPresentation", {
            color: colorInfo.color,
            range: lspRange(colorInfo.range),
          });
          return (Array.isArray(result) ? result : []).flatMap((item) => {
            const row = recordOf(item);
            if (!row || typeof row.label !== "string") return [];
            const edits = lspTextEdits(row.additionalTextEdits);
            const textEdit = lspTextEdits(row.textEdit ? [row.textEdit] : [])[0];
            return [{
              label: row.label,
              textEdit,
              additionalTextEdits: edits.length ? edits : undefined,
            }];
          });
        },
      });
    }
    if (capabilities?.foldingRange && claimLspProviderFeature(languageId, "foldingRange")) {
      monaco.languages.registerFoldingRangeProvider(languageId, {
        async provideFoldingRanges(model, _foldingContext, token) {
          const context = graphContextsByModel.get(model.uri.toString())?.current;
          if (!context?.requestLsp || !context.lspCapabilities?.foldingRange
            || token.isCancellationRequested) return [];
          const result = await context.requestLsp("textDocument/foldingRange");
          return (Array.isArray(result) ? result : []).flatMap((item) => {
            const row = recordOf(item);
            const start = Number(row?.startLine);
            const end = Number(row?.endLine);
            return Number.isFinite(start) && Number.isFinite(end) && end > start ? [{
              start: start + 1,
              end: end + 1,
              kind: typeof row?.kind === "string"
                ? monaco.languages.FoldingRangeKind.fromValue(row.kind)
                : undefined,
            }] : [];
          });
        },
      });
    }
    if (capabilities?.selectionRange && claimLspProviderFeature(languageId, "selectionRange")) {
      monaco.languages.registerSelectionRangeProvider(languageId, {
        async provideSelectionRanges(model, positions, token) {
          const context = graphContextsByModel.get(model.uri.toString())?.current;
          if (!context?.requestLsp || !context.lspCapabilities?.selectionRange
            || token.isCancellationRequested) return [];
          const result = await context.requestLsp("textDocument/selectionRange", {
            positions: positions.map(lspPosition),
          });
          return (Array.isArray(result) ? result : []).map((item) => {
            const ranges: import("monaco-editor").languages.SelectionRange[] = [];
            let cursor: unknown = item;
            for (let depth = 0; depth < 100 && cursor; depth += 1) {
              const row = recordOf(cursor);
              const range = monacoRange(row?.range);
              if (!row || !range) break;
              ranges.push({ range });
              cursor = row.parent;
            }
            return ranges;
          });
        },
      });
    }
    if (capabilities?.semanticTokens && capabilities.semanticTokensLegend.tokenTypes.length
      && claimLspProviderFeature(languageId, "semanticTokens")) {
      const legend = capabilities.semanticTokensLegend;
      monaco.languages.registerDocumentSemanticTokensProvider(languageId, {
        getLegend: () => legend,
        async provideDocumentSemanticTokens(model, lastResultId, token) {
          const context = graphContextsByModel.get(model.uri.toString())?.current;
          if (!context?.requestLsp || !context.lspCapabilities?.semanticTokens
            || token.isCancellationRequested) return { data: new Uint32Array() };
          const delta = Boolean(lastResultId && context.lspCapabilities.semanticTokensDelta);
          const result = recordOf(await context.requestLsp(
            delta ? "textDocument/semanticTokens/full/delta" : "textDocument/semanticTokens/full",
            delta ? { previousResultId: lastResultId } : {},
          ));
          if (Array.isArray(result?.edits)) {
            return {
              resultId: typeof result.resultId === "string" ? result.resultId : undefined,
              edits: result.edits.flatMap((item) => {
                const edit = recordOf(item);
                if (!edit) return [];
                return [{
                  start: Math.max(0, Number(edit.start) || 0),
                  deleteCount: Math.max(0, Number(edit.deleteCount) || 0),
                  data: Array.isArray(edit.data) ? semanticTokenData(edit.data) : undefined,
                }];
              }),
            };
          }
          return {
            resultId: typeof result?.resultId === "string" ? result.resultId : undefined,
            data: semanticTokenData(result?.data),
          };
        },
        releaseDocumentSemanticTokens() {},
      });
    }
    if (capabilities?.semanticTokensRange && capabilities.semanticTokensLegend.tokenTypes.length
      && claimLspProviderFeature(languageId, "semanticTokensRange")) {
      const legend = capabilities.semanticTokensLegend;
      monaco.languages.registerDocumentRangeSemanticTokensProvider(languageId, {
        getLegend: () => legend,
        async provideDocumentRangeSemanticTokens(model, range, token) {
          const context = graphContextsByModel.get(model.uri.toString())?.current;
          if (!context?.requestLsp || !context.lspCapabilities?.semanticTokensRange
            || token.isCancellationRequested) return { data: new Uint32Array() };
          const result = recordOf(await context.requestLsp(
            "textDocument/semanticTokens/range",
            { range: lspRange(range) },
          ));
          return {
            resultId: typeof result?.resultId === "string" ? result.resultId : undefined,
            data: semanticTokenData(result?.data),
          };
        },
      });
    }
    if (capabilities?.inlayHint && claimLspProviderFeature(languageId, "inlayHint")) {
      const hintPayloads = new WeakMap<object, { modelUri: string; raw: Record<string, unknown> }>();
      const toHint = (
        modelUri: string,
        raw: Record<string, unknown>,
      ): import("monaco-editor").languages.InlayHint | null => {
        const position = monacoPosition(raw.position);
        if (!position) return null;
        const rawLabel = raw.label;
        const label = typeof rawLabel === "string"
          ? rawLabel
          : Array.isArray(rawLabel)
            ? rawLabel.flatMap((item) => {
                const part = recordOf(item);
                if (!part || typeof part.value !== "string") return [];
                const location = recordOf(part.location);
                const locationContext = graphContextsByModel.get(modelUri)?.current;
                const locations = locationContext && location
                  ? lspLocations(location, locationContext)
                  : [];
                return [{
                  label: part.value,
                  tooltip: markupText(part.tooltip) || undefined,
                  command: lspCommand(part.command, modelUri),
                  location: locations[0],
                }];
              })
            : "";
        if (!label || (Array.isArray(label) && !label.length)) return null;
        const hint: import("monaco-editor").languages.InlayHint = {
          label,
          position,
          kind: Number(raw.kind) === 1
            ? monaco.languages.InlayHintKind.Type
            : Number(raw.kind) === 2
              ? monaco.languages.InlayHintKind.Parameter
              : undefined,
          tooltip: markupText(raw.tooltip) || undefined,
          textEdits: lspTextEdits(raw.textEdits),
          paddingLeft: raw.paddingLeft === true,
          paddingRight: raw.paddingRight === true,
        };
        hintPayloads.set(hint, { modelUri, raw });
        return hint;
      };
      monaco.languages.registerInlayHintsProvider(languageId, {
        async provideInlayHints(model, range, token) {
          const context = graphContextsByModel.get(model.uri.toString())?.current;
          if (!context?.requestLsp || !context.lspCapabilities?.inlayHint
            || token.isCancellationRequested) return { hints: [], dispose() {} };
          const result = await context.requestLsp(
            "textDocument/inlayHint",
            { range: lspRange(range) },
          );
          return {
            hints: (Array.isArray(result) ? result : []).flatMap((item) => {
              const row = recordOf(item);
              const hint = row ? toHint(model.uri.toString(), row) : null;
              return hint ? [hint] : [];
            }),
            dispose() {},
          };
        },
        async resolveInlayHint(hint) {
          const payload = hintPayloads.get(hint);
          const context = payload
            ? graphContextsByModel.get(payload.modelUri)?.current
            : undefined;
          if (!payload || !context?.requestLsp || !context.lspCapabilities?.inlayHintResolve) {
            return hint;
          }
          const resolved = recordOf(await context.requestLsp("inlayHint/resolve", payload.raw));
          return resolved ? toHint(payload.modelUri, resolved) ?? hint : hint;
        },
      });
    }
  }
  if (!lspWorkspaceEditCommandInstalled) {
    lspWorkspaceEditCommandInstalled = true;
    monaco.editor.registerCommand(APPLY_LSP_WORKSPACE_EDIT, (_accessor, modelUri, edit) => {
      const context = graphContextsByModel.get(String(modelUri || ""))?.current;
      if (context?.applyWorkspaceEdit) void context.applyWorkspaceEdit(edit);
    });
  }
  if (!lspCodeActionCommandInstalled) {
    lspCodeActionCommandInstalled = true;
    monaco.editor.registerCommand(APPLY_LSP_CODE_ACTION, (_accessor, modelUri, rawAction) => {
      const context = graphContextsByModel.get(String(modelUri || ""))?.current;
      const action = recordOf(rawAction);
      if (!context || !action) return;
      void (async () => {
        if (action.edit && context.applyWorkspaceEdit
          && !await context.applyWorkspaceEdit(action.edit, String(action.title || "Code action"))) return;
        const nested = recordOf(action.command);
        const command = typeof action.command === "string" ? action : nested;
        if (command && typeof command.command === "string" && context.requestLsp) {
          await context.requestLsp("workspace/executeCommand", {
            command: command.command,
            arguments: Array.isArray(command.arguments) ? command.arguments : [],
          });
        }
      })().catch((reason) => context.onLanguageError?.(
        reason instanceof Error ? reason.message : String(reason)));
    });
  }
  if (!lspCommandInstalled) {
    lspCommandInstalled = true;
    monaco.editor.registerCommand(EXECUTE_LSP_COMMAND, (_accessor, modelUri, rawCommand) => {
      const context = graphContextsByModel.get(String(modelUri || ""))?.current;
      const command = recordOf(rawCommand);
      if (!context?.requestLsp || !command || typeof command.command !== "string") return;
      void context.requestLsp("workspace/executeCommand", {
        command: command.command,
        arguments: Array.isArray(command.arguments) ? command.arguments : [],
      }).catch((reason) => context.onLanguageError?.(
        reason instanceof Error ? reason.message : String(reason)));
    });
  }
  if (!graphEditorOpenerInstalled) {
    graphEditorOpenerInstalled = true;
    monaco.editor.registerEditorOpener({
      openCodeEditor(source, resource, selectionOrPosition) {
        const context = graphContextsByEditor.get(source)?.current;
        if (!context?.onOpenAt) return false;
        const root = normalizedFilePath(context.projectPath);
        const target = normalizedFilePath(resource.fsPath);
        const comparableRoot = root.toLowerCase();
        const comparableTarget = target.toLowerCase();
        if (comparableTarget !== comparableRoot && !comparableTarget.startsWith(`${comparableRoot}/`)) {
          return false;
        }
        const rel = target.slice(root.length).replace(/^\/+/, "");
        if (!rel) return false;
        const line = selectionOrPosition
          ? ("lineNumber" in selectionOrPosition
              ? selectionOrPosition.lineNumber
              : selectionOrPosition.startLineNumber)
          : 1;
        context.onOpenAt(rel, line);
        return true;
      },
    });
  }
}

export default function EditorPane({ projectPath, relPath, accessToken, workspaceFile, active, focused, onDirty, onSaveHandle, reveal, codeGraph, onOpenAt, onNavigationLocation, onReady }: {
  projectPath: string;
  relPath: string;
  accessToken?: string;
  workspaceFile?: string;
  active: boolean;
  focused: boolean;
  onDirty(dirty: boolean): void;
  onSaveHandle?(handle: EditorFileHandle | null): void;
  reveal?: { line: number; nonce: number } | null;
  codeGraph?(mode: EditorCodeGraphMode, query: string): Promise<string>;
  onOpenAt?(rel: string, line: number): void;
  onNavigationLocation?(rel: string, line: number, column: number): void;
  onReady?(): void;
}) {
  const api = window.mixdogDesktop;
  ensureEditorLoad(projectPath, relPath, accessToken);
  reportEditorLoadStage(projectPath, relPath, accessToken, "module");
  const abs = `${projectPath.replace(/[\\/]+$/, "")}/${relPath}`;
  const viewStateKey = normalizedFilePath(abs);
  const [load, setLoad] = useState<FileLoad | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [diskChanged, setDiskChanged] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [revertError, setRevertError] = useState("");
  const [recovery, setRecovery] = useState<EditorRecovery | null>(null);
  const [breadcrumbOutline, setBreadcrumbOutline] = useState<EditorOutlineItem[]>([]);
  const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 });
  const [selectionStatus, setSelectionStatus] = useState({ selections: 1, characters: 0 });
  const [problemStatus, setProblemStatus] = useState({ errors: 0, warnings: 0 });
  const [editorFormat, setEditorFormat] = useState({
    tabSize: 4,
    insertSpaces: true,
    eol: "LF",
    languageId: "",
  });
  const [editorSettings, setEditorSettings] = useState<DesktopEditorSettings>(
    DEFAULT_DESKTOP_EDITOR_SETTINGS,
  );
  // Alt+Z override: the Editor options prop is re-applied on every render
  // (monaco-react updateOptions), so a plain editor.updateOptions toggle
  // would be reverted immediately. null follows the settings value.
  const [wordWrapOverride, setWordWrapOverride] =
    useState<DesktopEditorSettings["wordWrap"] | null>(null);
  const editorSettingsRef = useRef(editorSettings);
  editorSettingsRef.current = editorSettings;
  const [breadcrumbPicker, setBreadcrumbPicker] = useState<BreadcrumbPickerState | null>(null);
  const [breadcrumbFocusIndex, setBreadcrumbFocusIndex] = useState(0);
  const [, setLspFeatureRevision] = useState(0);
  const mediaForeground = useForegroundMedia(active);
  const [callHierarchy, setCallHierarchy] = useState<{
    root: EditorCallHierarchyItem | null;
    rows: EditorCallHierarchyItem[];
    stack: EditorCallHierarchyItem[];
    direction: "incoming" | "outgoing";
    selectedIndex: number;
    loading: boolean;
    error: string;
  } | null>(null);
  const callHierarchyRef = useRef(callHierarchy);
  callHierarchyRef.current = callHierarchy;
  const [callHierarchyTarget, setCallHierarchyTarget] = useState<HTMLElement | null>(null);
  const [callHierarchyLayout, setCallHierarchyLayout] = useState<CallHierarchyLayout>(
    readCallHierarchyLayout,
  );
  const [callHierarchyPreview, setCallHierarchyPreview] = useState<CallHierarchyPreview | null>(null);
  const callHierarchyPreviewGeneration = useRef(0);
  const callHierarchyTreeRef = useRef<HTMLDivElement | null>(null);
  const breadcrumbPickerGeneration = useRef(0);
  const breadcrumbPickerRef = useRef<HTMLDivElement | null>(null);
  const breadcrumbButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const breadcrumbPickerRowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Gutter quick-diff (VSCode parity): stripes vs the git worktree diff.
  const diffDecorations = useRef<import("monaco-editor").editor.IEditorDecorationsCollection | null>(null);
  const ansiDecorations = useRef<import("monaco-editor").editor.IEditorDecorationsCollection | null>(null);
  const ansiStyleElement = useRef<HTMLStyleElement | null>(null);
  const ansiRenderTimer = useRef<number | null>(null);
  const [diffTick, setDiffTick] = useState(0);
  const editorRef = useRef<import("monaco-editor").editor.IStandaloneCodeEditor | null>(null);
  const editorLayoutSize = useRef<EditorLayoutDimension | null>(null);
  const callHierarchyZone = useRef<{
    id: string;
    zone: {
      afterLineNumber: number;
      heightInLines: number;
      domNode: HTMLElement;
      suppressMouseDown: boolean;
    };
  } | null>(null);
  const activeRef = useRef(active);
  const focusedRef = useRef(focused);
  activeRef.current = active;
  focusedRef.current = focused;
  const [modelUri, setModelUri] = useState("");
  const lspReady = useRef(false);
  const lspCapabilities = useRef<DesktopLspCapabilities | null>(null);
  const lspCapabilitiesKey = useRef("");
  const lspLanguageId = useRef("");
  const lspLastVersion = useRef(-1);
  const lspOpenPromise = useRef<Promise<unknown> | null>(null);
  const lspAttached = useRef(false);
  const lspAttachmentEpoch = useRef(0);
  const lspReopenAt = useRef(0);
  const lspChangeTimer = useRef<number | null>(null);
  const outlineTimer = useRef<number | null>(null);
  const languageDisposables = useRef<Array<{ dispose(): void }>>([]);
  const editorLayoutObserver = useRef<ResizeObserver | null>(null);
  const lspMarkerSignature = useRef("");
  const callHierarchyContextKey =
    useRef<import("monaco-editor").editor.IContextKey<boolean> | null>(null);
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const graphContextRef = useRef<EditorGraphContext>({
    projectPath,
    relPath,
    codeGraph,
    onOpenAt,
  });
  const savedMtime = useRef(0);
  const savedDiskText = useRef("");
  const savedText = useRef("");
  const loadedRef = useRef(false);
  const savingRef = useRef(false);
  const saveQueue = useRef<Promise<boolean>>(Promise.resolve(true));
  const backupTimer = useRef<number | null>(null);
  const backupQueue = useRef<Promise<void>>(Promise.resolve());
  const skipUnmountBackup = useRef(false);
  const skipNextBackupRestore = useRef(false);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onNavigationLocationRef = useRef(onNavigationLocation);
  onNavigationLocationRef.current = onNavigationLocation;
  const layoutEditorToHost = useCallback((
    editor: import("monaco-editor").editor.IStandaloneCodeEditor,
    layoutHost: HTMLElement,
  ) => {
    if (editorRef.current !== editor) return;
    const dimension = nextEditorLayoutDimension(editorLayoutSize.current, layoutHost);
    if (!dimension) return;
    editorLayoutSize.current = dimension;
    editor.layout(dimension);
  }, []);
  const scheduleEditorLayout = useCallback((
    editor: import("monaco-editor").editor.IStandaloneCodeEditor,
    layoutHost: HTMLElement,
  ) => {
    scheduleLayoutFrame(editor, () => layoutEditorToHost(editor, layoutHost));
  }, [layoutEditorToHost]);
  const notifyReady = useCallback(() => onReadyRef.current?.(), []);
  const enqueueBackup = useCallback((operation: () => Promise<unknown>): Promise<void> => {
    const run = backupQueue.current.catch(() => undefined).then(operation).then(() => undefined);
    backupQueue.current = run.catch(() => undefined);
    return run;
  }, []);
  const writeBackupNow = useCallback((content: string): Promise<void> => {
    if (!api?.writeEditorBackup) return Promise.resolve();
    return enqueueBackup(() => api.writeEditorBackup!(
      projectPath,
      relPath,
      content,
      savedDiskText.current,
      accessToken,
    ));
  }, [accessToken, api, enqueueBackup, projectPath, relPath]);
  useEffect(() => {
    let live = true;
    const reader = api?.readEditorSettings;
    if (!reader || accessToken) {
      setEditorSettings(DEFAULT_DESKTOP_EDITOR_SETTINGS);
      return () => { live = false; };
    }
    void reader(projectPath, relPath, workspaceFile)
      .then((settings) => {
        if (live && settings) setEditorSettings(settings);
      })
      .catch(() => {
        if (live) setEditorSettings(DEFAULT_DESKTOP_EDITOR_SETTINGS);
      });
    return () => { live = false; };
  }, [accessToken, api, projectPath, relPath, workspaceFile]);
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    if (editorSettings.detectIndentation) {
      model.detectIndentation(editorSettings.insertSpaces, editorSettings.tabSize);
    } else {
      model.updateOptions({
        tabSize: editorSettings.tabSize,
        insertSpaces: editorSettings.insertSpaces,
      });
    }
  }, [editorSettings.detectIndentation, editorSettings.insertSpaces, editorSettings.tabSize]);
  const deleteBackup = useCallback((): Promise<void> => {
    if (backupTimer.current !== null) {
      window.clearTimeout(backupTimer.current);
      backupTimer.current = null;
    }
    if (!api?.deleteEditorBackup) return Promise.resolve();
    return enqueueBackup(() => api.deleteEditorBackup!(
      projectPath,
      relPath,
      accessToken,
    ));
  }, [accessToken, api, enqueueBackup, projectPath, relPath]);
  const scheduleBackup = useCallback((content: string) => {
    if (backupTimer.current !== null) window.clearTimeout(backupTimer.current);
    backupTimer.current = window.setTimeout(() => {
      backupTimer.current = null;
      void writeBackupNow(content).catch(() => undefined);
    }, 500);
  }, [writeBackupNow]);
  // READY is reported by the concrete surfaces below (Monaco onMount after
  // view-state restore, preview load, binary/error fallback) — NOT on first
  // DOM commit: an early ready dropped the pane cover one frame before
  // Monaco's rAF layout, so the fresh editor visibly settled up-right
  // (user: 스크립트 생성될 때 한 프레임 자리잡는 게 보인다). The gate's
  // 900ms cover cap still bounds a slow hydration.
  const removeCallHierarchyZone = useCallback(() => {
    const editor = editorRef.current;
    const current = callHierarchyZone.current;
    callHierarchyZone.current = null;
    if (editor && current) {
      try {
        editor.changeViewZones((accessor) => accessor.removeZone(current.id));
      } catch {
        // A disposed editor already removed all view zones.
      }
    }
    setCallHierarchyTarget(null);
  }, []);
  const closeCallHierarchy = useCallback(() => {
    setCallHierarchy(null);
    setCallHierarchyPreview(null);
    removeCallHierarchyZone();
    editorRef.current?.focus();
  }, [removeCallHierarchyZone]);
  const showCallHierarchyZone = useCallback((position: import("monaco-editor").Position) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    removeCallHierarchyZone();
    const domNode = document.createElement("div");
    domNode.className = "editor-call-hierarchy-zone";
    const visible = editor.getScrolledVisiblePosition(position);
    domNode.style.setProperty("--peek-arrow-left", `${Math.max(12, visible?.left ?? 12)}px`);
    const zone = {
      afterLineNumber: Math.min(model.getLineCount(), Math.max(1, position.lineNumber)),
      heightInLines: callHierarchyLayout.height,
      domNode,
      suppressMouseDown: false,
    };
    let id = "";
    editor.changeViewZones((accessor) => {
      id = accessor.addZone(zone);
    });
    callHierarchyZone.current = { id, zone };
    setCallHierarchyTarget(domNode);
    editor.revealLineInCenter(position.lineNumber);
  }, [callHierarchyLayout.height, removeCallHierarchyZone]);
  useEffect(() => {
    try {
      window.localStorage.setItem(CALL_HIERARCHY_LAYOUT_KEY, JSON.stringify(callHierarchyLayout));
    } catch {
      // Peek layout is a convenience only.
    }
    const editor = editorRef.current;
    const current = callHierarchyZone.current;
    if (!editor || !current) return;
    current.zone.heightInLines = callHierarchyLayout.height;
    editor.changeViewZones((accessor) => accessor.layoutZone(current.id));
  }, [callHierarchyLayout]);
  useEffect(() => () => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const viewState = editor?.saveViewState();
    if (viewState) writeEditorViewState(viewStateKey, viewState);
    if (model && graphContextsByModel.get(model.uri.toString()) === graphContextRef) {
      graphContextsByModel.delete(model.uri.toString());
    }
    if (editor) graphContextsByEditor.delete(editor);
    if (focusedGraphEditor === editor) focusedGraphEditor = null;
    const hierarchyZone = callHierarchyZone.current;
    if (editor && hierarchyZone) {
      try {
        editor.changeViewZones((accessor) => accessor.removeZone(hierarchyZone.id));
      } catch {
        // Editor disposal also removes the zone.
      }
      callHierarchyZone.current = null;
    }
    callHierarchyContextKey.current?.reset();
    callHierarchyContextKey.current = null;
    if (lspChangeTimer.current !== null) window.clearTimeout(lspChangeTimer.current);
    if (outlineTimer.current !== null) window.clearTimeout(outlineTimer.current);
    if (backupTimer.current !== null) window.clearTimeout(backupTimer.current);
    if (ansiRenderTimer.current !== null) window.clearTimeout(ansiRenderTimer.current);
    if (model && !skipUnmountBackup.current && model.getValue() !== savedText.current) {
      void writeBackupNow(model.getValue()).catch(() => undefined);
    }
    for (const disposable of languageDisposables.current.splice(0)) disposable.dispose();
    if (model) {
      clearActiveEditorDocument(model.uri.toString());
      if (lspAttached.current && api?.lspDocument) {
        lspAttached.current = false;
        lspAttachmentEpoch.current += 1;
        const pendingOpen = lspOpenPromise.current;
        lspOpenPromise.current = null;
        lspReady.current = false;
        lspLastVersion.current = -1;
        void Promise.resolve(pendingOpen).catch(() => undefined).then(() =>
          api.lspDocument!({
            kind: "close",
            projectPath,
            relPath,
            languageId: lspLanguageId.current || model.getLanguageId(),
            version: model.getVersionId(),
          })).catch(() => undefined);
      }
    }
    diffDecorations.current?.clear();
    diffDecorations.current = null;
    ansiDecorations.current?.clear();
    ansiDecorations.current = null;
    ansiStyleElement.current?.remove();
    ansiStyleElement.current = null;
    editorLayoutObserver.current?.disconnect();
    editorLayoutObserver.current = null;
    editorLayoutSize.current = null;
    if (editor) cancelLayoutFrame(editor);
    editorRef.current = null;
    model?.dispose();
  }, [api, projectPath, relPath, viewStateKey, writeBackupNow]);
  // Follow the app theme (default dark; :root[data-mixdog-theme="light"]).
  const [lightTheme, setLightTheme] = useState(() => document.documentElement.dataset.mixdogTheme === "light");
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setLightTheme(document.documentElement.dataset.mixdogTheme === "light"));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mixdog-theme"] });
    return () => observer.disconnect();
  }, []);
  const renderAnsiOutput = useCallback((
    model: import("monaco-editor").editor.ITextModel | null | undefined,
  ) => {
    const editor = editorRef.current;
    if (!editor || !model || !isAnsiOutputPath(relPath) || !model.getValue().includes("\x1b[")) {
      ansiDecorations.current?.clear();
      if (ansiStyleElement.current) ansiStyleElement.current.textContent = "";
      return;
    }
    const plan = editorAnsiDecorationPlan(model.getValue(), lightTheme);
    const next = plan.decorations.map((decoration) => ({
      range: new monaco.Range(
        model.getPositionAt(decoration.start).lineNumber,
        model.getPositionAt(decoration.start).column,
        model.getPositionAt(decoration.end).lineNumber,
        model.getPositionAt(decoration.end).column,
      ),
      options: {
        inlineClassName: decoration.className,
        inlineClassNameAffectsLetterSpacing: decoration.className === "editor-ansi-control",
      },
    }));
    if (ansiDecorations.current) ansiDecorations.current.set(next);
    else ansiDecorations.current = editor.createDecorationsCollection(next);
    if (!ansiStyleElement.current) {
      const style = document.createElement("style");
      style.dataset.mixdogEditorAnsi = "true";
      document.head.appendChild(style);
      ansiStyleElement.current = style;
    }
    ansiStyleElement.current.textContent = plan.cssText;
  }, [lightTheme, relPath]);
  const scheduleAnsiOutput = useCallback((
    model: import("monaco-editor").editor.ITextModel | null | undefined,
  ) => {
    if (ansiRenderTimer.current !== null) window.clearTimeout(ansiRenderTimer.current);
    ansiRenderTimer.current = window.setTimeout(() => {
      ansiRenderTimer.current = null;
      renderAnsiOutput(model);
    }, 80);
  }, [renderAnsiOutput]);
  useEffect(() => {
    renderAnsiOutput(editorRef.current?.getModel());
  }, [renderAnsiOutput]);
  const onDirtyRef = useRef(onDirty);
  onDirtyRef.current = onDirty;
  const markDirty = useCallback((next: boolean) => {
    setDirty(next);
    onDirtyRef.current(next);
  }, []);
  const publishOutline = useCallback((
    uri: string,
    rows: EditorOutlineItem[],
  ) => {
    setEditorOutline(uri, rows);
    setBreadcrumbOutline(rows);
  }, []);
  const acceptLspState = useCallback((state: DesktopLspServerState, languageId: string) => {
    lspReady.current = state.available;
    lspCapabilities.current = state.capabilities ?? null;
    callHierarchyContextKey.current?.set(
      Boolean(state.available && state.capabilities?.callHierarchy),
    );
    const key = JSON.stringify(state.capabilities ?? null);
    if (state.available && state.capabilities) {
      lspCapabilitiesByLanguage.set(languageId, state.capabilities);
      lspReadyLanguages.add(languageId);
      ensureGraphProviders(languageId);
    }
    if (key !== lspCapabilitiesKey.current) {
      lspCapabilitiesKey.current = key;
      setLspFeatureRevision((revision) => revision + 1);
    }
  }, []);
  const syncLsp = useCallback(async (kind: "change" | "save" = "change"): Promise<boolean> => {
    const model = editorRef.current?.getModel();
    if (!model || !api?.lspDocument) return false;
    if (lspOpenPromise.current) await lspOpenPromise.current.catch(() => undefined);
    if (!lspReady.current) {
      // A failed attach (server cold-start timeout at boot, idle 'missing'
      // window) must not mute the document forever — typing retried NOTHING
      // and diagnostics never appeared (user: 타이핑해도 반응 없음). Re-open
      // with the current content, throttled, and continue this very sync.
      if (!lspAttached.current || Date.now() < lspReopenAt.current) return false;
      lspReopenAt.current = Date.now() + 5_000;
      const epoch = lspAttachmentEpoch.current;
      const reopening = api.lspDocument({
        kind: "open",
        projectPath,
        relPath,
        languageId: model.getLanguageId(),
        version: model.getVersionId(),
        content: model.getValue(),
      });
      lspOpenPromise.current = reopening;
      try {
        const state = await reopening;
        if (epoch !== lspAttachmentEpoch.current || !lspAttached.current) return false;
        acceptLspState(state, model.getLanguageId());
        if (!state.available) return false;
        lspLastVersion.current = model.getVersionId();
        return true;
      } catch {
        return false;
      }
    }
    const version = model.getVersionId();
    if (kind === "change" && version === lspLastVersion.current) return true;
    const state = await api.lspDocument({
      kind,
      projectPath,
      relPath,
      languageId: model.getLanguageId(),
      version,
      content: model.getValue(),
    });
    acceptLspState(state, model.getLanguageId());
    if (state.available) lspLastVersion.current = version;
    return state.available;
  }, [acceptLspState, api, projectPath, relPath]);
  const requestLsp = useCallback(async (
    method: DesktopLspRequestMethod,
    params: Record<string, unknown> = {},
  ): Promise<unknown> => {
    const model = editorRef.current?.getModel();
    if (!model || !api?.lspRequest || !await syncLsp("change")) return undefined;
    const response = await api.lspRequest({
      projectPath,
      relPath,
      languageId: model.getLanguageId(),
      method,
      params,
    });
    return response.available && response.status !== "error" ? response.result : undefined;
  }, [api, projectPath, relPath, syncLsp]);
  const applyWorkspaceEdit = useCallback(async (
    edit: unknown,
    confirmationLabel?: string,
  ): Promise<boolean> => {
    try {
      setSaveError("");
      return await applyLspWorkspaceEdit(graphContextRef.current, edit, confirmationLabel);
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : String(reason));
      return false;
    }
  }, []);
  const updateOutline = useCallback(async (): Promise<void> => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    const raw = await requestLsp("textDocument/documentSymbol");
    const converted = lspDocumentSymbols(model, raw, graphContextRef.current);
    if (converted.outline.length) {
      publishOutline(model.uri.toString(), converted.outline);
      return;
    }
    if (!codeGraph) {
      publishOutline(model.uri.toString(), []);
      return;
    }
    try {
      const rows = parseCodeGraphSymbols(await codeGraph("symbols", relPath));
      publishOutline(
        model.uri.toString(),
        codeGraphOutlineItems(model, graphContextRef.current, rows),
      );
    } catch {
      publishOutline(model.uri.toString(), []);
    }
  }, [codeGraph, projectPath, publishOutline, relPath, requestLsp]);
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model || !api?.lspDocument) return;
    const languageId = model.getLanguageId();
    if (active) {
      if (lspAttached.current) return;
      lspAttached.current = true;
      const epoch = ++lspAttachmentEpoch.current;
      lspLanguageId.current = languageId;
      const opening = api.lspDocument({
        kind: "open",
        projectPath,
        relPath,
        languageId,
        version: model.getVersionId(),
        content: model.getValue(),
      });
      lspOpenPromise.current = opening;
      void opening.then((state) => {
        if (epoch !== lspAttachmentEpoch.current || !lspAttached.current) return;
        acceptLspState(state, languageId);
        if (state.available) lspLastVersion.current = model.getVersionId();
        void updateOutline();
      }).catch(() => {
        if (epoch === lspAttachmentEpoch.current) lspReady.current = false;
      });
      return;
    }
    if (!lspAttached.current) return;
    lspAttached.current = false;
    lspAttachmentEpoch.current += 1;
    const pendingOpen = lspOpenPromise.current;
    lspOpenPromise.current = null;
    lspReady.current = false;
    lspLastVersion.current = -1;
    void Promise.resolve(pendingOpen).catch(() => undefined).then(() =>
      api.lspDocument!({
        kind: "close",
        projectPath,
        relPath,
        languageId: lspLanguageId.current || languageId,
        version: model.getVersionId(),
      })).catch(() => undefined);
  }, [acceptLspState, active, api, modelUri, projectPath, relPath, updateOutline]);
  const loadCallHierarchy = useCallback(async (
    root: EditorCallHierarchyItem,
    direction: "incoming" | "outgoing",
    stack: EditorCallHierarchyItem[],
  ) => {
    setCallHierarchy({
      root,
      rows: [],
      stack,
      direction,
      selectedIndex: 0,
      loading: true,
      error: "",
    });
    try {
      const result = await requestLsp(
        direction === "incoming" ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls",
        { item: root.raw },
      );
      const rows = (Array.isArray(result) ? result : []).flatMap((value) => {
        const record = recordOf(value);
        const item = lspCallHierarchyItem(
          direction === "incoming" ? record?.from : record?.to,
          graphContextRef.current,
        );
        if (!item) return [];
        const ranges = (Array.isArray(record?.fromRanges) ? record.fromRanges : [])
          .flatMap((rawRange) => {
            const range = monacoRange(rawRange);
            return range ? [range] : [];
          });
        return [{
          ...item,
          previewUri: direction === "incoming" ? item.uri : root.uri,
          previewRanges: ranges.length ? ranges : [item.selectionRange],
        }];
      });
      setCallHierarchy({
        root,
        rows,
        stack,
        direction,
        selectedIndex: 0,
        loading: false,
        error: "",
      });
    } catch (reason) {
      setCallHierarchy({
        root,
        rows: [],
        stack,
        direction,
        selectedIndex: 0,
        loading: false,
        error: reason instanceof Error ? reason.message : String(reason),
      });
    }
  }, [requestLsp]);
  const startCallHierarchy = useCallback(async () => {
    const position = editorRef.current?.getPosition();
    if (!position) return;
    setCallHierarchy({
      root: null,
      rows: [],
      stack: [],
      direction: window.localStorage.getItem(CALL_HIERARCHY_DIRECTION_KEY) === "outgoing"
        ? "outgoing"
        : "incoming",
      selectedIndex: 0,
      loading: true,
      error: "",
    });
    showCallHierarchyZone(position);
    try {
      const result = await requestLsp(
        "textDocument/prepareCallHierarchy",
        { position: lspPosition(position) },
      );
      const root = lspCallHierarchyItem(
        Array.isArray(result) ? result[0] : result,
        graphContextRef.current,
      );
      if (!root) throw new Error("No call hierarchy is available at the cursor.");
      const direction = window.localStorage.getItem(CALL_HIERARCHY_DIRECTION_KEY) === "outgoing"
        ? "outgoing"
        : "incoming";
      await loadCallHierarchy(root, direction, []);
    } catch (reason) {
      setCallHierarchy({
        root: null,
        rows: [],
        stack: [],
        direction: "incoming",
        selectedIndex: 0,
        loading: false,
        error: reason instanceof Error ? reason.message : String(reason),
      });
    }
  }, [loadCallHierarchy, requestLsp, showCallHierarchyZone]);
  const switchCallHierarchyDirection = useCallback((next?: "incoming" | "outgoing") => {
    const current = callHierarchyRef.current;
    if (!current?.root) return;
    const direction = next ?? (current.direction === "incoming" ? "outgoing" : "incoming");
    try {
      window.localStorage.setItem(CALL_HIERARCHY_DIRECTION_KEY, direction);
    } catch {
      // Direction persistence is best-effort.
    }
    void loadCallHierarchy(current.root, direction, current.stack);
  }, [loadCallHierarchy]);
  graphContextRef.current = {
    projectPath,
    relPath,
    api,
    codeGraph,
    onOpenAt,
    requestLsp,
    applyWorkspaceEdit,
    lspCapabilities: lspCapabilities.current ?? undefined,
    onOutline: (rows) => {
      const uri = editorRef.current?.getModel()?.uri.toString();
      if (uri) publishOutline(uri, rows);
    },
    onLanguageError: setSaveError,
    startCallHierarchy: () => { void startCallHierarchy(); },
  };
  const openCallItem = useCallback((item: EditorCallHierarchyItem) => {
    try {
      const target = normalizedFilePath(monaco.Uri.parse(item.uri).fsPath);
      const root = normalizedFilePath(projectPath);
      if (target.toLocaleLowerCase() === root.toLocaleLowerCase()
        || !target.toLocaleLowerCase().startsWith(`${root.toLocaleLowerCase()}/`)) return;
      onOpenAt?.(target.slice(root.length + 1), item.line);
    } catch {
      // Stale server locations are ignored.
    }
  }, [onOpenAt, projectPath]);
  const selectedCallHierarchyItem = callHierarchy?.rows[
    Math.max(0, Math.min(callHierarchy.selectedIndex, callHierarchy.rows.length - 1))
  ] ?? null;
  useEffect(() => {
    const item = selectedCallHierarchyItem;
    const generation = ++callHierarchyPreviewGeneration.current;
    if (!item) {
      setCallHierarchyPreview(null);
      return;
    }
    let target: import("monaco-editor").Uri;
    try {
      target = monaco.Uri.parse(item.previewUri);
    } catch {
      setCallHierarchyPreview(null);
      return;
    }
    const normalizedRoot = normalizedFilePath(projectPath);
    const normalizedTarget = normalizedFilePath(target.fsPath);
    const rootComparable = normalizedRoot.toLocaleLowerCase();
    const targetComparable = normalizedTarget.toLocaleLowerCase();
    if (targetComparable === rootComparable
      || !targetComparable.startsWith(`${rootComparable}/`)) {
      setCallHierarchyPreview(null);
      return;
    }
    const previewRelPath = normalizedTarget.slice(normalizedRoot.length + 1);
    const line = item.previewRanges[0]?.startLineNumber ?? item.line;
    const existing = monaco.editor.getModels().find((candidate) =>
      normalizedFilePath(candidate.uri.fsPath).toLocaleLowerCase() === targetComparable);
    if (existing) {
      setCallHierarchyPreview({
        itemKey: item.key,
        relPath: previewRelPath,
        content: existing.getValue(),
        languageId: existing.getLanguageId(),
        line,
        ranges: item.previewRanges,
        loading: false,
        error: "",
      });
      return;
    }
    if (!api?.readProjectFile) {
      setCallHierarchyPreview(null);
      return;
    }
    setCallHierarchyPreview({
      itemKey: item.key,
      relPath: previewRelPath,
      content: "",
      languageId: editorLanguageIdForPath(previewRelPath),
      line,
      ranges: item.previewRanges,
      loading: true,
      error: "",
    });
    void api.readProjectFile(projectPath, previewRelPath, accessToken)
      .then((result) => {
        if (generation !== callHierarchyPreviewGeneration.current) return;
        if (result.binary || result.tooLarge) {
          throw new Error("Preview is unavailable for this file.");
        }
        setCallHierarchyPreview({
          itemKey: item.key,
          relPath: previewRelPath,
          content: result.content,
          languageId: editorLanguageIdForPath(previewRelPath),
          line,
          ranges: item.previewRanges,
          loading: false,
          error: "",
        });
      })
      .catch((reason) => {
        if (generation !== callHierarchyPreviewGeneration.current) return;
        setCallHierarchyPreview({
          itemKey: item.key,
          relPath: previewRelPath,
          content: "",
          languageId: editorLanguageIdForPath(previewRelPath),
          line,
          ranges: [],
          loading: false,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      });
  }, [accessToken, api, projectPath, selectedCallHierarchyItem?.key]);
  useEffect(() => {
    if (!callHierarchy || callHierarchy.loading || callHierarchy.error) return;
    window.requestAnimationFrame(() => callHierarchyTreeRef.current?.focus({ preventScroll: true }));
  }, [callHierarchy?.loading, callHierarchy?.error, callHierarchy?.root?.key]);
  const beginCallHierarchySplitResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const container = event.currentTarget.parentElement;
    if (!container) return;
    const move = (pointer: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      if (!rect.width) return;
      const ratio = (pointer.clientX - rect.left) / rect.width;
      setCallHierarchyLayout((current) => ({
        ...current,
        ratio: Math.max(0.35, Math.min(0.85, ratio)),
      }));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }, []);
  const beginCallHierarchyHeightResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = callHierarchyLayout.height;
    const move = (pointer: PointerEvent) => {
      const lineDelta = Math.round((pointer.clientY - startY) / 21);
      setCallHierarchyLayout((current) => ({
        ...current,
        height: Math.max(8, Math.min(40, startHeight + lineDelta)),
      }));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }, [callHierarchyLayout.height]);

  const reload = useCallback(() => {
    setError("");
    setSaveError("");
    setRevertError("");
    setPreviewError("");
    setPreviewLoaded(false);
    setPreview(null);
    if (filePreviewTypeForPath(relPath) && api?.previewProjectFile) {
      void api.previewProjectFile(projectPath, relPath, accessToken)
        .then((result) => {
          loadedRef.current = true;
          savedMtime.current = result.mtimeMs;
          savedDiskText.current = "";
          savedText.current = "";
          setPreview(result);
          setLoad({
            content: "",
            mtimeMs: result.mtimeMs,
            binary: true,
            tooLarge: false,
            encoding: "utf8",
          });
          setRecovery(null);
          setDiskChanged(false);
          markDirty(false);
        })
        .catch((reason) => {
          setLoad(null);
          setError(reason instanceof Error ? reason.message : String(reason));
        });
      return;
    }
    const reader = api?.readProjectFile;
    if (!reader) {
      setError("Desktop file access is unavailable.");
      return;
    }
    const shouldRestoreBackup = !skipNextBackupRestore.current;
    skipNextBackupRestore.current = false;
    void takeEditorFileLoad(
      api,
      projectPath,
      relPath,
      accessToken,
      !loadedRef.current,
      shouldRestoreBackup,
    )
      .then(({ file: result, backup }) => {
        const resolution = resolveEditorBackup(
          result.content,
          shouldRestoreBackup ? backup : null,
        );
        const content = resolution.content;
        let nextRecovery: EditorRecovery | null = null;
        if (!result.binary && !result.tooLarge && shouldRestoreBackup) {
          nextRecovery = resolution.recovery;
          if (resolution.discardBackup) {
            void deleteBackup().catch(() => undefined);
          }
        }
        loadedRef.current = true;
        savedMtime.current = result.mtimeMs;
        savedDiskText.current = result.content;
        savedText.current = resolution.savedContent;
        setLoad({ ...result, content });
        setRecovery(nextRecovery);
        setDiskChanged(false);
        const model = editorRef.current?.getModel();
        if (model && model.getValue() !== content) model.setValue(content);
        markDirty(content !== resolution.savedContent);
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
        if (loadedRef.current) setDiskChanged(true);
      });
  }, [accessToken, api, deleteBackup, projectPath, relPath, markDirty]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    if ((error && !load) || (load && !preview && (load.binary || load.tooLarge))) {
      reportEditorLoadStage(projectPath, relPath, accessToken, "fallback-ready", "", true);
      notifyReady();
    }
  }, [accessToken, error, load, notifyReady, preview, projectPath, relPath]);
  useEffect(() => {
    if (mediaForeground) return;
    mediaRef.current?.pause();
  }, [mediaForeground]);
  const saveNow = useCallback(async (encoding?: DesktopTextFileEncoding): Promise<boolean> => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const writer = api?.writeProjectFile;
    if (!editor || !model || !writer) return false;
    if (!encoding && model.getValue() === savedText.current) return true;
    if (editorSettings.formatOnSave) {
      try {
        await editor.getAction("editor.action.formatDocument")?.run();
      } catch (reason) {
        setSaveError(`Format on save failed: ${reason instanceof Error ? reason.message : String(reason)}`);
        return false;
      }
    }
    const content = model.getValue();
    const expectedContent = savedDiskText.current;
    savingRef.current = true;
    setSaving(true);
    setSaveError("");
    setRevertError("");
    try {
      const result = await writer(
        projectPath,
        relPath,
        content,
        expectedContent,
        accessToken,
        encoding,
      );
      savedMtime.current = result?.mtimeMs ?? Date.now();
      savedDiskText.current = content;
      savedText.current = content;
      setRecovery(null);
      setDiskChanged(false);
      setError("");
      if (encoding) {
        setLoad((current) => current ? { ...current, encoding } : current);
      }
      const currentContent = editorRef.current?.getModel()?.getValue() ?? content;
      const changedAfterSave = currentContent !== content;
      markDirty(changedAfterSave);
      setDiffTick((tick) => tick + 1);
      if (backupTimer.current !== null) {
        window.clearTimeout(backupTimer.current);
        backupTimer.current = null;
      }
      if (changedAfterSave) await writeBackupNow(currentContent).catch(() => undefined);
      else await deleteBackup().catch(() => undefined);
      void syncLsp("save");
      return true;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setSaveError(message);
      if (/changed on disk|ENOENT|no such file|cannot find/i.test(message)) setDiskChanged(true);
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [accessToken, api, deleteBackup, editorSettings.formatOnSave, projectPath, relPath,
    markDirty, syncLsp, writeBackupNow]);
  const save = useCallback((encoding?: DesktopTextFileEncoding): Promise<boolean> => {
    const queued = saveQueue.current.catch(() => false).then(() => saveNow(encoding));
    saveQueue.current = queued;
    return queued;
  }, [saveNow]);
  const saveRef = useRef<() => Promise<boolean>>(save);
  saveRef.current = save;
  const discard = useCallback(async (): Promise<void> => {
    skipUnmountBackup.current = true;
    await deleteBackup();
  }, [deleteBackup]);
  const onSaveHandleRef = useRef(onSaveHandle);
  onSaveHandleRef.current = onSaveHandle;
  useEffect(() => {
    const handle: EditorFileHandle = {
      save: () => saveRef.current(),
      discard,
    };
    onSaveHandleRef.current?.(handle);
    return () => onSaveHandleRef.current?.(null);
  }, [discard]);

  // VSCode changed-on-disk rule via 2.5s mtime polling while visible.
  useEffect(() => {
    if (!active || !load || load.binary || load.tooLarge) return undefined;
    const timer = window.setInterval(() => {
      // A live tab drag owns the main thread — skip this tick so a log-file
      // auto-reload can never jank the pointer gesture (titlebar sets the flag).
      if (document.body.dataset.tabDragging) return;
      void api?.statProjectFile?.(projectPath, relPath, accessToken).then((info) => {
        if (!info || info.mtimeMs <= savedMtime.current) return;
        const model = editorRef.current?.getModel();
        const isDirty = model ? model.getValue() !== savedText.current : false;
        if (isDirty) setDiskChanged(true);
        else reload();
      }).catch((reason) => {
        const model = editorRef.current?.getModel();
        if (!model) return;
        setDiskChanged(true);
        setSaveError(reason instanceof Error ? reason.message : "File was deleted or renamed on disk.");
      });
    }, 2_500);
    return () => window.clearInterval(timer);
  }, [accessToken, api, active, load, projectPath, relPath, reload]);
  // Unified-diff → gutter stripe ranges against the CURRENT file lines:
  // '+' runs paired with '-' in the same group read as modified, bare '+'
  // as added; a pure deletion marks the line the removal collapsed onto.
  // Reveal requests from cross-file jumps land after the tab activates.
  // Hidden→visible tab switches leave Monaco with a stale layout: the first
  // scrollbar press then only re-measures instead of grabbing the slider.
  // A focused file surface also takes the keyboard explicitly after mount or
  // pane activation, so the first pointer click can immediately type.
  useLayoutEffect(() => {
    if (!active || !load) return;
    const editor = editorRef.current;
    const layoutHost = editor?.getDomNode()?.parentElement;
    if (editor && layoutHost) {
      editorLayoutSize.current = null;
      layoutEditorToHost(editor, layoutHost);
    }
    if (focused) editor?.focus();
  }, [active, focused, layoutEditorToHost, load]);
  useEffect(() => {
    if (!modelUri) return;
    const model = editorRef.current?.getModel();
    if (active && focused && model) {
      setActiveEditorDocument({
        projectPath,
        relPath,
        uri: modelUri,
        languageId: model.getLanguageId(),
      });
      const position = editorRef.current?.getPosition();
      setActiveEditorPosition(modelUri, position?.lineNumber ?? 1, position?.column ?? 1);
      if (position) {
        onNavigationLocationRef.current?.(relPath, position.lineNumber, position.column);
      }
      void updateOutline();
    } else {
      clearActiveEditorDocument(modelUri);
    }
  }, [active, focused, modelUri, projectPath, relPath, updateOutline]);
  // Quick-diff refresh: on load/save (diffTick) and a slow poll while active.
  useEffect(() => {
    if (!active || !load || load.binary || load.tooLarge || !api?.gitDiff) return undefined;
    let live = true;
    const refresh = () => void api.gitDiff?.(projectPath, relPath, false)
      .then((text) => {
        if (!live) return;
        const editor = editorRef.current;
        if (!editor) return;
        const stripes = parseEditorQuickDiffStripes(text);
        const decos = stripes.map((stripe) => {
          const [token, darkFallback, lightFallback] = QUICK_DIFF_COLOR_TOKENS[stripe.kind];
          const color = resolveThemeColor(token, lightTheme ? lightFallback : darkFallback);
          return {
            range: new monaco.Range(stripe.line, 1, stripe.line, 1),
            options: {
              isWholeLine: stripe.kind !== "del",
              linesDecorationsClassName: `editor-dirty-diff editor-dirty-diff-${stripe.kind}`,
              linesDecorationsTooltip: stripe.kind === "add" ? "Added line"
                : stripe.kind === "mod" ? "Changed line" : "Removed line",
              overviewRuler: {
                color: colorWithAlpha(color, "99"),
                position: monaco.editor.OverviewRulerLane.Left,
              },
              minimap: {
                color,
                position: monaco.editor.MinimapPosition.Gutter,
              },
            },
          };
        });
        diffDecorations.current?.clear();
        diffDecorations.current = editor.createDecorationsCollection(decos);
      })
      .catch(() => { diffDecorations.current?.clear(); });
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [api, active, load, projectPath, relPath, diffTick, lightTheme]);
  useEffect(() => {
    if (!reveal || !load) return;
    const editor = editorRef.current;
    if (!editor) return;
    editor.setPosition({ lineNumber: reveal.line, column: 1 });
    editor.revealLineInCenter(reveal.line);
    editor.focus();
    onNavigationLocationRef.current?.(relPath, reveal.line, 1);
  }, [reveal?.nonce, load ? 1 : 0, relPath]);
  const revertFromDisk = useCallback(async (): Promise<boolean> => {
    const reader = api?.readProjectFile;
    const model = editorRef.current?.getModel();
    if (!reader || !model || reverting || savingRef.current) return false;
    setReverting(true);
    setRevertError("");
    try {
      const result = await reader(projectPath, relPath, accessToken);
      if (result.binary || result.tooLarge) {
        throw new Error("The disk version can no longer be safely edited as text.");
      }
      const content = normalizeEditorModelText(result.content);
      savedMtime.current = result.mtimeMs;
      savedDiskText.current = result.content;
      savedText.current = content;
      setLoad({ ...result, content });
      setRecovery(null);
      setDiskChanged(false);
      setError("");
      setSaveError("");
      model.setValue(content);
      markDirty(false);
      setDiffTick((tick) => tick + 1);
      await deleteBackup().catch(() => undefined);
      editorRef.current?.focus();
      return true;
    } catch (reason) {
      setRevertError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setReverting(false);
    }
  }, [accessToken, api, deleteBackup, markDirty, projectPath, relPath, reverting]);
  const restoreConflictingBackup = useCallback(() => {
    const model = editorRef.current?.getModel();
    if (!model || !recovery) return;
    model.setValue(recovery.content);
    setRecovery({ ...recovery, restored: true });
    markDirty(true);
    scheduleBackup(recovery.content);
    editorRef.current?.focus();
  }, [markDirty, recovery, scheduleBackup]);
  const discardPendingBackup = useCallback(() => {
    setRecovery(null);
    void deleteBackup().catch(() => undefined);
  }, [deleteBackup]);
  const keepEdits = useCallback(() => {
    const model = editorRef.current?.getModel();
    const reader = api?.readProjectFile;
    if (!model || !reader) return;
    setSaveError("");
    void reader(projectPath, relPath, accessToken)
      .then((result) => {
        if (result.binary || result.tooLarge) {
          throw new Error("The disk version can no longer be safely edited as text.");
        }
        const savedContent = normalizeEditorModelText(result.content);
        const currentContent = model.getValue();
        savedMtime.current = result.mtimeMs;
        savedDiskText.current = result.content;
        savedText.current = savedContent;
        setDiskChanged(false);
        setError("");
        const changed = currentContent !== savedContent;
        markDirty(changed);
        if (changed) void writeBackupNow(currentContent).catch(() => undefined);
        else void deleteBackup().catch(() => undefined);
      })
      .catch((reason) => {
        setDiskChanged(true);
        setSaveError(reason instanceof Error ? reason.message : String(reason));
      });
  }, [accessToken, api, deleteBackup, projectPath, relPath, markDirty, writeBackupNow]);
  const breadcrumbSegments = relPath.replace(/\\/g, "/").split("/").filter(Boolean);
  // VS Code parity: the symbol breadcrumb renders the full container chain
  // (outermost › … › innermost) at the cursor, one crumb per nesting level.
  const breadcrumbSymbols = (() => {
    const byLevel = new Map<number, EditorOutlineItem>();
    const containing = breadcrumbOutline
      .filter((item) => item.line <= cursorPosition.line
        && (item.endLine ?? item.line) >= cursorPosition.line)
      .sort((left, right) => left.level - right.level || left.line - right.line);
    for (const item of containing) byLevel.set(item.level, item);
    return [...byLevel.values()];
  })();
  const breadcrumbSymbol = breadcrumbSymbols[breadcrumbSymbols.length - 1];
  const selectionLabel = selectionStatus.selections > 1
    ? `${selectionStatus.selections} selections${selectionStatus.characters
      ? ` (${selectionStatus.characters} characters selected)`
      : ""}`
    : `Ln ${cursorPosition.line}, Col ${cursorPosition.column}${selectionStatus.characters
      ? ` (${selectionStatus.characters} selected)`
      : ""}`;
  const closeBreadcrumbPicker = useCallback((restoreBreadcrumbFocus = false) => {
    const sourceIndex = breadcrumbPicker?.anchor.sourceIndex ?? breadcrumbFocusIndex;
    setBreadcrumbPicker(null);
    if (restoreBreadcrumbFocus) {
      window.requestAnimationFrame(() => breadcrumbButtonRefs.current[sourceIndex]?.focus());
    }
  }, [breadcrumbFocusIndex, breadcrumbPicker?.anchor.sourceIndex]);
  const showBreadcrumbFiles = useCallback((
    anchor: BreadcrumbPickerAnchor,
    directory: string,
    selectedRelPath: string,
  ) => {
    const list = api?.listProjectDir;
    if (!list || accessToken) return;
    const generation = ++breadcrumbPickerGeneration.current;
    setBreadcrumbPicker({
      kind: "files",
      anchor,
      directory,
      selectedRelPath,
      rows: [],
      activeIndex: 0,
      loading: true,
      error: "",
    });
    void list(projectPath, directory)
      .then((entries) => {
        if (generation !== breadcrumbPickerGeneration.current) return;
        const rows = entries.map((entry) => ({
          ...entry,
          relPath: [directory, entry.name].filter(Boolean).join("/"),
        }));
        const selectedIndex = Math.max(0, rows.findIndex((row) =>
          normalizedFilePath(row.relPath).toLocaleLowerCase()
            === normalizedFilePath(selectedRelPath).toLocaleLowerCase()));
        setBreadcrumbPicker((current) => current?.kind === "files"
          ? { ...current, rows, activeIndex: selectedIndex, loading: false, error: "" }
          : current);
      })
      .catch((reason) => {
        if (generation !== breadcrumbPickerGeneration.current) return;
        setBreadcrumbPicker((current) => current?.kind === "files"
          ? {
              ...current,
              rows: [],
              activeIndex: 0,
              loading: false,
              error: reason instanceof Error ? reason.message : String(reason),
            }
          : current);
      });
  }, [accessToken, api, projectPath]);
  const openPathBreadcrumb = useCallback((
    event: React.MouseEvent<HTMLButtonElement>,
    index: number,
  ) => {
    setBreadcrumbFocusIndex(index);
    const anchor = breadcrumbPickerAnchor(event.currentTarget, index);
    const isFile = index === breadcrumbSegments.length - 1;
    const directory = isFile
      ? breadcrumbSegments.slice(0, -1).join("/")
      : breadcrumbSegments.slice(0, index + 1).join("/");
    const selectedRelPath = isFile
      ? breadcrumbSegments.join("/")
      : breadcrumbSegments.slice(0, index + 2).join("/");
    showBreadcrumbFiles(anchor, directory, selectedRelPath);
  }, [breadcrumbSegments, showBreadcrumbFiles]);
  const openSymbolBreadcrumb = useCallback((
    event: React.MouseEvent<HTMLButtonElement>,
    sourceIndex: number,
    selected?: EditorOutlineItem,
  ) => {
    setBreadcrumbFocusIndex(sourceIndex);
    const rows = breadcrumbOutline.slice().sort((left, right) =>
      left.line - right.line || left.level - right.level);
    const activeIndex = Math.max(0, rows.findIndex((row) =>
      row.key === (selected ?? breadcrumbSymbol)?.key));
    setBreadcrumbPicker({
      kind: "symbols",
      anchor: breadcrumbPickerAnchor(event.currentTarget, sourceIndex),
      rows,
      activeIndex,
    });
  }, [breadcrumbOutline, breadcrumbSymbol?.key]);
  const openBreadcrumbFile = useCallback((item: BreadcrumbFileItem) => {
    if (item.dir) {
      const current = breadcrumbPicker;
      if (current?.kind === "files") {
        showBreadcrumbFiles(current.anchor, item.relPath, "");
      }
      return;
    }
    setBreadcrumbPicker(null);
    if (normalizedFilePath(item.relPath).toLocaleLowerCase()
      === normalizedFilePath(relPath).toLocaleLowerCase()) {
      editorRef.current?.focus();
      return;
    }
    onOpenAt?.(item.relPath, 1);
  }, [breadcrumbPicker, onOpenAt, relPath, showBreadcrumbFiles]);
  const revealBreadcrumbSymbol = useCallback((item: EditorOutlineItem) => {
    const editor = editorRef.current;
    if (!editor) return;
    setBreadcrumbPicker(null);
    editor.setPosition({ lineNumber: item.line, column: Math.max(1, item.column) });
    editor.revealLineInCenter(item.line);
    editor.focus();
  }, []);
  const focusBreadcrumbPickerRow = useCallback((index: number) => {
    setBreadcrumbPicker((current) => current
      ? { ...current, activeIndex: index } as BreadcrumbPickerState
      : current);
    window.requestAnimationFrame(() => breadcrumbPickerRowRefs.current[index]?.focus());
  }, []);
  const handleBreadcrumbPickerKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const current = breadcrumbPicker;
    if (!current) return;
    const count = current.rows.length;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeBreadcrumbPicker(true);
      return;
    }
    if (current.kind === "files" && event.key === "ArrowLeft" && current.directory) {
      event.preventDefault();
      const parent = current.directory.split("/").slice(0, -1).join("/");
      showBreadcrumbFiles(current.anchor, parent, current.directory);
      return;
    }
    if (!count) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp"
      || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? 0
        : event.key === "End" ? count - 1
          : (current.activeIndex + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
      focusBreadcrumbPickerRow(next);
      return;
    }
    if (event.key === "Enter" || event.key === " "
      || (event.key === "ArrowRight" && current.kind === "files"
        && current.rows[current.activeIndex]?.dir)) {
      event.preventDefault();
      breadcrumbPickerRowRefs.current[current.activeIndex]?.click();
    }
  }, [breadcrumbPicker, closeBreadcrumbPicker, focusBreadcrumbPickerRow, showBreadcrumbFiles]);
  useEffect(() => {
    if (!breadcrumbPicker || breadcrumbPicker.kind === "files" && breadcrumbPicker.loading) return;
    window.requestAnimationFrame(() =>
      breadcrumbPickerRowRefs.current[breadcrumbPicker.activeIndex]?.focus());
  }, [
    breadcrumbPicker?.kind,
    breadcrumbPicker?.kind === "files" ? breadcrumbPicker.directory : "",
    breadcrumbPicker?.kind === "files" ? breadcrumbPicker.loading : false,
  ]);
  useEffect(() => {
    if (!breadcrumbPicker) return undefined;
    const dismiss = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && (breadcrumbPickerRef.current?.contains(target)
        || breadcrumbButtonRefs.current.some((button) => button?.contains(target)))) return;
      setBreadcrumbPicker(null);
    };
    window.addEventListener("pointerdown", dismiss, true);
    return () => window.removeEventListener("pointerdown", dismiss, true);
  }, [Boolean(breadcrumbPicker)]);
  const syncEditorFormat = useCallback(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    const options = model.getOptions();
    setEditorFormat({
      tabSize: options.tabSize,
      insertSpaces: options.insertSpaces,
      eol: model.getEOL() === "\r\n" ? "CRLF" : "LF",
      languageId: model.getLanguageId(),
    });
  }, []);
  const handleBreadcrumbKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    // The path owns roving left/right focus; the trailing file actions are
    // ordinary buttons and must keep their native keyboard behavior.
    if ((event.target as HTMLElement).closest(".editor-breadcrumb-actions")) return;
    const count = breadcrumbSegments.length + breadcrumbSymbols.length;
    if (!count) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setBreadcrumbPicker(null);
      editorRef.current?.focus();
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight"
      && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next = event.key === "Home" ? 0
      : event.key === "End" ? count - 1
        : (breadcrumbFocusIndex + (event.key === "ArrowRight" ? 1 : -1) + count) % count;
    setBreadcrumbFocusIndex(next);
    breadcrumbButtonRefs.current[next]?.focus();
  }, [breadcrumbFocusIndex, breadcrumbSegments.length, breadcrumbSymbols.length]);
  const editorBreadcrumbs = <nav className="editor-breadcrumbs" aria-label="Breadcrumbs"
    onKeyDown={handleBreadcrumbKeyDown}>
    <span className="editor-breadcrumb-path">
      {breadcrumbSegments.map((segment, index) =>
        <React.Fragment key={`${index}:${segment}`}>
          {index > 0 && <ChevronRight size={14} aria-hidden="true" />}
          <button ref={(node) => { breadcrumbButtonRefs.current[index] = node; }}
            type="button"
            className={`editor-breadcrumb-item${index === breadcrumbSegments.length - 1
              ? " editor-breadcrumb-current" : ""}`}
            title={breadcrumbSegments.slice(0, index + 1).join("/")}
            aria-haspopup={accessToken ? undefined : "tree"}
            aria-expanded={breadcrumbPicker?.kind === "files"
              && breadcrumbPicker.anchor.sourceIndex === index}
            disabled={Boolean(accessToken)}
            tabIndex={breadcrumbFocusIndex === index ? 0 : -1}
            onFocus={() => setBreadcrumbFocusIndex(index)}
            onClick={(event) => openPathBreadcrumb(event, index)}>
            {index === breadcrumbSegments.length - 1
              ? <FileIcon size={14} aria-hidden="true" />
              : <Folder size={14} aria-hidden="true" />}
            <span>{segment}</span>
          </button>
        </React.Fragment>)}
      {breadcrumbSymbols.map((item, symbolIndex) => {
        const focusIndex = breadcrumbSegments.length + symbolIndex;
        return <React.Fragment key={item.key}>
          <ChevronRight size={14} aria-hidden="true" />
          <button ref={(node) => { breadcrumbButtonRefs.current[focusIndex] = node; }}
            type="button"
            className="editor-breadcrumb-item editor-breadcrumb-symbol"
            title={item.detail || item.name}
            aria-haspopup="tree"
            aria-expanded={breadcrumbPicker?.kind === "symbols"
              && breadcrumbPicker.anchor.sourceIndex === focusIndex}
            tabIndex={breadcrumbFocusIndex === focusIndex ? 0 : -1}
            onFocus={() => setBreadcrumbFocusIndex(focusIndex)}
            onClick={(event) => openSymbolBreadcrumb(event, focusIndex, item)}>
            <Braces size={14} aria-hidden="true" />
            <span>{item.name}</span>
          </button>
        </React.Fragment>;
      })}
    </span>
    {/* File-local actions belong to the file path, not to the pane-wide tab
        strip. Keeping them in this shared row also preserves the controls for
        previews and fallback surfaces that do not mount Monaco. */}
    <span className="editor-breadcrumb-actions">
      {load && !preview && !load.binary && !load.tooLarge
        && <button type="button" disabled={!dirty || saving || reverting} onClick={() => { void save(); }}
          aria-label="Save" data-tooltip="Save (Ctrl+S)">
          <Save size={16} aria-hidden="true" />
        </button>}
      {load && !preview && !load.binary && !load.tooLarge && dirty
        && <button type="button" className="editor-revert-action" disabled={saving || reverting}
          onClick={() => { void revertFromDisk(); }}
          aria-label="Revert" data-tooltip="Revert File">
          <Undo2 size={18} aria-hidden="true" />
        </button>}
      <button type="button" aria-label="Reveal in Explorer" data-tooltip="Reveal in Explorer"
        onClick={() => void api?.revealFile?.(projectPath, relPath, accessToken)}>
        <FolderOpen size={16} aria-hidden="true" />
      </button>
    </span>
  </nav>;
  const breadcrumbPickerPortal = breadcrumbPicker
    ? createPortal(
        <div ref={breadcrumbPickerRef} className="editor-breadcrumb-picker" role="dialog"
          aria-label={breadcrumbPicker.kind === "files" ? "File Breadcrumbs" : "Symbol Breadcrumbs"}
          style={{
            left: breadcrumbPicker.anchor.x,
            top: breadcrumbPicker.anchor.y,
            width: breadcrumbPicker.anchor.width,
            maxHeight: breadcrumbPicker.anchor.maxHeight,
          }}
          onKeyDown={handleBreadcrumbPickerKeyDown}>
          {breadcrumbPicker.kind === "files" && <div className="editor-breadcrumb-picker-header">
            <button type="button" aria-label="Parent Folder"
              disabled={!breadcrumbPicker.directory}
              onClick={() => {
                const parent = breadcrumbPicker.directory.split("/").slice(0, -1).join("/");
                showBreadcrumbFiles(
                  breadcrumbPicker.anchor,
                  parent,
                  breadcrumbPicker.directory,
                );
              }}><ChevronLeft size={14} aria-hidden="true" /></button>
            <span title={breadcrumbPicker.directory || projectPath}>
              {breadcrumbPicker.directory || projectPath}
            </span>
          </div>}
          <div className="editor-breadcrumb-picker-tree" role="tree">
            {breadcrumbPicker.kind === "files" && breadcrumbPicker.loading
              && <p><ProgressSpinner size={14} className="editor-pane-spinner" /> Loading…</p>}
            {breadcrumbPicker.kind === "files" && !breadcrumbPicker.loading
              && breadcrumbPicker.error && <p>{breadcrumbPicker.error}</p>}
            {breadcrumbPicker.kind === "files" && !breadcrumbPicker.loading
              && !breadcrumbPicker.error && !breadcrumbPicker.rows.length
              && <p>No files found.</p>}
            {breadcrumbPicker.kind === "symbols" && !breadcrumbPicker.rows.length
              && <p>No symbols found.</p>}
            {breadcrumbPicker.rows.map((item, index) => {
              const fileItem = breadcrumbPicker.kind === "files"
                ? item as BreadcrumbFileItem
                : null;
              const symbolItem = breadcrumbPicker.kind === "symbols"
                ? item as EditorOutlineItem
                : null;
              const selected = index === breadcrumbPicker.activeIndex;
              return <button key={fileItem?.relPath || symbolItem?.key || index}
                ref={(node) => { breadcrumbPickerRowRefs.current[index] = node; }}
                type="button"
                role="treeitem"
                aria-selected={selected}
                className={selected ? "selected" : ""}
                style={symbolItem ? { paddingLeft: `${8 + symbolItem.level * 14}px` } : undefined}
                onFocus={() => setBreadcrumbPicker((current) => current
                  ? { ...current, activeIndex: index } as BreadcrumbPickerState
                  : current)}
                onMouseEnter={() => setBreadcrumbPicker((current) => current
                  ? { ...current, activeIndex: index } as BreadcrumbPickerState
                  : current)}
                onClick={() => fileItem
                  ? openBreadcrumbFile(fileItem)
                  : symbolItem && revealBreadcrumbSymbol(symbolItem)}>
                {fileItem
                  ? fileItem.dir
                    ? <Folder size={14} aria-hidden="true" />
                    : <FileIcon size={14} aria-hidden="true" />
                  : <Braces size={14} aria-hidden="true" />}
                <span>{fileItem?.name || symbolItem?.name}</span>
                {symbolItem?.detail && <small>{symbolItem.detail}</small>}
              </button>;
            })}
          </div>
        </div>,
        document.body,
      )
    : null;
  const callHierarchyPortal = callHierarchy && callHierarchyTarget
    ? createPortal(
        <section className="editor-call-hierarchy" role="dialog" aria-label="Call Hierarchy"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closeCallHierarchy();
              return;
            }
            if (event.shiftKey && event.altKey && event.key.toLocaleLowerCase() === "h") {
              event.preventDefault();
              switchCallHierarchyDirection();
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setCallHierarchy((current) => {
                if (!current?.rows.length) return current;
                const offset = event.key === "ArrowDown" ? 1 : -1;
                return {
                  ...current,
                  selectedIndex: (current.selectedIndex + offset + current.rows.length)
                    % current.rows.length,
                };
              });
              return;
            }
            if (event.key === "ArrowLeft" && callHierarchy.stack.length) {
              event.preventDefault();
              const root = callHierarchy.stack.at(-1);
              if (root) void loadCallHierarchy(
                root,
                callHierarchy.direction,
                callHierarchy.stack.slice(0, -1),
              );
              return;
            }
            if (event.key === "ArrowRight" && selectedCallHierarchyItem) {
              event.preventDefault();
              if (callHierarchy.root) void loadCallHierarchy(
                selectedCallHierarchyItem,
                callHierarchy.direction,
                [...callHierarchy.stack, callHierarchy.root],
              );
              return;
            }
            if (event.key === "Enter" && selectedCallHierarchyItem) {
              event.preventDefault();
              openCallItem(selectedCallHierarchyItem);
              closeCallHierarchy();
            }
          }}>
          <header>
            <div className="editor-call-hierarchy-title">
              <b>{callHierarchy.loading
                ? "Loading…"
                : callHierarchy.direction === "incoming"
                  ? `Callers of '${callHierarchy.root?.name || ""}'`
                  : `Calls from '${callHierarchy.root?.name || ""}'`}</b>
              {callHierarchy.root?.detail && <small>{callHierarchy.root.detail}</small>}
            </div>
            <div className="editor-call-hierarchy-actions">
              <button type="button" disabled={!callHierarchy.stack.length}
                aria-label="Back" data-tooltip="Back"
                onClick={() => {
                  const root = callHierarchy.stack.at(-1);
                  if (root) void loadCallHierarchy(
                    root,
                    callHierarchy.direction,
                    callHierarchy.stack.slice(0, -1),
                  );
                }}>←</button>
              <button type="button"
                aria-label={callHierarchy.direction === "incoming"
                  ? "Show Outgoing Calls"
                  : "Show Incoming Calls"}
                data-tooltip={callHierarchy.direction === "incoming"
                  ? "Show Outgoing Calls (Shift+Alt+H)"
                  : "Show Incoming Calls (Shift+Alt+H)"}
                onClick={() => switchCallHierarchyDirection()}>
                {callHierarchy.direction === "incoming" ? "⇥" : "⇤"}
              </button>
              <button type="button" aria-label="Close" data-tooltip="Close (Escape)"
                onClick={closeCallHierarchy}><X size={14} /></button>
            </div>
          </header>
          <div className="editor-call-hierarchy-results"
            style={{
              gridTemplateColumns: `${callHierarchyLayout.ratio * 100}% 4px minmax(100px, 1fr)`,
            }}>
            <div className="editor-call-hierarchy-preview">
              {callHierarchyPreview?.loading
                ? <p>Loading…</p>
                : callHierarchyPreview?.error
                  ? <p>{callHierarchyPreview.error}</p>
                  : callHierarchyPreview
                    ? <Editor key={callHierarchyPreview.itemKey}
                        defaultValue={callHierarchyPreview.content}
                        defaultLanguage={callHierarchyPreview.languageId}
                        theme={lightTheme ? "mixdog-light" : "mixdog-dark"}
                        options={{
                          readOnly: true,
                          domReadOnly: true,
                          fontSize: 13,
                          lineHeight: 20,
                          fontFamily: '"JetBrains Mono Variable", "Cascadia Code", Consolas, monospace',
                          minimap: { enabled: false },
                          scrollbar: MIXDOG_EDITOR_SCROLLBAR,
                          scrollBeyondLastLine: false,
                          overviewRulerLanes: 2,
                          fixedOverflowWidgets: true,
                          automaticLayout: true,
                          lineNumbersMinChars: 3,
                          folding: false,
                          glyphMargin: false,
                        }}
                        onMount={(peekEditor) => {
                          peekEditor.setPosition({
                            lineNumber: callHierarchyPreview.line,
                            column: callHierarchyPreview.ranges[0]?.startColumn ?? 1,
                          });
                          if (callHierarchyPreview.ranges.length) {
                            peekEditor.revealRangeInCenter(callHierarchyPreview.ranges[0]);
                            peekEditor.createDecorationsCollection(
                              callHierarchyPreview.ranges.map((range) => ({
                                range,
                                options: {
                                  className: "editor-call-hierarchy-match",
                                  overviewRuler: {
                                    color: resolveThemeColor("--mx-focus", "#0078d4"),
                                    position: monaco.editor.OverviewRulerLane.Center,
                                  },
                                },
                              })),
                            );
                          } else {
                            peekEditor.revealLineInCenter(callHierarchyPreview.line);
                          }
                          peekEditor.addCommand(monaco.KeyCode.Escape, closeCallHierarchy);
                          peekEditor.addCommand(
                            monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyH,
                            () => switchCallHierarchyDirection(),
                          );
                          peekEditor.onMouseDown((mouseEvent) => {
                            if (mouseEvent.event.detail !== 2 || !selectedCallHierarchyItem) return;
                            openCallItem(selectedCallHierarchyItem);
                            closeCallHierarchy();
                          });
                        }} />
                    : <p>{callHierarchy.error || (callHierarchy.loading
                      ? "Loading…"
                      : "No results")}</p>}
            </div>
            <div className="editor-call-hierarchy-sash" role="separator"
              aria-orientation="vertical" onPointerDown={beginCallHierarchySplitResize} />
            <div ref={callHierarchyTreeRef} className="editor-call-hierarchy-tree"
              role="tree" aria-label={callHierarchy.direction === "incoming"
                ? "Incoming Calls"
                : "Outgoing Calls"} tabIndex={0}>
              {callHierarchy.loading && <p>Loading…</p>}
              {!callHierarchy.loading && callHierarchy.error && <p>{callHierarchy.error}</p>}
              {!callHierarchy.loading && !callHierarchy.error && !callHierarchy.rows.length
                && <p>{callHierarchy.direction === "incoming"
                  ? `No callers of '${callHierarchy.root?.name || ""}'`
                  : `No calls from '${callHierarchy.root?.name || ""}'`}</p>}
              {callHierarchy.rows.map((item, index) =>
                <div key={item.key} role="treeitem"
                  aria-selected={index === callHierarchy.selectedIndex}
                  className={index === callHierarchy.selectedIndex ? "selected" : ""}>
                  <button type="button" className="editor-call-hierarchy-row"
                    onMouseEnter={() => setCallHierarchy((current) =>
                      current ? { ...current, selectedIndex: index } : current)}
                    onClick={() => setCallHierarchy((current) =>
                      current ? { ...current, selectedIndex: index } : current)}
                    onDoubleClick={() => {
                      openCallItem(item);
                      closeCallHierarchy();
                    }}>
                    <span><b>{item.name}</b>{item.detail && <small>{item.detail}</small>}</span>
                  </button>
                  <button type="button" className="editor-call-hierarchy-expand"
                    aria-label={`Show ${callHierarchy.direction} calls for ${item.name}`}
                    onClick={() => callHierarchy.root && void loadCallHierarchy(
                      item,
                      callHierarchy.direction,
                      [...callHierarchy.stack, callHierarchy.root],
                    )}><ChevronRight size={14} /></button>
                </div>)}
            </div>
          </div>
          <div className="editor-call-hierarchy-height-sash" role="separator"
            aria-orientation="horizontal" onPointerDown={beginCallHierarchyHeightResize} />
        </section>,
        callHierarchyTarget,
      )
    : null;
  if (error && !load) {
    return <>{breadcrumbPickerPortal}<div className="editor-pane">{editorBreadcrumbs}<div className="editor-pane-notice">
      <p>{error}</p>
      <button type="button" onClick={reload}>Retry</button>
    </div></div></>;
  }
  if (!load) {
    return <>{breadcrumbPickerPortal}<div className="editor-pane">{editorBreadcrumbs}<div className="editor-pane-notice">
      <ProgressSpinner size={16} className="editor-pane-spinner" aria-hidden="true" /><p>Loading…</p>
    </div></div></>;
  }
  if (preview) {
    const completePreview = () => {
      setPreviewLoaded(true);
      notifyReady();
    };
    const failPreview = () => {
      setPreviewLoaded(true);
      setPreviewError("This file could not be displayed in the built-in viewer.");
      notifyReady();
    };
    return <>{breadcrumbPickerPortal}<div className="editor-pane">{editorBreadcrumbs}
      <div className={`editor-pane-preview is-${preview.kind}`}
        data-ready={previewLoaded ? "true" : "false"}>
        {!previewLoaded && !previewError && <div className="editor-pane-preview-loading" role="status">
          <ProgressSpinner size={16} className="editor-pane-spinner" aria-hidden="true" />
          <p>Loading preview…</p>
        </div>}
        {preview.kind === "image"
          ? <img src={preview.url} alt={relPath.split("/").at(-1) || relPath}
              onLoad={completePreview} onError={failPreview} />
          : preview.kind === "pdf"
            ? <iframe src={preview.url} title={`${relPath.split("/").at(-1) || relPath} PDF preview`}
              onLoad={completePreview} onError={failPreview} />
            : preview.kind === "audio"
              ? <audio key={mediaForeground ? "foreground" : "suspended"}
                ref={(node) => { mediaRef.current = node; }}
                src={mediaForeground ? preview.url : undefined}
                controls={mediaForeground} preload={mediaForeground ? "metadata" : "none"}
                onLoadedMetadata={completePreview} onError={failPreview} />
              : <video key={mediaForeground ? "foreground" : "suspended"}
                ref={(node) => { mediaRef.current = node; }}
                src={mediaForeground ? preview.url : undefined}
                controls={mediaForeground} preload={mediaForeground ? "metadata" : "none"}
                onLoadedMetadata={completePreview} onError={failPreview} />}
        {previewError && <div className="editor-pane-preview-error" role="alert">
          <p>{previewError}</p>
          <button type="button" onClick={() => void api?.openFilePath?.(projectPath, relPath, accessToken)}>
            <ExternalLink size={14} aria-hidden="true" /> Open in default app</button>
        </div>}
      </div>
    </div></>;
  }
  if (load.binary || load.tooLarge) {
    return <>{breadcrumbPickerPortal}<div className="editor-pane">{editorBreadcrumbs}<div className="editor-pane-notice">
      <p>{load.binary ? "Binary file — in-app editing is unavailable." : "File exceeds the 1 MB in-app editing cap."}</p>
      <button type="button" onClick={() => void api?.openFilePath?.(projectPath, relPath, accessToken)}>
        <ExternalLink size={14} aria-hidden="true" /> Open in default app</button>
    </div></div></>;
  }
  return <>{breadcrumbPickerPortal}{callHierarchyPortal}<div className="editor-pane">
    {editorBreadcrumbs}
    {recovery && <div className="editor-pane-recovery" role="status">
      <span>{recovery.diskChanged && !recovery.restored
        ? "Unsaved backup conflicts with the current disk version."
        : "Unsaved changes were restored from the previous session."}</span>
      {recovery.diskChanged && !recovery.restored
        ? <>
            <button type="button" onClick={restoreConflictingBackup}>Restore Backup</button>
            <button type="button" onClick={discardPendingBackup}>Discard Backup</button>
          </>
        : null}
    </div>}
    {diskChanged && <div className="editor-pane-conflict" role="alert">
      <span>{saveError || error || "File changed on disk."}</span>
      <button type="button" onClick={() => { void revertFromDisk(); }}>Reload</button>
      <button type="button" onClick={keepEdits}>Keep my edits</button>
    </div>}
    {revertError && <div className="editor-pane-conflict" role="alert">
      <span>Revert failed: {revertError}</span>
      <button type="button" onClick={() => { void revertFromDisk(); }}>Retry</button>
    </div>}
    {!diskChanged && saveError && <div className="editor-pane-conflict" role="alert">
      <span>Save failed: {saveError}</span>
      <button type="button" onClick={() => { void save(); }}>Retry</button>
    </div>}
    <div className="editor-pane-body stable-surface-preserved stable-editor-surface">
      <Editor
        path={abs}
        defaultLanguage={explicitEditorLanguageIdForPath(relPath)}
        defaultValue={load.content}
        keepCurrentModel
        theme={lightTheme ? "mixdog-light" : "mixdog-dark"}
        options={{
          fontSize: editorSettings.fontSize,
          lineHeight: editorSettings.lineHeight,
          fontFamily: editorSettings.fontFamily,
          readOnly: false,
          domReadOnly: false,
          wordWrap: wordWrapOverride ?? editorSettings.wordWrap,
          wordWrapColumn: editorSettings.wordWrapColumn,
          minimap: {
            enabled: editorSettings.minimapEnabled,
            /* VS Code default parity. */
            size: "proportional",
            showSlider: "mouseover",
          },
          stickyScroll: { enabled: editorSettings.stickyScrollEnabled },
          scrollbar: MIXDOG_EDITOR_SCROLLBAR,
          automaticLayout: false,
          scrollBeyondLastLine: true,
          renderWhitespace: editorSettings.renderWhitespace,
          bracketPairColorization: {
            enabled: editorSettings.bracketPairColorization,
            /* VS Code default parity (textModelDefaults). */
            independentColorPoolPerBracketType: false,
          },
          guides: {
            bracketPairs: editorSettings.bracketPairGuides,
            bracketPairsHorizontal: "active",
            highlightActiveBracketPair: true,
            indentation: true,
          },
          inlayHints: { enabled: editorSettings.inlayHintsEnabled },
          formatOnPaste: editorSettings.formatOnPaste,
          formatOnType: editorSettings.formatOnType,
          glyphMargin: true,
          folding: true,
          showFoldingControls: "mouseover",
          lineNumbersMinChars: 5,
          overviewRulerLanes: 3,
          renderLineHighlight: "line",
          padding: { top: 4, bottom: 4 },
          fixedOverflowWidgets: true,
          /* VS Code default parity: no lightbulb on empty lines. */
          lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.OnCode },
        }}
        onMount={(editor) => {
          editorRef.current = editor;
          armMonoFontRemeasure();
          const layoutHost = editor.getDomNode()?.parentElement;
          if (layoutHost && typeof ResizeObserver !== "undefined") {
            editorLayoutObserver.current?.disconnect();
            editorLayoutObserver.current = new ResizeObserver(() => {
              scheduleEditorLayout(editor, layoutHost);
            });
            editorLayoutObserver.current.observe(layoutHost);
            editorLayoutSize.current = null;
            scheduleEditorLayout(editor, layoutHost);
          }
          ensureCallHierarchyMenu();
          callHierarchyContextKey.current = editor.createContextKey(
            HAS_CALL_HIERARCHY,
            Boolean(lspReady.current && lspCapabilities.current?.callHierarchy),
          );
          languageDisposables.current.push(editor.onDidFocusEditorText(() => {
            focusedGraphEditor = editor;
          }));
          if (activeRef.current && focusedRef.current) focusedGraphEditor = editor;
          const model = editor.getModel();
          if (model) {
            // A model reused or created before this pane owned it can carry a
            // stale guessed language (plain white paint); realign with the
            // path-derived language before wiring providers and LSP state.
            const expectedLanguageId = explicitEditorLanguageIdForPath(relPath);
            if (expectedLanguageId && model.getLanguageId() !== expectedLanguageId) {
              monaco.editor.setModelLanguage(model, expectedLanguageId);
            }
            ensureEditorLanguageStore();
            setModelUri(model.uri.toString());
            graphContextsByModel.set(model.uri.toString(), graphContextRef);
            graphContextsByEditor.set(editor, graphContextRef);
            ensureGraphProviders(model.getLanguageId());
            lspLanguageId.current = model.getLanguageId();
            const syncLanguageState = () => {
              const languageSnapshot = getEditorLanguageSnapshot();
              const comparableRelPath = relPath.replace(/\\/g, "/").toLocaleLowerCase();
              const status = languageSnapshot.statuses.find((candidate) =>
                candidate.projectPath === projectPath
                && candidate.languageId === model.getLanguageId()
                && candidate.relPath?.replace(/\\/g, "/").toLocaleLowerCase()
                  === comparableRelPath)
                ?? languageSnapshot.statuses.find((candidate) =>
                  candidate.projectPath === projectPath
                  && candidate.languageId === model.getLanguageId()
                  && !candidate.relPath);
              if (status) acceptLspState(status, model.getLanguageId());
              const problems = languageSnapshot.problems
                .filter((problem) => problem.origin === "lsp"
                  && problem.projectPath.replace(/[\\/]+/g, "/").toLocaleLowerCase()
                    === projectPath.replace(/[\\/]+/g, "/").toLocaleLowerCase()
                  && problem.relPath.replace(/\\/g, "/").toLocaleLowerCase()
                    === relPath.replace(/\\/g, "/").toLocaleLowerCase());
              const signature = JSON.stringify(problems.map((problem) => [
                problem.severity,
                problem.message,
                problem.startLineNumber,
                problem.startColumn,
                problem.endLineNumber,
                problem.endColumn,
              ]));
              if (signature === lspMarkerSignature.current) return;
              lspMarkerSignature.current = signature;
              monaco.editor.setModelMarkers(model, "mixdog-lsp", problems.map((problem) => ({
                severity: problem.severity === 1 ? monaco.MarkerSeverity.Error
                  : problem.severity === 2 ? monaco.MarkerSeverity.Warning
                    : problem.severity === 4 ? monaco.MarkerSeverity.Hint
                      : monaco.MarkerSeverity.Info,
                message: problem.message,
                source: problem.source,
                code: problem.code || undefined,
                startLineNumber: problem.startLineNumber,
                startColumn: problem.startColumn,
                endLineNumber: problem.endLineNumber,
                endColumn: problem.endColumn,
              })));
            };
            const unsubscribeStore = subscribeEditorLanguageStore(syncLanguageState);
            languageDisposables.current.push({ dispose: unsubscribeStore });
            syncLanguageState();
            const publishNative = () => setNativeEditorProblems(
              projectPath,
              relPath,
              model.uri.toString(),
              monaco.editor.getModelMarkers({ resource: model.uri })
                .filter((marker) => marker.owner !== "mixdog-lsp"),
            );
            languageDisposables.current.push(monaco.editor.onDidChangeMarkers((uris) => {
              if (uris.some((uri) => uri.toString() === model.uri.toString())) publishNative();
            }));
            publishNative();
            languageDisposables.current.push(model.onDidChangeContent(() => {
              scheduleAnsiOutput(model);
              if (lspChangeTimer.current !== null) window.clearTimeout(lspChangeTimer.current);
              lspChangeTimer.current = window.setTimeout(() => { void syncLsp("change"); }, 120);
              if (outlineTimer.current !== null) window.clearTimeout(outlineTimer.current);
              outlineTimer.current = window.setTimeout(() => { void updateOutline(); }, 350);
            }));
            languageDisposables.current.push(editor.onDidChangeCursorPosition((event) => {
              setActiveEditorPosition(model.uri.toString(), event.position.lineNumber, event.position.column);
              setCursorPosition({
                line: event.position.lineNumber,
                column: event.position.column,
              });
              if (activeRef.current && focusedRef.current) {
                onNavigationLocationRef.current?.(
                  relPath,
                  event.position.lineNumber,
                  event.position.column,
                );
              }
            }));
            const syncSelection = () => {
              const selections = editor.getSelections() ?? [];
              setSelectionStatus({
                selections: Math.max(1, selections.length),
                characters: selections.reduce(
                  (total, selection) => total + model.getValueLengthInRange(selection),
                  0,
                ),
              });
            };
            languageDisposables.current.push(editor.onDidChangeCursorSelection(syncSelection));
            syncSelection();
            const syncProblems = () => {
              const markers = monaco.editor.getModelMarkers({ resource: model.uri });
              setProblemStatus({
                errors: markers.filter((marker) =>
                  marker.severity === monaco.MarkerSeverity.Error).length,
                warnings: markers.filter((marker) =>
                  marker.severity === monaco.MarkerSeverity.Warning).length,
              });
            };
            languageDisposables.current.push(monaco.editor.onDidChangeMarkers((uris) => {
              if (uris.some((uri) => uri.toString() === model.uri.toString())) syncProblems();
            }));
            syncProblems();
            const position = editor.getPosition();
            if (position) {
              setCursorPosition({ line: position.lineNumber, column: position.column });
            }
            const modelOptions = model.getOptions();
            setEditorFormat({
              tabSize: modelOptions.tabSize,
              insertSpaces: modelOptions.insertSpaces,
              eol: model.getEOL() === "\r\n" ? "CRLF" : "LF",
              languageId: model.getLanguageId(),
            });
            languageDisposables.current.push(model.onDidChangeOptions(syncEditorFormat));
            languageDisposables.current.push(model.onDidChangeLanguage(syncEditorFormat));
            const editorNode = editor.getDomNode();
            const copyRenderedAnsi = (event: ClipboardEvent) => {
              if (!isAnsiOutputPath(relPath) || !event.clipboardData) return;
              const selections = editor.getSelections() ?? [];
              const raw = selections.map((selection) => model.getValueInRange(selection)).join("\n");
              if (!raw.includes("\x1b[")) return;
              event.preventDefault();
              event.clipboardData.setData("text/plain", visibleEditorAnsiText(raw));
            };
            editorNode?.addEventListener("copy", copyRenderedAnsi, true);
            languageDisposables.current.push({
              dispose: () => editorNode?.removeEventListener("copy", copyRenderedAnsi, true),
            });
          }
          const viewState = readEditorViewState(viewStateKey);
          if (viewState) {
            try { editor.restoreViewState(viewState); } catch { /* stale Monaco state starts at the top */ }
          }
          if (active && focused) {
            requestAnimationFrame(() => editor.focus());
          }
          editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { void saveRef.current(); });
          // VS Code parity: Alt+Z toggles word wrap. The action id matches
          // VS Code so the command-palette route resolves it via getAction.
          editor.addAction({
            id: "editor.action.toggleWordWrap",
            label: "View: Toggle Word Wrap",
            keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyZ],
            run: () => {
              const wrapped = editor.getOption(monaco.editor.EditorOption.wordWrap) !== "off";
              const configured = editorSettingsRef.current.wordWrap;
              setWordWrapOverride(wrapped ? "off" : configured !== "off" ? configured : "on");
            },
          });
          // Workspace-shortcut parity while Monaco owns the keyboard: tab
          // cycling (Ctrl+PageUp/PageDown / Ctrl+Tab) and immediate mod+W close
          // re-emit the same app-level events the global listener handles.
          const cycle = (offset: number) => window.dispatchEvent(
            new CustomEvent("mixdog:cycle-tab", { detail: offset }));
          editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.PageDown, () => cycle(1));
          editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.PageUp, () => cycle(-1));
          // Ctrl+Tab routes to the MRU switcher, not the sequential cycle.
          const switchTab = (offset: number) => window.dispatchEvent(
            new CustomEvent("mixdog:tab-switcher", { detail: offset }));
          editor.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.Tab, () => switchTab(1));
          editor.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyMod.Shift | monaco.KeyCode.Tab, () => switchTab(-1));
          // Alt+←/→ belongs to pane focus (user), so the editor keeps no
          // history binding there; Go Back/Forward stay palette commands.
          editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW, () =>
            window.dispatchEvent(new CustomEvent("mixdog:close-active-tab")));
          editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyQ, () =>
            window.dispatchEvent(new CustomEvent("mixdog:close-active-tab")));
          const onEditorAction = (event: Event) => {
            if (!activeRef.current || !focusedRef.current) return;
            const detail = (event as CustomEvent).detail;
            const action = typeof detail === "string" ? detail : String(detail?.action || "");
            if (typeof detail?.line === "number") {
              editor.setPosition({
                lineNumber: Math.max(1, detail.line),
                column: Math.max(1, Number(detail.column) || 1),
              });
              editor.revealLineInCenter(Math.max(1, detail.line));
            }
            if (action === "callHierarchy") {
              void startCallHierarchy();
              return;
            }
            const actionId = action === "rename" ? "editor.action.rename"
              : action === "quickFix" ? "editor.action.quickFix"
                : action === "refactor" ? "editor.action.refactor"
                  : action === "format" ? "editor.action.formatDocument"
                    : action.startsWith("editor.") ? action : "";
            if (actionId === FORMAT_DOCUMENT_WITH) {
              void editor.getAction("editor.action.formatDocument")?.run();
            } else if (actionId) {
              void editor.getAction(actionId)?.run();
            }
          };
          window.addEventListener("mixdog:editor-action", onEditorAction);
          languageDisposables.current.push({
            dispose: () => window.removeEventListener("mixdog:editor-action", onEditorAction),
          });
          if (model) markDirty(model.getValue() !== savedText.current);
          renderAnsiOutput(model);
          reportEditorLoadStage(projectPath, relPath, accessToken, "ready", "", true);
          notifyReady();
        }}
        onChange={(value) => {
          const content = String(value ?? "");
          const changed = content !== savedText.current;
          skipUnmountBackup.current = false;
          setRevertError("");
          markDirty(changed);
          if (changed) scheduleBackup(content);
          else {
            setRecovery(null);
            void deleteBackup().catch(() => undefined);
          }
        }}
      />
    </div>
    {/* ALWAYS mounted: gating on `focused` resized the editor body by 22px on
        every focus change — a visible jump right after a pane appears (user:
        자리를 못 잡고 튄다). Unfocused panes keep the reserved row, hidden. */}
    <footer className={`editor-statusbar${focused ? "" : " editor-statusbar-idle"}`}
      aria-label="Editor status" aria-hidden={focused ? undefined : true}>
      <div className="editor-statusbar-left">
        <button type="button" aria-label="Show Problems"
          data-tooltip={`${problemStatus.errors} Errors, ${problemStatus.warnings} Warnings`}
          onClick={() => window.dispatchEvent(new CustomEvent("mixdog:show-problems"))}>
          <span aria-hidden="true">×</span> {problemStatus.errors}
          <span aria-hidden="true">△</span> {problemStatus.warnings}
        </button>
      </div>
      <div className="editor-statusbar-right">
        {lspCapabilities.current?.formatting && <button type="button"
          aria-label="Format Document" data-tooltip="Format Document"
          onClick={() => { void editorRef.current?.getAction("editor.action.formatDocument")?.run(); }}>
          Formatter
        </button>}
        <button type="button" aria-label="Go to Line/Column" data-tooltip={selectionLabel}
          onClick={() => { void editorRef.current?.getAction("editor.action.gotoLine")?.run(); }}>
          {selectionLabel}
        </button>
        {/* Language stays as a quiet read-only indicator (final cleanup:
            encoding/EOL/indentation pickers removed — VS Code-depth knobs
            without an in-app need). */}
        <span className="editor-statusbar-language">
          {editorLanguageLabel(editorFormat.languageId)}
        </span>
      </div>
    </footer>
  </div></>;
}
