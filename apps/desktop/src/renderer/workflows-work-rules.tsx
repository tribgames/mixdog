import { ChevronRight, Layers3, Plus } from 'lucide-react';
import type { RecordValue } from './desktop-types';
import { t } from './i18n';
import { contextMenuRowProps, type ScmContextMenuState } from './ScmContextMenu';
import type { usePersistedListOrder } from './use-persisted-list-order';

type RowMenuOpener = (label: string, point: { x: number; y: number }, items: ScmContextMenuState['items']) => void;

/** The Work rules list: one row per workflow pack, opening its editor; a
 *  user pack's menu offers Delete (Reset to defaults for a saved copy of a
 *  shipped pack). */
export function WorkRulesSection({
  workflows,
  orderedWorkflows,
  busy,
  getReorderProps,
  later,
  onNew,
  onOpen,
  openRowMenu,
}: {
  workflows: readonly RecordValue[];
  orderedWorkflows: readonly RecordValue[];
  busy: boolean;
  getReorderProps: ReturnType<typeof usePersistedListOrder>['getReorderProps'];
  later(action: () => void): () => void;
  onNew(): void;
  onOpen(id: string, name: string, deletable: boolean, armDelete?: boolean): void;
  openRowMenu: RowMenuOpener;
}) {
  return (
    <section className="workflows-models workflows-packs" aria-label={t('Work rules')}>
      <div className="workflows-section-head">
        <h2>{t('Work rules')}</h2>
        <button
          type="button"
          className="session-panel-action schedules-new"
          disabled={busy}
          aria-label={t('New workflow')}
          data-tooltip={t('New workflow')}
          onClick={onNew}
        >
          <Plus size={16} aria-hidden="true" />
        </button>
      </div>
      {workflows.length > 0 && (
        <div className="schedules-list">
          {orderedWorkflows.map((workflow) => {
            const id = String(workflow.id || '');
            const name = String(workflow.name || id);
            const custom = String(workflow.source || '') === 'user';
            // A saved copy of a shipped pack: deleting it brings the shipped version back.
            const overridesBuiltIn = custom && workflow.overridesBuiltIn === true;
            const description = String(workflow.description || '');
            const shownDescription =
              description && String(workflow.source || '') === 'built-in' ? t(description) : description;
            return (
              <button
                type="button"
                key={id}
                className="schedules-row utilities-row sidebar-resource-row"
                disabled={busy}
                aria-label={t('Edit workflow {{name}}', { name })}
                data-tooltip={shownDescription || undefined}
                onClick={() => onOpen(id, name, custom)}
                {...contextMenuRowProps((point) =>
                  openRowMenu(name, point, [
                    { id: 'edit', label: t('Edit'), onSelect: later(() => onOpen(id, name, custom)) },
                    ...(custom
                      ? [
                          {
                            id: 'delete',
                            label: overridesBuiltIn ? t('Reset to defaults') : t('Delete'),
                            danger: true,
                            separatorBefore: true,
                            onSelect: later(() => onOpen(id, name, true, true)),
                          },
                        ]
                      : []),
                  ])
                )}
                {...getReorderProps(id)}
              >
                <span className="sidebar-resource-icon" aria-hidden="true">
                  <Layers3 size={16} />
                </span>
                <span className="schedules-row-copy utilities-row-copy">
                  <b>{name}</b>
                  <small>{[shownDescription, custom ? t('Custom') : ''].filter(Boolean).join(' · ')}</small>
                </span>
                <ChevronRight className="utilities-row-chevron" size={16} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      )}
      {workflows.length === 0 && (
        <div className="utility-dock-empty">
          <p>{t('No workflows.')}</p>
        </div>
      )}
    </section>
  );
}
