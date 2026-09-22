import { ChevronRight, FileText, Folder, Plus } from 'lucide-react';
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from 'react';

import type { DesktopProjectSummary } from '../shared/contract';
import { t } from './i18n';
import { ErrorNotice } from './ErrorNotice';
import { InitialSurface } from './InitialSurface';
import { projectIdentity, SidebarPanelAction } from './session-sidebar';
import { ExtensionDetailDialog, ExtensionField, ExtensionSection } from './settings/extension-detail';
import { useSidebarPanelDismiss } from './sidebar-panel-surface';
import './desktop/extension-dialog.css';
import { publishSidebarProjects } from './sidebar-reference-cache';
import { usePersistedListOrder } from './use-persisted-list-order';
import {
  ProjectEditorCache,
  memoryResultError,
  readProjectMemories,
  type CoreMemoryEntry,
  type ProjectMemoryCatalog,
} from './project-editor-data';

function displayProjectFolder(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .at(-1) || path
  );
}

type ProjectEditTarget = { path: string | null; title: string };
type MemoryControl = (input: Record<string, unknown>) => Promise<unknown>;

/** Memory address: the common store has no project, every other memory is
 *  addressed by its project folder. */
function memoryScope(path: string | null) {
  return path === null ? { project_id: 'common' } : { cwd: path };
}

/** Scope picker shared by the add row and every saved row: Common plus one
 *  option per project. */
