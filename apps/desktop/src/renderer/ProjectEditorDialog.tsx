import { FileText, Folder, Plus } from 'lucide-react';
import { type Dispatch, forwardRef, type SetStateAction, useImperativeHandle, useRef, useState } from 'react';

import type { DesktopProjectSummary } from '../shared/contract';
import { t } from './i18n';
import { ErrorNotice } from './ErrorNotice';
import { projectIdentity } from './project-catalog-cache';
import { ExtensionDetailDialog, ExtensionField, ExtensionSection } from './settings/extension-detail';
import { useSidebarPanelDismiss } from './sidebar-panel-surface';
import './desktop/extension-dialog.css';
import {
  ProjectEditorCache,
  memoryResultError,
  readProjectMemories,
  type CoreMemoryEntry,
  type ProjectMemoryCatalog,
} from './project-editor-data';

export function displayProjectFolder(path: string): string {
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

/** One memory write: a result that reports a failure rejects, and a success
 *  rereads the open editor's catalog. */
function writeMemory(
  onMemoryControl: MemoryControl,
  input: Record<string, unknown>,
  refresh: () => Promise<void>
): Promise<void> {
  return onMemoryControl(input).then((value) => {
    const failure = memoryResultError(value);
    if (failure) throw new Error(failure);
    return refresh();
  });
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
        // biome-ignore lint/a11y/noAutofocus: the row is revealed by an explicit "add memory" action and should take typing at once.
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
              void writeMemory(
                onMemoryControl,
                { action: 'core', op: 'add', summary, verbatim: true, ...memoryScope(target) },
                () => refreshMemories(editTarget.path)
              )
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
  const draft = memoryDrafts[entry.id] ?? entry.summary;
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
        value={draft}
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
            memoryBusy || !draft.trim() || (draft.trim() === entry.summary && moveTarget === (editTarget?.path ?? ''))
          }
          onClick={() => {
            if (!editTarget) return;
            setMemoryBusy(true);
            setEditError('');
            const summary = draft.trim();
            void writeMemory(
              onMemoryControl,
              {
                action: 'core',
                op: 'edit',
                id: entry.id,
                index_revision: entry.indexRevision,
                element: entry.singleSentence ? summary : entry.element,
                summary,
                verbatim: true,
                ...memoryScope(editTarget.path),
                ...(moveTarget === '' ? { target_project_id: 'common' } : { target_cwd: moveTarget }),
              },
              () => refreshMemories(editTarget.path)
            )
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
            void writeMemory(
              onMemoryControl,
              {
                action: 'core',
                op: 'delete',
                id: entry.id,
                index_revision: entry.indexRevision,
                ...memoryScope(editTarget.path),
              },
              () => refreshMemories(editTarget.path)
            )
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

export interface ProjectEditorDialogHandle {
  /** Opens the editor for a project path, or the common memory for null. */
  open(path: string | null, options?: { confirmRemove?: boolean }): void;
  /** Warms the shared memory catalog. */
  warm(): void;
}

export interface ProjectEditorDialogProps {
  /** A sidebar panel passes its activity: going inactive closes the dialog.
   *  A host outside the panels leaves it unset and is never auto-closed. */
  active?: boolean;
  projects: DesktopProjectSummary[];
  onRename(path: string, alias: string): void;
  onRemove(path: string): void;
  onMemoryControl?(input: Record<string, unknown>): Promise<unknown>;
}

/** Project / common-memory editor dialog. Owns its state and is opened by path. */
export const ProjectEditorDialog = forwardRef<ProjectEditorDialogHandle, ProjectEditorDialogProps>(
  function ProjectEditorDialog({ active = true, projects, onRename, onRemove, onMemoryControl }, ref) {
    // Common and project memory share one editor and one injection store.
    const [editTarget, setEditTarget] = useState<ProjectEditTarget | null>(null);
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
    const projectPathsKey = JSON.stringify(projects.map((project) => project.path));
    const memoriesSupported = Boolean(onMemoryControl);
    const readMemories = async (path: string | null, refresh = false): Promise<CoreMemoryEntry[]> => {
      if (!onMemoryControl) return [];
      const catalog = await memoriesCache.read(
        projectPathsKey,
        () => readProjectMemories(JSON.parse(projectPathsKey), onMemoryControl),
        refresh
      );
      return catalog.get(path) ?? [];
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
    useImperativeHandle(ref, () => ({
      open(path, options) {
        if (path === null) {
          openEdit(null, t('Common Memory'));
          return;
        }
        const project = projects.find((entry) => projectIdentity(entry.path) === projectIdentity(path));
        if (!project) return;
        openEdit(project.path, project.alias?.trim() || project.name?.trim() || displayProjectFolder(project.path));
        // Armed AFTER openEdit (which disarms): the Remove button then reads
        // "Confirm remove" and still needs one explicit click.
        if (options?.confirmRemove) setEditConfirmRemove(true);
      },
      warm() {
        if (memoriesSupported) void readMemories(null, true).catch(() => {});
      },
    }));
    // Hidden panel, no body portal: collapsing the sidebar or presenting another
    // destination closes the dialog (and disarms a pending removal).
    useSidebarPanelDismiss(active, resetEdit);

    if (!active || !editTarget) return null;
    return (
      <ExtensionDetailDialog
        width="detail"
        className="projects-edit-dialog"
        titleId="projects-edit-title"
        icon={
          editTarget.path === null ? <FileText size={16} aria-hidden="true" /> : <Folder size={16} aria-hidden="true" />
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
          try {
            if (path !== null && alias && alias !== title) onRename(path, alias);
            setEditBusy(false);
            resetEdit();
          } catch (reason) {
            setEditBusy(false);
            setEditError(reason instanceof Error ? reason.message : String(reason));
          }
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
              // biome-ignore lint/a11y/noAutofocus: the edit dialog opens to rename the project immediately.
              autoFocus
              disabled={editBusy}
              aria-label={t('Project display name')}
              onChange={(event) => setEditName(event.currentTarget.value)}
            />
          </ExtensionField>
        )}
        {onMemoryControl && (
          <ExtensionSection
            title={t('Instructions')}
            description={t('Saved memories are included in new conversations. Common memories apply to every project.')}
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
    );
  }
);
