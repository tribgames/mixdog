// Phone sheet pane switching. The sheet has no title/icon bar: every pane's own
// PC header is the top row, so Changes / Browser / Terminal / … live in that
// header's ⋯ menu. Terminal and browser draw their header in their own React
// roots, so the dock publishes the items through this module-level store and
// each DockHeaderRow reads it.
import { Monitor } from 'lucide-react';
import { startTransition, useMemo, useSyncExternalStore } from 'react';

import { t } from './i18n';
import type { DockAction } from './pane-dock-chrome';
import { openRemoteScreen, remoteScreenAvailable } from './remote-screen-request';

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

/** The last ⋯ item: the PC's whole screen, full-screen. Only a phone whose
 *  host offers it gets one; the panes before it are unchanged. */
export function phoneDockScreenAction(available: boolean, separatorBefore: boolean): DockAction | null {
  return available
    ? {
        id: 'switch-pc-screen',
        label: t('View entire PC screen'),
        icon: Monitor,
        separatorBefore,
        onSelect: () => startTransition(openRemoteScreen),
      }
    : null;
}

/** The switch items as ⋯ menu actions (empty off the phone sheet). */
export function usePhoneDockSwitchActions(enabled: boolean): DockAction[] {
  const current = useSyncExternalStore(
    subscribe,
    () => items,
    () => items
  );
  const screenAvailable = enabled && remoteScreenAvailable(window.mixdogDesktop, true);
  return useMemo(() => {
    if (!enabled) return [];
    const switches: DockAction[] = current.map((item, index) => ({
      id: `switch-${item.id}`,
      label: item.label,
      icon: item.icon,
      disabled: item.disabled || item.active,
      separatorBefore: index === 0,
      // The menu closes on the tap's own frame; the pane switch (a whole
      // app render on a phone's CPU) commits right after, like the
      // header toggles' press (pane-dock-toggles).
      onSelect: () => startTransition(() => select(item.id)),
    }));
    const screen = phoneDockScreenAction(screenAvailable, current.length === 0);
    return screen ? [...switches, screen] : switches;
  }, [current, enabled, screenAvailable]);
}
