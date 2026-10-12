import { useState, type ComponentProps, type MouseEvent } from 'react';
import { EditorDelimitedGrid } from './editor-delimited-grid';
import { headingForAnchor, readHeadings, scrollToHeading } from './editor-markdown-outline';
import MarkdownBody from './MarkdownBody';
import { MarkdownDocumentDirContext, MarkdownOpenFileContext, MarkdownProjectContext } from './MarkdownLink';
import { documentDirectory } from './rich-markdown/rich-markdown-links';
import { CopyControl } from './transcript-primitives';
import { ZoomFrame, ZoomImage, useImageSize } from './ZoomFrame';

/** SVG as an image only: its source is never injected as markup. */
export function EditorSvgPreview({
  url,
  name,
  error,
  zoomKey,
  onComplete,
  onFail,
}: {
  url: string;
  name: string;
  error: string;
  /** Remembers the zoom while this file stays open in its surface. */
  zoomKey?: string;
  onComplete(): void;
  onFail(): void;
}) {
  // The failure belongs to the source that failed: a changed URL or snapshot
  // gets a fresh attempt.
  const [failedUrl, setFailedUrl] = useState('');
  const [loadedUrl, setLoadedUrl] = useState('');
  const { natural, onNatural } = useImageSize(url);
  return (
    <ZoomFrame
      ready={loadedUrl === url && !(error && failedUrl === url)}
      intrinsicWidth={natural?.width}
      intrinsicHeight={natural?.height}
      memoryKey={zoomKey}
      clickToggle
      scrollerClassName="editor-pane-preview is-image editor-svg-preview"
    >
      {({ scale }) =>
        error && failedUrl === url ? (
          <p role="alert">{error}</p>
        ) : (
          <ZoomImage
            src={url}
            alt={name}
            natural={natural}
            scale={scale}
            onNatural={onNatural}
            onLoad={() => {
              setLoadedUrl(url);
              onComplete();
            }}
            onError={() => {
              setFailedUrl(url);
              onFail();
            }}
          />
        )
      }
    </ZoomFrame>
  );
}

/** Read-only rendered Markdown through the transcript pipeline (raw HTML stays
 *  text). Relative images and links resolve against the file's own folder. */
export function EditorMarkdownPreview({
  text,
  projectPath,
  relPath,
  onOpenFile,
}: {
  text: string;
  projectPath: string;
  relPath: string;
  onOpenFile?(project: string, rel: string, line?: number): void;
}) {
  const directory = documentDirectory(relPath);
  // `#anchor` links scroll inside the preview (never navigate the renderer);
  // relative file links keep going through MarkdownLink → onOpenFile.
  const followAnchor = (event: MouseEvent<HTMLDivElement>) => {
    const link = event.target instanceof Element ? event.target.closest('a') : null;
    const href = link?.getAttribute('href') ?? '';
    if (!link || !href.startsWith('#') || event.button !== 0) return;
    event.preventDefault();
    const target = headingForAnchor(readHeadings(event.currentTarget, true), href.slice(1));
    if (target) scrollToHeading(target);
  };
  return (
    <MarkdownProjectContext.Provider value={projectPath}>
      <MarkdownDocumentDirContext.Provider value={directory}>
        <MarkdownOpenFileContext.Provider value={onOpenFile ?? null}>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: delegated handler for the rendered anchors, which are real focusable links with their own keyboard activation. */}
          <div className="editor-text-view editor-markdown-preview markdown" onClick={followAnchor}>
            <MarkdownBody text={text} copyControl={CopyControl} />
          </div>
        </MarkdownOpenFileContext.Provider>
      </MarkdownDocumentDirContext.Provider>
    </MarkdownProjectContext.Provider>
  );
}

/** Editable table of a CSV/TSV file (see editor-delimited-grid.tsx). */
export function EditorDelimitedTable(props: ComponentProps<typeof EditorDelimitedGrid>) {
  return <EditorDelimitedGrid {...props} />;
}
