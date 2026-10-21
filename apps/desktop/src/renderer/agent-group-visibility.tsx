import { useSyncExternalStore } from 'react';
import { RowOverflowMenu } from './RowOverflowMenu';
import { t } from './i18n';
import { sectionLabel } from './agent-section-order';
import { PANE_TOGGLE_IDS, RETAIN_CHOICES, type PaneToggleId, type RetainChoice } from './bot-order-store';

const STORAGE_KEY = 'mixdog.agent-hidden-groups';
const stores = new WeakMap<Window, ReturnType<typeof createStore>>();
/** The dock header and the title-less pane toolbar control the same tree. */
export const AGENT_GROUP_EXPANSION_EVENT = 'mixdog:agent-group-expansion';

function parseIds(value: string | null): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(value || '[]');
    return new Set(
      Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
    );
  } catch {
    return new Set();
  }
}

function createStore(host: Window) {
  const read = (): ReadonlySet<string> => {
    try {
      return parseIds(host.localStorage.getItem(STORAGE_KEY));
    } catch {
      return new Set();
    }
  };
  let ids = read();
  const listeners = new Set<() => void>();
  const publish = () => {
    for (const listener of listeners) listener();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    ids = read();
    publish();
  };
  const update = (next: ReadonlySet<string>) => {
    ids = next;
    try {
      host.localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
    } catch {
      /* Storage-less hosts retain the choice for this window. */
    }
    publish();
  };
  return {
    getSnapshot: () => ids,
    subscribe(listener: () => void) {
      if (listeners.size === 0) host.addEventListener('storage', onStorage);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) host.removeEventListener('storage', onStorage);
      };
    },
    hide: (ownerId: string) => update(new Set([...ids, ownerId])),
    restore: () => update(new Set()),
  };
}

export function useHiddenAgentGroups() {
  let store = stores.get(window);
  if (!store) {
    store = createStore(window);
    stores.set(window, store);
  }
  const hiddenOwnerIds = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { hiddenOwnerIds, hideGroup: store.hide, restoreGroups: store.restore };
}

const groupLabel = (id: PaneToggleId): string =>
  id === 'representative' ? t('Representative bot') : id === 'connectors' ? t('Connectors') : sectionLabel(id);

const RETAIN_LABELS: Record<RetainChoice, () => string> = {
  '1h': () => t('1 hour'),
  '1d': () => t('1 day'),
  '7d': () => t('7 days'),
  forever: () => t('Forever'),
};
const retainLabel = (choice: RetainChoice): string => RETAIN_LABELS[choice]();

export function AgentGroupsMenu({
  hiddenGroups,
  onToggleGroup,
  retain,
  onRetain,
}: {
  /** The Bots page's hidden groups, with a toggle for each (page header only). */
  hiddenGroups?: ReadonlySet<PaneToggleId>;
  onToggleGroup?(id: PaneToggleId, hidden: boolean): void;
  /** How long finished Leads stay listed, as radio choices (page header only). */
  retain?: RetainChoice;
  onRetain?(choice: RetainChoice): void;
} = {}) {
  const { hiddenOwnerIds, restoreGroups } = useHiddenAgentGroups();
  const setAllExpanded = (expanded: boolean) =>
    window.dispatchEvent(new window.CustomEvent(AGENT_GROUP_EXPANSION_EVENT, { detail: expanded }));
  return (
    <RowOverflowMenu
      label={t('Agent group actions')}
      items={[
        {
          id: 'collapse-agent-groups',
          label: t('Collapse all'),
          onSelect: () => setAllExpanded(false),
        },
        {
          id: 'expand-agent-groups',
          label: t('Expand all'),
          onSelect: () => setAllExpanded(true),
        },
        {
          id: 'restore-agent-groups',
          label: t('Show hidden groups'),
          separatorBefore: true,
          disabled: hiddenOwnerIds.size === 0,
          onSelect: restoreGroups,
        },
        ...(hiddenGroups && onToggleGroup
          ? PANE_TOGGLE_IDS.map((id, index) => ({
              id: `show-group-${id}`,
              label: groupLabel(id),
              checked: !hiddenGroups.has(id),
              separatorBefore: index === 0,
              closeOnSelect: false,
              onSelect: () => onToggleGroup(id, !hiddenGroups.has(id)),
            }))
          : []),
        ...(retain && onRetain
          ? [
              {
                id: 'keep-finished-agents',
                label: t('Keep finished agents'),
                separatorBefore: true,
                disabled: true,
              },
              ...RETAIN_CHOICES.map((choice) => ({
                id: `retain-${choice}`,
                label: retainLabel(choice),
                checked: retain === choice,
                radio: true,
                closeOnSelect: false,
                onSelect: () => onRetain(choice),
              })),
            ]
          : []),
      ]}
    />
  );
}
