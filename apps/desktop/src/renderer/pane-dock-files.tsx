// The pane dock's Files surface: the Search/Files rail view's explorer tree
// (FilesRootPane) under the shared DockHeaderRow — project/folder chip at the
// left; refresh, ⋯, expand and close at the right. A transcript folder link
// opens it with the folder revealed.
import { memo, useState } from 'react';
import { FilePlus, Folder, FolderPlus, ListCollapse, RefreshCw } from 'lucide-react';
import { DockHeaderRow, type DockAction } from './pane-dock-chrome';
import { FilesRootPane, type ExplorerControls } from './ExplorerTree';
import type { PaneSideDockFolder } from './pane-side-dock';
import { t } from './i18n';

const NO_CHANGED_FILES = new Set<string>();
const ignoreReadyChange = () => {};

function lastSegment(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .at(-1) || path
  );
}

/** The folder a Files surface reveals, as an explorer reveal key. */
export function paneDockFolderRevealKey(folder: Pick<PaneSideDockFolder, 'project' | 'rel'>): string {
  return folder.rel ? `file:${folder.project}:${folder.rel}` : '';
}

export const PaneDockFilesSurface = memo(function PaneDockFilesSurface({
  folder,
  active,
  onOpenFile,
  onRenameEntry,
  onClose,
}: {
  folder: PaneSideDockFolder;
  active: boolean;
  onOpenFile(project: string, rel: string, mode?: 'preview' | 'pinned'): void;
  onRenameEntry?(projectPath: string, relPath: string, newName: string): Promise<void>;
  onClose(): void;
}) {
  const [controls, setControls] = useState<ExplorerControls | null>(null);
  const label = folder.rel ? lastSegment(folder.rel) : lastSegment(folder.project);
  const actions: DockAction[] = [
    {
      id: 'refresh',
      label: t('Refresh Explorer'),
      icon: RefreshCw,
      onSelect: () => controls?.refresh(),
      disabled: !controls || controls.refreshing,
    },
    {
      id: 'new-file',
      label: t('New File…'),
      icon: FilePlus,
      menuOnly: true,
      onSelect: () => controls?.newFile(),
    },
    {
      id: 'new-folder',
      label: t('New Folder…'),
      icon: FolderPlus,
      menuOnly: true,
      onSelect: () => controls?.newFolder(),
    },
    {
      id: 'collapse-all',
      label: t('Collapse All'),
      icon: ListCollapse,
      menuOnly: true,
      onSelect: () => controls?.collapseAll(),
      disabled: !controls?.canCollapseAll,
    },
  ];
  return (
    <div className="pane-dock-files">
      <DockHeaderRow
        left={
          <div className="browser-tab is-active dock-header-chip">
            <span
              className="browser-tab-select"
              title={folder.rel ? `${folder.project}/${folder.rel}` : folder.project}
            >
              <Folder size={14} aria-hidden="true" />
              <span>{label}</span>
            </span>
          </div>
        }
        actions={actions}
        onClose={onClose}
      />
      <div className="workbench-explorer pane-dock-files-body">
        <FilesRootPane
          projectPath={folder.project}
          gitStatus={null}
          changed={NO_CHANGED_FILES}
          activeFileKey={paneDockFolderRevealKey(folder)}
          active={active}
          readinessKey={`dock-files:${folder.project}`}
          onReadyChange={ignoreReadyChange}
          onOpenFile={onOpenFile}
          onRenameEntry={onRenameEntry}
          revealDir
          revealNonce={folder.nonce}
          onControls={setControls}
        />
      </div>
    </div>
  );
});
