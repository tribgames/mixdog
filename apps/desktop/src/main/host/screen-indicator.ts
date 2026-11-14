/**
 * The on-PC pill of a phone's screen session, driven by the core (the screen sessions run there).
 * `host/screen/indicator {state, screenId, clientLabel?, controlling?}` shows, relabels or hides one
 * session's place on the pill; one pill serves every active phone (screen-indicator-core.ts), and its Stop
 * ends every session, which this reports as one `host/screen/indicator/stop {screenId}` per session.
 * The pill's window is injected, so this module stays Electron-free.
 */
import type { RemoteScreenIndicatorHandle, RemoteScreenIndicatorOptions } from '../remote-screen/screen-indicator-core';
import { HOST_INVALID_PARAMS, HostRpcError, objectParams, type HostConnection } from './connection';

export const HOST_SCREEN_INDICATOR = 'host/screen/indicator';
export const HOST_SCREEN_INDICATOR_STOP = 'host/screen/indicator/stop';

/** The longest session id the core sends (a display id). */
const MAX_SCREEN_ID = 128;

/** Shows a session's place on the pill (the Electron pill: remote-screen/screen-indicator.ts). */
export type ShowScreenIndicator = (options: RemoteScreenIndicatorOptions) => RemoteScreenIndicatorHandle;

/** The Electron display a session views: its screen id is that display's id; any other id shows on the primary display. */
function displayOf(screenId: string): number | undefined {
  const id = Number(screenId);
  return Number.isSafeInteger(id) && String(id) === screenId ? id : undefined;
}

/**
 * Serves `host/screen/indicator`. Returns what closes every place still shown (the connection closed: no session of
 * the core remains).
 */
export function registerScreenIndicatorHost(
  connection: Pick<HostConnection, 'handleRequest' | 'notify' | 'onClose'>,
  show: ShowScreenIndicator
): () => void {
  const shown = new Map<string, RemoteScreenIndicatorHandle>();
  const closeAll = (): void => {
    for (const handle of shown.values()) handle.close();
    shown.clear();
  };
  connection.handleRequest(HOST_SCREEN_INDICATOR, async (params): Promise<Record<string, never>> => {
    const { state, screenId, clientLabel } = objectParams(params, HOST_SCREEN_INDICATOR);
    if (typeof screenId !== 'string' || screenId.length === 0 || screenId.length > MAX_SCREEN_ID) {
      throw new HostRpcError(HOST_INVALID_PARAMS, `${HOST_SCREEN_INDICATOR}: screenId is a short string`);
    }
    if (clientLabel !== undefined && typeof clientLabel !== 'string') {
      throw new HostRpcError(HOST_INVALID_PARAMS, `${HOST_SCREEN_INDICATOR}: clientLabel is a string`);
    }
    if (state === 'show') {
      // A session of the display that was not hidden is replaced by this one.
      shown.get(screenId)?.close();
      shown.set(
        screenId,
        show({
          deviceLabel: clientLabel ?? '',
          displayId: displayOf(screenId),
          onStop: () => connection.notify(HOST_SCREEN_INDICATOR_STOP, { screenId }),
        })
      );
    } else if (state === 'update') {
      if (clientLabel !== undefined) shown.get(screenId)?.update(clientLabel);
    } else if (state === 'hide') {
      shown.get(screenId)?.close();
      shown.delete(screenId);
    } else {
      throw new HostRpcError(HOST_INVALID_PARAMS, `${HOST_SCREEN_INDICATOR}: state is show, update or hide`);
    }
    return {};
  });
  connection.onClose(closeAll);
  return closeAll;
}
