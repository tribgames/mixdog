import React, { useState } from 'react';
import { Folder, FolderPlus, Search, X } from 'lucide-react';

import type { DesktopProjectSummary } from '../shared/contract';
import { projectIdentity } from './session-sidebar';

function displayProjectFolder(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path;
}

// Projects page (sidebar -> Projects): the Schedules-page grammar — a
// main-pane list with search and per-row actions — replacing the old popup
// switcher. Pin/unpin was dropped with the popup. Add project opens a small
// in-place dialog (Name + folder via the native chooser) instead of
// navigating away (user decision).
export function ProjectsPane({
  active = true,
  projects,
  selectedProjectPath,
  onChooseFolder,
  onCreateProject,
  onOpenProject,
  onStartProjectTask,
  onOpenExplorer,
  onRename,
  onRemove,
}: {
  active?: boolean;
  projects: DesktopProjectSummary[];
  selectedProjectPath: string;
  onChooseFolder(): Promise<string | null>;
  onCreateProject(path: string, name: string): Promise<void>;
  onOpenProject(path: string): void;
  onStartProjectTask(path: string): void;
  onOpenExplorer(path: string): void;
  onRename(path: string, alias: string): void;
  onRemove(path: string): void;
}) {
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState('');
  const [renameDraft, setRenameDraft] = useState('');
  const [confirmingRemove, setConfirmingRemove] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [addPath, setAddPath] = useState('');
  const [addName, setAddName] = useState('');
  const [addError, setAddError] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const closeAdd = () => {
    setAddOpen(false);
    setAddPath('');
    setAddName('');
    setAddError('');
  };
  const text = query.trim().toLowerCase();
  const visible = projects.filter((project) => {
    if (!text) return true;
    return [project.alias, project.name, project.path]
      .map((value) => String(value || '').toLowerCase()).join(' ').includes(text);
  });

  return <div className="schedules-pane projects-pane" style={active ? undefined : { display: 'none' }}>
    <div className="schedules-page">
      <header className="schedules-page-header">
        <div>
          <h1>Projects</h1>
          <p>Choose the workspace for your next task.</p>
        </div>
        <button type="button" className="settings-action schedules-new projects-add"
          onClick={() => setAddOpen(true)}>
          <FolderPlus size={14} aria-hidden="true" />Add project</button>
      </header>
      {addOpen && <div className="schedules-dialog-layer"
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
            <h2 id="projects-add-title">Add project</h2>
            <button type="button" aria-label="Close add project" onClick={closeAdd}>
              <X size={15} aria-hidden="true" /></button>
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
            <label className="schedules-field">Name
              <input name="project-name" value={addName} maxLength={120} autoFocus disabled={addBusy}
                placeholder="my-project"
                onChange={(event) => setAddName(event.currentTarget.value)} />
            </label>
            <div className="schedules-field">
              <span>Folder</span>
              <div className="projects-folder-row">
                <code>{addPath || 'No folder selected'}</code>
                {/* Folder comes from the OS chooser only (user decision):
                    prefill the Name with the folder's basename once picked. */}
                <button type="button" className="settings-action" disabled={addBusy}
                  onClick={() => void onChooseFolder().then((selected) => {
                    if (!selected) return;
                    setAddPath(selected);
                    setAddName((current) => current.trim() ? current : displayProjectFolder(selected));
                    setAddError('');
                  })}>Browse…</button>
              </div>
            </div>
            <footer>
              {addError && <p className="schedules-form-error" role="alert">{addError}</p>}
              <button type="button" disabled={addBusy} onClick={closeAdd}>Cancel</button>
              <button type="submit" disabled={addBusy || !addPath}>Add</button>
            </footer>
          </form>
        </section>
      </div>}
      <div className="schedules-search">
        <Search size={14} aria-hidden="true" />
        <input aria-label="Search projects" placeholder="Search projects…" value={query}
          onChange={(event) => setQuery(event.currentTarget.value)} />
      </div>
      {visible.length ? <div className="schedules-list projects-list">{visible.map((project) => {
        const title = project.alias?.trim() || project.name?.trim() || displayProjectFolder(project.path);
        const selected = projectIdentity(selectedProjectPath) === projectIdentity(project.path);
        return <div key={project.path} className={`schedules-row projects-row${selected ? ' selected' : ''}`}>
          <span className="projects-row-icon" aria-hidden="true"><Folder size={16} /></span>
          {renaming === project.path
            ? <form className="projects-rename" onSubmit={(event) => {
              event.preventDefault();
              const alias = renameDraft.trim();
              setRenaming('');
              if (alias && alias !== title) onRename(project.path, alias);
            }}>
              <input value={renameDraft} maxLength={120} autoFocus aria-label="Project display name"
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setRenameDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape') return;
                  event.preventDefault();
                  setRenaming('');
                }}
                onBlur={() => setRenaming('')} />
            </form>
            : <button type="button" className="schedules-row-copy projects-row-open"
              aria-current={selected ? 'page' : undefined}
              onClick={() => onOpenProject(project.path)}>
              <b>{title}</b>
              <small>{project.path}</small>
            </button>}
          <div className="schedules-row-actions">
            <button type="button" className="settings-action"
              onClick={() => onStartProjectTask(project.path)}>New task</button>
            <button type="button" className="settings-action"
              onClick={() => onOpenExplorer(project.path)}>Explorer</button>
            <button type="button" className="settings-action"
              onClick={() => {
                setConfirmingRemove('');
                setRenameDraft(title);
                setRenaming(project.path);
              }}>Rename</button>
            <button type="button" className="settings-action danger"
              onClick={() => {
                if (confirmingRemove !== project.path) {
                  setConfirmingRemove(project.path);
                  return;
                }
                setConfirmingRemove('');
                onRemove(project.path);
              }}>{confirmingRemove === project.path ? 'Confirm remove' : 'Remove'}</button>
          </div>
        </div>;
      })}</div>
        : <div className="schedules-empty">
          <Folder size={40} strokeWidth={1.5} aria-hidden="true" />
          <p>{projects.length ? 'No projects match the current search.' : 'No projects yet. Add a folder to make it available in Mixdog.'}</p>
        </div>}
    </div>
  </div>;
}
