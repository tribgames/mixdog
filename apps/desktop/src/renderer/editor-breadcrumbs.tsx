import { ExternalLink, FolderOpen, Save, Undo2 } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMobileBack } from './mobile-back';
import type { EditorFileLoad } from './editor-file-loader';
import type { EditorOutlineItem } from './editor-language-store';
import { normalizedFilePath } from './editor-lsp-conversion';
import { t } from './i18n';
import { wrappedNavigationIndex } from './list-navigation';
import {
  breadcrumbPickerAnchor,
  type BreadcrumbFileItem,
  type BreadcrumbPickerAnchor,
  type BreadcrumbPickerState,
  type FilePreview,
} from './editor-pane-model';
import { openEditorFileExternally } from './editor-external-file';
import { BreadcrumbPicker, BreadcrumbTrail } from './editor-breadcrumb-parts';
import { DockOverflowMenu, type DockAction } from './pane-dock-chrome';
import { explorerAbsolutePath } from './explorer-tree-model';
import { isRemoteHostRenderer } from './remote-ui-projection';
import { copyTextToClipboard } from './text-format';

/** Same grammar as the side header: Save is the only inline button (while
 *  dirty); everything else is a ⋯ item. */
function breadcrumbMoreActions({
  api,
  projectPath,
  relPath,
  accessToken,
  showOpenDefault,
  showRevert,
  revertDisabled,
  menuActions,
  onRevert,
}: {
  api: typeof window.mixdogDesktop;
  projectPath: string;
  relPath: string;
  accessToken?: string;
  showOpenDefault: boolean;
  showRevert: boolean;
  revertDisabled: boolean;
  menuActions: readonly DockAction[];
  onRevert(): void;
}): DockAction[] {
  const moreActions: DockAction[] = [];
  const remote = isRemoteHostRenderer();
  if (!remote && showOpenDefault) {
    moreActions.push({
      id: 'open-default',
      label: t('Open in default app'),
      icon: ExternalLink,
      onSelect: () => void openEditorFileExternally(projectPath, relPath, accessToken),
    });
  }
  moreActions.push(
    remote
      ? {
          id: 'copy-path',
          label: t('Copy path'),
          icon: FolderOpen,
          onSelect: () => void copyTextToClipboard(explorerAbsolutePath(projectPath, relPath)),
        }
      : {
          id: 'reveal',
          label: t('Reveal in Explorer'),
          icon: FolderOpen,
          onSelect: () => void api?.revealFile?.(projectPath, relPath, accessToken),
        }
  );
  if (showRevert) {
    moreActions.push({
      id: 'revert',
      label: t('Revert File'),
      icon: Undo2,
      disabled: revertDisabled,
      onSelect: onRevert,
    });
  }
  moreActions.push(...menuActions);
  return moreActions;
}

