// Source/rendered toggle for files that open as text but also have a rendered
// view (SVG, Markdown, CSV/TSV). The hidden editor and its unsaved edits stay
// mounted; the snapshot is the text the rendered view shows.
import { useEffect, useState, type RefObject } from 'react';
import type { EditorViewMode, editorViewKindForPath } from './editor-delimited';

export function useEditorViewMode({
  viewKind,
  modelRef,
  loadedContent,
  contentRevision,
}: {
  viewKind: ReturnType<typeof editorViewKindForPath>;
  modelRef: RefObject<import('monaco-editor').editor.ITextModel | null>;
  loadedContent: string | undefined;
  contentRevision: number;
}) {
  const [viewMode, setViewMode] = useState<EditorViewMode>(viewKind === 'svg' ? 'rendered' : 'source');
  const [viewSnapshot, setViewSnapshot] = useState<string | null>(null);
  // A reload or revert replaces the model text: a snapshot taken earlier must
  // follow it or the rendered view keeps showing the old file.
  // biome-ignore lint/correctness/useExhaustiveDependencies: contentRevision is the deliberate trigger; the model text it signals is read through modelRef.
  useEffect(() => {
    if (viewMode !== 'rendered') return;
    setViewSnapshot((current) => (current === null ? current : (modelRef.current?.getValue() ?? current)));
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
    if (next === viewMode) return;
    if (next === 'rendered') setViewSnapshot(modelRef.current?.getValue() ?? loadedContent ?? '');
    setViewMode(next);
  };
  return { viewMode, viewSnapshot, setViewSnapshot, changeViewMode };
}
