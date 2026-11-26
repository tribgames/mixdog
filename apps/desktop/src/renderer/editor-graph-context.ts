// Per-model/per-editor graph context registries plus the helpers every editor
// provider module shares. Kept apart from editor-monaco-providers so the LSP and
// code-graph provider modules can use them without importing their own registrar.
import { monaco } from './monaco-setup';
import { ensureMonacoLanguage } from './monaco-language-loader';
import type { DesktopApi, DesktopLspCapabilities, DesktopLspRequestMethod } from '../shared/contract';
import type { EditorCodeGraphMode } from './editor-code-graph';
import { lspSymbolKind, lspUriInProject, monacoRange, projectRelativePath, recordOf } from './editor-lsp-conversion';
import type { EditorOutlineItem } from './editor-language-store';

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

/** Disposes every cached peek preview model not currently attached to an editor. */
export function releaseUnattachedPeekPreviewModels(): void {
  for (const key of [...peekPreviewModels.keys()]) {
    const model = monaco.editor.getModel(monaco.Uri.parse(key));
    if (model?.isAttachedToEditor()) continue;
    peekPreviewModels.delete(key);
    model?.dispose();
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
  const seen = new Set<string>([source.uri.toString()]);
  for (const location of locations) {
    if (seen.size > PEEK_PREVIEW_LOADS_PER_REQUEST) break;
    const key = location.uri.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    const isPreview = peekPreviewModels.has(key);
    if (monaco.editor.getModel(location.uri) && !isPreview) continue;
    try {
      const relPath = projectRelativePath(location.uri.fsPath, context.projectPath);
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
        const created = monaco.editor.createModel(content, languageId, location.uri);
        void ensureMonacoLanguage(languageId ?? created.getLanguageId()).catch(() => {});
      }
      peekPreviewModels.set(key, Date.now());
    } catch {
      // Preview is best-effort; peek falls back to plain navigation.
    }
  }
  prunePeekPreviewModels();
  return locations;
}
