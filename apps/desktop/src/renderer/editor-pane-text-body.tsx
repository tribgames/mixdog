// The text-file body of the editor pane: the rendered view (SVG, Markdown,
// table) over the Monaco surface, which stays mounted while hidden so unsaved
// edits survive the view toggle.
import { lazy, Suspense, useRef, useState, type ComponentProps, type RefObject } from 'react';
import { t } from './i18n';
import SharedEditorSurface from './SharedEditorSurface';
import { EditorOutline, useMarkdownOutline } from './editor-markdown-outline';
import { delimiterForPath, svgDataUrl, type EditorViewMode, type editorViewKindForPath } from './editor-delimited';
import type { EditorFileLoad } from './editor-file-loader';
import type { FilePreview } from './editor-pane-model';
import { EditorDelimitedTable, EditorMarkdownPreview, EditorSvgPreview } from './EditorTextViews';
import { explicitEditorLanguageIdForPath } from '../shared/editor-languages';

const RichMarkdownEditor = lazy(() => import('./rich-markdown/RichMarkdownEditor'));

export function EditorPaneTextBody({
  load,
  preview,
  previewError,
  viewKind,
  viewMode,
  richNotice,
  tocOpen,
  onViewSource,
  onRichUnsupported,
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
  onRichHeldChange,
  onMount,
  onRelease,
}: {
  load: EditorFileLoad;
  preview: FilePreview | null;
  previewError: string;
  viewKind: ReturnType<typeof editorViewKindForPath>;
  viewMode: EditorViewMode;
  /** Why Preview shows although Rich was requested ('' when it did not). */
  richNotice: string;
  tocOpen: boolean;
  onViewSource(): void;
  onRichUnsupported(reason: string): void;
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
  /** Rich holds (true) or released (false) an edit the file lacks;
   *  `heldText` reads the file as it would be with that edit. */
  onRichHeldChange?(held: boolean, heldText?: () => string | null): void;
  onMount: ComponentProps<typeof SharedEditorSurface>['onMount'];
  onRelease: ComponentProps<typeof SharedEditorSurface>['onRelease'];
}) {
  const showRendered = viewMode === 'rendered' && viewKind !== null && (viewKind !== 'svg' || Boolean(preview));
  const renderedText = viewSnapshot ?? load.content;
  const delimiter = delimiterForPath(relPath);
  // An edit Rich holds but the file does not have yet keeps Rich in view
  // (with its notice) until it is written or explicitly discarded.
  const [richHeld, setRichHeld] = useState(false);
  const showRich = (viewMode === 'rich' || richHeld) && viewKind === 'markdown';
  const markdownShown = viewKind === 'markdown' && (showRendered || showRich);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const { headings, activeId } = useMarkdownOutline(surfaceRef, markdownShown && tocOpen, !showRich);
  return (
    <>
      {richNotice && (
        <p className="editor-pane-rich-notice" role="status">
          <span>{richNotice}</span>
          <button type="button" onClick={onViewSource}>
            {t('View source')}
          </button>
        </p>
      )}
      <div className="editor-pane-body stable-surface-preserved stable-editor-surface">
        {markdownShown && (
          <div className="editor-md-layout">
            <div className="editor-md-surface" ref={surfaceRef}>
              {showRich ? (
                <Suspense fallback={null}>
                  <RichMarkdownEditor
                    modelRef={modelRef}
                    text={renderedText}
                    projectPath={projectPath}
                    relPath={relPath}
                    readOnly={false}
                    active={active}
                    onSave={onSave}
                    onOpenFile={onOpenFile}
                    onUnsupported={onRichUnsupported}
                    onHeldChange={(held, heldText) => {
                      setRichHeld(held);
                      onRichHeldChange?.(held, heldText);
                    }}
                  />
                </Suspense>
              ) : (
                <EditorMarkdownPreview
                  text={renderedText}
                  projectPath={projectPath}
                  relPath={relPath}
                  onOpenFile={onOpenFile}
                />
              )}
            </div>
            {tocOpen && <EditorOutline headings={headings} activeId={activeId} />}
          </div>
        )}
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
        <div className="editor-pane-editor-host" style={showRendered || showRich ? { display: 'none' } : undefined}>
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
    </>
  );
}