export function EditorBreadcrumbs({
  projectPath,
  relPath,
  accessToken,
  load,
  preview,
  dirty,
  saving,
  reverting,
  cursorLine,
  outline,
  menuActions = [],
  onSave,
  onRevert,
  onOpenAt,
  onFocusEditor,
  onRevealSymbol,
}: {
  projectPath: string;
  relPath: string;
  accessToken?: string;
  load: EditorFileLoad | null;
  preview: FilePreview | null;
  dirty: boolean;
  saving: boolean;
  reverting: boolean;
  cursorLine: number;
  outline: EditorOutlineItem[];
  /** Extra ⋯ entries (Format Document…), after Reveal / Open in default app. */
  menuActions?: readonly DockAction[];
  onSave(): void;
  onRevert(): void;
  onOpenAt?(relPath: string, line: number): void;
  onFocusEditor(): void;
  onRevealSymbol(item: EditorOutlineItem): void;
}) {
  const api = window.mixdogDesktop;
  const [picker, setPicker] = useState<BreadcrumbPickerState | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const pickerGeneration = useRef(0);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const segments = relPath.replace(/\\/g, '/').split('/').filter(Boolean);
  const byLevel = new Map<number, EditorOutlineItem>();
  const containing = outline
    .filter((item) => item.line <= cursorLine && (item.endLine ?? item.line) >= cursorLine)
    .sort((left, right) => left.level - right.level || left.line - right.line);
  for (const item of containing) byLevel.set(item.level, item);
  const symbols = [...byLevel.values()];
  const symbol = symbols[symbols.length - 1];
  const editable = Boolean(load && !preview && !load.binary && !load.tooLarge && !load.readOnly);
  const moreActions = breadcrumbMoreActions({
    api,
    projectPath,
    relPath,
    accessToken,
    showOpenDefault: Boolean(preview || load?.binary || load?.tooLarge),
    showRevert: editable && dirty,
    revertDisabled: saving || reverting,
    menuActions,
    onRevert,
  });

  const closePicker = useCallback(
    (restoreFocus = false) => {
      const sourceIndex = picker?.anchor.sourceIndex ?? focusIndex;
      setPicker(null);
      if (restoreFocus) {
        window.requestAnimationFrame(() => buttonRefs.current[sourceIndex]?.focus());
      }
    },
    [focusIndex, picker?.anchor.sourceIndex]
  );
  useMobileBack(Boolean(picker), () => closePicker(true));

  // biome-ignore lint/correctness/useExhaustiveDependencies: api is the window bridge, re-read each render and kept as a dependency so a re-installed bridge re-creates this callback.
  const showFiles = useCallback(
    (anchor: BreadcrumbPickerAnchor, directory: string, selectedRelPath: string) => {
      const list = api?.listProjectDir;
      if (!list || accessToken) return;
      const generation = ++pickerGeneration.current;
      setPicker({
        kind: 'files',
        anchor,
        directory,
        selectedRelPath,
        rows: [],
        activeIndex: 0,
        loading: true,
        error: '',
      });
      void list(projectPath, directory)
        .then((entries) => {
          if (generation !== pickerGeneration.current) return;
          const rows = entries.map((entry) => ({
            ...entry,
            relPath: [directory, entry.name].filter(Boolean).join('/'),
          }));
          const selectedIndex = Math.max(
            0,
            rows.findIndex(
              (row) =>
                normalizedFilePath(row.relPath).toLocaleLowerCase() ===
                normalizedFilePath(selectedRelPath).toLocaleLowerCase()
            )
          );
          setPicker((current) =>
            current?.kind === 'files'
              ? { ...current, rows, activeIndex: selectedIndex, loading: false, error: '' }
              : current
          );
        })
        .catch((reason) => {
          if (generation !== pickerGeneration.current) return;
          const error = reason instanceof Error ? reason.message : String(reason);
          setPicker((current) =>
            current?.kind === 'files' ? { ...current, rows: [], activeIndex: 0, loading: false, error } : current
          );
        });
    },
    [accessToken, api, projectPath]
  );

  const showParentFolder = useCallback(
    (files: Extract<BreadcrumbPickerState, { kind: 'files' }>) => {
      const parent = files.directory.split('/').slice(0, -1).join('/');
      showFiles(files.anchor, parent, files.directory);
    },
    [showFiles]
  );

  const openPath = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>, index: number) => {
      setFocusIndex(index);
      const anchor = breadcrumbPickerAnchor(event.currentTarget, index);
      const isFile = index === segments.length - 1;
      const directory = isFile ? segments.slice(0, -1).join('/') : segments.slice(0, index + 1).join('/');
      const selectedRelPath = isFile ? segments.join('/') : segments.slice(0, index + 2).join('/');
      showFiles(anchor, directory, selectedRelPath);
    },
    [segments, showFiles]
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: only the active symbol's key is read, so keying on it avoids a new callback when the outline is re-published with equal symbols.
  const openSymbol = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>, sourceIndex: number, selected?: EditorOutlineItem) => {
      setFocusIndex(sourceIndex);
      const rows = outline.slice().sort((left, right) => left.line - right.line || left.level - right.level);
      const activeIndex = Math.max(
        0,
        rows.findIndex((row) => row.key === (selected ?? symbol)?.key)
      );
      setPicker({
        kind: 'symbols',
        anchor: breadcrumbPickerAnchor(event.currentTarget, sourceIndex),
        rows,
        activeIndex,
      });
    },
    [outline, symbol?.key]
  );

  const openFile = useCallback(
    (item: BreadcrumbFileItem) => {
      if (item.dir) {
        if (picker?.kind === 'files') showFiles(picker.anchor, item.relPath, '');
        return;
      }
      setPicker(null);
      if (normalizedFilePath(item.relPath).toLocaleLowerCase() === normalizedFilePath(relPath).toLocaleLowerCase()) {
        onFocusEditor();
        return;
      }
      onOpenAt?.(item.relPath, 1);
    },
    [onFocusEditor, onOpenAt, picker, relPath, showFiles]
  );

  const activateRow = useCallback((index: number) => {
    setPicker((current) => (current ? ({ ...current, activeIndex: index } as BreadcrumbPickerState) : current));
  }, []);

  const focusRow = useCallback(
    (index: number) => {
      activateRow(index);
      window.requestAnimationFrame(() => rowRefs.current[index]?.focus());
    },
    [activateRow]
  );

  const handlePickerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!picker) return;
      const count = picker.rows.length;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closePicker(true);
        return;
      }
      if (picker.kind === 'files' && event.key === 'ArrowLeft' && picker.directory) {
        event.preventDefault();
        showParentFolder(picker);
        return;
      }
      if (!count) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        const next = wrappedNavigationIndex(event.key, picker.activeIndex, count, event.key === 'ArrowDown' ? 1 : -1);
        focusRow(next);
        return;
      }
      if (
        event.key === 'Enter' ||
        event.key === ' ' ||
        (event.key === 'ArrowRight' && picker.kind === 'files' && picker.rows[picker.activeIndex]?.dir)
      ) {
        event.preventDefault();
        rowRefs.current[picker.activeIndex]?.click();
      }
    },
    [closePicker, focusRow, picker, showParentFolder]
  );

  // Focus the active row when the picker opens, changes directory or finishes
  // loading - not on every activeIndex change, or hovering would steal focus.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the dependency list is the deliberate set of open/directory/loading triggers.
  useEffect(() => {
    if (!picker || (picker.kind === 'files' && picker.loading)) return;
    window.requestAnimationFrame(() => rowRefs.current[picker.activeIndex]?.focus());
  }, [
    picker?.kind,
    picker?.kind === 'files' ? picker.directory : '',
    picker?.kind === 'files' ? picker.loading : false,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the listener is armed once per open picker (keyed on its presence); it only reads refs and calls setPicker.
  useEffect(() => {
    if (!picker) return undefined;
    const dismiss = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (
        target &&
        (pickerRef.current?.contains(target) || buttonRefs.current.some((button) => button?.contains(target)))
      )
        return;
      setPicker(null);
    };
    window.addEventListener('pointerdown', dismiss, true);
    return () => window.removeEventListener('pointerdown', dismiss, true);
  }, [Boolean(picker)]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if ((event.target as HTMLElement).closest('.editor-breadcrumb-actions')) return;
      const count = segments.length + symbols.length;
      if (!count) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        setPicker(null);
        onFocusEditor();
        return;
      }
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End')
        return;
      event.preventDefault();
      const next = wrappedNavigationIndex(event.key, focusIndex, count, event.key === 'ArrowRight' ? 1 : -1);
      setFocusIndex(next);
      buttonRefs.current[next]?.focus();
    },
    [focusIndex, onFocusEditor, segments.length, symbols.length]
  );

  const portal = picker && (
    <BreadcrumbPicker
      picker={picker}
      projectPath={projectPath}
      pickerRef={pickerRef}
      rowRefs={rowRefs}
      onKeyDown={handlePickerKeyDown}
      onParentFolder={() => {
        if (picker.kind === 'files') showParentFolder(picker);
      }}
      onActivateRow={activateRow}
      onPickFile={openFile}
      onPickSymbol={(item) => {
        setPicker(null);
        onRevealSymbol(item);
      }}
    />
  );

  return (
    <>
      <nav className="editor-breadcrumbs" aria-label={t('Breadcrumbs')} onKeyDown={handleKeyDown}>
        <BreadcrumbTrail
          segments={segments}
          symbols={symbols}
          picker={picker}
          focusIndex={focusIndex}
          accessToken={accessToken}
          buttonRefs={buttonRefs}
          onFocusItem={setFocusIndex}
          onOpenPath={openPath}
          onOpenSymbol={openSymbol}
        />
        <span className="editor-breadcrumb-actions">
          {editable && dirty && (
            <button
              type="button"
              disabled={saving || reverting}
              onClick={onSave}
              aria-label={t('Save')}
              data-tooltip={t('Save (Ctrl+S)')}
            >
              <Save size={16} aria-hidden="true" />
            </button>
          )}
          <DockOverflowMenu items={moreActions} />
        </span>
      </nav>
      {portal}
    </>
  );
}
