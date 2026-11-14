/**
 * `host/screen/displays {}` → the displays the whole-PC screen source can
 * stream, as the phone's picker lists them (RemoteScreenDisplaySummary[]).
 * The core asks this of the host for the paired phone's `browserRemoteScreenDisplays`
 * request; a display without a desktop-capture source is not in the provider's
 * list (createElectronScreenDisplays leaves it out), so none left answers [].
 */
import type { RemoteScreenDisplaySummary } from '../../shared/remote-webrtc';
import type { ScreenDisplay } from '../remote-screen/screen-geometry';
import { summarizeScreenDisplay } from '../remote-screen/screen-geometry';
import { type HostConnection, objectParams } from './connection';

export const HOST_SCREEN_DISPLAYS = 'host/screen/displays';

export interface ScreenDisplaysSource {
  list(): Promise<ScreenDisplay[]> | ScreenDisplay[];
}

export function registerScreenDisplaysHost(connection: HostConnection, displays: () => ScreenDisplaysSource): void {
  connection.handleRequest(HOST_SCREEN_DISPLAYS, async (params): Promise<RemoteScreenDisplaySummary[]> => {
    objectParams(params, HOST_SCREEN_DISPLAYS);
    return (await displays().list()).map(summarizeScreenDisplay);
  });
}
