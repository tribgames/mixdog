// The plain-text cover of a text file's first open: while the Monaco chunk
// loads and the editor mounts behind the pane gate, the file's own text is
// already on screen in the editor's font, line height and gutter, so the swap
// to the real editor repaints the same lines in place. It is an overlay
// (absolute inside the gate), so neither its arrival nor its removal moves
// anything in flow.
import { useEffect, useState, type CSSProperties } from 'react';
import type { DesktopEditorSettings } from '../shared/contract';
import { DEFAULT_DESKTOP_EDITOR_SETTINGS } from '../shared/editor-settings';
import { documentPreviewFormatForPath, filePreviewTypeForPath } from '../shared/file-preview';
import { editorViewKindForPath } from './editor-delimited';
import { normalizeEditorModelText, peekEditorFileLoad, resolveEditorBackup } from './editor-file-loader';
import { t } from './i18n';

/** Lines kept: a pane never shows more than this many at once. */
const PLACEHOLDER_MAX_LINES = 160;
/** Columns kept per line; the rest is off-screen in any pane. */
const PLACEHOLDER_MAX_COLUMNS = 400;

export interface EditorTextPlaceholderContent {
  lines: string[];
  lineCount: number;
  settings: DesktopEditorSettings;
}

/** Only a file that opens straight into the Monaco source view gets a text
 *  cover; previews, documents and rendered kinds (Markdown, SVG, tables) open
 *  in a different view, so a text cover would be replaced by a re-layout. */
export function editorTextPlaceholderEligible(relPath: string): boolean {
  return (
    !filePreviewTypeForPath(relPath) &&
    !documentPreviewFormatForPath(relPath) &&
    editorViewKindForPath(relPath) === null
  );
}

/** The first lines of `content` and its total line count, without splitting a
 *  large file. */
export function editorPlaceholderLines(content: string): Pick<EditorTextPlaceholderContent, 'lines' | 'lineCount'> {
  const lines: string[] = [];
  let lineCount = 1;
  let start = 0;
  for (let end = content.indexOf('\n'); end !== -1; end = content.indexOf('\n', start)) {
    if (lines.length < PLACEHOLDER_MAX_LINES) {
      const line = content.slice(start, end);
      lines.push((line.endsWith('\r') ? line.slice(0, -1) : line).slice(0, PLACEHOLDER_MAX_COLUMNS));
    }
    lineCount += 1;
    start = end + 1;
  }
  if (lines.length < PLACEHOLDER_MAX_LINES) lines.push(content.slice(start, start + PLACEHOLDER_MAX_COLUMNS));
  return { lines, lineCount };
}

function readPlaceholderContent(
  projectPath: string,
  relPath: string,
  accessToken: string | undefined,
  workspaceFile: string | undefined
): Promise<EditorTextPlaceholderContent | null> | null {
  const api = window.mixdogDesktop;
  const hydration = peekEditorFileLoad(api, projectPath, relPath, accessToken);
  if (!hydration) return null;
  const settings =
    api?.readEditorSettings && !accessToken
      ? api.readEditorSettings(projectPath, relPath, workspaceFile).catch(() => null)
      : Promise.resolve(null);
  return Promise.all([hydration, settings])
    .then(([{ file, backup }, resolved]) => {
      if (file.binary || file.tooLarge) return null;
      // The text the editor will show: a read-only file as read, else the
      // disk text or the unsaved backup that recovery restores.
      const content = file.readOnly
        ? normalizeEditorModelText(file.content)
        : resolveEditorBackup(file.content, backup).content;
      return { ...editorPlaceholderLines(content), settings: resolved ?? DEFAULT_DESKTOP_EDITOR_SETTINGS };
    })
    .catch(() => null);
}

/** Starts the file read at mount (before the editor chunk's own session can
 *  take it) and yields the cover content once it lands; null until then, and
 *  for a file that gets no text cover. `settled` turns true once the read
 *  answered (with or without a cover), or at once when there is nothing to read. */
export function useEditorTextPlaceholder(
  projectPath: string,
  relPath: string,
  accessToken: string | undefined,
  workspaceFile: string | undefined
): { eligible: boolean; content: EditorTextPlaceholderContent | null; settled: boolean } {
  const eligible = editorTextPlaceholderEligible(relPath);
  const [source] = useState(() =>
    eligible ? readPlaceholderContent(projectPath, relPath, accessToken, workspaceFile) : null
  );
  const [read, setRead] = useState<{ content: EditorTextPlaceholderContent | null } | null>(null);
  useEffect(() => {
    let live = true;
    void source?.then((next) => {
      if (live) setRead({ content: next });
    });
    return () => {
      live = false;
    };
  }, [source]);
  return { eligible, content: read?.content ?? null, settled: !source || read !== null };
}

/** Width of the line-number column in characters, as Monaco sizes it. */
function gutterChars(lineCount: number, minChars: number): number {
  return Math.max(String(lineCount).length, minChars);
}

export function EditorTextPlaceholder({
  relPath,
  content,
  side,
}: {
  relPath: string;
  content: EditorTextPlaceholderContent | null;
  /** The side dock's slim editor: no breadcrumb row, no glyph or folding margin. */
  side: boolean;
}) {
  const settings = content?.settings ?? DEFAULT_DESKTOP_EDITOR_SETTINGS;
  const style = {
    '--editor-placeholder-font': settings.fontFamily,
    '--editor-placeholder-size': `${settings.fontSize}px`,
    '--editor-placeholder-line': `${settings.lineHeight || Math.round(settings.fontSize * 1.5)}px`,
    '--editor-placeholder-tab': settings.tabSize,
    '--editor-placeholder-gutter-chars': content ? gutterChars(content.lineCount, side ? 3 : 5) : side ? 3 : 5,
  } as CSSProperties;
  return (
    <div
      className="editor-text-placeholder"
      data-side={side ? 'true' : undefined}
      style={style}
      role="status"
      aria-label={t('Loading editor…')}
    >
      {!side && (
        <div className="editor-breadcrumbs" aria-hidden="true">
          <span className="editor-breadcrumb-path">{relPath}</span>
        </div>
      )}
      <div className="editor-text-placeholder-body" aria-hidden="true">
        {content && (
          <>
            <pre className="editor-text-placeholder-gutter">
              {content.lines.map((_, index) => index + 1).join('\n')}
            </pre>
            <pre className="editor-text-placeholder-code">{content.lines.join('\n')}</pre>
          </>
        )}
      </div>
    </div>
  );
}
