import { monaco } from './monaco-setup';
import { t } from './i18n';
// @ts-expect-error The Peek submenu registry is internal and has no declarations.
import { MenuId, MenuRegistry } from 'monaco-editor/esm/vs/platform/actions/common/actions.js';
// @ts-expect-error See the menu-registry import above.
import { ContextKeyExpr } from 'monaco-editor/esm/vs/platform/contextkey/common/contextkey.js';
import type {
  DesktopApi,
  DesktopLspCapabilities,
  DesktopLspRequestMethod,
  DesktopWorkspaceTextWrite,
} from '../shared/contract';
import { codeGraphDocumentSymbols, codeGraphOutlineItems, type EditorCodeGraphMode } from './editor-code-graph';
import { lspSymbolKind, lspUriInProject, monacoRange, normalizedFilePath, recordOf } from './editor-lsp-conversion';
import { applyLspTextEdits, type EditorOutlineItem } from './editor-language-store';
import { ensureGraphEditorOpener, registerCodeGraphProviders } from './editor-code-graph-providers';
import { ensureLspCommands, registerLspCapabilityProviders } from './editor-lsp-providers';

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

export const graphContextsByEditor = new WeakMap<import('monaco-editor').editor.ICodeEditor, EditorGraphContextRef>();
export const lspReadyLanguages = new Set<string>();
export const lspCapabilitiesByLanguage = new Map<string, DesktopLspCapabilities>();
const PEEK_CALL_HIERARCHY = 'editor.showCallHierarchy';
export const HAS_CALL_HIERARCHY = 'editorHasCallHierarchyProvider';
const EDITOR_VIEW_STATE_KEY = 'mixdog.desktop-editor-view-state.v1';
export const CALL_HIERARCHY_LAYOUT_KEY = 'callHierarchyPeekLayout';
export const CALL_HIERARCHY_DIRECTION_KEY = 'callHierarchy/defaultDirection';
type EditorViewState = import('monaco-editor').editor.ICodeEditorViewState;
const editorViewStates = new Map<string, { state: EditorViewState; touchedAt: number }>();
let editorViewStatesLoaded = false;
export const focusedGraphEditor = { current: null as import('monaco-editor').editor.ICodeEditor | null };
let callHierarchyMenuInstalled = false;
export const FORMAT_DOCUMENT_WITH = 'editor.action.formatDocument.multiple';

export function ensureCallHierarchyMenu(): void {
  if (callHierarchyMenuInstalled) return;
  callHierarchyMenuInstalled = true;
  for (const item of MenuRegistry.getMenuItems(MenuId.EditorContext)) {
    if ('command' in item && item.command.id === 'editor.action.quickOutline') {
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
    group: 'navigation',
    order: 1000,
    command: {
      id: PEEK_CALL_HIERARCHY,
      title: 'Peek Call Hierarchy',
      precondition: available,
    },
    when: available,
  });
  monaco.editor.registerCommand(FORMAT_DOCUMENT_WITH, () => {
    void focusedGraphEditor.current?.getAction('editor.action.formatDocument')?.run();
  });
  const multipleFormatters = ContextKeyExpr.has('editorHasMultipleDocumentFormattingProvider');
  MenuRegistry.appendMenuItem(MenuId.EditorContext, {
    group: '1_modification',
    order: 1.3,
    command: {
      id: FORMAT_DOCUMENT_WITH,
      title: 'Format Document With...',
      precondition: multipleFormatters,
    },
    when: multipleFormatters,
  });
}

function loadEditorViewStates(): void {
  if (editorViewStatesLoaded) return;
  editorViewStatesLoaded = true;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(EDITOR_VIEW_STATE_KEY) || '[]') as unknown;
    if (!Array.isArray(parsed)) return;
    for (const row of parsed.slice(-100)) {
      if (!Array.isArray(row) || typeof row[0] !== 'string' || !row[1] || typeof row[1] !== 'object') continue;
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
    window.localStorage.setItem(
      EDITOR_VIEW_STATE_KEY,
      JSON.stringify(entries.map(([key, value]) => [key, value.state, value.touchedAt]))
    );
  } catch {
    // Storage quota/privacy mode must never block editor disposal.
  }
}

