import type { Dispatch, SetStateAction } from 'react';
import type { DesktopProjectSummary } from '../shared/contract';
import { errorMessage } from './editor-pane-session-errors';
import { t } from './i18n';
import { memoryResultError, type CoreMemoryEntry, type ProjectMemoryCatalog } from './project-editor-data';
import { displayProjectFolder } from './project-folder-label';

export type MemoryControl = (input: Record<string, unknown>) => Promise<unknown>;

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

type MemoryWriteIo = {
  onMemoryControl: MemoryControl;
  refreshMemories(afterWrite?: boolean): Promise<void>;
  setEditError(value: string): void;
  setMemoryBusy(value: boolean): void;
};

function submitMemoryWrite(io: MemoryWriteIo, input: Record<string, unknown>, onWritten?: () => void): void {
  io.setMemoryBusy(true);
  io.setEditError('');
  void writeMemory(io.onMemoryControl, input, () => io.refreshMemories(true))
    .then(onWritten)
    .catch((reason) => io.setEditError(errorMessage(reason)))
    .finally(() => io.setMemoryBusy(false));
}

/** Scope picker shared by the add row and every saved row: Common plus one
 *  option per project. */
function memoryScopeSelect({
  value,
  disabled,
  projects,
  memoryCatalog,
  onChange,
}: {
  value: string;
  disabled: boolean;
  projects: DesktopProjectSummary[];
  memoryCatalog: ProjectMemoryCatalog;
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
          <option key={project.path} value={project.path} disabled={!memoryCatalog.has(project.path)}>
            {project.alias || project.name || displayProjectFolder(project.path)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Add row of the memory editor. It shares the saved rows' vertical shape:
 *  text on top, then scope + actions on one line. */
export function memoryAddRow({
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
}: {
  addMemoryDraft: string;
  addMemoryScope: string;
  memoryBusy: boolean;
  projects: DesktopProjectSummary[];
  memoryCatalog: ProjectMemoryCatalog;
  onMemoryControl: MemoryControl;
  refreshMemories(afterWrite?: boolean): Promise<void>;
  setAddMemoryDraft(value: string): void;
  setAddMemoryScope(value: string): void;
  setAddingMemory(value: boolean): void;
  setEditError(value: string): void;
  setMemoryBusy(value: boolean): void;
}) {
  const target = memoryCatalog.get(addMemoryScope || null);
  return (
    <div className="projects-memory-add-row">
      <textarea
        aria-label={t('Memory text')}
        value={addMemoryDraft}
        // biome-ignore lint/a11y/noAutofocus: the row is revealed by an explicit "add memory" action and should take typing at once.
        autoFocus
        rows={3}
        disabled={memoryBusy}
        placeholder={t('What should be remembered?')}
        onChange={(event) => setAddMemoryDraft(event.currentTarget.value)}
      />
      <div className="projects-memory-row-foot">
        {memoryScopeSelect({
          value: addMemoryScope,
          disabled: memoryBusy,
          projects,
          memoryCatalog,
          onChange: setAddMemoryScope,
        })}
        <div className="core-memory-actions">
          <button
            type="button"
            disabled={memoryBusy || !target || !addMemoryDraft.trim()}
            onClick={() => {
              if (!target) return;
              submitMemoryWrite(
                { onMemoryControl, refreshMemories, setEditError, setMemoryBusy },
                {
                  action: 'core',
                  op: 'add',
                  summary: addMemoryDraft.trim(),
                  verbatim: true,
                  project_id: target.projectId ?? 'common',
                  ...(addMemoryScope ? { destination_cwd: addMemoryScope } : {}),
                },
                () => {
                  setAddingMemory(false);
                  setAddMemoryDraft('');
                }
              );
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
export function memoryEditRow({
  entry,
  moveTarget,
  memoryDrafts,
  memoryBusy,
  memoriesLoading,
  confirmDeleteMemory,
  sourceProjectId,
  projects,
  memoryCatalog,
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
  sourceProjectId: string | null;
  projects: DesktopProjectSummary[];
  memoryCatalog: ProjectMemoryCatalog;
  onMemoryControl: MemoryControl;
  refreshMemories(afterWrite?: boolean): Promise<void>;
  setMemoryDrafts: Dispatch<SetStateAction<Record<number, string>>>;
  setMoveTargets: Dispatch<SetStateAction<Record<number, string>>>;
  setConfirmDeleteMemory(value: number | null): void;
  setEditError(value: string): void;
  setMemoryBusy(value: boolean): void;
}) {
  const draft = memoryDrafts[entry.id] ?? entry.summary;
  const target = memoryCatalog.get(moveTarget || null);
  const source = sourceProjectId ?? 'common';
  return (
    <div className="core-memory-edit" key={entry.id}>
      <div className="projects-memory-row-head">
        <span className="projects-memory-index">#{entry.id}</span>
        {memoryScopeSelect({
          value: moveTarget,
          disabled: memoryBusy || memoriesLoading,
          projects,
          memoryCatalog,
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
            memoryBusy ||
            !target ||
            !draft.trim() ||
            (draft.trim() === entry.summary && target.projectId === sourceProjectId)
          }
          onClick={() => {
            if (!target) return;
            const summary = draft.trim();
            submitMemoryWrite(
              { onMemoryControl, refreshMemories, setEditError, setMemoryBusy },
              {
                action: 'core',
                op: 'edit',
                id: entry.id,
                index_revision: entry.indexRevision,
                element: entry.singleSentence ? summary : entry.element,
                summary,
                verbatim: true,
                project_id: source,
                target_project_id: target.projectId ?? 'common',
                ...(moveTarget ? { destination_cwd: moveTarget } : {}),
              }
            );
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
            submitMemoryWrite(
              { onMemoryControl, refreshMemories, setEditError, setMemoryBusy },
              {
                action: 'core',
                op: 'delete',
                id: entry.id,
                index_revision: entry.indexRevision,
                project_id: source,
              },
              () => setConfirmDeleteMemory(null)
            );
          }}
        >
          {confirmDeleteMemory === entry.id ? t('Confirm delete') : t('Delete')}
        </button>
      </div>
    </div>
  );
}
