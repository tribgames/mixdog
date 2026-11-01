/** The ordered backends one capture may try for its target: the app's own
 *  window, the window-owned native surfaces, then the compositor. */
import { desktopCapturer, type NativeImage } from 'electron';
import { DESKTOP_CAPTURE_TIMEOUT_MS, OWNED_CAPTURE_TIMEOUT_MS, withTimeout } from '../shared/common';
import type { CaptureAttempt, CaptureBackend } from '../shared/capture-attempts';
import type { ComputerCommand } from '../shared/types';
import { nativeWindowSurface, type NativeSurfaceHost } from './capture-native-surface';
import { CaptureSourceError, type Bounds, type Surface } from './capture-source-attempt';
import { gnomeShellSourceId, gnomeWindowHandle, usesGnomeHelper, type GnomeShellSource } from '../host/gnome-helper';
import { captureGnomeShellSource } from './gnome-shell-capture';
import { electronWindowForNativeId } from './window-handles';
import { computerCaptureSize } from '../../../../../../src/runtime/computer-bridge/capture-size.mjs';

/** Ceiling for one GNOME Shell screenshot; above the 10 s gdbus call timeout
 *  (gnome-helper.ts) so the helper's own timeout error surfaces first. */
const GNOME_SHELL_CAPTURE_TIMEOUT_MS = 12_000;

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
  client?: Bounds;
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

/** GNOME Wayland: the shell extension's pixels, never a portal prompt. */
async function gnomeShellSurface(request: CaptureSourceRequest): Promise<Surface> {
  const { sourceType, windowId, displayId, width, height, maxWidth, sourceTitle, preserveResolution = false } = request;
  let source: GnomeShellSource;
  if (sourceType === 'screen') source = { kind: 'screen', displayId };
  else {
    const handle = gnomeWindowHandle(windowId);
    if (handle === null) throw new CaptureSourceError('capture_source_unavailable: exact window source is unavailable');
    source = { kind: 'window', handle };
  }
  const size = preserveResolution ? { width, height } : computerCaptureSize(width, height, maxWidth);
  try {
    const image = await withTimeout(
      captureGnomeShellSource(source, size),
      GNOME_SHELL_CAPTURE_TIMEOUT_MS,
      'capture_timeout: GNOME shell capture'
    );
    return { image, sourceId: gnomeShellSourceId(source), sourceName: sourceTitle || sourceType, route: 'composited' };
  } catch (error) {
    throw error instanceof CaptureSourceError
      ? error
      : new CaptureSourceError(error instanceof Error ? error.message : String(error));
  }
}

async function compositedSurface(request: CaptureSourceRequest): Promise<Surface> {
  if (usesGnomeHelper()) return gnomeShellSurface(request);
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

/** The default order, then the window's remembered winner moved to the front.
 *  Nothing is dropped or repeated, so every backend and frame check the full
 *  order applies still applies to the survivors of a failed preference.
 *
 *  A Windows window is read through its own surface first (PrintWindow, then
 *  WGC when that frame is black), as the cua reference does, and the
 *  compositor last: its thumbnail enumeration of every window failed on 66% of
 *  captures (~420 ms unavailable, or the 2 s timeout) and, when it worked,
 *  averaged ~550 ms against ~50 ms for PrintWindow and ~310 ms for WGC. Screens
 *  and platforms without native surfaces keep the compositor as the only path. */
export function buildCapturePlan(
  host: NativeSurfaceHost,
  request: CaptureSourceRequest,
  preferred?: CaptureBackend
): CapturePlanEntry[] {
  const plan = defaultCapturePlan(host, request);
  const index = preferred ? plan.findIndex((entry) => entry.backend === preferred) : -1;
  if (index > 0) plan.unshift(...plan.splice(index, 1));
  return plan;
}

function defaultCapturePlan(host: NativeSurfaceHost, request: CaptureSourceRequest): CapturePlanEntry[] {
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
  if (windowId)
    for (const backend of host.nativeSurfaceBackends) {
      plan.push({
        backend,
        acquire: () => nativeWindowSurface(host, command, windowId, backend, attempts, request.client),
      });
    }
  plan.push({ backend: 'composited', acquire: () => compositedSurface(request) });
  return plan;
}
