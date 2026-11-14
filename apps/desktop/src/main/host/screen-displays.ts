/**
 * `host/screen/displays {}` → the displays the whole-PC screen source can
 * stream, as the phone's picker lists them (RemoteScreenDisplaySummary[]).
 * The core asks this of the host for the paired phone's `browser/screenDisplays`
 * request (live_view.rs). The provider is the screen sources' own `displays()`
 * (fresh capture ids, summarized with summarizeScreenDisplay; a display without
 * a desktop-capture source is left out, so none left answers []).
 */
import type { RemoteScreenDisplaySummary } from '../../shared/remote-webrtc';
import { type HostConnection, objectParams } from './connection';

export const HOST_SCREEN_DISPLAYS = 'host/screen/displays';

export interface ScreenDisplaysSource {
  list(): Promise<RemoteScreenDisplaySummary[]> | RemoteScreenDisplaySummary[];
}

export function registerScreenDisplaysHost(connection: HostConnection, displays: () => ScreenDisplaysSource): void {
  connection.handleRequest(HOST_SCREEN_DISPLAYS, async (params): Promise<RemoteScreenDisplaySummary[]> => {
    objectParams(params, HOST_SCREEN_DISPLAYS);
    return displays().list();
  });
}

export const HOST_SCREEN_DISPLAYS_CHANGED = 'host/screen/displaysChanged';

/** The screen events that change what the picker lists or what a session maps its pointer through. */
const DISPLAY_EVENTS = ['display-added', 'display-removed', 'display-metrics-changed'] as const;

interface DisplayEvents {
  on(event: (typeof DISPLAY_EVENTS)[number], listener: () => void): unknown;
  removeListener(event: (typeof DISPLAY_EVENTS)[number], listener: () => void): unknown;
}

/**
 * Tells the core that a display was added, removed or rescaled, so it reads `host/computer/displays` again and every
 * phone screen session renews its geometry. Returns the function that stops reporting.
 */
export function reportScreenDisplayChanges(connection: Pick<HostConnection, 'notify'>, screen: DisplayEvents): () => void {
  const report = () => connection.notify(HOST_SCREEN_DISPLAYS_CHANGED, {});
  for (const event of DISPLAY_EVENTS) screen.on(event, report);
  return () => {
    for (const event of DISPLAY_EVENTS) screen.removeListener(event, report);
  };
}
