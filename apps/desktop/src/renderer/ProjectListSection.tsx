import { ChevronRight, FileText, Folder, Plus } from 'lucide-react';
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from 'react';

import type { DesktopProjectSummary } from '../shared/contract';
import { t } from './i18n';
import { ErrorNotice } from './ErrorNotice';
import { InitialSurface } from './InitialSurface';
import { SidebarPanelAction } from './session-sidebar-sections';
import { projectIdentity } from './project-catalog-cache';
import { ExtensionDetailDialog, ExtensionField } from './settings/extension-detail';
import { useSidebarPanelDismiss } from './sidebar-panel-surface';
import './desktop/extension-dialog.css';
import { publishSidebarProjects } from './sidebar-reference-cache';
import { usePersistedListOrder } from './use-persisted-list-order';
import { displayProjectFolder, ProjectEditorDialog, type ProjectEditorDialogHandle } from './ProjectEditorDialog';

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
}: {
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
          <code>{addPath || t('No folder selected')}</code>
          {/* Folder comes from the OS chooser only (user decision):
            prefill the Name with the folder's basename once picked. */}
          <button
            type="button"
            className="extensions-action"
            disabled={addBusy}
            onClick={() =>
              void onChooseFolder().then((selected) => {
                if (!selected) return;
                setAddPath(selected);
                setAddName((current) => (current.trim() ? current : displayProjectFolder(selected)));
                setAddError('');
              })
            }
          >
            {t('Browse…')}
          </button>
        </div>
      </ExtensionField>
    </ExtensionDetailDialog>
  );
}

export interface ProjectListSectionProps {
  active?: boolean;
  projects: DesktopProjectSummary[];
  projectsReady?: boolean;
  selectedProjectPath: string;
  onChooseFolder(): Promise<string | null>;
  onCreateProject(path: string, name: string): Promise<void>;
  onRename(path: string, alias: string): void;
  onRemove(path: string): void;
  onMemoryControl?(input: Record<string, unknown>): Promise<unknown>;
}

// Project list (Projects panel → Project tab): the Schedules grammar — a
// compact list with per-row actions hosted in the session-panel area (user
// decision — no main-pane takeover). Add project opens a small popup dialog
// (Name + folder via the native chooser) portaled above the workspace. The
// hosting ProjectsPane owns the surface wrapper and the section toolbar.
export function ProjectListSection({
  active = true,
  projects,
  projectsReady = true,
  selectedProjectPath,
  onChooseFolder,
  onCreateProject,
  onRename,
  onRemove,
  onMemoryControl,
}: ProjectListSectionProps) {
  const [addOpen, setAddOpen] = useState(false);
  const [addPath, setAddPath] = useState('');
  const [addName, setAddName] = useState('');
  const [addError, setAddError] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const editorRef = useRef<ProjectEditorDialogHandle>(null);
  // The app shell owns project add/rename/remove and refetches its catalog
  // once a mutation actually succeeded. Mirroring THAT list into the shared
  // sidebar cache is the authoritative completion boundary: a failed mutation
  // never changes the list, so it never triggers a refresh either.
  useEffect(() => {
    publishSidebarProjects(projects);
  }, [projects]);
  const projectPathsKey = JSON.stringify(projects.map((project) => project.path));
  const memoriesSupported = Boolean(onMemoryControl);
  // One shared catalog request warms every row, including empty projects.
  // biome-ignore lint/correctness/useExhaustiveDependencies: projectPathsKey is a deliberate restart trigger; the read itself goes through the editor handle.
  useEffect(() => {
    if (!active || !memoriesSupported) return;
    editorRef.current?.warm();
  }, [active, projectPathsKey, memoriesSupported]);
  const closeAdd = () => {
    setAddOpen(false);
    setAddPath('');
    setAddName('');
    setAddError('');
  };
  // Hidden panel, no body portal: collapsing the sidebar or presenting another
  // destination closes the add dialog; the editor dialog dismisses itself.
  useSidebarPanelDismiss(active, closeAdd);
  // No search field (user: 프로젝트 목록은 짧다 — 서치창 제거).
  const projectOrder = usePersistedListOrder(
    'mixdog.sidebar-order.projects.v1',
    projects.map((project) => project.path)
  );
  const visible = projectOrder.orderedIds
    .map((path) => projects.find((project) => project.path === path))
    .filter((project): project is DesktopProjectSummary => Boolean(project));

  return (
    <>
      {/* The panel header names this view and hosts its action (user: 타이틀
          이 2번 나옴). */}
      {/* Plain + like every other rail panel action (user: 프로젝트도 + 통일). */}
      <SidebarPanelAction
        active={active}
        label={t('Add project')}
        icon={Plus}
        className="projects-add"
        onClick={() => setAddOpen(true)}
      />
      {/* Both dialogs ride the Extensions card (user: 이쪽도 레이아웃 맞춰):
          identity plate + title, the body on the section rhythm, the footer
          ladder with the destructive action parked left. */}
      {active &&
        addOpen &&
        projectAddDialog({
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
        })}
      <ProjectEditorDialog
        ref={editorRef}
        active={active}
        projects={projects}
        onRename={onRename}
        onRemove={onRemove}
        onMemoryControl={onMemoryControl}
      />
      {onMemoryControl && (
        <div className="schedules-list projects-list projects-common-instructions">
          <button
            type="button"
            className="schedules-row utilities-row projects-row"
            data-tooltip={t('Used for every project.')}
            onClick={() => editorRef.current?.open(null)}
          >
            <span className="sidebar-resource-icon" aria-hidden="true">
              <FileText size={16} />
            </span>
            <span className="schedules-row-copy utilities-row-copy">
              <b>{t('Common Memory')}</b>
              <small>{t('Used for every project.')}</small>
            </span>
            <ChevronRight className="utilities-row-chevron" size={16} aria-hidden="true" />
          </button>
        </div>
      )}
      {!projectsReady && projects.length === 0 && <InitialSurface />}
      {(projectsReady || projects.length > 0) && visible.length > 0 && (
        <div className="schedules-list projects-list">
          {visible.map((project) => {
            const title = project.alias?.trim() || project.name?.trim() || displayProjectFolder(project.path);
            const selected = projectIdentity(selectedProjectPath) === projectIdentity(project.path);
            return (
              <button
                type="button"
                key={project.path}
                className={`schedules-row utilities-row projects-row${selected ? ' selected' : ''}`}
                aria-current={selected ? 'page' : undefined}
                aria-label={t('Edit {{name}}', { name: title })}
                data-tooltip={project.path}
                onClick={() => editorRef.current?.open(project.path)}
                {...projectOrder.getReorderProps(project.path)}
              >
                <span className="sidebar-resource-icon" aria-hidden="true">
                  <Folder size={16} />
                </span>
                <span className="schedules-row-copy utilities-row-copy projects-row-label">
                  <b>{title}</b>
                  <small>{project.path}</small>
                </span>
                <ChevronRight className="utilities-row-chevron" size={16} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      )}
      {(projectsReady || projects.length > 0) && visible.length === 0 && (
        <div className="schedules-empty">
          <Folder size={40} aria-hidden="true" />
          <p>
            {projects.length
              ? t('No projects match the current search.')
              : t('No projects yet. Add a folder to make it available in Mixdog.')}
          </p>
        </div>
      )}
    </>
  );
}
