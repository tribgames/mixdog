import { Folder } from 'lucide-react';
import { type Dispatch, forwardRef, type SetStateAction, useImperativeHandle, useState } from 'react';
import type { DesktopProjectSummary } from '../shared/contract';
import { t } from './i18n';
import { HostFolderBrowser, parentHostPath } from './HostFolderBrowser';
import { desktopConnection, isSshConnectionWindow } from './desktop-connection';
import { ServerFolderDialog } from './settings/connection-dialogs';
import { isRemoteHostRenderer } from './remote-ui-projection';
import { ErrorNotice } from './ErrorNotice';
import { ExtensionDetailDialog, ExtensionField } from './settings/extension-detail';
import { displayProjectFolder } from './ProjectEditorDialog';
import './desktop/extension-dialog.css';

function listServerFolders(path: string) {
  const list = window.mixdogDesktop?.listServerDirectories;
  if (!list) return Promise.reject(new Error('Server folder listing is unavailable.'));
  return list(path);
}

/** Add-project dialog: a name and an OS-chosen folder, nothing else (user
 *  decision — the folder never comes from typed text). */
function projectAddDialog({
  addPath,
  addName,
  addError,
  addBusy,
  setAddPath,
  setAddName,
  setAddError,
  setAddBusy,
  closeAdd,
  onChooseFolder,
  onCreateProject,
  browsing,
  setBrowsing,
  browseStart,
  setServerPicking,
}: {
  browsing: boolean;
  setBrowsing(value: boolean): void;
  /** Opens the server folder dialog of an ssh window. */
  setServerPicking(value: boolean): void;
  browseStart: string;
  addPath: string;
  addName: string;
  addError: string;
  addBusy: boolean;
  setAddPath(value: string): void;
  setAddName: Dispatch<SetStateAction<string>>;
  setAddError(value: string): void;
  setAddBusy(value: boolean): void;
  closeAdd(): void;
  onChooseFolder(): Promise<string | null>;
  onCreateProject(path: string, name: string): Promise<void>;
}) {
  const acceptFolder = (selected: string) => {
    setAddPath(selected);
    setAddName((current) => (current.trim() ? current : displayProjectFolder(selected)));
    setAddError('');
  };
  return (
    <ExtensionDetailDialog
      width="compact"
      className="projects-add-dialog"
      titleId="projects-add-title"
      icon={<Folder size={16} aria-hidden="true" />}
      title={t('Add project')}
      onClose={closeAdd}
      onSubmit={(event) => {
        event.preventDefault();
        if (!addPath || addBusy) return;
        setAddBusy(true);
        setAddError('');
        void onCreateProject(addPath, addName.trim())
          .then(() => closeAdd())
          .catch((reason) => setAddError(reason instanceof Error ? reason.message : String(reason)))
          .finally(() => setAddBusy(false));
      }}
      footer={
        <>
          {addError && <ErrorNotice error={addError} />}
          <button type="button" className="secondary" disabled={addBusy} onClick={closeAdd}>
            {t('Cancel')}
          </button>
          <button type="submit" disabled={addBusy || !addPath}>
            {t('Add')}
          </button>
        </>
      }
    >
      <ExtensionField label={t('Name')} note={t('Shown in the Projects list.')}>
        <input
          name="project-name"
          value={addName}
          maxLength={120}
          // biome-ignore lint/a11y/noAutofocus: the add-project dialog opens to type the name immediately.
          autoFocus
          disabled={addBusy}
          placeholder={t('my-project')}
          onChange={(event) => setAddName(event.currentTarget.value)}
        />
      </ExtensionField>
      <ExtensionField as="div" label={t('Folder')} note={t('Folder opened for this project.')}>
        <div className="projects-folder-row">
          <code>
            <bdi>{addPath || t('No folder selected')}</bdi>
          </code>
          {/* Folder comes from a chooser only (user decision) — the OS dialog,
            or the in-app host browser on a remote surface: prefill the Name
            with the folder's basename once picked. */}
          <button
            type="button"
            className="extensions-action"
            disabled={addBusy}
            onClick={() => {
              // A server window picks on the server, not with this PC's dialog.
              if (isSshConnectionWindow()) {
                setServerPicking(true);
                return;
              }
              // A remote surface cannot show the host's OS chooser.
              if (isRemoteHostRenderer()) {
                setBrowsing(true);
                return;
              }
              void onChooseFolder().then((selected) => {
                if (selected) acceptFolder(selected);
              });
            }}
          >
            {t('Browse…')}
          </button>
        </div>
        {browsing && (
          <HostFolderBrowser
            startPath={browseStart}
            onCancel={() => setBrowsing(false)}
            onSelect={(selected) => {
              setBrowsing(false);
              acceptFolder(selected);
            }}
          />
        )}
      </ExtensionField>
    </ExtensionDetailDialog>
  );
}

export interface ProjectAddDialogHandle {
  open(): void;
}

/** The one add-project dialog, hosted outside the sidebar panels so the
 *  Projects panel and the Sessions header open the same instance; it is never
 *  closed by panel activation changes. */
export const ProjectAddDialogHost = forwardRef<
  ProjectAddDialogHandle,
  {
    projects: readonly DesktopProjectSummary[];
    onChooseFolder(): Promise<string | null>;
    onCreateProject(path: string, name: string): Promise<void>;
  }
>(function ProjectAddDialogHost({ projects, onChooseFolder, onCreateProject }, ref) {
  const [addOpen, setAddOpen] = useState(false);
  const [addPath, setAddPath] = useState('');
  const [addName, setAddName] = useState('');
  const [addError, setAddError] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [serverPicking, setServerPicking] = useState(false);
  useImperativeHandle(ref, () => ({ open: () => setAddOpen(true) }), []);
  const closeAdd = () => {
    setBrowsing(false);
    setServerPicking(false);
    setAddOpen(false);
    setAddPath('');
    setAddName('');
    setAddError('');
  };
  if (!addOpen) return null;
  return (
    <>
      {projectAddDialog({
        addPath,
        addName,
        addError,
        addBusy,
        setAddPath,
        setAddName,
        setAddError,
        setAddBusy,
        closeAdd,
        onChooseFolder,
        onCreateProject,
        browsing,
        setBrowsing,
        setServerPicking,
        browseStart: addPath || parentHostPath(projects[0]?.path ?? '') || projects[0]?.path || '',
      })}
      {/* Beside the add dialog, not inside it: its Escape and backdrop
          handling must not see the server dialog's events. */}
      {serverPicking && (
        <ServerFolderDialog
          serverName={desktopConnection()?.name ?? ''}
          list={listServerFolders}
          onClose={() => setServerPicking(false)}
          onSelect={(selected) => {
            setServerPicking(false);
            setAddPath(selected);
            setAddName((current) => (current.trim() ? current : displayProjectFolder(selected)));
            setAddError('');
          }}
        />
      )}
    </>
  );
});