function memoryScopeSelect({
  value,
  disabled,
  projects,
  onChange,
}: {
  value: string;
  disabled: boolean;
  projects: DesktopProjectSummary[];
  onChange(value: string): void;
}) {
  return (
    <label>
      {t('Scope')}
      <select
        aria-label={t('Memory scope')}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{t('Common')}</option>
        {projects.map((project) => (
          <option key={project.path} value={project.path}>
            {project.alias || project.name || displayProjectFolder(project.path)}
          </option>
        ))}
      </select>
    </label>
  );
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

/** Footer ladder of the edit dialog. Memories save per row, so the common
 *  editor only closes; Save exists for the project alias alone and Remove is
 *  the destructive action parked left, behind its own confirm. */
function projectEditFooter({
  editTarget,
  editError,
  editBusy,
  memoryBusy,
  memoriesLoading,
  addingMemory,
  editConfirmRemove,
  setEditConfirmRemove,
  resetEdit,
  closeEdit,
  onRemove,
}: {
  editTarget: ProjectEditTarget;
  editError: string;
  editBusy: boolean;
  memoryBusy: boolean;
  memoriesLoading: boolean;
  addingMemory: boolean;
  editConfirmRemove: boolean;
  setEditConfirmRemove(value: boolean): void;
  resetEdit(): void;
  closeEdit(): void;
  onRemove(path: string): void;
}) {
  return (
    <>
      {editError && <ErrorNotice error={editError} />}
      {editTarget.path === null && (
        <button type="button" className="secondary" disabled={memoryBusy} onClick={closeEdit}>
          {t('Close')}
        </button>
      )}
      {editTarget.path !== null && (
        <>
          <button
            type="button"
            className="danger"
            disabled={editBusy || memoryBusy}
            onClick={() => {
              if (!editConfirmRemove) {
                setEditConfirmRemove(true);
                return;
              }
              const path = editTarget.path;
              if (path === null) return;
              resetEdit();
              onRemove(path);
            }}
          >
            {editConfirmRemove ? t('Confirm remove') : t('Remove')}
          </button>
          <button type="button" className="secondary" disabled={editBusy || memoryBusy} onClick={closeEdit}>
            {t('Cancel')}
          </button>
          <button type="submit" disabled={editBusy || memoriesLoading || memoryBusy || addingMemory}>
            {t('Save')}
          </button>
        </>
      )}
    </>
  );
}

/** Add row of the memory editor. It shares the saved rows' vertical shape:
 *  text on top, then scope + actions on one line (user: 추가 UI 정리). */
function memoryAddRow({
  addMemoryDraft,
  addMemoryScope,
  memoryBusy,
  editTarget,
  projects,
  onMemoryControl,
  refreshMemories,
  setAddMemoryDraft,
  setAddMemoryScope,
  setAddingMemory,
  setEditError,
  setMemoryBusy,
}: {
  addMemoryDraft: string;
  addMemoryScope: string;
  memoryBusy: boolean;
  editTarget: ProjectEditTarget | null;
  projects: DesktopProjectSummary[];
  onMemoryControl: MemoryControl;
  refreshMemories(path: string | null): Promise<void>;
  setAddMemoryDraft(value: string): void;
  setAddMemoryScope(value: string): void;
  setAddingMemory(value: boolean): void;
  setEditError(value: string): void;
  setMemoryBusy(value: boolean): void;
}) {
  return (
    <div className="projects-memory-add-row">
      <textarea
        aria-label={t('Memory text')}
        value={addMemoryDraft}
        autoFocus
        rows={3}
        disabled={memoryBusy}
        placeholder={t('What should Mixdog remember?')}
        onChange={(event) => setAddMemoryDraft(event.currentTarget.value)}
      />
      <div className="projects-memory-row-foot">
        {memoryScopeSelect({
          value: addMemoryScope,
          disabled: memoryBusy,
          projects,
          onChange: setAddMemoryScope,
        })}
        <div className="core-memory-actions">
          <button
            type="button"
            disabled={memoryBusy || !addMemoryDraft.trim()}
            onClick={() => {
              if (!editTarget) return;
              const summary = addMemoryDraft.trim();
              const target = addMemoryScope === '' ? null : addMemoryScope;
              setMemoryBusy(true);
              setEditError('');
              void onMemoryControl({
                action: 'core',
                op: 'add',
                summary,
                verbatim: true,
                ...memoryScope(target),
              })
                .then((value) => {
                  const failure = memoryResultError(value);
                  if (failure) throw new Error(failure);
                  return refreshMemories(editTarget.path);
                })
                .then(() => {
                  setAddingMemory(false);
                  setAddMemoryDraft('');
                })
                .catch((reason) => setEditError(reason instanceof Error ? reason.message : String(reason)))
                .finally(() => setMemoryBusy(false));
            }}
          >
            {t('Add')}
          </button>
          <button
            type="button"
            disabled={memoryBusy}
            onClick={() => {
              setAddingMemory(false);
              setAddMemoryDraft('');
            }}
          >
            {t('Cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One saved memory: its scope (which can move it to another project), its
 *  text, and the save/delete pair that writes through the memory control. */
function memoryEditRow({
  entry,
  moveTarget,
  memoryDrafts,
  memoryBusy,
  memoriesLoading,
  confirmDeleteMemory,
  editTarget,
  projects,
  onMemoryControl,
  refreshMemories,
  setMemoryDrafts,
  setMoveTargets,
  setConfirmDeleteMemory,
  setEditError,
  setMemoryBusy,
}: {
  entry: CoreMemoryEntry;
  moveTarget: string;
  memoryDrafts: Record<number, string>;
  memoryBusy: boolean;
  memoriesLoading: boolean;
  confirmDeleteMemory: number | null;
  editTarget: ProjectEditTarget | null;
  projects: DesktopProjectSummary[];
  onMemoryControl: MemoryControl;
  refreshMemories(path: string | null): Promise<void>;
  setMemoryDrafts: Dispatch<SetStateAction<Record<number, string>>>;
  setMoveTargets: Dispatch<SetStateAction<Record<number, string>>>;
  setConfirmDeleteMemory(value: number | null): void;
  setEditError(value: string): void;
  setMemoryBusy(value: boolean): void;
}) {
  return (
    <div className="core-memory-edit" key={entry.id}>
      <div className="projects-memory-row-head">
        <span className="projects-memory-index">#{entry.id}</span>
        {memoryScopeSelect({
          value: moveTarget,
          disabled: memoryBusy || memoriesLoading,
          projects,
          onChange: (value) => setMoveTargets((current) => ({ ...current, [entry.id]: value })),
        })}
      </div>
      <textarea
        aria-label={t('Memory text')}
        value={memoryDrafts[entry.id] ?? entry.summary}
        rows={3}
        disabled={memoryBusy || memoriesLoading}
        onChange={(event) => {
          const value = event.currentTarget.value;
          setMemoryDrafts((current) => ({
            ...current,
            [entry.id]: value,
          }));
        }}
      />
      <div className="core-memory-actions">
        <button
          type="button"
          disabled={
            memoryBusy ||
            !(memoryDrafts[entry.id] ?? entry.summary).trim() ||
            ((memoryDrafts[entry.id] ?? entry.summary).trim() === entry.summary &&
              moveTarget === (editTarget?.path ?? ''))
          }
          onClick={() => {
            if (!editTarget) return;
            setMemoryBusy(true);
            setEditError('');
            const summary = (memoryDrafts[entry.id] ?? entry.summary).trim();
            void onMemoryControl({
              action: 'core',
              op: 'edit',
              id: entry.id,
              index_revision: entry.indexRevision,
              element: entry.singleSentence ? summary : entry.element,
              summary,
              verbatim: true,
              ...memoryScope(editTarget.path),
              ...(moveTarget === '' ? { target_project_id: 'common' } : { target_cwd: moveTarget }),
            })
              .then((value) => {
                const failure = memoryResultError(value);
                if (failure) throw new Error(failure);
                return refreshMemories(editTarget.path);
              })
              .catch((reason) => setEditError(reason instanceof Error ? reason.message : String(reason)))
              .finally(() => setMemoryBusy(false));
          }}
        >
          {t('Save')}
        </button>
        <button
          type="button"
          className="danger"
          disabled={memoryBusy}
          onClick={() => {
            if (confirmDeleteMemory !== entry.id) {
              setConfirmDeleteMemory(entry.id);
              return;
            }
            if (!editTarget) return;
            setMemoryBusy(true);
            setEditError('');
            void onMemoryControl({
              action: 'core',
              op: 'delete',
              id: entry.id,
              index_revision: entry.indexRevision,
              ...memoryScope(editTarget.path),
            })
              .then((value) => {
                const failure = memoryResultError(value);
                if (failure) throw new Error(failure);
                return refreshMemories(editTarget.path);
              })
              .then(() => setConfirmDeleteMemory(null))
              .catch((reason) => setEditError(reason instanceof Error ? reason.message : String(reason)))
              .finally(() => setMemoryBusy(false));
          }}
        >
          {confirmDeleteMemory === entry.id ? t('Confirm delete') : t('Delete')}
        </button>
      </div>
    </div>
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
  // Common and project memory share one editor and one injection store.
  const [editTarget, setEditTarget] = useState<{ path: string | null; title: string } | null>(null);
  const [editName, setEditName] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState('');
  const [editConfirmRemove, setEditConfirmRemove] = useState(false);
  const editOpenRequestRef = useRef(0);
  const memoriesCache = useRef(new ProjectEditorCache<ProjectMemoryCatalog>()).current;
  const [memories, setMemories] = useState<CoreMemoryEntry[]>([]);
  const [memoriesLoading, setMemoriesLoading] = useState(false);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [memoryDrafts, setMemoryDrafts] = useState<Record<number, string>>({});
  const [addingMemory, setAddingMemory] = useState(false);
  const [addMemoryDraft, setAddMemoryDraft] = useState('');
  const [addMemoryScope, setAddMemoryScope] = useState('');
  const [confirmDeleteMemory, setConfirmDeleteMemory] = useState<number | null>(null);
  const [moveTargets, setMoveTargets] = useState<Record<number, string>>({});
  // The app shell owns project add/rename/remove and refetches its catalog
  // once a mutation actually succeeded. Mirroring THAT list into the shared
  // sidebar cache is the authoritative completion boundary: a failed mutation
  // never changes the list, so it never triggers a refresh either.
  useEffect(() => {
    publishSidebarProjects(projects);
  }, [projects]);
  const projectPathsKey = JSON.stringify(projects.map((project) => project.path));
  const readMemories = async (path: string | null, refresh = false): Promise<CoreMemoryEntry[]> => {
    if (!onMemoryControl) return [];
    try {
      const catalog = await memoriesCache.read(
        projectPathsKey,
        () => readProjectMemories(JSON.parse(projectPathsKey), onMemoryControl),
        refresh
      );
      return catalog.get(path) ?? [];
    } catch (reason) {
      throw new Error(t(reason instanceof Error ? reason.message : String(reason)));
    }
  };
  const refreshMemories = async (path: string | null) => {
    const requestId = editOpenRequestRef.current;
    // A completed write must not join a pre-write background read. Reload the
    // whole catalog so moves also refresh their destination immediately.
    memoriesCache.invalidate(projectPathsKey);
    const entries = await readMemories(path);
    if (editOpenRequestRef.current !== requestId) return;
    setMemories(entries);
    setMemoryDrafts(Object.fromEntries(entries.map((entry) => [entry.id, entry.summary])));
    setMoveTargets({});
    setConfirmDeleteMemory(null);
  };
  // One shared catalog request warms every row, including empty projects.
  // Inline callback props must not restart it on unrelated shell renders.
  const readersRef = useRef({ readMemories });
  readersRef.current = { readMemories };
  const memoriesSupported = Boolean(onMemoryControl);
  useEffect(() => {
    if (!active || !memoriesSupported) return;
    void readersRef.current.readMemories(null, true).catch(() => {});
  }, [active, projectPathsKey, memoriesSupported, memoriesCache]);
  const openEdit = (path: string | null, title: string) => {
    const requestId = ++editOpenRequestRef.current;
    const cachedMemories = memoriesCache.peek(projectPathsKey)?.get(path);
    setEditName(title);
    setEditError('');
    setEditConfirmRemove(false);
    setMemories(cachedMemories ?? []);
    setMemoryDrafts(Object.fromEntries((cachedMemories ?? []).map((entry) => [entry.id, entry.summary])));
    setAddingMemory(false);
    setConfirmDeleteMemory(null);
    setMoveTargets({});
    setEditTarget({ path, title });
    const current = () => editOpenRequestRef.current === requestId;
    const reportError = (reason: unknown) => {
      if (!current()) return;
      const message = reason instanceof Error ? reason.message : String(reason);
      setEditError((previous) => (previous ? `${previous}\n${message}` : message));
    };
    setMemoriesLoading(memoriesSupported && cachedMemories === undefined);
    if (onMemoryControl) {
      void readMemories(path)
        .then((entries) => {
          if (!current()) return;
          setMemories(entries);
          setMemoryDrafts(Object.fromEntries(entries.map((entry) => [entry.id, entry.summary])));
        })
        .catch(reportError)
        .finally(() => {
          if (current()) setMemoriesLoading(false);
        });
    }
  };
  const resetEdit = () => {
    editOpenRequestRef.current += 1;
    setEditTarget(null);
    setEditName('');
    setEditError('');
    setEditConfirmRemove(false);
    setMemories([]);
    setMemoryDrafts({});
    setAddingMemory(false);
    setAddMemoryDraft('');
    setConfirmDeleteMemory(null);
  };
  const closeEdit = () => {
    if (editBusy || memoryBusy) return;
    resetEdit();
  };
  const closeAdd = () => {
    setAddOpen(false);
    setAddPath('');
    setAddName('');
    setAddError('');
  };
  // Hidden panel, no body portal: collapsing the sidebar or presenting another
  // destination closes the dialogs (and disarms a pending removal) while the
  // list itself keeps its state.
  useSidebarPanelDismiss(active, () => {
    setAddOpen(false);
    setAddPath('');
    setAddName('');
    setAddError('');
    resetEdit();
  });
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
          이 2번 나옴) — the list starts right at the search field. */}
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
      {active && editTarget && (
        <ExtensionDetailDialog
          width="detail"
          className="projects-edit-dialog"
          titleId="projects-edit-title"
          icon={
            editTarget.path === null ? (
              <FileText size={16} aria-hidden="true" />
            ) : (
              <Folder size={16} aria-hidden="true" />
            )
          }
          title={editTarget.title}
          tagline={editTarget.path ?? t('Used for every project.')}
          onClose={closeEdit}
          onSubmit={(event) => {
            event.preventDefault();
            if (!editTarget || editBusy || memoriesLoading || memoryBusy) return;
            const { path, title } = editTarget;
            const alias = editName.trim();
            setEditBusy(true);
            setEditError('');
            const save = Promise.resolve();
            void save
              .then(() => {
                if (path !== null && alias && alias !== title) onRename(path, alias);
                setEditBusy(false);
                resetEdit();
              })
              .catch((reason) => {
                setEditBusy(false);
                setEditError(reason instanceof Error ? reason.message : String(reason));
              });
          }}
          footer={projectEditFooter({
            editTarget,
            editError,
            editBusy,
            memoryBusy,
            memoriesLoading,
            addingMemory,
            editConfirmRemove,
            setEditConfirmRemove,
            resetEdit,
            closeEdit,
            onRemove,
          })}
        >
          {editTarget.path !== null && (
            <ExtensionField
              className="projects-edit-field"
              label={t('Name')}
              note={t('Changes the display name without renaming the folder.')}
            >
              <input
                name="project-alias"
                value={editName}
                maxLength={120}
                autoFocus
                disabled={editBusy}
                aria-label={t('Project display name')}
                onChange={(event) => setEditName(event.currentTarget.value)}
              />
            </ExtensionField>
          )}
          {onMemoryControl && (
            <ExtensionSection
              title={t('Memories')}
              description={t(
                'Saved memories are included in new conversations. Common memories apply to every project.'
              )}
              action={
                <div className="projects-memory-head-actions">
                  <button
                    type="button"
                    className="extensions-action"
                    disabled={memoryBusy || memoriesLoading}
                    onClick={() => {
                      setMemoryBusy(true);
                      setEditError('');
                      setMoveTargets({});
                      setConfirmDeleteMemory(null);
                      void refreshMemories(editTarget.path)
                        .catch((reason) => setEditError(reason instanceof Error ? reason.message : String(reason)))
                        .finally(() => setMemoryBusy(false));
                    }}
                  >
                    {t('Refresh')}
                  </button>
                  <button
                    type="button"
                    className="extensions-action"
                    disabled={memoriesLoading || memoryBusy || addingMemory}
                    aria-label={t('Add memory')}
                    onClick={() => {
                      setAddingMemory(true);
                      setAddMemoryDraft('');
                      setAddMemoryScope(editTarget.path ?? '');
                      setConfirmDeleteMemory(null);
                    }}
                  >
                    <Plus size={14} aria-hidden="true" />
                    {t('Add')}
                  </button>
                </div>
              }
            >
              <div className="projects-memory-editor" aria-busy={memoriesLoading}>
                <div className={`projects-memory-viewport${memories.length || addingMemory ? '' : ' is-empty'}`}>
                  {/* Add row and saved rows share one vertical shape: text on top,
                  then scope + actions on one line (user: 추가 UI 정리). */}
                  {addingMemory &&
                    memoryAddRow({
                      addMemoryDraft,
                      addMemoryScope,
                      memoryBusy,
                      editTarget,
                      projects,
                      onMemoryControl,
                      refreshMemories,
                      setAddMemoryDraft,
                      setAddMemoryScope,
                      setAddingMemory,
                      setEditError,
                      setMemoryBusy,
                    })}
                  {memoriesLoading && <p className="projects-memory-empty">{t('Loading…')}</p>}
                  {!memoriesLoading && memories.length > 0 && (
                    <div className="core-memory-list">
                      {memories.map((entry) =>
                        memoryEditRow({
                          entry,
                          moveTarget: moveTargets[entry.id] ?? editTarget.path ?? '',
                          memoryDrafts,
                          memoryBusy,
                          memoriesLoading,
                          confirmDeleteMemory,
                          editTarget,
                          projects,
                          onMemoryControl,
                          refreshMemories,
                          setMemoryDrafts,
                          setMoveTargets,
                          setConfirmDeleteMemory,
                          setEditError,
                          setMemoryBusy,
                        })
                      )}
                    </div>
                  )}
                  {!memoriesLoading && memories.length === 0 && (
                    <p className="projects-memory-empty">{t('No memories yet.')}</p>
                  )}
                </div>
              </div>
            </ExtensionSection>
          )}
        </ExtensionDetailDialog>
      )}
      {onMemoryControl && (
        <div className="schedules-list projects-list projects-common-instructions">
          <button
            type="button"
            className="schedules-row utilities-row projects-row"
            onClick={() => openEdit(null, t('Common Memory'))}
          >
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
                onClick={() => openEdit(project.path, title)}
                {...projectOrder.getReorderProps(project.path)}
              >
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
          <Folder size={40} strokeWidth={1.5} aria-hidden="true" />
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
