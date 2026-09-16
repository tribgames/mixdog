import type { EditorOutlineItem } from './editor-language-store';

export type EditorCodeGraphMode = 'find_symbol' | 'references' | 'symbols';

export interface EditorGraphLocation {
  rel: string;
  line: number;
  endLine: number;
  column: number;
}

export interface EditorGraphSymbol {
  kind: string;
  name: string;
  line: number;
  endLine: number;
  exported: boolean;
  sig: string | null;
  level: number;
}

export const UNIFIED_SYMBOL_KINDS = [
  'module',
  'namespace',
  'package',
  'class',
  'struct',
  'interface',
  'trait',
  'enum',
  'enumMember',
  'type',
  'function',
  'method',
  'constructor',
  'field',
  'property',
  'variable',
  'constant',
  'macro',
  'event',
  'protocol',
  'impl',
] as const;

export type UnifiedSymbolKind = (typeof UNIFIED_SYMBOL_KINDS)[number];

/** Map unified symbol kinds to Monaco SymbolKind numeric enum values. */
export function codeGraphSymbolKindValue(kind: string): number {
  switch (kind.toLowerCase()) {
    case 'module':
      return 1; // SymbolKind.Module
    case 'namespace':
      return 2; // SymbolKind.Namespace
    case 'package':
      return 3; // SymbolKind.Package
    case 'class':
    case 'impl':
      return 4; // SymbolKind.Class
    case 'method':
      return 5; // SymbolKind.Method
    case 'property':
      return 6; // SymbolKind.Property
    case 'field':
      return 7; // SymbolKind.Field
    case 'constructor':
      return 8; // SymbolKind.Constructor
    case 'enum':
      return 9; // SymbolKind.Enum
    case 'interface':
    case 'trait':
    case 'protocol':
    case 'type':
      return 10; // SymbolKind.Interface
    case 'function':
    case 'macro':
      return 11; // SymbolKind.Function
    case 'variable':
      return 12; // SymbolKind.Variable
    case 'constant':
      return 13; // SymbolKind.Constant
    case 'enummember':
      return 21; // SymbolKind.EnumMember
    case 'struct':
      return 22; // SymbolKind.Struct
    case 'event':
      return 23; // SymbolKind.Event
    default:
      return 12; // SymbolKind.Variable
  }
}

/** Parse the stable path:line[-end][:column] anchors emitted by code_graph. */
export function parseCodeGraphLocations(text: string): EditorGraphLocation[] {
  const seen = new Set<string>();
  const out: EditorGraphLocation[] = [];
  for (const match of String(text || '').matchAll(
    /([A-Za-z0-9_@./\\-]+\.[A-Za-z0-9_]+):(\d+)(?:-(\d+))?(?::(\d+))?/g
  )) {
    const rel = match[1].replace(/\\/g, '/').replace(/^\.\//, '');
    const line = Number(match[2]);
    const endLine = Math.max(line, Number(match[3] || line));
    const column = Math.max(1, Number(match[4] || 1));
    const key = `${rel}:${line}:${endLine}:${column}`;
    if (!line || rel.includes('node_modules') || seen.has(key)) continue;
    seen.add(key);
    out.push({ rel, line, endLine, column });
  }
  return out;
}

/**
 * Parse code_graph's file-outline rows, e.g.:
 *   "export class Service (L27-45)"
 *   "  function run (L33-37)  def run(self, payload) -> str"
 *   "function save (L89-104)"
 */
const SYMBOL_ROW_RE = /^( *)(?:(export)\s+)?([A-Za-z_][\w-]*)\s+(.+?)\s+\(L(\d+)(?:-(\d+))?\)(?:\s\s+(.*))?\s*$/;

export function parseCodeGraphSymbols(text: string): EditorGraphSymbol[] {
  const seen = new Set<string>();
  const out: EditorGraphSymbol[] = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const match = SYMBOL_ROW_RE.exec(raw);
    if (!match) continue;
    const indentSpaces = match[1].length;
    const level = Math.floor(indentSpaces / 2);
    const exported = Boolean(match[2]);
    const kind = match[3];
    const name = match[4].trim();
    const line = Number(match[5]);
    const endLine = Math.max(line, Number(match[6] || line));
    const rawSig = match[7]?.trim();
    const sig = rawSig && rawSig.length > 0 ? rawSig : null;
    const key = `${kind}:${name}:${line}:${endLine}:${level}`;
    if (!name || !line || seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, name, line, endLine, exported, sig, level });
  }
  return out;
}

export interface EditorGraphOutlineModel {
  uri: { toString(): string };
  getLineCount(): number;
}

export interface EditorGraphOutlineContext {
  projectPath: string;
  relPath: string;
}

