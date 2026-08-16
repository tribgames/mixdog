import { monaco } from "./monaco-setup";
import type { EditorGraphLocation } from "./editor-code-graph";

interface EditorPathContext {
  projectPath: string;
  relPath: string;
}

export function normalizedFilePath(value: string): string {
  return String(value || "").replace(/\\/g, "/").replace(/^\/([A-Za-z]:\/)/, "$1").replace(/\/+$/, "");
}

export function graphTargetUri(
  model: import("monaco-editor").editor.ITextModel,
  context: EditorPathContext,
  location: EditorGraphLocation,
): import("monaco-editor").Uri {
  if (normalizedFilePath(location.rel) === normalizedFilePath(context.relPath)) return model.uri;
  return monaco.Uri.file(`${normalizedFilePath(context.projectPath)}/${normalizedFilePath(location.rel)}`);
}

export function graphLocationRange(
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

export function symbolKind(kind: string): import("monaco-editor").languages.SymbolKind {
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

export function lspSymbolKind(value: unknown): import("monaco-editor").languages.SymbolKind {
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

export function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function lspPosition(position: import("monaco-editor").Position): Record<string, number> {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

export function monacoRange(value: unknown): import("monaco-editor").Range | null {
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

export function lspUriInProject(
  uriValue: unknown,
  context: EditorPathContext,
): import("monaco-editor").Uri | null {
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

export function lspLocations(
  value: unknown,
  context: EditorPathContext,
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

export interface EditorCallHierarchyItem {
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

export function lspCallHierarchyItem(
  value: unknown,
  context: EditorPathContext,
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

export function markupText(value: unknown): string {
  if (typeof value === "string") return value;
  const record = recordOf(value);
  if (typeof record?.value === "string") return record.value;
  if (typeof record?.language === "string" && typeof record?.value === "string") {
    return `\`\`\`${record.language}\n${record.value}\n\`\`\``;
  }
  if (Array.isArray(value)) return value.map(markupText).filter(Boolean).join("\n\n");
  return "";
}

export function completionKind(value: unknown): import("monaco-editor").languages.CompletionItemKind {
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

export function lspRange(range: import("monaco-editor").IRange): Record<string, unknown> {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
  };
}

export function monacoPosition(value: unknown): import("monaco-editor").Position | null {
  const position = recordOf(value);
  if (!position) return null;
  const line = Number(position.line);
  const character = Number(position.character);
  if (!Number.isFinite(line) || !Number.isFinite(character)) return null;
  return new monaco.Position(Math.max(1, line + 1), Math.max(1, character + 1));
}

export function lspTextEdits(value: unknown): import("monaco-editor").languages.TextEdit[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = recordOf(item);
    const range = monacoRange(row?.range);
    return range && typeof row?.newText === "string"
      ? [{ range, text: row.newText }]
      : [];
  });
}
