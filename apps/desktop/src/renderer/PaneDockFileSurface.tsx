import type { ReactNode } from 'react';
import type { SideFileProblemsState } from './pane-side-dock-hooks';
import { PaneDockSurfaceSlot } from './pane-side-dock-surface-slot';
import { SideFileEditorSlot } from './side-file-editor-portals';
import { SideFileProblems } from './side-file-problems';
import { SideFileStatusRow, sideFileHasFooter } from './side-file-status-row';
import { sideFileKey, type PaneSideDockFile } from './side-file-tabs';
import { SideFileStrip, type SideFileChrome } from './side-surface-strip';

export function PaneDockFileSurface({
  leafId,
  files,
  heldFiles,
  onFocusPane,
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
  leadingTab,
}: {
  leadingTab?: { label: string; onSelect(): void };
  leafId: string;
  /** The open file tabs, in order. */
  files: readonly PaneSideDockFile[];
  /** Other tabs' file tabs with unsaved edits, held behind these: their
   *  editors stay, unseen (a clean held tab has none until it is in front). */
  heldFiles: readonly PaneSideDockFile[];
  /** Focuses the pane on a click inside an editor (absent while focused). */
  onFocusPane?(): void;
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
  // One editor per file tab, so unsaved edits survive a tab switch; only the
  // active tab's editor shows. The editor follows the file, not this pane
  // (side-file-editor-portals): this is only its slot.
  const frontIds = new Set(files.map(sideFileKey));
  const fileSurface = [...files, ...heldFiles.filter((file) => !frontIds.has(sideFileKey(file)))].map((file) => {
    const fileId = sideFileKey(file);
    const shown = frontIds.has(fileId) && fileId === activeFileId;
    const side = { onChrome: chromeSetter(fileId), onShowProblems: toggleFileProblems };
    return (
      <SideFileEditorSlot
        key={fileId}
        editorKey={fileId}
        slotId={`side-file-slot:${leafId}:${fileId}`}
        shown={shown}
        onFocusPane={onFocusPane}
        hidden={renderFileSurface?.(file, false, side) ?? null}
      >
        {renderFileSurface?.(file, active && shown, side) ?? null}
      </SideFileEditorSlot>
    );
  });
  const fileProblems = fileProblemsOpen && activeFile ? (renderFileProblems?.(activeFile) ?? null) : null;
  return (
    <PaneDockSurfaceSlot active={active}>
      <SideFileStrip
        files={files}
        activeKey={activeFileId}
        leadingTab={leadingTab}
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
    </PaneDockSurfaceSlot>
  );
}
