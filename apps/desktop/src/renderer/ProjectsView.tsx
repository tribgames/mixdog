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
  onOpenProject,
  onRename,
  onRemove,
  instructionsSupported = false,
  onReadInstructions,
  onSaveInstructions,
}: {
  active?: boolean;
  projects: DesktopProjectSummary[];
  selectedProjectPath: string;
  onChooseFolder(): Promise<string | null>;
  onCreateProject(path: string, name: string): Promise<void>;
  onOpenProject(path: string): void;
  onRename(path: string, alias: string): void;
  onRemove(path: string): void;
  /** Instructions editing needs the desktop bridge; the remote shim omits it. */
  instructionsSupported?: boolean;
  onReadInstructions?(projectPath: string | null): Promise<string>;
  onSaveInstructions?(projectPath: string | null, content: string): Promise<void>;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [addPath, setAddPath] = useState('');
  const [addName, setAddName] = useState('');
  const [addError, setAddError] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  // Instructions editor (md plain text). target.path === null edits the common
  // instructions file (data/instructions.md → "# Common Instructions" in BP3);
  // a project path edits <project>/.mixdog/instructions.md (session-start block).
  const [insTarget, setInsTarget] = useState<{ path: string | null; title: string } | null>(null);
  const [insDraft, setInsDraft] = useState('');
  const [insLoading, setInsLoading] = useState(false);
  const [insBusy, setInsBusy] = useState(false);
  const [insError, setInsError] = useState('');
  // Per-project edit dialog (user: 공통지침과 동일하게 연필 버튼 하나 —
  // 이름 변경/삭제/지침 수정을 그 안에서). editIns === null means the
  // instructions never loaded (unsupported or failed) and stays untouched.
  const [editTarget, setEditTarget] = useState<{ path: string; title: string } | null>(null);
  const [editName, setEditName] = useState('');
  const [editIns, setEditIns] = useState<string | null>(null);
  const [editInsLoading, setEditInsLoading] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState('');
  const [editConfirmRemove, setEditConfirmRemove] = useState(false);
  // The dialog scrims cannot dim the NATIVE caption band — hold the titlebar
  // claim while either portal is open (user: - ㅁ x 딤드 안 먹음).
  useEffect(() => {
    if (!(active && addOpen)) return;
    return acquireTitleBarDim();
  }, [active, addOpen]);
  useEffect(() => {
    if (!(active && insTarget)) return;
    return acquireTitleBarDim();
  }, [active, insTarget]);
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
  const openInstructions = (path: string | null, title: string) => {
    if (!onReadInstructions) return;
    setInsTarget({ path, title });
    setInsDraft('');
    setInsError('');
    setInsLoading(true);
    void onReadInstructions(path)
      .then((text) => setInsDraft(String(text ?? '')))
      .catch((reason) => setInsError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setInsLoading(false));
  };
  const closeInstructions = () => {
    if (insBusy) return;
    setInsTarget(null);
    setInsDraft('');
    setInsError('');
  };
  const openEdit = (path: string, title: string) => {
    setEditTarget({ path, title });
    setEditName(title);
    setEditIns(null);
    setEditError('');
    setEditConfirmRemove(false);
    if (canEditInstructions && onReadInstructions) {
      setEditInsLoading(true);
      void onReadInstructions(path)
        .then((text) => setEditIns(String(text ?? '')))
        .catch((reason) => setEditError(reason instanceof Error ? reason.message : String(reason)))
        .finally(() => setEditInsLoading(false));
    }
  };
  const resetEdit = () => {
    setEditTarget(null);
    setEditName('');
    setEditIns(null);
    setEditError('');
    setEditConfirmRemove(false);
  };
  const closeEdit = () => {
    if (editBusy) return;
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
    setInsTarget(null);
    setInsDraft('');
    setInsError('');
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
            <label className="schedules-field">{t('Name')}
              <input name="project-name" value={addName} maxLength={120} autoFocus disabled={addBusy}
                placeholder={t('my-project')}
                onChange={(event) => setAddName(event.currentTarget.value)} />
            </label>
            <div className="schedules-field">
              <span>{t('Folder')}</span>
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
      {active && insTarget && createPortal(<div className="schedules-dialog-layer"
        onMouseDown={(event) => { if (event.target === event.currentTarget) closeInstructions(); }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeInstructions();
          }
        }}>
        <section className="schedules-dialog projects-instructions-dialog" role="dialog" aria-modal="true"
          aria-labelledby="projects-instructions-title">
          <header>
            <h2 id="projects-instructions-title">{insTarget.title}</h2>
            <button type="button" aria-label={t('Close instructions editor')} onClick={closeInstructions}>
              <X size={16} aria-hidden="true" /></button>
          </header>
          <form onSubmit={(event) => {
            event.preventDefault();
            if (insBusy || insLoading || !onSaveInstructions || !insTarget) return;
            setInsBusy(true);
            setInsError('');
            void onSaveInstructions(insTarget.path, insDraft)
              .then(() => { setInsBusy(false); setInsTarget(null); setInsDraft(''); })
              .catch((reason) => {
                setInsBusy(false);
                setInsError(reason instanceof Error ? reason.message : String(reason));
              });
          }}>
            {/* EXACT workflow-editor field grammar (user: 옵션창에서 쓰는
                거로) — same label + bare textarea as the WORKFLOW.md body. */}
            <label className="schedules-field workflows-md-field">{t('Instructions')}
              <textarea aria-label={t('Instructions markdown')}
                value={insLoading ? t('Loading…') : insDraft} disabled={insLoading || insBusy}
                spellCheck={false} autoFocus
                placeholder={t('Markdown instructions for the model…')}
                onChange={(event) => setInsDraft(event.currentTarget.value)} />
            </label>
            <footer>
              {insError && <p className="schedules-form-error" role="alert">{insError}</p>}
              <button type="button" disabled={insBusy} onClick={closeInstructions}>{t('Cancel')}</button>
              <button type="submit" disabled={insBusy || insLoading}>{t('Save')}</button>
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
            if (!editTarget || editBusy || editInsLoading) return;
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
              if (alias && alias !== title) onRename(path, alias);
              setEditBusy(false);
              resetEdit();
            }).catch((reason) => {
              setEditBusy(false);
              setEditError(reason instanceof Error ? reason.message : String(reason));
            });
          }}>
            <label className="schedules-field">{t('Name')}
              <input name="project-alias" value={editName} maxLength={120} autoFocus
                disabled={editBusy} aria-label={t('Project display name')}
                onChange={(event) => setEditName(event.currentTarget.value)} />
            </label>
            {canEditInstructions && <label className="schedules-field workflows-md-field">{t('Instructions')}
              <textarea aria-label={t('Instructions markdown')}
                value={editInsLoading ? t('Loading…') : (editIns ?? '')}
                disabled={editInsLoading || editBusy || editIns === null}
                spellCheck={false}
                placeholder={t('Markdown instructions for the model…')}
                onChange={(event) => setEditIns(event.currentTarget.value)} />
            </label>}
            <footer>
              {editError && <p className="schedules-form-error" role="alert">{editError}</p>}
              <button type="button" className="danger" disabled={editBusy}
                onClick={() => {
                  if (!editConfirmRemove) {
                    setEditConfirmRemove(true);
                    return;
                  }
                  const path = editTarget.path;
                  resetEdit();
                  onRemove(path);
                }}>{editConfirmRemove ? t('Confirm remove') : t('Remove')}</button>
              <button type="button" disabled={editBusy} onClick={closeEdit}>{t('Cancel')}</button>
              <button type="submit" disabled={editBusy || editInsLoading}>{t('Save')}</button>
            </footer>
          </form>
        </section>
      </div>, document.body)}
      {canEditInstructions && <div className="schedules-list projects-list projects-common-instructions">
        <div className="schedules-row projects-row">
          <span className="projects-row-icon" aria-hidden="true"><NotebookPen size={16} /></span>
          <button type="button" className="schedules-row-copy projects-row-open"
            onClick={() => openInstructions(null, 'Common Instructions')}>
            <b>{t('Common Instructions')}</b>
            <small>{t('Applies to all projects')}</small>
          </button>
          <button type="button" className="session-panel-action projects-instructions-edit"
            aria-label={t('Edit common instructions')} data-tooltip={t('Edit')}
            onClick={() => openInstructions(null, 'Common Instructions')}>
            <Pencil size={14} aria-hidden="true" />
          </button>
        </div>
      </div>}
      {visible.length ? <div className="schedules-list projects-list">{visible.map((project) => {
        const title = project.alias?.trim() || project.name?.trim() || displayProjectFolder(project.path);
        const selected = projectIdentity(selectedProjectPath) === projectIdentity(project.path);
        return <div key={project.path} className={`schedules-row projects-row${selected ? ' selected' : ''}`}>
          <span className="projects-row-icon" aria-hidden="true"><Folder size={16} /></span>
          <button type="button" className="schedules-row-copy projects-row-open"
            aria-current={selected ? 'page' : undefined}
            onClick={() => onOpenProject(project.path)}>
            <b>{title}</b>
            <small>{project.path}</small>
          </button>
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