export function codeGraphOutlineItems(
  model: EditorGraphOutlineModel,
  context: EditorGraphOutlineContext,
  sourceRows: readonly EditorGraphSymbol[]
): EditorOutlineItem[] {
  const rows = [...sourceRows].sort(
    (left, right) => left.line - right.line || right.endLine - left.endLine || left.name.localeCompare(right.name)
  );
  const hasExplicitLevels = rows.some((r) => (r.level ?? 0) > 0);
  const parents: Array<{ endLine: number }> = [];
  return rows.slice(0, 200).map((row, index) => {
    const line = Math.min(model.getLineCount(), Math.max(1, row.line));
    const endLine = Math.min(model.getLineCount(), Math.max(line, row.endLine));
    while (parents.length && line > parents.at(-1)!.endLine) parents.pop();
    const spanLevel = parents.length;
    if (endLine > line) parents.push({ endLine });
    const level = hasExplicitLevels ? (row.level ?? 0) : spanLevel;
    return {
      key: `${model.uri.toString()}:${line}:${index}:${row.name}`,
      projectPath: context.projectPath,
      relPath: context.relPath,
      uri: model.uri.toString(),
      name: row.name,
      detail: row.sig ?? row.kind,
      kind: row.kind,
      line,
      column: 1,
      endLine,
      level,
    };
  });
}

export interface EditorGraphSymbolModel extends EditorGraphOutlineModel {
  getLineContent(lineNumber: number): string;
  getLineMaxColumn?(lineNumber: number): number;
}

export interface EditorGraphRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export type EditorGraphRangeFactory<TRange> = (
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number
) => TRange;

export interface EditorGraphDocumentSymbol<TRange = EditorGraphRange> {
  name: string;
  detail: string;
  kind: number;
  tags: readonly number[];
  range: TRange;
  selectionRange: TRange;
  children?: Array<EditorGraphDocumentSymbol<TRange>>;
}

export function codeGraphDocumentSymbols<TRange = EditorGraphRange>(
  model: EditorGraphSymbolModel,
  sourceRows: readonly EditorGraphSymbol[],
  rangeFactory?: EditorGraphRangeFactory<TRange>
): Array<EditorGraphDocumentSymbol<TRange>> {
  const createRange: EditorGraphRangeFactory<TRange> =
    rangeFactory ??
    ((sl, sc, el, ec) =>
      ({ startLineNumber: sl, startColumn: sc, endLineNumber: el, endColumn: ec }) as unknown as TRange);

  const rows = [...sourceRows].sort(
    (left, right) => left.line - right.line || right.endLine - left.endLine || left.name.localeCompare(right.name)
  );
  const hasExplicitLevels = rows.some((r) => (r.level ?? 0) > 0);
  const parents: Array<{ endLine: number }> = [];
  const roots: Array<EditorGraphDocumentSymbol<TRange>> = [];
  const stack: Array<{ level: number; symbol: EditorGraphDocumentSymbol<TRange> }> = [];

  for (const row of rows.slice(0, 200)) {
    const line = Math.min(model.getLineCount(), Math.max(1, row.line));
    const endLine = Math.min(model.getLineCount(), Math.max(line, row.endLine));
    while (parents.length && line > parents.at(-1)!.endLine) parents.pop();
    const spanLevel = parents.length;
    if (endLine > line) parents.push({ endLine });
    const level = hasExplicitLevels ? (row.level ?? 0) : spanLevel;

    const lineContent = model.getLineContent(line) ?? '';
    const nameIndex = lineContent.indexOf(row.name);
    const selectionColumn = Math.max(1, nameIndex >= 0 ? nameIndex + 1 : 1);
    const maxLineCol = model.getLineMaxColumn?.(line) ?? lineContent.length + 1;
    const maxEndCol = model.getLineMaxColumn?.(endLine) ?? (model.getLineContent(endLine) ?? '').length + 1;

    const docSymbol: EditorGraphDocumentSymbol<TRange> = {
      name: row.name,
      detail: row.sig ?? row.kind,
      kind: codeGraphSymbolKindValue(row.kind),
      tags: [],
      range: createRange(line, 1, endLine, maxEndCol),
      selectionRange: createRange(line, selectionColumn, line, Math.min(maxLineCol, selectionColumn + row.name.length)),
      children: [],
    };

    while (stack.length && stack.at(-1)!.level >= level) {
      stack.pop();
    }
    if (stack.length === 0) {
      roots.push(docSymbol);
    } else {
      const parent = stack.at(-1)!.symbol;
      if (!parent.children) parent.children = [];
      parent.children.push(docSymbol);
    }
    stack.push({ level, symbol: docSymbol });
  }

  return roots;
}
