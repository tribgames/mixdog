// Which view a file opens in. A Markdown file reopens in the mode last chosen
// for its (normalized, absolute) path, else the default-view setting; SVG opens
// rendered and tables open as source. The per-path memory is a bounded
// recency list kept in localStorage (in memory when storage is unavailable).
import type { DesktopEditorSettings } from '../shared/contract';
import type { EditorViewMode, editorViewKindForPath } from './editor-delimited';

type MarkdownDefaultView = DesktopEditorSettings['markdownDefaultView'];

export const EDITOR_VIEW_MODE_LIMIT = 200;
const MODES_KEY = 'mixdog.desktop.editor-view-modes.v1';

const MODE_OF_VIEW: Record<MarkdownDefaultView, EditorViewMode> = {
  preview: 'rendered',
  rich: 'rich',
  source: 'source',
};

function isMode(value: unknown): value is EditorViewMode {
  return value === 'rendered' || value === 'rich' || value === 'source';
}

let remembered: Map<string, EditorViewMode> | null = null;

function modes(): Map<string, EditorViewMode> {
  if (remembered) return remembered;
  remembered = new Map();
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(MODES_KEY) ?? '[]');
    if (Array.isArray(stored)) {
      for (const row of stored.slice(-EDITOR_VIEW_MODE_LIMIT)) {
        if (Array.isArray(row) && typeof row[0] === 'string' && isMode(row[1])) remembered.set(row[0], row[1]);
      }
    }
  } catch {
    // Unreadable storage starts the list empty.
  }
  return remembered;
}

export function readRememberedViewMode(path: string): EditorViewMode | null {
  return modes().get(path) ?? null;
}

/** Remembers `mode` for `path`; the least recently chosen paths beyond the
 *  bound are forgotten. */
export function rememberViewMode(path: string, mode: EditorViewMode): void {
  const map = modes();
  map.delete(path);
  map.set(path, mode);
  while (map.size > EDITOR_VIEW_MODE_LIMIT) map.delete(map.keys().next().value as string);
  try {
    window.localStorage.setItem(MODES_KEY, JSON.stringify([...map]));
  } catch {
    // The in-memory list still serves this renderer.
  }
}

/** Forgets the in-memory copy so the next read reloads storage (tests). */
export function resetViewModeMemory(): void {
  remembered = null;
}

/** The mode a file opens in when the user has not chosen one this session. */
export function initialViewMode(
  viewKind: ReturnType<typeof editorViewKindForPath>,
  path: string,
  defaultView: MarkdownDefaultView
): EditorViewMode {
  if (viewKind === 'svg') return 'rendered';
  if (viewKind !== 'markdown') return 'source';
  return readRememberedViewMode(path) ?? MODE_OF_VIEW[defaultView];
}
