// The side file card of the per-pane dock (PaneSideDock): the file tab
// header, one mounted editor per tab, the Problems split under the editor and
// the status footer — in that DOM order. The dock owns the card's mount gate
// and the Problems/chrome state (`useSideFileProblems`), so both keep the
// dock's lifetime.
import type { ReactNode } from 'react';
import type { SideFileProblemsState } from './pane-side-dock-hooks';
import { SideFileProblems } from './side-file-problems';
import { SideFileStatusRow, sideFileHasFooter } from './side-file-status-row';
import { sideFileKey, type PaneSideDockFile } from './side-file-tabs';
import { SideFileStrip, type SideFileChrome } from './side-surface-strip';

export function PaneDockFileSurface({
  files,
  activeFile,
  active,
  problems,
  renderFileSurface,
  renderFileProblems,
  onActivateFile,
  onCloseFileTab,
  onKeepFile,
  onCloseFile,
  onClose,
  openFileTab,
}: {
  /** The open file tabs, in order. */
  files: readonly PaneSideDockFile[];
  activeFile: PaneSideDockFile | null;
  /** The file child is the dock's showing surface. */
  active: boolean;
  problems: SideFileProblemsState;
  renderFileSurface?(
    file: PaneSideDockFile,
    active: boolean,
    side: { onChrome: (chrome: SideFileChrome | null) => void; onShowProblems: () => void }
  ): ReactNode;
  renderFileProblems?(file: PaneSideDockFile): ReactNode;
  onActivateFile?(fileKey: string): void;
  onCloseFileTab?(fileKey: string): void;
  onKeepFile?(fileKey: string): void;
  onCloseFile?(): void;
  onClose(): void;
  openFileTab(project: string, rel: string, line?: number, accessToken?: string): void;
}) {
  const {
    fileChromes,
    chromeSetter,
    fileProblemsOpen,
    setFileProblemsOpen,
    fileProblemsHeight,
    setFileProblemsHeight,
    toggleFileProblems,
  } = problems;
  const activeFileId = activeFile ? sideFileKey(activeFile) : null;
  const fileChrome = activeFileId ? (fileChromes[activeFileId] ?? null) : null;
  // One mounted editor per file tab, so unsaved edits survive a tab switch;
  // only the active tab's editor shows.
  const fileSurface = files.map((file) => {
    const fileId = sideFileKey(file);
    const shown = fileId === activeFileId;
    return (
      <div key={fileId} className="pane-side-file-tab" hidden={!shown}>
        {renderFileSurface?.(file, active && shown, {
          onChrome: chromeSetter(fileId),
          onShowProblems: toggleFileProblems,
        }) ?? null}
      </div>
    );
  });
  const fileProblems = fileProblemsOpen && activeFile ? (renderFileProblems?.(activeFile) ?? null) : null;
  return (
    <div
      className="workbench-side-surface-slot"
      data-surface-active={active ? 'true' : 'false'}
      inert={active ? undefined : true}
      aria-hidden={active ? undefined : true}
    >
      <SideFileStrip
        files={files}
        activeKey={activeFileId}
        chrome={fileChrome}
        onSelect={(fileKey) => onActivateFile?.(fileKey)}
        onCloseTab={(fileKey) => (onCloseFileTab ? onCloseFileTab(fileKey) : (onCloseFile ?? onClose)())}
        onKeep={(fileKey) => onKeepFile?.(fileKey)}
        onClose={onCloseFile ?? onClose}
        onOpenInMain={() => {
          // The host's main-tab open takes the file over from this dock
          // (confirming unsaved edits), so nothing else to close here.
          if (!activeFile) return;
          openFileTab(activeFile.project, activeFile.rel, activeFile.line, activeFile.accessToken);
          // A side preview holds no editor, so the open leaves it behind.
          if (activeFile.sidePreview) onCloseFileTab?.(sideFileKey(activeFile));
        }}
      />
      <div className="pane-side-file-body">
        <div className="pane-side-file-editor">{fileSurface}</div>
        {fileProblems && (
          <SideFileProblems
            height={fileProblemsHeight}
            onHeightChange={setFileProblemsHeight}
            onClose={() => setFileProblemsOpen(false)}
          >
            {fileProblems}
          </SideFileProblems>
        )}
      </div>
      {sideFileHasFooter(fileChrome) && <SideFileStatusRow chrome={fileChrome} />}
    </div>
  );
}
