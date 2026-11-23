export type SidePanelMode = 'close-left' | 'close-right' | 'close-both' | 'keep-open';

const SIDE_PANEL_MODE_KEY = 'mixdog.desktop.side-panel-mode.v1';
const CHANGE_EVENT = 'mixdog:side-panel-mode-changed';
const DEFAULT_MODE: SidePanelMode = 'close-both';
let fallbackMode: SidePanelMode = DEFAULT_MODE;

function isSidePanelMode(value: string | null): value is SidePanelMode {
  return value === 'close-left' || value === 'close-right' || value === 'close-both' || value === 'keep-open';
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

export function setSidePanelMode(mode: SidePanelMode): boolean {
  fallbackMode = isSidePanelMode(mode) ? mode : DEFAULT_MODE;
  let persisted = false;
  try {
    window.localStorage.setItem(SIDE_PANEL_MODE_KEY, fallbackMode);
    persisted = true;
  } catch {
    // The current renderer still applies the in-memory preference.
  }
  try {
    window.dispatchEvent(new window.Event(CHANGE_EVENT));
  } catch {
    // Non-browser imports keep the in-memory preference only.
  }
  return persisted;
}

export function subscribeSidePanelMode(listener: () => void): () => void {
  const onChange = () => listener();
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => window.removeEventListener(CHANGE_EVENT, onChange);
}

/** Where the per-pane side dock sits on desktop: beside the chat, below it, or
 *  chosen from the window shape. The phone keeps its overlay sheet. */
export type SidePanelPosition = 'right' | 'bottom' | 'auto';
export type SidePanelPlacement = 'right' | 'bottom';

const SIDE_PANEL_POSITION_KEY = 'mixdog.desktop.side-panel-position.v1';
const POSITION_CHANGE_EVENT = 'mixdog:side-panel-position-changed';
const DEFAULT_POSITION: SidePanelPosition = 'right';
/** Auto docks the panel BELOW the chat under this window width (CSS px), or
 *  whenever the window is portrait (taller than wide). Beside the chat the
 *  dock needs the chat's 360px floor, the 280px dock floor (500px for the
 *  browser default), the rail and the session sidebar: below ~1100px the
 *  chat is squeezed to its floor as soon as the browser opens. */
export const SIDE_PANEL_AUTO_BOTTOM_MAX_WIDTH = 1100;
let fallbackPosition: SidePanelPosition = DEFAULT_POSITION;

/** Unknown or missing stored values fall back to the right dock. */
export function normalizeSidePanelPosition(value: unknown): SidePanelPosition {
  return value === 'right' || value === 'bottom' || value === 'auto' ? value : DEFAULT_POSITION;
}

export function getSidePanelPosition(): SidePanelPosition {
  try {
    fallbackPosition = normalizeSidePanelPosition(window.localStorage.getItem(SIDE_PANEL_POSITION_KEY));
  } catch {
    // Desktop-local layout preferences degrade to the in-memory value.
  }
  return fallbackPosition;
}

export function setSidePanelPosition(position: SidePanelPosition): boolean {
  fallbackPosition = normalizeSidePanelPosition(position);
  let persisted = false;
  try {
    window.localStorage.setItem(SIDE_PANEL_POSITION_KEY, fallbackPosition);
    persisted = true;
  } catch {
    // The current renderer still applies the in-memory preference.
  }
  try {
    window.dispatchEvent(new window.Event(POSITION_CHANGE_EVENT));
  } catch {
    // Non-browser imports keep the in-memory preference only.
  }
  return persisted;
}

export function subscribeSidePanelPosition(listener: () => void): () => void {
  const onChange = () => listener();
  window.addEventListener(POSITION_CHANGE_EVENT, onChange);
  return () => window.removeEventListener(POSITION_CHANGE_EVENT, onChange);
}

/** Whether a session's info shows in the session panel on desktop (the pane
 *  header's toggle); not shown, the composer island carries it. Opened or
 *  closed by hand only: an open panel shows at every pane width, in the
 *  presentation that width gives. Stored as 'auto' (shown) or 'island' (not
 *  shown), the values earlier builds wrote; their 'none' reads as not shown. */
const SESSION_INFO_DISPLAY_KEY = 'mixdog.desktop.session-info-display.v1';
const SESSION_INFO_DISPLAY_CHANGE_EVENT = 'mixdog:session-info-display-changed';
let fallbackSessionPanelShown = true;

/** A missing or unknown stored value shows the panel. */
function storedSessionPanelShown(value: string | null): boolean {
  return value !== 'island' && value !== 'none';
}

export function getSessionPanelShown(): boolean {
  try {
    fallbackSessionPanelShown = storedSessionPanelShown(window.localStorage.getItem(SESSION_INFO_DISPLAY_KEY));
  } catch {
    // Desktop-local layout preferences degrade to the in-memory value.
  }
  return fallbackSessionPanelShown;
}

export function setSessionPanelShown(shown: boolean): boolean {
  fallbackSessionPanelShown = shown;
  let persisted = false;
  try {
    window.localStorage.setItem(SESSION_INFO_DISPLAY_KEY, shown ? 'auto' : 'island');
    persisted = true;
  } catch {
    // The current renderer still applies the in-memory preference.
  }
  try {
    window.dispatchEvent(new window.Event(SESSION_INFO_DISPLAY_CHANGE_EVENT));
  } catch {
    // Non-browser imports keep the in-memory preference only.
  }
  return persisted;
}

export function subscribeSessionPanelShown(listener: () => void): () => void {
  const onChange = () => listener();
  // Another window of the app changed the choice.
  const onStorage = (event: StorageEvent) => {
    if (event.key === SESSION_INFO_DISPLAY_KEY || event.key === null) listener();
  };
  window.addEventListener(SESSION_INFO_DISPLAY_CHANGE_EVENT, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(SESSION_INFO_DISPLAY_CHANGE_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
  };
}

/** The placement a position resolves to in a window of this size. */
export function resolveSidePanelPlacement(
  position: SidePanelPosition,
  windowWidth: number,
  windowHeight: number
): SidePanelPlacement {
  if (position !== 'auto') return position;
  const narrow = windowWidth > 0 && windowWidth < SIDE_PANEL_AUTO_BOTTOM_MAX_WIDTH;
  const portrait = windowWidth > 0 && windowHeight > windowWidth;
  return narrow || portrait ? 'bottom' : 'right';
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
