// The file editor's chrome model. ONE object feeds both modes: the side dock
// (header actions + footer) and the main tab (footer; actions live in the
// breadcrumb row).
import { useEffect, useMemo, useRef } from 'react';
import { t } from './i18n';
import { delimiterForPath, delimitedWidth, parseDelimited, type EditorViewMode } from './editor-delimited';
import type { editorViewKindForPath } from './editor-delimited';
import type { DocumentPreview } from './editor-document-model';
import type { EditorFileLoad } from './editor-file-loader';
import { openEditorFileExternally } from './editor-external-file';
import { editorLanguageLabel, type FilePreview } from './editor-pane-model';
import { explorerAbsolutePath } from './explorer-tree-model';
import { isRemoteHostRenderer } from './remote-ui-projection';
import type { SideFileChrome } from './side-surface-strip';
import { copyTextToClipboard } from './text-format';

/** Status-bar selection readout: "N selections (M characters selected)" for a
 *  multi-cursor selection, otherwise "Ln L, Col C" with the selected count. */
export function selectionStatusLabel(
  selectionStatus: { selections: number; characters: number },
  cursorPosition: { line: number; column: number }
): string {
  const selectedCharacters = selectionStatus.characters;
  let selectionLabel: string;
  if (selectionStatus.selections > 1) {
    selectionLabel = t('{{count}} selections', { count: selectionStatus.selections });
    if (selectedCharacters) selectionLabel += ` ${t('({{count}} characters selected)', { count: selectedCharacters })}`;
  } else {
    selectionLabel = t('Ln {{line}}, Col {{column}}', { line: cursorPosition.line, column: cursorPosition.column });
    if (selectedCharacters) selectionLabel += ` ${t('({{count}} selected)', { count: selectedCharacters })}`;
  }
  return selectionLabel;
}

export function useEditorSideChrome({
  api,
  projectPath,
  relPath,
  accessToken,
  load,
  preview,
  documentPreview,
  viewKind,
  viewMode,
  viewSnapshot,
  changeViewMode,
  dirty,
  saving,
  save,
  problemStatus,
  showProblems,
  selectionLabel,
  cursorPosition,
  languageId,
  formattingAvailable,
  formatDocument,
  gotoLine,
  onSideChrome,
}: {
  api: typeof window.mixdogDesktop;
  projectPath: string;
  relPath: string;
  accessToken?: string;
  load: EditorFileLoad | null;
  preview: FilePreview | null;
  documentPreview: DocumentPreview | null;
  viewKind: ReturnType<typeof editorViewKindForPath>;
  viewMode: EditorViewMode;
  viewSnapshot: string | null;
  changeViewMode(next: EditorViewMode): void;
  dirty: boolean;
  saving: boolean;
  save(): Promise<boolean>;
  problemStatus: { errors: number; warnings: number };
  showProblems(): void;
  selectionLabel: string;
  cursorPosition: { line: number; column: number };
  languageId: string;
  formattingAvailable: boolean;
  formatDocument(): void;
  gotoLine(): void;
  onSideChrome?(chrome: SideFileChrome | null): void;
}): SideFileChrome {
  const sideChromeRef = useRef({ save, changeViewMode });
  sideChromeRef.current = { save, changeViewMode };
  const sideEditable = Boolean(load && !preview && !load.binary && !load.tooLarge && !load.readOnly);
  // Text/code editor present (not an image/pdf/office preview or a binary fallback).
  const sideTextEditor = Boolean(load && !preview && !documentPreview && !load.binary && !load.tooLarge);
  const sideViewToggle =
    viewKind && load && !load.binary && !load.tooLarge && (viewKind !== 'svg' || preview) ? viewKind : null;
  const sideOpenDefault = Boolean(preview || load?.binary || load?.tooLarge);
  const tableText =
    sideViewToggle === 'table' && viewMode === 'rendered' ? (viewSnapshot ?? load?.content ?? '') : null;
  const tableSize = useMemo(() => {
    const tableDelimiter = delimiterForPath(relPath);
    if (tableText === null || !tableDelimiter) return undefined;
    const { rows } = parseDelimited(tableText, tableDelimiter);
    return { rows: Math.max(rows.length - 1, 0), columns: delimitedWidth(rows) };
  }, [tableText, relPath]);
  let viewToggle: SideFileChrome['viewToggle'];
  if (sideViewToggle) {
    viewToggle = {
      value: viewMode,
      renderedLabel: sideViewToggle === 'table' ? t('Table') : t('Preview'),
      onChange: (next) => sideChromeRef.current.changeViewMode(next),
    };
  }
  const remote = isRemoteHostRenderer();
  const fileChrome: SideFileChrome = {
    editable: sideEditable,
    dirty,
    saving,
    tableSize,
    viewToggle,
    problems: sideEditable ? { ...problemStatus, onToggle: showProblems } : undefined,
    cursor: sideTextEditor
      ? { label: selectionLabel, short: `${cursorPosition.line}:${cursorPosition.column}`, onGoto: gotoLine }
      : undefined,
    language: sideTextEditor ? editorLanguageLabel(languageId) : undefined,
    format: formattingAvailable && sideEditable ? formatDocument : undefined,
    save: () => void sideChromeRef.current.save(),
    reveal: remote ? undefined : () => void api?.revealFile?.(projectPath, relPath, accessToken),
    copyPath: remote ? () => void copyTextToClipboard(explorerAbsolutePath(projectPath, relPath)) : undefined,
    openDefault: sideOpenDefault && !remote ?() => void openEditorFileExternally(projectPath, relPath, accessToken) : undefined,
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: fileChrome is rebuilt every render; the listed primitives are its change signature, so the dock is told only when something it shows changed.
  useEffect(() => {
    if (!onSideChrome) return;
    onSideChrome(fileChrome);
  }, [
    onSideChrome,
    tableSize,
    problemStatus,
    showProblems,
    selectionLabel,
    cursorPosition.line,
    cursorPosition.column,
    sideTextEditor,
    gotoLine,
    languageId,
    formattingAvailable,
    formatDocument,
    sideEditable,
    sideViewToggle,
    sideOpenDefault,
    viewMode,
    dirty,
    saving,
    api,
    projectPath,
    relPath,
    accessToken,
  ]);
  useEffect(() => () => onSideChrome?.(null), [onSideChrome]);
  return fileChrome;
}
