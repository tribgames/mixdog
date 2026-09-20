/** The ordered backends one capture may try for its target: the app's own
 *  window, the compositor, then the window-owned native surfaces. */
import { desktopCapturer, type NativeImage } from 'electron';
import { DESKTOP_CAPTURE_TIMEOUT_MS, OWNED_CAPTURE_TIMEOUT_MS, withTimeout } from '../shared/common';
import type { CaptureAttempt, CaptureBackend } from '../shared/capture-attempts';
import type { ComputerCommand } from '../shared/types';
import { nativeWindowSurface, type NativeSurfaceHost } from './capture-native-surface';
import { CaptureSourceError, type Surface } from './capture-source-attempt';
import { electronWindowForNativeId } from './window-handles';
import { computerCaptureSize } from '../../../../../../src/runtime/computer-bridge/capture-size.mjs';

export interface CaptureSourceRequest {
  command: ComputerCommand;
  sourceType: 'screen' | 'window';
  sourceTitle: string;
  windowId: string;
  displayId: string;
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  maxWidth: number;
  preserveResolution?: boolean;
  attempts: CaptureAttempt[];
}

export interface CapturePlanEntry {
  backend: CaptureBackend;
  acquire: () => Promise<Surface>;
}

export function fitCaptureImage(image: NativeImage, maxWidth: number): NativeImage {
  const size = image.getSize();
  const fitted = computerCaptureSize(size.width, size.height, maxWidth);
  return size.width === fitted.width && size.height === fitted.height
    ? image
    : image.resize({ ...fitted, quality: 'best' });
}

async function compositedSurface(request: CaptureSourceRequest): Promise<Surface> {
  const { sourceType, windowId, displayId, width, height, maxWidth, preserveResolution = false } = request;
  const sources = await withTimeout(
    desktopCapturer.getSources({
      types: [sourceType],
      thumbnailSize: preserveResolution ? { width, height } : computerCaptureSize(width, height, maxWidth),
    }),
    DESKTOP_CAPTURE_TIMEOUT_MS,
    'capture_timeout: desktop capture'
  );
  const handle = Number.parseInt(windowId.replace(/^hwnd:/i, '').replace(/^0x/i, ''), 16);
  const source =
    sourceType === 'screen'
      ? sources.find((value) => value.display_id === displayId)
      : sources.find(
          (value) =>
            Number.isFinite(handle) && value.id.startsWith('window:') && Number(value.id.split(':')[1]) === handle
        );
  if (!source) throw new CaptureSourceError(`capture_source_unavailable: exact ${sourceType} source is unavailable`);
  return { image: source.thumbnail, sourceId: source.id, sourceName: source.name, route: 'composited' };
}

export function buildCapturePlan(host: NativeSurfaceHost, request: CaptureSourceRequest): CapturePlanEntry[] {
  const { command, sourceTitle, windowId, maxWidth, preserveResolution = false, attempts } = request;
  const owned = windowId ? electronWindowForNativeId(windowId) : null;
  const plan: CapturePlanEntry[] = [];
  if (owned && !owned.isDestroyed() && !owned.webContents.isDestroyed()) {
    plan.push({
      backend: 'app_owned',
      acquire: async () => {
        const image = await withTimeout(
          owned.capturePage(),
          OWNED_CAPTURE_TIMEOUT_MS,
          'capture_timeout: app-owned capture'
        );
        return {
          image: preserveResolution ? image : fitCaptureImage(image, maxWidth),
          sourceId: `browser-window:${windowId}`,
          sourceName: sourceTitle,
          route: 'app_owned',
        };
      },
    });
  }
  plan.push({ backend: 'composited', acquire: () => compositedSurface(request) });
  if (windowId)
    for (const backend of ['print_window', 'wgc'] as const) {
      plan.push({ backend, acquire: () => nativeWindowSurface(host, command, windowId, backend, attempts) });
    }
  return plan;
}
