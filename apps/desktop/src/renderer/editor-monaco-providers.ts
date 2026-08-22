import { monaco } from "./monaco-setup";
// @ts-expect-error The Peek submenu registry is internal and has no declarations.
import { MenuId, MenuRegistry } from "monaco-editor/esm/vs/platform/actions/common/actions.js";
// @ts-expect-error See the menu-registry import above.
import { ContextKeyExpr } from "monaco-editor/esm/vs/platform/contextkey/common/contextkey.js";
import type {
  DesktopApi,
  DesktopLspCapabilities,
  DesktopLspRequestMethod,
  DesktopWorkspaceTextWrite,
} from "../shared/contract";
import {
  parseCodeGraphLocations,
  parseCodeGraphSymbols,
  type EditorCodeGraphMode,
} from "./editor-code-graph";
import {
  completionKind,
  graphLocationRange,
  graphTargetUri,
  lspLocations,
  lspPosition,
  lspRange,
  lspSymbolKind,
  lspTextEdits,
  lspUriInProject,
  markupText,
  monacoPosition,
  monacoRange,
  normalizedFilePath,
  recordOf,
  symbolKind,
} from "./editor-lsp-conversion";
import {
  applyLspTextEdits,
  type EditorOutlineItem,
} from "./editor-language-store";

