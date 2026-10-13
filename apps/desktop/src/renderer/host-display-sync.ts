// A browser paired with a host PC shows that PC's theme and UI language until the
// user picks their own here (display-preference-source.ts). Reads the host's
// choice on mount, on every (re)connection, and whenever the host announces a
// settings change — the same channel the rail pins use to stay in step.
import type { DesktopApi } from '../shared/contract';
import { readHostDisplayPreferences } from '../shared/host-display-preferences';
import { markHostDisplayChoice } from './display-preference-source';
import { adoptHostThemePreference, hasLocalThemeChoice } from './desktop-theme';
import { adoptHostUiLanguage, hasLocalUiLanguageChoice } from './i18n';
import { REMOTE_CONNECTION_READY_EVENT } from './remote-connection-state';
import { isRemoteBrowserRenderer } from './remote-ui-projection';

type HostDisplayApi = Pick<Partial<DesktopApi>, 'readHostDisplayPreferences' | 'subscribeSettingsChanged'>;

/** Fired on window after the host's theme replaced this device's. */
export const HOST_DISPLAY_ADOPTED_EVENT = 'mixdog:host-display-adopted';

/** Apply the host's choice for every setting this device has no choice of its own for. */
export function applyHostDisplayPreferences(value: unknown, reload: () => void = () => window.location.reload()): void {
  const host = readHostDisplayPreferences(value);
  if (!host) return;
  if (host.theme && !hasLocalThemeChoice() && adoptHostThemePreference(host.theme)) {
    window.dispatchEvent(new window.Event(HOST_DISPLAY_ADOPTED_EVENT));
  }
  if (host.language && !hasLocalUiLanguageChoice() && adoptHostUiLanguage(host.language)) reload();
}

/** Drop this device's own theme/language choice and take the host PC's again. */
export async function followHostDisplay(api: HostDisplayApi, reload?: () => void): Promise<void> {
  const host = readHostDisplayPreferences(await api.readHostDisplayPreferences?.());
  if (!host) return;
  // Only a setting the host actually states is handed back: the rest keeps its own choice.
  if (host.theme) markHostDisplayChoice('theme');
  if (host.language) markHostDisplayChoice('language');
  applyHostDisplayPreferences(host, reload);
}

export function installHostDisplaySync(
  api: HostDisplayApi | undefined = window.mixdogDesktop,
  reload?: () => void
): () => void {
  // Only the remote shim carries the read; Electron windows keep their own choice.
  if (!api?.readHostDisplayPreferences || !isRemoteBrowserRenderer()) return () => {};
  const read = api.readHostDisplayPreferences.bind(api);
  let live = true;
  const refresh = () => {
    // An interrupted or unsupported read (older host) leaves this device's own look.
    void read()
      .then((preferences) => {
        if (live) applyHostDisplayPreferences(preferences, reload);
      })
      .catch(() => undefined);
  };
  const unsubscribe = api.subscribeSettingsChanged?.(refresh);
  window.addEventListener(REMOTE_CONNECTION_READY_EVENT, refresh);
  refresh();
  return () => {
    live = false;
    unsubscribe?.();
    window.removeEventListener(REMOTE_CONNECTION_READY_EVENT, refresh);
  };
}
