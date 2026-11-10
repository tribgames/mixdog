/**
 * The in-app browser's live view on demand (SPEC §4.7.3): the core sends
 * `host/browser/viewFrames{tabId, streamId, on, request}` on the first and
 * last viewer; while `on`, this host keeps the page's screencast lease alive
 * and sends each frame's facts as `host/browser/frame` and its JPEG paint as
 * the X17 binary frame after them. Nothing is captured while nobody views.
 */
import type { HostBrowserFrameParams, HostBrowserViewFramesParams } from '../../../../../packages/protocol/src/index.ts';
import type { DesktopRemoteBrowserStreamFrame, DesktopRemoteBrowserStreamOptions } from '../../shared/contract';
import { HOST_INVALID_PARAMS, HOST_METHOD, type HostConnection, HostRpcError, objectParams } from './connection';
import { encodeMediaFrame, MEDIA_FLAG_FIT_FAILED, MEDIA_FLAG_FIT_SETTLED } from './media-frame';

/** Shorter than the stream's own 4 s lease, so a live viewer never lapses. */
const LEASE_RENEW_MS = 2_000;

export interface BrowserViewControl {
  /** Start or renew (options) or stop (null) streaming a session's page. */
  remoteBrowserStream(sessionId: string, options: DesktopRemoteBrowserStreamOptions | null): Promise<void>;
}

interface Viewing {
  streamId: number;
  options: DesktopRemoteBrowserStreamOptions;
  renew: NodeJS.Timeout;
}

function streamOptions(request: unknown): DesktopRemoteBrowserStreamOptions {
  const value = objectParams(request, HOST_METHOD.browserViewFrames);
  const { maxWidth, maxHeight, fit } = value;
  if (!Number.isFinite(maxWidth) || !Number.isFinite(maxHeight) || Number(maxWidth) <= 0 || Number(maxHeight) <= 0) {
    throw new HostRpcError(HOST_INVALID_PARAMS, 'viewFrames request needs positive maxWidth and maxHeight.');
  }
  return {
    maxWidth: Number(maxWidth),
    maxHeight: Number(maxHeight),
    ...(fit === null || (fit && typeof fit === 'object') ? { fit: fit as DesktopRemoteBrowserStreamOptions['fit'] } : {}),
  };
}

export function createBrowserView(
  connection: HostConnection,
  control: BrowserViewControl,
  /** A live view that could not start or renew. */
  onFailure: (error: unknown) => void
) {
  const viewing = new Map<string, Viewing>();

  function stop(tabId: string): void {
    const current = viewing.get(tabId);
    if (!current) return;
    viewing.delete(tabId);
    clearInterval(current.renew);
    void control.remoteBrowserStream(tabId, null).catch(() => undefined);
  }

  // Checked here, before the notification handler returns: an invalid one throws, as `host/notification/show` does.
  function parseFrames(params: unknown): { tabId: string; streamId: number; on: boolean; options: DesktopRemoteBrowserStreamOptions | null } {
    const { tabId, streamId, on, request } = objectParams<HostBrowserViewFramesParams>(params, HOST_METHOD.browserViewFrames);
    if (typeof tabId !== 'string' || !tabId || !Number.isSafeInteger(streamId) || typeof on !== 'boolean') {
      throw new HostRpcError(HOST_INVALID_PARAMS, 'viewFrames needs tabId, streamId and on.');
    }
    return { tabId, streamId: Number(streamId), on, options: on ? streamOptions(request) : null };
  }

  async function setFrames({ tabId, streamId, on, options }: ReturnType<typeof parseFrames>): Promise<void> {
    if (!on || !options) {
      stop(tabId);
      return;
    }
    const existing = viewing.get(tabId);
    if (existing) {
      existing.streamId = streamId;
      existing.options = options;
    } else {
      const entry: Viewing = {
        streamId,
        options,
        renew: setInterval(
          () => void control.remoteBrowserStream(tabId, entry.options).catch(() => undefined),
          LEASE_RENEW_MS
        ),
      };
      entry.renew.unref?.();
      viewing.set(tabId, entry);
    }
    await control.remoteBrowserStream(tabId, options);
  }

  // A server notification in the protocol: nothing answers it, so a stream that cannot start is reported.
  connection.handleNotification(HOST_METHOD.browserViewFrames, (params) => {
    void setFrames(parseFrames(params)).catch(onFailure);
  });
  connection.onClose(() => {
    for (const tabId of [...viewing.keys()]) stop(tabId);
  });

  return {
    /** The browser host's `publishRemoteFrame` (Node's `browserRemoteFrame`): the frame's facts as `host/browser/frame`, the
     *  picture they announce (`image` without `data`) as the X17 frame that follows, sent only for a JPEG paint of a viewed tab. */
    publishFrame(frame: DesktopRemoteBrowserStreamFrame): Promise<void> {
      let facts: DesktopRemoteBrowserStreamFrame = frame;
      if (frame.image) {
        const { data: _picture, ...image } = frame.image;
        facts = { ...frame, image: image as DesktopRemoteBrowserStreamFrame['image'] };
      }
      const params: Omit<HostBrowserFrameParams, 'frame'> & { frame: DesktopRemoteBrowserStreamFrame } = { tabId: frame.sessionId, frame: facts };
      connection.notify(HOST_METHOD.browserFrame, params);
      const current = viewing.get(frame.sessionId);
      if (!current || frame.image?.mimeType !== 'image/jpeg') return Promise.resolve();
      const flags = (frame.fitSettled ? MEDIA_FLAG_FIT_SETTLED : 0) | (frame.fitFailed ? MEDIA_FLAG_FIT_FAILED : 0);
      connection.sendBinary(
        encodeMediaFrame(
          {
            flags,
            streamId: current.streamId,
            width: Math.min(0xffff, Math.max(1, Math.round(frame.width))),
            height: Math.min(0xffff, Math.max(1, Math.round(frame.height))),
          },
          Buffer.from(frame.image.data, 'base64')
        )
      );
      return Promise.resolve();
    },
    viewingTabs: (): string[] => [...viewing.keys()],
  };
}
