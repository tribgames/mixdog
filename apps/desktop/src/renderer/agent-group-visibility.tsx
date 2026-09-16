import { useSyncExternalStore } from 'react';
import { RowOverflowMenu } from './RowOverflowMenu';
import { t } from './i18n';

const STORAGE_KEY = 'mixdog.agent-hidden-groups';
const stores = new WeakMap<Window, ReturnType<typeof createStore>>();
/** The dock header and the title-less pane toolbar control the same tree. */
export const AGENT_GROUP_EXPANSION_EVENT = 'mixdog:agent-group-expansion';

function parseIds(value: string | null): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(value || '[]');
    return new Set(Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : []);
  } catch { return new Set(); }
}

function createStore(host: Window) {
  const read = (): ReadonlySet<string> => {
    try { return parseIds(host.localStorage.getItem(STORAGE_KEY)); }
    catch { return new Set(); }
  };
  let ids = read();
  const listeners = new Set<() => void>();
  const publish = () => { for (const listener of listeners) listener(); };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    ids = read();
    publish();
  };
  const update = (next: ReadonlySet<string>) => {
    ids = next;
    try { host.localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids])); }
    catch { /* Storage-less hosts retain the choice for this window. */ }
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

export function AgentGroupsMenu() {
  const { hiddenOwnerIds, restoreGroups } = useHiddenAgentGroups();
  const setAllExpanded = (expanded: boolean) => window.dispatchEvent(
    new window.CustomEvent(AGENT_GROUP_EXPANSION_EVENT, { detail: expanded }),
  );
  return <RowOverflowMenu label={t('Agent group actions')} items={[{
    id: 'collapse-agent-groups',
    label: t('Collapse all'),
    onSelect: () => setAllExpanded(false),
  }, {
    id: 'expand-agent-groups',
    label: t('Expand all'),
    onSelect: () => setAllExpanded(true),
  }, {
    id: 'restore-agent-groups',
    label: t('Show hidden groups'),
    separatorBefore: true,
    disabled: hiddenOwnerIds.size === 0,
    onSelect: restoreGroups,
  }]} />;
}
