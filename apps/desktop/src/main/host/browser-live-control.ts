/**
 * `host/browser/liveControl{sessionId, kind, request}` → null: a phone's live-view control that is
 * not page input. `resize` carries its `resize-request` object, `videoLimit` its
 * `ready.videoLimit`; both go to the streamed page's remote control (browser/remote-control.ts).
 * A malformed request is `-32602`; the lazily resolved control exists once the browser does.
 */
import type { HostBrowserLiveControlParams } from '../../../../../packages/protocol/src/index.ts';
import type { RemoteWebrtcResize, RemoteWebrtcVideoLimit } from '../../shared/remote-webrtc';
import { HOST_INVALID_PARAMS, type HostConnection, HostRpcError, objectParams } from './connection';

const LIVE_CONTROL_METHOD = 'host/browser/liveControl';

export interface BrowserLiveControl {
  resize(sessionId: string, request: RemoteWebrtcResize): Promise<void>;
  widenVideo(sessionId: string, limit: RemoteWebrtcVideoLimit): void;
}

function invalid(what: string): never {
  throw new HostRpcError(HOST_INVALID_PARAMS, `${LIVE_CONTROL_METHOD} ${what}.`);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${what} must be an object`);
  return value as Record<string, unknown>;
}

function positive(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) invalid(`${what} must be a positive number`);
  return value as number;
}

function resizeRequest(value: unknown): RemoteWebrtcResize {
  const input = record(value, 'request');
  if (input.mode === 'page') return { mode: 'page' };
  if (input.mode !== 'fit-client') invalid('resize mode must be page or fit-client');
  return {
    mode: 'fit-client',
    cssWidth: positive(input.cssWidth, 'cssWidth'),
    cssHeight: positive(input.cssHeight, 'cssHeight'),
    deviceScaleFactor: positive(input.deviceScaleFactor, 'deviceScaleFactor'),
  };
}

export function registerBrowserLiveControlHost(connection: HostConnection, control: () => BrowserLiveControl): void {
  connection.handleRequest(LIVE_CONTROL_METHOD, async (params): Promise<null> => {
    const { sessionId, kind, request } = objectParams<HostBrowserLiveControlParams>(params, LIVE_CONTROL_METHOD);
    if (typeof sessionId !== 'string' || sessionId === '') invalid('needs a sessionId');
    if (kind === 'resize') {
      await control().resize(sessionId as string, resizeRequest(request));
    } else if (kind === 'videoLimit') {
      const limit = record(request, 'request');
      control().widenVideo(sessionId as string, {
        maxWidth: positive(limit.maxWidth, 'maxWidth'),
        maxHeight: positive(limit.maxHeight, 'maxHeight'),
      });
    } else {
      invalid('kind must be resize or videoLimit');
    }
    return null;
  });
}
