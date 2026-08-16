import { Folder, NotebookPen, Pencil, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import type { DesktopProjectSummary } from '../shared/contract';
import { t } from './i18n';
import { projectIdentity, SidebarPanelAction } from './session-sidebar';
import { useSidebarPanelDismiss } from './sidebar-panel-surface';
import { publishSidebarProjects } from './sidebar-reference-cache';
import { acquireTitleBarDim } from './titlebar-dim';

function displayProjectFolder(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path;
}

// Projects panel (rail -> Projects): the Schedules grammar — a compact list
// with search and per-row actions hosted in the session-panel area (user
// decision — no main-pane takeover). Add project opens a small popup dialog
// (Name + folder via the native chooser) portaled above the workspace.
export function ProjectsPane({
  active = true,
  projects,
  selectedProjectPath,
  onChooseFolder,
  onCreateProject,
  onRename,
  onRemove,
  instructionsSupported = false,
  onReadInstructions,
  onSaveInstructions,
  onMemoryControl,
}: {
  active?: boolean;
  projects: DesktopProjectSummary[];
  selectedProjectPath: string;
  onChooseFolder(): Promise<string | null>;
  onCreateProject(path: string, name: string): Promise<void>;
  onRename(path: string, alias: string): void;
  onRemove(path: string): void;
  /** Instructions editing needs the desktop bridge; the remote shim omits it. */
  instructionsSupported?: boolean;
  onReadInstructions?(projectPath: string | null): Promise<string>;
  onSaveInstructions?(projectPath: string | null, content: string): Promise<void>;
  onMemoryControl?(input: Record<string, unknown>): Promise<unknown>;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [addPath, setAddPath] = useState('');
  const [addName, setAddName] = useState('');
  const [addError, setAddError] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  // Project editor: name, instructions, and existing memories share the one
  // pencil action. editIns === null means the
  // instructions never loaded (unsupported or failed) and stays untouched.
  const [editTarget, setEditTarget] = useState<{ path: string | null; title: string } | null>(null);
  const [editName, setEditName] = useState('');
  const [editIns, setEditIns] = useState<string | null>(null);
  const [editInsLoading, setEditInsLoading] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState('');
  const [editConfirmRemove, setEditConfirmRemove] = useState(false);
  const [memories, setMemories] = useState<CoreMemoryEntry[]>([]);
  const [memoriesLoading, setMemoriesLoading] = useState(false);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [editingMemory, setEditingMemory] = useState<number | null>(null);
  const [memoryDraft, setMemoryDraft] = useState('');
  const [memoryTargetPath, setMemoryTargetPath] = useState('');
  const [addingMemory, setAddingMemory] = useState(false);
  const [addMemoryDraft, setAddMemoryDraft] = useState('');
  const [addMemoryTargetPath, setAddMemoryTargetPath] = useState('');
  const [confirmDeleteMemory, setConfirmDeleteMemory] = useState<number | null>(null);
  // The dialog scrims cannot dim the NATIVE caption band — hold the titlebar
  // claim while either portal is open (user: - ㅁ x 딤드 안 먹음).
  useEffect(() => {
    if (!(active && addOpen)) return;
    return acquireTitleBarDim();
  }, [active, addOpen]);
  useEffect(() => {
    if (!(active && editTarget)) return;
    return acquireTitleBarDim();
  }, [active, editTarget]);
  const canEditInstructions = instructionsSupported && !!onReadInstructions && !!onSaveInstructions;
  // The app shell owns project add/rename/remove and refetches its catalog
  // once a mutation actually succeeded. Mirroring THAT list into the shared
  // sidebar cache is the authoritative completion boundary: a failed mutation
  // never changes the list, so it never triggers a refresh either.
  useEffect(() => {
    publishSidebarProjects(projects);
  }, [projects]);
  const memoryScope = (path: string | null) => path === null
    ? { project_id: 'common' }
    : { cwd: path };
  const refreshMemories = async (path: string | null) => {
    if (!onMemoryControl) return;
    const value = await onMemoryControl({ action: 'core', op: 'list', ...memoryScope(path) });
    setMemories(parseCoreMemoryEntries(value));
  };
  const openEdit = (path: string | null, title: string) => {
    setEditTarget({ path, title });
    setEditName(title);
    setEditIns(null);
    setEditError('');
    setEditConfirmRemove(false);
    setMemories([]);
    setEditingMemory(null);
    setAddingMemory(false);
    setConfirmDeleteMemory(null);
    if (canEditInstructions && onReadInstructions) {
      setEditInsLoading(true);
      void onReadInstructions(path)
        .then((text) => setEditIns(String(text ?? '')))
        .catch((reason) => setEditError(reason instanceof Error ? reason.message : String(reason)))
        .finally(() => setEditInsLoading(false));
    }
    if (onMemoryControl) {
      setMemoriesLoading(true);
      void refreshMemories(path)
        .catch((reason) => setEditError(reason instanceof Error ? reason.message : String(reason)))
        .finally(() => setMemoriesLoading(false));
    }
  };
  const resetEdit = () => {
    setEditTarget(null);
    setEditName('');
    setEditIns(null);
    setEditError('');
    setEditConfirmRemove(false);
    setMemories([]);
    setEditingMemory(null);
    setMemoryDraft('');
    setMemoryTargetPath('');
    setAddingMemory(false);
    setAddMemoryDraft('');
    setAddMemoryTargetPath('');
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
  const visible = projects;

  return <div className="schedules-pane projects-pane stable-surface-preserved stable-takeover-surface"
    data-surface-active={active ? 'true' : 'false'}
    inert={active ? undefined : true} aria-hidden={active ? undefined : true}>
    <div className="schedules-page">
      {/* The panel header names this view and hosts its action (user: 타이틀
          이 2번 나옴) — the list starts right at the search field. */}
      {/* Plain + like every other rail panel action (user: 프로젝트도 + 통일). */}
      <SidebarPanelAction active={active} label={t('Add project')} icon={Plus}
        className="projects-add" onClick={() => setAddOpen(true)} />
      {active && addOpen && createPortal(<div className="schedules-dialog-layer"
        onMouseDown={(event) => { if (event.target === event.currentTarget) closeAdd(); }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeAdd();
          }
        }}>
        <section className="schedules-dialog projects-add-dialog" role="dialog" aria-modal="true"
          aria-labelledby="projects-add-title">
          <header>
            <h2 id="projects-add-title">{t('Add project')}</h2>
            <button type="button" aria-label={t('Close add project')} onClick={closeAdd}>
              <X size={16} aria-hidden="true" /></button>
          </header>
          <form onSubmit={(event) => {
            event.preventDefault();
            if (!addPath || addBusy) return;
            setAddBusy(true);
            setAddError('');
            void onCreateProject(addPath, addName.trim())
              .then(() => closeAdd())
              .catch((reason) => setAddError(reason instanceof Error ? reason.message : String(reason)))
              .finally(() => setAddBusy(false));
          }}>
            <label className="schedules-field"><span>{t('Name')}</span>
              <small>{t('Shown in the Projects list.')}</small>
              <input name="project-name" value={addName} maxLength={120} autoFocus disabled={addBusy}
                placeholder={t('my-project')}
                onChange={(event) => setAddName(event.currentTarget.value)} />
            </label>
            <div className="schedules-field">
              <span>{t('Folder')}</span>
              <small>{t('Folder opened for this project.')}</small>
              <div className="projects-folder-row">
                <code>{addPath || t('No folder selected')}</code>
                {/* Folder comes from the OS chooser only (user decision):
                    prefill the Name with the folder's basename once picked. */}
                <button type="button" className="settings-action" disabled={addBusy}
                  onClick={() => void onChooseFolder().then((selected) => {
                    if (!selected) return;
                    setAddPath(selected);
                    setAddName((current) => current.trim() ? current : displayProjectFolder(selected));
                    setAddError('');
                  })}>{t('Browse…')}</button>
              </div>
            </div>
            <footer>
              {addError && <p className="schedules-form-error" role="alert">{addError}</p>}
              <button type="button" disabled={addBusy} onClick={closeAdd}>{t('Cancel')}</button>
              <button type="submit" disabled={addBusy || !addPath}>{t('Add')}</button>
            </footer>
          </form>
        </section>
      </div>, document.body)}
      {active && editTarget && createPortal(<div className="schedules-dialog-layer"
        onMouseDown={(event) => { if (event.target === event.currentTarget) closeEdit(); }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeEdit();
          }
        }}>
        <section className="schedules-dialog projects-edit-dialog" role="dialog" aria-modal="true"
          aria-labelledby="projects-edit-title">
          <header>
            <h2 id="projects-edit-title">{t('Edit {{name}}', { name: editTarget.title })}</h2>
            <button type="button" aria-label={t('Close')} onClick={closeEdit}>
              <X size={16} aria-hidden="true" /></button>
          </header>
          <form onSubmit={(event) => {
            event.preventDefault();
            if (!editTarget || editBusy || editInsLoading || memoryBusy) return;
            const { path, title } = editTarget;
            const alias = editName.trim();
            setEditBusy(true);
            setEditError('');
            // Instructions save only when the file actually loaded; the alias
            // applies after so a failed write never half-commits the dialog.
            const save = canEditInstructions && editIns !== null
              ? onSaveInstructions(path, editIns)
              : Promise.resolve();
            void save.then(() => {
              if (path !== null && alias && alias !== title) onRename(path, alias);
              setEditBusy(false);
              resetEdit();
            }).catch((reason) => {
              setEditBusy(false);
              setEditError(reason instanceof Error ? reason.message : String(reason));
            });
          }}>
            {editTarget.path !== null && <label className="schedules-field projects-edit-field">
              <span>{t('Name')}</span>
              <small>{t('Changes the display name without renaming the folder.')}</small>
              <input name="project-alias" value={editName} maxLength={120} autoFocus
                disabled={editBusy} aria-label={t('Project display name')}
                onChange={(event) => setEditName(event.currentTarget.value)} />
            </label>}
            {canEditInstructions && <label className="schedules-field workflows-md-field projects-edit-field">
              <span>{t('Instructions')}</span>
              <small>{editTarget.path === null
                ? t('Markdown instructions applied across all projects.')
                : t('Markdown instructions applied when working in this project.')}</small>
              <textarea aria-label={t('Instructions markdown')}
                value={editInsLoading ? t('Loading…') : (editIns ?? '')}
                disabled={editInsLoading || editBusy || editIns === null}
                spellCheck={false}
                placeholder={t('Markdown instructions for the model…')}
                onChange={(event) => setEditIns(event.currentTarget.value)} />
            </label>}
            {onMemoryControl && <section className="projects-memory-editor">
              <header className="projects-edit-field">
                <div><span>{t('Memories')}</span>
                  <small>{t('Create, edit, move, or delete project memories.')}</small></div>
                <button type="button" className="projects-memory-add-trigger"
                  disabled={memoryBusy || addingMemory}
                  aria-label={t('Add memory')} data-tooltip={t('Add memory')}
                  onClick={() => {
                    setAddingMemory(true);
                    setAddMemoryDraft('');
                    setAddMemoryTargetPath(editTarget.path ?? '');
                    setEditingMemory(null);
                    setConfirmDeleteMemory(null);
                  }}>
                  <Plus size={15} aria-hidden="true" />
                </button>
              </header>
              <div className={`projects-memory-viewport${memories.length || addingMemory ? '' : ' is-empty'}`}>
              {addingMemory && <div className="projects-memory-add-row">
                <div className="projects-memory-edit-fields">
                  <input aria-label={t('Memory text')} value={addMemoryDraft} maxLength={2000} autoFocus
                    disabled={memoryBusy} placeholder={t('What should Mixdog remember?')}
                    onChange={(event) => setAddMemoryDraft(event.currentTarget.value)} />
                  <label><span>{t('Project')}</span>
                    <select value={addMemoryTargetPath} disabled={memoryBusy}
                      onChange={(event) => setAddMemoryTargetPath(event.currentTarget.value)}>
                      <option value="">{t('Common')}</option>
                      {projects.map((project) => <option key={project.path} value={project.path}>
                        {project.alias?.trim() || project.name?.trim() || displayProjectFolder(project.path)}
                      </option>)}
                    </select>
                  </label>
                </div>
                <div className="core-memory-actions">
                  <button type="button" disabled={memoryBusy || !addMemoryDraft.trim()} onClick={() => {
                    if (!editTarget) return;
                    const targetPath = addMemoryTargetPath || null;
                    const summary = addMemoryDraft.trim();
                    setMemoryBusy(true);
                    setEditError('');
                    void onMemoryControl({
                      action: 'core', op: 'add', element: summary, summary, ...memoryScope(targetPath),
                    }).then((value) => {
                      const failure = memoryResultError(value);
                      if (failure) throw new Error(failure);
                      return refreshMemories(editTarget.path);
                    }).then(() => {
                      setAddingMemory(false);
                      setAddMemoryDraft('');
                      setAddMemoryTargetPath('');
                    }).catch((reason) => setEditError(reason instanceof Error ? reason.message : String(reason)))
                      .finally(() => setMemoryBusy(false));
                  }}>{t('Add')}</button>
                  <button type="button" disabled={memoryBusy} onClick={() => {
                    setAddingMemory(false);
                    setAddMemoryDraft('');
                    setAddMemoryTargetPath('');
                  }}>{t('Cancel')}</button>
                </div>
              </div>}
              {memoriesLoading ? <p className="projects-memory-empty">{t('Loading…')}</p>
                : memories.length ? <div className="core-memory-list">{memories.map((entry) =>
                  editingMemory === entry.id
                    ? <div className="core-memory-edit" key={entry.id}>
                      <div className="projects-memory-edit-fields">
                        <input aria-label={t('Memory text')} value={memoryDraft} maxLength={2000} autoFocus
                          disabled={memoryBusy} onChange={(event) => setMemoryDraft(event.currentTarget.value)} />
                        <label><span>{t('Project')}</span>
                          <select value={memoryTargetPath} disabled={memoryBusy}
                            onChange={(event) => setMemoryTargetPath(event.currentTarget.value)}>
                            <option value="">{t('Common')}</option>
                            {projects.map((project) => <option key={project.path} value={project.path}>
                              {project.alias?.trim() || project.name?.trim() || displayProjectFolder(project.path)}
                            </option>)}
                          </select>
                        </label>
                      </div>
                      <div className="core-memory-actions">
                        <button type="button" disabled={memoryBusy || !memoryDraft.trim()
                          || (memoryDraft.trim() === entry.summary && memoryTargetPath === (editTarget.path ?? ''))} onClick={() => {
                          if (!editTarget) return;
                          setMemoryBusy(true);
                          setEditError('');
                          const summary = memoryDraft.trim();
                          void onMemoryControl({
                            action: 'core', op: 'edit', id: entry.id,
                            element: entry.singleSentence ? summary : entry.element,
                            summary, ...memoryScope(editTarget.path),
                            ...(memoryTargetPath
                              ? { target_cwd: memoryTargetPath }
                              : { target_project_id: 'common' }),
                          }).then((value) => {
                            const failure = memoryResultError(value);
                            if (failure) throw new Error(failure);
                            return refreshMemories(editTarget.path);
                          }).then(() => setEditingMemory(null))
                            .catch((reason) => setEditError(reason instanceof Error ? reason.message : String(reason)))
                            .finally(() => setMemoryBusy(false));
                        }}>{t('Save')}</button>
                        <button type="button" disabled={memoryBusy} onClick={() => setEditingMemory(null)}>{t('Cancel')}</button>
                      </div>
                    </div>
                    : <div className="core-memory-row" key={entry.id}>
                      <div className="core-memory-copy"><span>{entry.summary}</span></div>
                      <div className="core-memory-actions">
                        <button type="button" disabled={memoryBusy} onClick={() => {
                          setEditingMemory(entry.id);
                          setMemoryDraft(entry.summary);
                          setMemoryTargetPath(editTarget.path ?? '');
                          setConfirmDeleteMemory(null);
                        }}>{t('Edit')}</button>
                        <button type="button" className="danger" disabled={memoryBusy} onClick={() => {
                          if (confirmDeleteMemory !== entry.id) {
                            setConfirmDeleteMemory(entry.id);
                            return;
                          }
                          if (!editTarget) return;
                          setMemoryBusy(true);
                          setEditError('');
                          void onMemoryControl({
                            action: 'core', op: 'delete', id: entry.id, ...memoryScope(editTarget.path),
                          }).then((value) => {
                            const failure = memoryResultError(value);
                            if (failure) throw new Error(failure);
                            return refreshMemories(editTarget.path);
                          }).then(() => setConfirmDeleteMemory(null))
                            .catch((reason) => setEditError(reason instanceof Error ? reason.message : String(reason)))
                            .finally(() => setMemoryBusy(false));
                        }}>{confirmDeleteMemory === entry.id ? t('Confirm delete') : t('Delete')}</button>
                      </div>
                    </div>)}</div>
                  : <p className="projects-memory-empty">{t('No memories yet.')}</p>}
              </div>
            </section>}
            <footer>
              {editError && <p className="schedules-form-error" role="alert">{editError}</p>}
              {editTarget.path !== null && <button type="button" className="danger" disabled={editBusy || memoryBusy}
                onClick={() => {
                  if (!editConfirmRemove) {
                    setEditConfirmRemove(true);
                    return;
                  }
                  const path = editTarget.path;
                  if (path === null) return;
                  resetEdit();
                  onRemove(path);
                }}>{editConfirmRemove ? t('Confirm remove') : t('Remove')}</button>}
              <button type="button" disabled={editBusy || memoryBusy} onClick={closeEdit}>{t('Cancel')}</button>
              <button type="submit" disabled={editBusy || editInsLoading || memoryBusy || addingMemory || editingMemory !== null}>{t('Save')}</button>
            </footer>
          </form>
        </section>
      </div>, document.body)}
      {canEditInstructions && <div className="schedules-list projects-list projects-common-instructions">
        <div className="schedules-row projects-row">
          <span className="projects-row-icon" aria-hidden="true"><NotebookPen size={16} /></span>
          <button type="button" className="schedules-row-copy projects-row-open"
            onClick={() => openEdit(null, 'Common Instructions')}>
            <b>{t('Common Instructions')}</b>
            <small>{t('Used for every project.')}</small>
          </button>
          <button type="button" className="session-panel-action projects-instructions-edit"
            aria-label={t('Edit common instructions')} data-tooltip={t('Edit')}
            onClick={() => openEdit(null, 'Common Instructions')}>
            <Pencil size={14} aria-hidden="true" />
          </button>
        </div>
      </div>}
      {visible.length ? <div className="schedules-list projects-list">{visible.map((project) => {
        const title = project.alias?.trim() || project.name?.trim() || displayProjectFolder(project.path);
        const selected = projectIdentity(selectedProjectPath) === projectIdentity(project.path);
        return <div key={project.path} className={`schedules-row projects-row${selected ? ' selected' : ''}`}>
          <span className="projects-row-icon" aria-hidden="true"><Folder size={16} /></span>
          {/* The row is a read-only entry (user: 클릭 없애 그냥) — clicking a
              project no longer mints a NEW TASK draft; only the pencil acts. */}
          <div className="schedules-row-copy projects-row-label"
            aria-current={selected ? 'page' : undefined}>
            <b>{title}</b>
            <small>{project.path}</small>
          </div>
          {/* Same pencil grammar as the Common Instructions row (user: 공통
              지침과 동일하게) — every mutation lives in the edit dialog. */}
          <button type="button" className="session-panel-action projects-instructions-edit"
            aria-label={t('Edit {{name}}', { name: title })} data-tooltip={t('Edit')}
            onClick={() => openEdit(project.path, title)}>
            <Pencil size={14} aria-hidden="true" />
          </button>
        </div>;
      })}</div>
        : <div className="schedules-empty">
          <Folder size={40} strokeWidth={1.5} aria-hidden="true" />
          <p>{projects.length ? t('No projects match the current search.') : t('No projects yet. Add a folder to make it available in Mixdog.')}</p>
        </div>}
    </div>
  </div>;
}

type CoreMemoryEntry = {
  id: number;
  element: string;
  summary: string;
  singleSentence: boolean;
};

function parseCoreMemoryEntries(value: unknown): CoreMemoryEntry[] {
  const entries: CoreMemoryEntry[] = [];
  for (const line of String(value || '').split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    const match = line.match(/^id=(\d+)\s+(.+?)(?:\s+—\s+(.+))?$/);
    if (!match) continue;
    const element = match[2];
    const rawSummary = match[3] || '';
    entries.push({
      id: Number(match[1]),
      element,
      summary: rawSummary || element,
      singleSentence: !rawSummary || element === rawSummary,
    });
  }
  return entries.sort((left, right) => right.id - left.id);
}

function memoryResultError(value: unknown): string {
  const text = String(value || '').trim();
  return /^(?:core (?:add|edit|delete)(?::| failed)|core:.*(?:not initialized|failed|error)|(?:error|failed)\b)/i.test(text)
    ? text
    : '';
}
