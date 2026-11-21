import { errorMessage } from './editor-pane-session-errors';
import { FileText, Folder, Plus } from 'lucide-react';
import { forwardRef, useImperativeHandle, useRef, useState } from 'react';

import type { DesktopProjectSummary } from '../shared/contract';
import { t } from './i18n';
import { ConnectorSwitchList, type ConnectorSwitchApi } from './connector-switches';
import { ErrorNotice } from './ErrorNotice';
import { memoryAddRow, memoryEditRow, type MemoryControl } from './ProjectMemoryRows';
import { projectIdentity } from './project-catalog-cache';
import { displayProjectTitle } from './project-folder-label';
import { ExtensionDetailDialog, ExtensionField, ExtensionSection } from './settings/extension-detail';
import { useSidebarPanelDismiss } from './sidebar-panel-surface';
import './desktop/extension-dialog.css';
import { ProjectEditorCache, readProjectMemories, type ProjectMemoryCatalog } from './project-editor-data';

type ProjectEditTarget = { path: string | null; title: string };

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
  /** Reads and saves the project's connector switches (tests stub it). */
  connectorApi?: ConnectorSwitchApi;
}

/** Project / common-memory editor dialog. Owns its state and is opened by path. */
export const ProjectEditorDialog = forwardRef<ProjectEditorDialogHandle, ProjectEditorDialogProps>(
  function ProjectEditorDialog(
    { active = true, projects, onRename, onRemove, onMemoryControl, connectorApi = window.mixdogDesktop },
    ref
  ) {
    // Common and project memory share one editor and one injection store.
    const [editTarget, setEditTarget] = useState<ProjectEditTarget | null>(null);
    const [editName, setEditName] = useState('');
    const [editBusy, setEditBusy] = useState(false);
    const [editError, setEditError] = useState('');
    const [editConfirmRemove, setEditConfirmRemove] = useState(false);
    const editOpenRequestRef = useRef(0);
    const memoriesCache = useRef(new ProjectEditorCache<ProjectMemoryCatalog>()).current;
    const [memoryCatalog, setMemoryCatalog] = useState<ProjectMemoryCatalog>();
    const [memoriesLoading, setMemoriesLoading] = useState(false);
    const [memoryBusy, setMemoryBusy] = useState(false);
    const [memoryDrafts, setMemoryDrafts] = useState<Record<number, string>>({});
    const [addingMemory, setAddingMemory] = useState(false);
    const [addMemoryDraft, setAddMemoryDraft] = useState('');
    const [addMemoryScope, setAddMemoryScope] = useState('');
    const [confirmDeleteMemory, setConfirmDeleteMemory] = useState<number | null>(null);
    const [moveTargets, setMoveTargets] = useState<Record<number, string>>({});
    const projectPathsKey = JSON.stringify(projects.map((project) => project.path));
    const memoryScope = editTarget && memoryCatalog?.get(editTarget.path);
    const memories = memoryScope?.entries ?? [];
    const readMemories = (control: MemoryControl, refresh = false) =>
      memoriesCache.read(projectPathsKey, () => readProjectMemories(JSON.parse(projectPathsKey), control), refresh);
    const refreshMemories = async (afterWrite = false) => {
      if (!onMemoryControl) return;
      const requestId = ++editOpenRequestRef.current;
      // A completed write must not join a pre-write background read. Reload the
      // whole catalog for whichever scope is open; don't show old rows if
      // readback fails after the write committed.
      memoriesCache.invalidate(projectPathsKey);
      try {
        const catalog = await readMemories(onMemoryControl);
        if (editOpenRequestRef.current !== requestId) return;
        setMemoryCatalog(catalog);
        setMemoryDrafts({});
        setMoveTargets({});
        setConfirmDeleteMemory(null);
      } catch (reason) {
        if (editOpenRequestRef.current !== requestId) return;
        if (afterWrite) setMemoryCatalog(undefined);
        throw reason;
      } finally {
        if (editOpenRequestRef.current === requestId) setMemoriesLoading(false);
      }
    };
    const openEdit = (path: string | null, title: string) => {
      const requestId = ++editOpenRequestRef.current;
      const cachedCatalog = memoriesCache.peek(projectPathsKey);
      setEditName(title);
      setEditError('');
      setEditConfirmRemove(false);
      setMemoryCatalog(cachedCatalog);
      setMemoryDrafts({});
      setAddingMemory(false);
      setConfirmDeleteMemory(null);
      setMoveTargets({});
      setEditTarget({ path, title });
      const current = () => editOpenRequestRef.current === requestId;
      const reportError = (reason: unknown) => {
        if (!current()) return;
        const message = errorMessage(reason);
        setEditError((previous) => (previous ? `${previous}\n${message}` : message));
      };
      setMemoriesLoading(Boolean(onMemoryControl) && cachedCatalog === undefined);
      if (onMemoryControl) {
        void readMemories(onMemoryControl)
          .then((catalog) => {
            if (!current()) return;
            setMemoryCatalog(catalog);
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
      setMemoryCatalog(undefined);
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
        openEdit(project.path, displayProjectTitle(project));
        if (options?.confirmRemove) setEditConfirmRemove(true);
      },
      warm() {
        if (onMemoryControl) void readMemories(onMemoryControl, true).catch(() => {});
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
            setEditError(errorMessage(reason));
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
        {editTarget.path !== null && (
          <ExtensionSection title={t('Connectors')}>
            <ConnectorSwitchList api={connectorApi} kind="project" target={editTarget.path} />
          </ExtensionSection>
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
                    void refreshMemories()
                      .catch((reason) => setEditError(errorMessage(reason)))
                      .finally(() => setMemoryBusy(false));
                  }}
                >
                  {t('Refresh')}
                </button>
                <button
                  type="button"
                  className="extensions-action"
                  disabled={memoriesLoading || memoryBusy || addingMemory || !memoryScope}
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
                then scope + actions on one line. */}
                {addingMemory &&
                  !memoriesLoading &&
                  memoryCatalog &&
                  memoryScope &&
                  memoryAddRow({
                    addMemoryDraft,
                    addMemoryScope,
                    memoryBusy,
                    projects,
                    memoryCatalog,
                    onMemoryControl,
                    refreshMemories,
                    setAddMemoryDraft,
                    setAddMemoryScope,
                    setAddingMemory,
                    setEditError,
                    setMemoryBusy,
                  })}
                {memoriesLoading && <p className="projects-memory-empty mx-empty-state">{t('Loading…')}</p>}
                {!memoriesLoading && memoryCatalog && memoryScope && memories.length > 0 && (
                  <div className="core-memory-list">
                    {memories.map((entry) =>
                      memoryEditRow({
                        entry,
                        moveTarget: moveTargets[entry.id] ?? editTarget.path ?? '',
                        memoryDrafts,
                        memoryBusy,
                        memoriesLoading,
                        confirmDeleteMemory,
                        sourceProjectId: memoryScope.projectId,
                        projects,
                        memoryCatalog,
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
                {!memoriesLoading && memoryCatalog && !memoryScope && (
                  <p className="projects-memory-empty mx-empty-state">{t('Memory is temporarily unavailable.')}</p>
                )}
                {!memoriesLoading && memoryScope && memories.length === 0 && (
                  <p className="projects-memory-empty mx-empty-state">{t('No memories yet.')}</p>
                )}
              </div>
            </div>
          </ExtensionSection>
        )}
      </ExtensionDetailDialog>
    );
  }
);
