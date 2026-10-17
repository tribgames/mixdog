// Phone sheet pane switching. The sheet has no title/icon bar: every pane's own
// PC header is the top row, so Changes / Browser / Terminal / … live in that
// header's ⋯ menu. Terminal and browser draw their header in their own React
// roots, so the dock publishes the items through this module-level store and
// each DockHeaderRow reads it.
import { startTransition, useMemo, useSyncExternalStore } from 'react';

import type { DockAction } from './pane-dock-chrome';

export interface PhoneDockSwitchItem {
  id: string;
  label: string;
  icon: DockAction['icon'];
  /** The pane already showing; listed, but not selectable. */
  active: boolean;
  disabled: boolean;
}

let items: readonly PhoneDockSwitchItem[] = [];
let select: (id: string) => void = () => {};
const listeners = new Set<() => void>();

const same = (a: readonly PhoneDockSwitchItem[], b: readonly PhoneDockSwitchItem[]) =>
  a.length === b.length &&
  a.every(
    (item, index) =>
      item.id === b[index].id &&
      item.label === b[index].label &&
      item.icon === b[index].icon &&
      item.active === b[index].active &&
      item.disabled === b[index].disabled
  );

/** Called by the phone dock on every render; the handler is always the newest,
 *  subscribers are notified only when the item list changes. */
export function publishPhoneDockSwitch(next: readonly PhoneDockSwitchItem[], onSelect: (id: string) => void): void {
  select = onSelect;
  if (same(items, next)) return;
  items = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The switch items as ⋯ menu actions (empty off the phone sheet). */
export function usePhoneDockSwitchActions(enabled: boolean): DockAction[] {
  const current = useSyncExternalStore(
    subscribe,
    () => items,
    () => items
  );
  return useMemo(
    () =>
      enabled
        ? current.map((item, index) => ({
            id: `switch-${item.id}`,
            label: item.label,
            icon: item.icon,
            disabled: item.disabled || item.active,
            separatorBefore: index === 0,
            // The menu closes on the tap's own frame; the pane switch (a whole
            // app render on a phone's CPU) commits right after, like the
            // header toggles' press (pane-dock-toggles).
            onSelect: () => startTransition(() => select(item.id)),
          }))
        : [],
    [current, enabled]
  );
}
