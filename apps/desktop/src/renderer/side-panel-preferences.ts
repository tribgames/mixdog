export type SidePanelMode = 'close-left' | 'close-right' | 'close-both' | 'keep-open';

const SIDE_PANEL_MODE_KEY = 'mixdog.desktop.side-panel-mode.v1';
export const SIDE_PANEL_MOTION_MS = 180;
export const SIDE_PANEL_EASING = 'cubic-bezier(.2, .8, .2, 1)';
const CHANGE_EVENT = 'mixdog:side-panel-mode-changed';
const DEFAULT_MODE: SidePanelMode = 'close-both';
let fallbackMode: SidePanelMode = DEFAULT_MODE;

function isSidePanelMode(value: string | null): value is SidePanelMode {
  return value === 'close-left' || value === 'close-right' ||
    value === 'close-both' || value === 'keep-open';
}

export function getSidePanelMode(): SidePanelMode {
  try {
    const stored = window.localStorage.getItem(SIDE_PANEL_MODE_KEY);
    fallbackMode = isSidePanelMode(stored) ? stored : DEFAULT_MODE;
  } catch {
    // Desktop-local layout preferences degrade to the in-memory default.
  }
  return fallbackMode;
}

export function setSidePanelMode(mode: SidePanelMode): void {
  fallbackMode = isSidePanelMode(mode) ? mode : DEFAULT_MODE;
  try {
    window.localStorage.setItem(SIDE_PANEL_MODE_KEY, fallbackMode);
  } catch {
    // The current renderer still applies the in-memory preference.
  }
  try {
    window.dispatchEvent(new window.Event(CHANGE_EVENT));
  } catch {
    // Non-browser imports keep the in-memory preference only.
  }
}

export function subscribeSidePanelMode(listener: () => void): () => void {
  const onChange = () => listener();
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => window.removeEventListener(CHANGE_EVENT, onChange);
}

export function sidePanelLayout(mode: SidePanelMode): {
  sidebarOpen: boolean;
  dockOpen: boolean;
  sidebarLockedOpen: boolean;
  dockLockedOpen: boolean;
} {
  return {
    sidebarOpen: mode === 'close-right' || mode === 'keep-open',
    dockOpen: mode === 'close-left' || mode === 'keep-open',
    sidebarLockedOpen: mode === 'close-right' || mode === 'keep-open',
    dockLockedOpen: mode === 'close-left' || mode === 'keep-open',
  };
}
