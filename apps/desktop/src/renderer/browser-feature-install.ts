import { useEffect, useState } from 'react';
import { desktopSettingsFromConfig } from '../shared/desktop-settings';
import { isSshConnectionWindow } from './desktop-connection';
import { REMOTE_CONNECTION_READY_EVENT } from './remote-connection-state';
import { useSection, windowSectionStore } from './section-store';
import { readDesktopStatus } from './settings/desktop-status-cache';
import { useDesktopStatus } from './settings/use-desktop-status';

/** The last known marker outlives the renderer, so the first paint of the next
 *  start already draws every Browser Use entry. It only stands in while the section is unknown. */
const BROWSER_FEATURE_INSTALLED_KEY = 'mixdog.desktop.browser-feature-installed.v1';

function readStoredBrowserFeatureInstalled(): boolean | null {
  try {
    const stored = window.localStorage.getItem(BROWSER_FEATURE_INSTALLED_KEY);
    if (stored === 'true') return true;
    return stored === 'false' ? false : null;
  } catch {
    return null;
  }
}

// A server window has no browser pane: the pane drives this PC's browser.
const browserPaneUnavailable = isSshConnectionWindow();

/** `null` while the marker is still unknown: callers hide the entry instead of
 *  painting one that disappears a frame later. */
export function useBrowserFeatureInstalled(): boolean | null {
  const desktop = useSection<unknown>('config', 'desktop');
  const [lastKnown] = useState(readStoredBrowserFeatureInstalled);
  // A section the core published as a stub (null) carries no value either.
  const held =
    desktop && typeof desktop === 'object' && !Array.isArray(desktop)
      ? desktopSettingsFromConfig({ desktop }).browserInstalled
      : null;
  const api = window.mixdogDesktop;
  const fallbackNeeded = !browserPaneUnavailable && !windowSectionStore();
  const settings = useDesktopStatus(api, 'settings', fallbackNeeded);
  // biome-ignore lint/correctness/useExhaustiveDependencies: api is the window bridge read each render, listed so the listeners follow a replaced bridge
  useEffect(() => {
    if (!fallbackNeeded) return;
    const refresh = () => void readDesktopStatus(api, 'settings')?.catch(() => undefined);
    window.addEventListener(REMOTE_CONNECTION_READY_EVENT, refresh);
    window.addEventListener('mixdog:built-in-features-changed', refresh);
    return () => {
      window.removeEventListener(REMOTE_CONNECTION_READY_EVENT, refresh);
      window.removeEventListener('mixdog:built-in-features-changed', refresh);
    };
  }, [api, fallbackNeeded]);
  const installed = held ?? (fallbackNeeded ? settings?.browserInstalled : null) ?? null;
  useEffect(() => {
    if (installed === null || browserPaneUnavailable) return;
    try {
      window.localStorage.setItem(BROWSER_FEATURE_INSTALLED_KEY, String(installed));
    } catch {
      /* session-only */
    }
  }, [installed]);
  return browserPaneUnavailable ? false : (installed ?? lastKnown);
}
