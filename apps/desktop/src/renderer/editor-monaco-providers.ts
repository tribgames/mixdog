import { monaco } from './monaco-setup';
import { t } from './i18n';
// @ts-expect-error The Peek submenu registry is internal and has no declarations.
import { MenuId, MenuRegistry } from 'monaco-editor/esm/vs/platform/actions/common/actions.js';
// @ts-expect-error See the menu-registry import above.
import { ContextKeyExpr } from 'monaco-editor/esm/vs/platform/contextkey/common/contextkey.js';
import type { DesktopLspCapabilities, DesktopWorkspaceTextWrite } from '../shared/contract';
import { codeGraphOutlineItems } from './editor-code-graph';
import { lspUriInProject, monacoRange, projectRelativePath, recordOf } from './editor-lsp-conversion';
import { applyLspTextEdits } from './editor-language-store';
import { ensureGraphEditorOpener, registerCodeGraphProviders } from './editor-code-graph-providers';
import { ensureLspCommands, registerLspCapabilityProviders } from './editor-lsp-providers';
import { type EditorGraphContext, findOpenProjectModel, graphContextsByEditor } from './editor-graph-context';

export type { EditorGraphContext, EditorGraphContextRef } from './editor-graph-context';
export { graphContextsByEditor, graphContextsByModel, lspDocumentSymbols } from './editor-graph-context';

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
      // Monaco draws its menus outside the DOM localizer's reach.
      title: t('Peek Call Hierarchy'),
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
    // Right after Format Document (1.3): a shared order fell back to title
    // order, which put the translated "…With" entry first.
    order: 1.31,
    command: {
      id: FORMAT_DOCUMENT_WITH,
      title: t('Format Document With...'),
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

export { codeGraphOutlineItems };

type WorkspaceEditGroup = {
  edits: Array<Record<string, unknown>>;
  /** LSP documentChanges version — equals the monaco model versionId our
   *  didOpen/didChange sync reports, so stale edits are detectable. */
  version: number | null;
};

function workspaceEditGroups(value: unknown): Map<string, WorkspaceEditGroup> {
  const edit = recordOf(value);
  // User-facing product noun is Project; the LSP wire name stays internal.
  if (!edit) throw new Error(t('Language server returned an invalid project edit.'));
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
        throw new Error(t('Create, rename, and delete project edits require explicit file confirmation.'));
      }
      const document = recordOf(record.textDocument);
      if (typeof document?.uri === 'string') {
        append(document.uri, record.edits, typeof document.version === 'number' ? document.version : null);
      }
    }
  }
  if (groups.size > 100 || [...groups.values()].reduce((sum, group) => sum + group.edits.length, 0) > 10_000) {
    throw new Error(t('Language server project edit is too large.'));
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
    if (!uri) throw new Error(t('Language server edit escaped the project.'));
    const relPath = projectRelativePath(uri.fsPath, context.projectPath);
    if (!relPath) throw new Error(t('Language server targeted the project directory.'));
    const model = findOpenProjectModel(context, relPath);
    if (model) {
      // Stale-edit guard: the server computed these ranges against the
      // version our didOpen/didChange sync reported (= monaco versionId).
      // Applying them onto a document that moved on (fast typing, an agent
      // rewriting the file) interleaves lines and splits words — observed as
      // scrambled "restored" backups (user report).
      if (group.version !== null && model.getVersionId() !== group.version) {
        throw new Error(t('The document changed while the language server prepared this edit. Try again.'));
      }
      modelEdits.push({ model, edits });
      continue;
    }
    const loaded = await api.readProjectFile(context.projectPath, relPath);
    if (loaded.binary || loaded.tooLarge) {
      throw new Error(t('Project edit cannot safely change {{value0}}.', { value0: relPath }));
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
      if (!range) throw new Error(t('Language server returned an invalid text range.'));
      // Bounds sanity for version-less edits: a range beyond the current
      // document is certainly stale and must not scramble the model.
      if (range.startLineNumber > lineCount + 1 || range.endLineNumber > lineCount + 1) {
        throw new Error(t('Language server edit targets a stale document position. Try again.'));
      }
      return { range, text: String(edit.newText ?? ''), forceMoveMarkers: true };
    });
    entry.model.pushEditOperations([], operations, () => null);
  }
  return true;
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
