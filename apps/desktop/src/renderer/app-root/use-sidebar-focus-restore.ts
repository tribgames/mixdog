import { useEffect } from 'react';

/** When the sidebar closes around focused content, hand focus back to its rail button. */
export function restoreSidebarFocus(sidebar: Element | null = document.getElementById('session-sidebar')): void {
  if (!sidebar?.contains(document.activeElement)) return;
  const rail = document.querySelector<HTMLButtonElement>('.activity-rail [data-side-view="sessions"]');
  if (rail) rail.focus();
  else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

export function useSidebarFocusRestore(sidebarOpen: boolean) {
  useEffect(() => {
    if (!sidebarOpen) restoreSidebarFocus();
  }, [sidebarOpen]);
}
