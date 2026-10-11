// The file header's view controls, shared by the main tab's breadcrumb row and
// the side dock's file header: the Preview | Rich | Source segmented switch,
// the table-of-contents toggle and "Open Preview to the Side".
import { Columns2, ListTree } from 'lucide-react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { t } from './i18n';
import type { EditorViewMode } from './editor-delimited';

export interface EditorViewToggle {
  value: EditorViewMode;
  /** "Preview" (SVG, Markdown) or "Table" (CSV/TSV). */
  renderedLabel: string;
  modes: readonly EditorViewMode[];
  onChange(next: EditorViewMode): void;
}

export interface EditorViewControls {
  viewToggle?: EditorViewToggle;
  /** Markdown in Preview or Rich: the outline panel. */
  toc?: { open: boolean; onToggle(): void };
  /** Markdown in Source (main tab): the same file as a Preview in the dock. */
  sideBySide?: { onOpen(): void };
}

function editorViewModeLabel(toggle: Pick<EditorViewToggle, 'renderedLabel'>, mode: EditorViewMode): string {
  if (mode === 'rendered') return toggle.renderedLabel;
  return mode === 'rich' ? t('Rich') : t('Source');
}

/** The mode an arrow/Home/End key moves the selection to, or null. */
export function nextViewSwitchMode(
  modes: readonly EditorViewMode[],
  current: EditorViewMode,
  key: string
): EditorViewMode | null {
  const index = Math.max(0, modes.indexOf(current));
  if (key === 'ArrowRight' || key === 'ArrowDown') return modes[(index + 1) % modes.length];
  if (key === 'ArrowLeft' || key === 'ArrowUp') return modes[(index - 1 + modes.length) % modes.length];
  if (key === 'Home') return modes[0];
  if (key === 'End') return modes[modes.length - 1];
  return null;
}

export function EditorViewSwitch({ toggle }: { toggle: EditorViewToggle }) {
  // Navigate from the focused radio: the effective mode can differ from it
  // (Rich falls back to Preview) and would trap the arrows.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, focused: EditorViewMode) => {
    const next = nextViewSwitchMode(toggle.modes, focused, event.key);
    if (next === null) return;
    event.preventDefault();
    toggle.onChange(next);
    const radios = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    radios?.[toggle.modes.indexOf(next)]?.focus();
  };
  return (
    <span className="editor-view-switch" role="radiogroup" aria-label={t('View mode')}>
      {toggle.modes.map((mode) => (
        // biome-ignore lint/a11y/useSemanticElements: a segmented control of toggle buttons; aria-checked carries the selection.
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={toggle.value === mode}
          tabIndex={toggle.value === mode ? 0 : -1}
          onKeyDown={(event) => onKeyDown(event, mode)}
          onClick={() => toggle.onChange(mode)}
        >
          {editorViewModeLabel(toggle, mode)}
        </button>
      ))}
    </span>
  );
}

/** Icon buttons for the breadcrumb row's action cluster. */
export function EditorViewTools({ controls }: { controls: Pick<EditorViewControls, 'toc' | 'sideBySide'> }) {
  return (
    <>
      {controls.toc && (
        <button
          type="button"
          aria-pressed={controls.toc.open}
          aria-label={t('Table of contents')}
          data-tooltip={t('Table of contents')}
          onClick={controls.toc.onToggle}
        >
          <ListTree size={16} aria-hidden="true" />
        </button>
      )}
      {controls.sideBySide && (
        <button
          type="button"
          aria-label={t('Open Preview to the Side')}
          data-tooltip={t('Open Preview to the Side')}
          onClick={controls.sideBySide.onOpen}
        >
          <Columns2 size={16} aria-hidden="true" />
        </button>
      )}
    </>
  );
}
