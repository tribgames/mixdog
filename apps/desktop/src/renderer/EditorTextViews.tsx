import { useMemo, useState } from 'react';
import { parseDelimited } from './editor-delimited';
import { t } from './i18n';
import MarkdownBody from './MarkdownBody';
import { MarkdownDocumentDirContext, MarkdownOpenFileContext, MarkdownProjectContext } from './MarkdownLink';
import { CopyControl } from './transcript-primitives';

/** SVG as an image only: its source is never injected as markup. */
export function EditorSvgPreview({
  url,
  name,
  error,
  onComplete,
  onFail,
}: {
  url: string;
  name: string;
  error: string;
  onComplete(): void;
  onFail(): void;
}) {
  // The failure belongs to the source that failed: a changed URL or snapshot
  // gets a fresh attempt.
  const [failedUrl, setFailedUrl] = useState('');
  return (
    <div className="editor-pane-preview is-image editor-svg-preview">
      {error && failedUrl === url ? (
        <p role="alert">{error}</p>
      ) : (
        <img
          src={url}
          alt={name}
          onLoad={onComplete}
          onError={() => {
            setFailedUrl(url);
            onFail();
          }}
        />
      )}
    </div>
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
  const directory = relPath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  return (
    <MarkdownProjectContext.Provider value={projectPath}>
      <MarkdownDocumentDirContext.Provider value={directory}>
        <MarkdownOpenFileContext.Provider value={onOpenFile ?? null}>
          <div className="editor-text-view editor-markdown-preview markdown">
            <MarkdownBody text={text} copyControl={CopyControl} />
          </div>
        </MarkdownOpenFileContext.Provider>
      </MarkdownDocumentDirContext.Provider>
    </MarkdownProjectContext.Provider>
  );
}

/** Read-only table of a CSV/TSV file; the first row is the header. */
export function EditorDelimitedTable({ text, delimiter }: { text: string; delimiter: string }) {
  const { rows, truncated, columnsTruncated } = useMemo(() => parseDelimited(text, delimiter), [text, delimiter]);
  const [header = [], ...body] = rows;
  const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const cells = (row: string[]) => Array.from({ length: columns }, (_, column) => row[column] ?? '');
  return (
    <div className="editor-text-view editor-table-view">
      {truncated && (
        <p className="editor-table-notice" role="status">
          {t('Showing the first {{count}} rows of this file.', { count: rows.length })}
        </p>
      )}
      {columnsTruncated && (
        <p className="editor-table-notice" role="status">
          {t('Showing the first {{count}} columns of this file.', { count: columns })}
        </p>
      )}
      <div className="editor-table-scroll">
        <table>
          <thead>
            <tr>
              {cells(header).map((cell, column) => (
                <th key={column}>{cell}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, index) => (
              <tr key={index}>
                {cells(row).map((cell, column) => (
                  <td key={column}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
