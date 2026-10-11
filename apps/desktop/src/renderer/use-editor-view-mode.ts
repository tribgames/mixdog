// Preview | Rich | Source for files that open as text but also have a rendered
// view (SVG, Markdown, CSV/TSV; Rich is Markdown only). The hidden editor and
// its unsaved edits stay mounted; the snapshot is the text the rendered view
// shows.
import { useEffect, useMemo, useState, type RefObject } from 'react';
import { t } from './i18n';
import type { DesktopEditorSettings } from '../shared/contract';
import type { EditorViewMode, editorViewKindForPath } from './editor-delimited';
import { initialViewMode, rememberViewMode } from './editor-view-mode-store';
import { richMarkdownSupport } from './rich-markdown/rich-markdown-support';

export function useEditorViewMode({
  viewKind,
  modelRef,
  loadedContent,
  contentRevision,
  modeKey,
  markdownDefaultView,
  readOnly,
}: {
  viewKind: ReturnType<typeof editorViewKindForPath>;
  modelRef: RefObject<import('monaco-editor').editor.ITextModel | null>;
  loadedContent: string | undefined;
  contentRevision: number;
  /** Normalized absolute path: the key of the remembered mode. */
  modeKey: string;
  markdownDefaultView: DesktopEditorSettings['markdownDefaultView'];
  readOnly: boolean;
}) {
  // The user's choice for this file; until then the remembered mode or the
  // default-view setting (which loads after the first render) applies.
  const [choice, setChoice] = useState<{ key: string; mode: EditorViewMode } | null>(null);
  const requestedMode = useMemo(
    () => initialViewMode(viewKind, modeKey, markdownDefaultView),
    [viewKind, modeKey, markdownDefaultView]
  );
  // Read-only files open in Preview, whatever the default or remembered Source;
  // a manual choice still wins.
  const defaultMode = readOnly && requestedMode === 'source' ? 'rendered' : requestedMode;
  const requested = choice && choice.key === modeKey ? choice.mode : defaultMode;
  const [viewSnapshot, setViewSnapshot] = useState<string | null>(null);
  // The refusal belongs to the text it was reported for.
  const [reported, setReported] = useState<{ key: string; reason: string; text: string } | null>(null);
  // Rich only mounts for text the Rich editor can round-trip; anything else
  // shows Preview with the reason. Evaluated when Rich is requested (and after
  // a reload), against the model's current text.
  // biome-ignore lint/correctness/useExhaustiveDependencies: contentRevision signals a model text replacement; the text itself is read through modelRef.
  const richBlock = useMemo(() => {
    if (requested !== 'rich') return '';
    if (readOnly) return t('Read-only files open in Preview.');
    const text = modelRef.current?.getValue() ?? loadedContent ?? '';
    if (reported?.key === modeKey && reported.text === text) return reported.reason;
    const support = richMarkdownSupport(text);
    return support.ok ? '' : support.reason;
    // viewSnapshot changes with every content edit while Preview shows.
  }, [requested, readOnly, reported, modeKey, contentRevision, viewSnapshot, modelRef, loadedContent]);
  const viewMode: EditorViewMode = requested === 'rich' && richBlock ? 'rendered' : requested;
  const richNotice = requested === 'rich' ? richBlock : '';
  // A reload or revert replaces the model text: a snapshot taken earlier must
  // follow it or the rendered view keeps showing the old file.
  // biome-ignore lint/correctness/useExhaustiveDependencies: contentRevision is the deliberate trigger; the model text it signals is read through modelRef.
  useEffect(() => {
    if (viewMode === 'source') return;
    setViewSnapshot((current) => modelRef.current?.getValue() ?? current);
  }, [contentRevision, modelRef, viewMode]);
  // Another surface showing the same file shares this model: keep the rendered
  // snapshot on the latest text so a grid never commits over stale content.
  // biome-ignore lint/correctness/useExhaustiveDependencies: contentRevision re-subscribes after a model swap, which modelRef.current cannot signal.
  useEffect(() => {
    const model = modelRef.current;
    if (viewMode !== 'rendered' || !model) return undefined;
    const listener = model.onDidChangeContent(() => setViewSnapshot(model.getValue()));
    return () => listener.dispose();
  }, [viewMode, contentRevision, modelRef]);
  const changeViewMode = (next: EditorViewMode) => {
    // Compare with the shown mode: clicking Rich while it fell back to Preview retries.
    if (next === viewMode && next === requested) return;
    if (next !== 'source') setViewSnapshot(modelRef.current?.getValue() ?? loadedContent ?? '');
    setReported(null);
    setChoice({ key: modeKey, mode: next });
    if (viewKind === 'markdown') rememberViewMode(modeKey, next);
  };
  /** The Rich editor refused the document after mounting (onUnsupported). */
  const reportRichUnsupported = (reason: string) =>
    setReported({ key: modeKey, reason, text: modelRef.current?.getValue() ?? loadedContent ?? '' });
  // Preview always shows the model's current text, also on the render that
  // follows a fallback from Rich (when no snapshot was taken yet).
  const renderedSnapshot = viewMode === 'rendered' ? (modelRef.current?.getValue() ?? viewSnapshot) : viewSnapshot;
  return {
    viewMode,
    richNotice,
    viewSnapshot: renderedSnapshot,
    setViewSnapshot,
    changeViewMode,
    reportRichUnsupported,
  };
}
