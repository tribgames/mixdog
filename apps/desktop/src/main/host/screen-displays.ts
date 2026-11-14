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
