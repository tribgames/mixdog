// "Open Preview to the Side": a read-only rendered view of a Markdown file in
// the side dock. It mounts NO editor and no file session: the main tab's
// editor and this view address the same Monaco model by path URI, so the
// preview follows unsaved edits live. With no open model (the tab was closed)
// it shows the file as saved on disk.
import { useEffect, useRef, useState } from 'react';
import { EditorMarkdownPreview } from './EditorTextViews';
import { EditorOutline, useMarkdownOutline } from './editor-markdown-outline';
import { startEditorDiskWatch } from './editor-disk-watch';
import { errorMessage } from './editor-pane-session-errors';
import { monaco } from './monaco-setup';
import type { SideFileChrome } from './side-surface-strip';

export default function EditorSideMarkdownPreview({
  projectPath,
  relPath,
  accessToken,
  onSideChrome,
  onOpenFile,
}: {
  projectPath: string;
  relPath: string;
  accessToken?: string;
  onSideChrome(chrome: SideFileChrome | null): void;
  onOpenFile?(project: string, rel: string, line?: number): void;
}) {
  const abs = `${projectPath.replace(/[\\/]+$/, '')}/${relPath}`;
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [tocOpen, setTocOpen] = useState(false);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const { headings, activeId } = useMarkdownOutline(surfaceRef, tocOpen, true);

  useEffect(() => {
    const uri = monaco.Uri.parse(abs);
    let content: { dispose(): void } | null = null;
    let disposal: { dispose(): void } | null = null;
    let stopWatch: (() => void) | null = null;
    let diskMtime = -1;
    let live = true;
    const api = window.mixdogDesktop;
    // No open model: show the file as saved, and keep following the disk.
    // Bumped whenever the disk-following session ends, so late responses are ignored.
    let epoch = 0;
    const readDisk = (mine: number) =>
      api
        ?.readProjectFile?.(projectPath, relPath, accessToken)
        .then((file) => {
          if (!live || mine !== epoch || monaco.editor.getModel(uri)) return;
          diskMtime = file.mtimeMs;
          setError('');
          setText(file.content);
        })
        .catch((reason) => {
          if (live && mine === epoch && !monaco.editor.getModel(uri)) setError(errorMessage(reason));
        });
    const followDisk = () => {
      stopWatch?.();
      const mine = ++epoch;
      // Single-flight: a tick is skipped while a read or stat is still pending.
      let busy = true;
      void Promise.resolve(readDisk(mine)).finally(() => {
        busy = false;
      });
      stopWatch = startEditorDiskWatch(window, () => {
        if (busy) return;
        busy = true;
        void Promise.resolve(
          api
            ?.statProjectFile?.(projectPath, relPath, accessToken)
            .then((info) => {
              if (live && mine === epoch && info.mtimeMs !== diskMtime) return readDisk(mine);
            })
            .catch((reason) => {
              if (live && mine === epoch && !monaco.editor.getModel(uri)) setError(errorMessage(reason));
            })
        ).finally(() => {
          busy = false;
        });
      });
    };
    const follow = (model: import('monaco-editor').editor.ITextModel) => {
      epoch += 1;
      content?.dispose();
      disposal?.dispose();
      stopWatch?.();
      stopWatch = null;
      setError('');
      setText(model.getValue());
      content = model.onDidChangeContent(() => setText(model.getValue()));
      // The main tab closed (possibly discarding edits): fall back to the disk.
      disposal = model.onWillDispose(() => {
        content?.dispose();
        content = null;
        followDisk();
      });
    };
    const existing = monaco.editor.getModel(uri);
    if (existing) follow(existing);
    else followDisk();
    // The main tab's model may be created after this view.
    const created = monaco.editor.onDidCreateModel((model) => {
      if (model.uri.toString() === uri.toString()) follow(model);
    });
    return () => {
      live = false;
      epoch += 1;
      content?.dispose();
      disposal?.dispose();
      stopWatch?.();
      created.dispose();
    };
  }, [abs, projectPath, relPath, accessToken]);

  useEffect(() => {
    onSideChrome({
      editable: false,
      dirty: false,
      saving: false,
      save() {},
      toc: { open: tocOpen, onToggle: () => setTocOpen((open) => !open) },
      reveal: () => void window.mixdogDesktop?.revealFile?.(projectPath, relPath, accessToken),
    });
  }, [onSideChrome, tocOpen, projectPath, relPath, accessToken]);
  useEffect(() => () => onSideChrome(null), [onSideChrome]);

  return (
    <div className="editor-pane">
      <div className="editor-pane-body">
        <div className="editor-md-layout">
          <div className="editor-md-surface" ref={surfaceRef}>
            {error ? (
              <div className="editor-pane-notice" role="alert">
                {error}
              </div>
            ) : (
              <EditorMarkdownPreview text={text} projectPath={projectPath} relPath={relPath} onOpenFile={onOpenFile} />
            )}
          </div>
          {tocOpen && <EditorOutline headings={headings} activeId={activeId} />}
        </div>
      </div>
    </div>
  );
}