export interface EditorGraphContext {
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

export interface EditorGraphContextRef {
  current: EditorGraphContext;
}

export const graphContextsByModel = new Map<string, EditorGraphContextRef>();
export const graphContextsByEditor = new WeakMap<
  import("monaco-editor").editor.ICodeEditor,
  EditorGraphContextRef
>();
const graphProviderLanguages = new Set<string>();
export const lspReadyLanguages = new Set<string>();
export const lspCapabilitiesByLanguage = new Map<string, DesktopLspCapabilities>();
const lspProviderFeaturesByLanguage = new Map<string, Set<string>>();
let graphEditorOpenerInstalled = false;
let lspWorkspaceEditCommandInstalled = false;
let lspCodeActionCommandInstalled = false;
let lspCommandInstalled = false;
const APPLY_LSP_WORKSPACE_EDIT = "mixdog.editor.applyLspWorkspaceEdit";
const APPLY_LSP_CODE_ACTION = "mixdog.editor.applyLspCodeAction";
const EXECUTE_LSP_COMMAND = "mixdog.editor.executeLspCommand";
const PEEK_CALL_HIERARCHY = "editor.showCallHierarchy";
export const HAS_CALL_HIERARCHY = "editorHasCallHierarchyProvider";
const EDITOR_VIEW_STATE_KEY = "mixdog.desktop-editor-view-state.v1";
export const CALL_HIERARCHY_LAYOUT_KEY = "callHierarchyPeekLayout";
export const CALL_HIERARCHY_DIRECTION_KEY = "callHierarchy/defaultDirection";
type EditorViewState = import("monaco-editor").editor.ICodeEditorViewState;
const editorViewStates = new Map<string, { state: EditorViewState; touchedAt: number }>();
let editorViewStatesLoaded = false;
export const focusedGraphEditor = { current: null as import("monaco-editor").editor.ICodeEditor | null };
let callHierarchyMenuInstalled = false;
export const FORMAT_DOCUMENT_WITH = "editor.action.formatDocument.multiple";

export function ensureCallHierarchyMenu(): void {
  if (callHierarchyMenuInstalled) return;
  callHierarchyMenuInstalled = true;
  for (const item of MenuRegistry.getMenuItems(MenuId.EditorContext)) {
    if ("command" in item && item.command.id === "editor.action.quickOutline") {
      item.when = ContextKeyExpr.false();
    }
  }
  monaco.editor.registerCommand(PEEK_CALL_HIERARCHY, () => {
    const context = focusedGraphEditor.current
      ? graphContextsByEditor.get(focusedGraphEditor.current)?.current
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
    void focusedGraphEditor.current?.getAction("editor.action.formatDocument")?.run();
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

export function readEditorViewState(path: string): EditorViewState | null {
  loadEditorViewStates();
  return editorViewStates.get(path)?.state ?? null;
}

export function writeEditorViewState(path: string, state: EditorViewState): void {
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

export function lspDocumentSymbols(
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

export function codeGraphOutlineItems(
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
  // User-facing product noun is Project; the LSP wire name stays internal.
  if (!edit) throw new Error("Language server returned an invalid project edit.");
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
        throw new Error("Create, rename, and delete project edits require explicit file confirmation.");
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
    throw new Error("Language server project edit is too large.");
  }
  return groups;
}

export async function applyLspWorkspaceEdit(
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
    const model = findOpenProjectModel(context, relPath);
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
      throw new Error(`Project edit cannot safely change ${relPath}.`);
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

export function findOpenProjectModel(
  context: EditorGraphContext,
  relPath: string,
): import("monaco-editor").editor.ITextModel | undefined {
  const projectComparable = context.projectPath.replace(/[\\/]+/g, "/").toLocaleLowerCase();
  const relComparable = relPath.replace(/\\/g, "/").toLocaleLowerCase();
  return monaco.editor.getModels().find((candidate) => {
    const owner = graphContextsByModel.get(candidate.uri.toString())?.current;
    return owner?.projectPath.replace(/[\\/]+/g, "/").toLocaleLowerCase() === projectComparable
      && owner.relPath.replace(/\\/g, "/").toLocaleLowerCase() === relComparable;
  });
}

const peekPreviewModels = new Map<string, number>();
const PEEK_PREVIEW_MODEL_LIMIT = 20;
const PEEK_PREVIEW_LOADS_PER_REQUEST = 20;

function prunePeekPreviewModels(): void {
  let excess = peekPreviewModels.size - PEEK_PREVIEW_MODEL_LIMIT;
  if (excess <= 0) return;
  for (const [key] of [...peekPreviewModels.entries()].sort((left, right) => left[1] - right[1])) {
    if (excess <= 0) break;
    const model = monaco.editor.getModel(monaco.Uri.parse(key));
    // A model rendered inside an open peek widget must survive eviction.
    if (model?.isAttachedToEditor()) continue;
    peekPreviewModels.delete(key);
    model?.dispose();
    excess -= 1;
  }
}

/** Standalone Monaco's peek widgets (Peek Definition/References/…) resolve
 *  result URIs against already-created text models only, so a target file
 *  without one rendered as an empty preview. Open tabs never match either:
 *  \@monaco-editor/react keys models by Uri.parse(path) while locations use
 *  Uri.file/LSP URIs. Materialize preview models for cross-file targets
 *  before returning locations, mirroring an open tab's live buffer when one
 *  exists and reading from disk otherwise. */
export async function preparePeekModels<T extends { uri: import("monaco-editor").Uri }>(
  context: EditorGraphContext,
  source: import("monaco-editor").editor.ITextModel,
  locations: T[],
): Promise<T[]> {
  const api = context.api;
  if (!api?.readProjectFile) return locations;
  const root = normalizedFilePath(context.projectPath);
  const rootComparable = root.toLocaleLowerCase();
  const seen = new Set<string>([source.uri.toString()]);
  for (const location of locations) {
    if (seen.size > PEEK_PREVIEW_LOADS_PER_REQUEST) break;
    const key = location.uri.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    const isPreview = peekPreviewModels.has(key);
    if (monaco.editor.getModel(location.uri) && !isPreview) continue;
    try {
      const target = normalizedFilePath(location.uri.fsPath);
      if (!target.toLocaleLowerCase().startsWith(`${rootComparable}/`)) continue;
      const relPath = target.slice(root.length).replace(/^\/+/, "");
      if (!relPath) continue;
      const openModel = findOpenProjectModel(context, relPath);
      let content: string;
      let languageId: string | undefined;
      if (openModel) {
        content = openModel.getValue();
        languageId = openModel.getLanguageId();
      } else {
        const loaded = await api.readProjectFile(context.projectPath, relPath);
        if (loaded.binary || loaded.tooLarge) continue;
        content = loaded.content;
      }
      const existing = monaco.editor.getModel(location.uri);
      if (existing) {
        if (isPreview && !existing.isAttachedToEditor() && existing.getValue() !== content) {
          existing.setValue(content);
        }
      } else {
        monaco.editor.createModel(content, languageId, location.uri);
      }
      peekPreviewModels.set(key, Date.now());
    } catch {
      // Preview is best-effort; peek falls back to plain navigation.
    }
  }
  prunePeekPreviewModels();
  return locations;
}

function claimLspProviderFeature(languageId: string, feature: string): boolean {
  const registered = lspProviderFeaturesByLanguage.get(languageId) ?? new Set<string>();
  if (registered.has(feature)) return false;
  registered.add(feature);
  lspProviderFeaturesByLanguage.set(languageId, registered);
  return true;
}

export function ensureGraphProviders(languageId: string): void {
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
            if (locations.length) return preparePeekModels(context, model, locations);
          }
          if (!context.codeGraph) return [];
          const rows = parseCodeGraphLocations(await context.codeGraph("find_symbol", word));
          if (token.isCancellationRequested) return [];
          return preparePeekModels(context, model, rows.slice(0, 20).map((location) => ({
            uri: graphTargetUri(model, context, location),
            range: graphLocationRange(location, word.length),
          })));
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
            if (locations.length) return preparePeekModels(context, model, locations);
          }
          if (!context.codeGraph) return [];
          const rows = parseCodeGraphLocations(await context.codeGraph("references", word));
          if (token.isCancellationRequested) return [];
          return preparePeekModels(context, model, rows.slice(0, 100).map((location) => ({
            uri: graphTargetUri(model, context, location),
            range: graphLocationRange(location, word.length),
          })));
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
          return preparePeekModels(context, model, lspLocations(await context.requestLsp(
            "textDocument/typeDefinition",
            { position: lspPosition(position) },
          ), context));
        },
      });
    }
    if (capabilities?.declaration && claimLspProviderFeature(languageId, "declaration")) {
      monaco.languages.registerDeclarationProvider(languageId, {
        async provideDeclaration(model, position) {
          const context = graphContextsByModel.get(model.uri.toString())?.current;
          if (!context?.requestLsp || !context.lspCapabilities?.declaration) return [];
          return preparePeekModels(context, model, lspLocations(await context.requestLsp(
            "textDocument/declaration",
            { position: lspPosition(position) },
          ), context));
        },
      });
    }
    if (capabilities?.implementation && claimLspProviderFeature(languageId, "implementation")) {
      monaco.languages.registerImplementationProvider(languageId, {
        async provideImplementation(model, position) {
          const context = graphContextsByModel.get(model.uri.toString())?.current;
          if (!context?.requestLsp || !context.lspCapabilities?.implementation) return [];
          return preparePeekModels(context, model, lspLocations(await context.requestLsp(
            "textDocument/implementation",
            { position: lspPosition(position) },
          ), context));
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