export function lspDocumentSymbols(
  model: import('monaco-editor').editor.ITextModel,
  value: unknown,
  context: EditorGraphContext
): { symbols: import('monaco-editor').languages.DocumentSymbol[]; outline: EditorOutlineItem[] } {
  const symbols: import('monaco-editor').languages.DocumentSymbol[] = [];
  const outline: EditorOutlineItem[] = [];
  const visit = (rows: unknown, level: number, target: import('monaco-editor').languages.DocumentSymbol[]) => {
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
      const name = typeof record.name === 'string' ? record.name : 'symbol';
      const detail = typeof record.detail === 'string' ? record.detail : '';
      const row: import('monaco-editor').languages.DocumentSymbol = {
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
        kind: String(record.kind || ''),
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

export { codeGraphDocumentSymbols, codeGraphOutlineItems };

type WorkspaceEditGroup = {
  edits: Array<Record<string, unknown>>;
  /** LSP documentChanges version — equals the monaco model versionId our
   *  didOpen/didChange sync reports, so stale edits are detectable. */
  version: number | null;
};

function workspaceEditGroups(value: unknown): Map<string, WorkspaceEditGroup> {
  const edit = recordOf(value);
  // User-facing product noun is Project; the LSP wire name stays internal.
  if (!edit) throw new Error('Language server returned an invalid project edit.');
  const groups = new Map<string, WorkspaceEditGroup>();
  const append = (uri: string, edits: unknown, version: number | null = null) => {
    if (!Array.isArray(edits)) return;
    const group = groups.get(uri) ?? { edits: [], version: null };
    for (const row of edits) {
      const record = recordOf(row);
      if (record?.range && typeof record.newText === 'string') group.edits.push(record);
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
        throw new Error('Create, rename, and delete project edits require explicit file confirmation.');
      }
      const document = recordOf(record.textDocument);
      if (typeof document?.uri === 'string') {
        append(document.uri, record.edits, typeof document.version === 'number' ? document.version : null);
      }
    }
  }
  if (groups.size > 100 || [...groups.values()].reduce((sum, group) => sum + group.edits.length, 0) > 10_000) {
    throw new Error('Language server project edit is too large.');
  }
  return groups;
}

export async function applyLspWorkspaceEdit(
  context: EditorGraphContext,
  value: unknown,
  confirmationLabel?: string
): Promise<boolean> {
  const api = context.api;
  if (!api?.readProjectFile || !api.writeProjectFile) return false;
  const groups = workspaceEditGroups(value);
  const editCount = [...groups.values()].reduce((sum, group) => sum + group.edits.length, 0);
  if (
    confirmationLabel &&
    groups.size > 1 &&
    !window.confirm(
      t('{{action}} will update {{locations}} locations in {{files}} files. Continue?', {
        action: confirmationLabel,
        locations: editCount,
        files: groups.size,
      })
    )
  ) {
    return false;
  }
  const modelEdits: Array<{
    model: import('monaco-editor').editor.ITextModel;
    edits: Array<Record<string, unknown>>;
  }> = [];
  const writes: DesktopWorkspaceTextWrite[] = [];
  for (const [uriValue, group] of groups) {
    const edits = group.edits;
    const uri = lspUriInProject(uriValue, context);
    if (!uri) throw new Error('Language server edit escaped the project.');
    const root = normalizedFilePath(context.projectPath);
    const target = normalizedFilePath(uri.fsPath);
    const relPath = target.slice(root.length).replace(/^\/+/, '');
    if (!relPath) throw new Error('Language server targeted the project directory.');
    const model = findOpenProjectModel(context, relPath);
    if (model) {
      // Stale-edit guard: the server computed these ranges against the
      // version our didOpen/didChange sync reported (= monaco versionId).
      // Applying them onto a document that moved on (fast typing, an agent
      // rewriting the file) interleaves lines and splits words — observed as
      // scrambled "restored" backups (user report).
      if (group.version !== null && model.getVersionId() !== group.version) {
        throw new Error('The document changed while the language server prepared this edit. Try again.');
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
        await api.writeProjectFile(context.projectPath, write.relPath, write.content, write.expectedContent);
      }
    }
  }
  for (const entry of modelEdits) {
    const lineCount = entry.model.getLineCount();
    const operations = entry.edits.map((edit) => {
      const range = monacoRange(edit.range);
      if (!range) throw new Error('Language server returned an invalid text range.');
      // Bounds sanity for version-less edits: a range beyond the current
      // document is certainly stale and must not scramble the model.
      if (range.startLineNumber > lineCount + 1 || range.endLineNumber > lineCount + 1) {
        throw new Error('Language server edit targets a stale document position. Try again.');
      }
      return { range, text: String(edit.newText ?? ''), forceMoveMarkers: true };
    });
    entry.model.pushEditOperations([], operations, () => null);
  }
  return true;
}

export function findOpenProjectModel(
  context: EditorGraphContext,
  relPath: string
): import('monaco-editor').editor.ITextModel | undefined {
  const projectComparable = context.projectPath.replace(/[\\/]+/g, '/').toLocaleLowerCase();
  const relComparable = relPath.replace(/\\/g, '/').toLocaleLowerCase();
  return monaco.editor.getModels().find((candidate) => {
    const owner = graphContextsByModel.get(candidate.uri.toString())?.current;
    return (
      owner?.projectPath.replace(/[\\/]+/g, '/').toLocaleLowerCase() === projectComparable &&
      owner.relPath.replace(/\\/g, '/').toLocaleLowerCase() === relComparable
    );
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
export async function preparePeekModels<T extends { uri: import('monaco-editor').Uri }>(
  context: EditorGraphContext,
  source: import('monaco-editor').editor.ITextModel,
  locations: T[]
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
      const relPath = target.slice(root.length).replace(/^\/+/, '');
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

/** Every provider this pane's language needs, in the order Monaco sees them:
 *  code-graph navigation first, then one provider per declared LSP capability,
 *  then the commands their payloads invoke and the cross-file opener. Each step
 *  claims its own registration, so repeated calls add nothing. */
export function ensureGraphProviders(languageId: string): void {
  registerCodeGraphProviders(languageId);
  if (lspReadyLanguages.has(languageId)) {
    registerLspCapabilityProviders(languageId, lspCapabilitiesByLanguage.get(languageId));
  }
  ensureLspCommands();
  ensureGraphEditorOpener();
}
