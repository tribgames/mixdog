// The text-file body of the editor pane: the rendered view (SVG, Markdown,
// table) over the Monaco surface, which stays mounted while hidden so unsaved
// edits survive the view toggle.
import type { ComponentProps, RefObject } from 'react';
import SharedEditorSurface from './SharedEditorSurface';
import { delimiterForPath, svgDataUrl, type EditorViewMode, type editorViewKindForPath } from './editor-delimited';
import type { EditorFileLoad } from './editor-file-loader';
import type { FilePreview } from './editor-pane-model';
import { EditorDelimitedTable, EditorMarkdownPreview, EditorSvgPreview } from './EditorTextViews';
import { explicitEditorLanguageIdForPath } from '../shared/editor-languages';

export function EditorPaneTextBody({
  load,
  preview,
  previewError,
  viewKind,
  viewMode,
  viewSnapshot,
  onSnapshotChange,
  projectPath,
  relPath,
  path,
  surfaceKey,
  zoomKey,
  active,
  theme,
  options,
  modelRef,
  onComplete,
  onFail,
  onOpenFile,
  onSave,
  onMount,
  onRelease,
}: {
  load: EditorFileLoad;
  preview: FilePreview | null;
  previewError: string;
  viewKind: ReturnType<typeof editorViewKindForPath>;
  viewMode: EditorViewMode;
  viewSnapshot: string | null;
  onSnapshotChange(text: string): void;
  projectPath: string;
  relPath: string;
  path: string;
  surfaceKey: string;
  zoomKey: string;
  active: boolean;
  theme: string;
  options: ComponentProps<typeof SharedEditorSurface>['options'];
  modelRef: RefObject<import('monaco-editor').editor.ITextModel | null>;
  onComplete(): void;
  onFail(): void;
  onOpenFile?(project: string, rel: string, line?: number, accessToken?: string): void;
  onSave(): void;
  onMount: ComponentProps<typeof SharedEditorSurface>['onMount'];
  onRelease: ComponentProps<typeof SharedEditorSurface>['onRelease'];
}) {
  const showRendered = viewMode === 'rendered' && viewKind !== null && (viewKind !== 'svg' || Boolean(preview));
  const renderedText = viewSnapshot ?? load.content;
  const delimiter = delimiterForPath(relPath);
  return (
    <div className="editor-pane-body stable-surface-preserved stable-editor-surface">
      {showRendered && viewKind === 'svg' && preview && (
        <EditorSvgPreview
          key={relPath}
          url={viewSnapshot === null ? preview.url : svgDataUrl(viewSnapshot)}
          name={relPath.split('/').at(-1) || relPath}
          error={previewError}
          zoomKey={zoomKey}
          onComplete={onComplete}
          onFail={onFail}
        />
      )}
      {showRendered && viewKind === 'markdown' && (
        <EditorMarkdownPreview
          text={renderedText}
          projectPath={projectPath}
          relPath={relPath}
          onOpenFile={onOpenFile}
        />
      )}
      {showRendered && viewKind === 'table' && delimiter && (
        <EditorDelimitedTable
          text={renderedText}
          delimiter={delimiter}
          modelRef={modelRef}
          readOnly={Boolean(load.readOnly)}
          onTextChange={onSnapshotChange}
          onSave={onSave}
        />
      )}
      <div className="editor-pane-editor-host" style={showRendered ? { display: 'none' } : undefined}>
        <SharedEditorSurface
          surfaceKey={surfaceKey}
          active={active}
          path={path}
          modelRef={modelRef}
          defaultLanguage={explicitEditorLanguageIdForPath(relPath)}
          defaultValue={load.content}
          theme={theme}
          options={options}
          onMount={onMount}
          onRelease={onRelease}
        />
      </div>
    </div>
  );
}
