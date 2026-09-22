// What the call-hierarchy panel is looking at, decided without React: the rows
// of one direction, the four states a request can be in, and where a selected
// row's preview comes from. Pure so the hook only has to hold it.
import { editorLanguageIdForPath } from '../shared/editor-languages';
import {
  lspCallHierarchyItem,
  monacoRange,
  normalizedFilePath,
  recordOf,
  type EditorCallHierarchyItem,
} from './editor-lsp-conversion';
import type { EditorGraphContext } from './editor-monaco-providers';
import type { CallHierarchyPreview } from './editor-pane-model';
import { monaco } from './monaco-setup';

export type CallHierarchyDirection = 'incoming' | 'outgoing';

export interface CallHierarchyState {
  root: EditorCallHierarchyItem | null;
  rows: EditorCallHierarchyItem[];
  stack: EditorCallHierarchyItem[];
  direction: CallHierarchyDirection;
  selectedIndex: number;
  loading: boolean;
  error: string;
}

/** A server location as a project-relative path, or null when it leaves the
 *  project — including the project directory itself, which names no file. */
export function projectRelativePath(fsPath: string, projectPath: string): string | null {
  const root = normalizedFilePath(projectPath);
  const path = normalizedFilePath(fsPath);
  const rootComparable = root.toLocaleLowerCase();
  const pathComparable = path.toLocaleLowerCase();
  if (pathComparable === rootComparable || !pathComparable.startsWith(`${rootComparable}/`)) return null;
  return path.slice(root.length + 1);
}

/** The rows of one direction. Each carries where its call sites are, so the
 *  preview can highlight them in the file the direction actually points at. */
export function callHierarchyCalls(
  result: unknown,
  direction: CallHierarchyDirection,
  root: EditorCallHierarchyItem,
  context: EditorGraphContext
): EditorCallHierarchyItem[] {
  return (Array.isArray(result) ? result : []).flatMap((value) => {
    const record = recordOf(value);
    const item = lspCallHierarchyItem(direction === 'incoming' ? record?.from : record?.to, context);
    if (!item) return [];
    const ranges = (Array.isArray(record?.fromRanges) ? record.fromRanges : []).flatMap((rawRange) => {
      const range = monacoRange(rawRange);
      return range ? [range] : [];
    });
    return [
      {
        ...item,
        previewUri: direction === 'incoming' ? item.uri : root.uri,
        previewRanges: ranges.length ? ranges : [item.selectionRange],
      },
    ];
  });
}

const hierarchyState = (
  root: EditorCallHierarchyItem | null,
  direction: CallHierarchyDirection,
  stack: EditorCallHierarchyItem[],
  rest: { rows?: EditorCallHierarchyItem[]; loading?: boolean; error?: string }
): CallHierarchyState => ({
  root,
  rows: rest.rows ?? [],
  stack,
  direction,
  selectedIndex: 0,
  loading: rest.loading === true,
  error: rest.error ?? '',
});

export const hierarchyLoading = (
  root: EditorCallHierarchyItem | null,
  direction: CallHierarchyDirection,
  stack: EditorCallHierarchyItem[]
): CallHierarchyState => hierarchyState(root, direction, stack, { loading: true });

export const hierarchyResults = (
  root: EditorCallHierarchyItem | null,
  direction: CallHierarchyDirection,
  stack: EditorCallHierarchyItem[],
  rows: EditorCallHierarchyItem[]
): CallHierarchyState => hierarchyState(root, direction, stack, { rows });

export const hierarchyFailure = (
  root: EditorCallHierarchyItem | null,
  direction: CallHierarchyDirection,
  stack: EditorCallHierarchyItem[],
  reason: unknown
): CallHierarchyState => hierarchyState(root, direction, stack, { error: failureText(reason) });

/** What went wrong, as the panel prints it. */
export function failureText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export interface CallHierarchyPreviewTarget {
  relPath: string;
  line: number;
  ranges: import('monaco-editor').Range[];
  /** The open buffer for this file, when one exists: a live tab is what the
   *  preview must mirror instead of re-reading disk. */
  model: import('monaco-editor').editor.ITextModel | null;
}

/** Where a selected row's preview comes from, or null when the row points
 *  outside this project (a stale server location). */
export function callHierarchyPreviewTarget(
  item: EditorCallHierarchyItem,
  projectPath: string
): CallHierarchyPreviewTarget | null {
  let uri: import('monaco-editor').Uri;
  try {
    uri = monaco.Uri.parse(item.previewUri);
  } catch {
    return null;
  }
  const relPath = projectRelativePath(uri.fsPath, projectPath);
  if (relPath === null) return null;
  const comparable = normalizedFilePath(uri.fsPath).toLocaleLowerCase();
  return {
    relPath,
    line: item.previewRanges[0]?.startLineNumber ?? item.line,
    ranges: item.previewRanges,
    model:
      monaco.editor
        .getModels()
        .find((candidate) => normalizedFilePath(candidate.uri.fsPath).toLocaleLowerCase() === comparable) ?? null,
  };
}

export function callHierarchyPreview(
  item: EditorCallHierarchyItem,
  target: CallHierarchyPreviewTarget,
  rest: {
    content?: string;
    languageId?: string;
    ranges?: import('monaco-editor').Range[];
    loading?: boolean;
    error?: string;
  } = {}
): CallHierarchyPreview {
  return {
    itemKey: item.key,
    relPath: target.relPath,
    content: rest.content ?? '',
    languageId: rest.languageId ?? editorLanguageIdForPath(target.relPath),
    line: target.line,
    ranges: rest.ranges ?? target.ranges,
    loading: rest.loading === true,
    error: rest.error ?? '',
  };
}
