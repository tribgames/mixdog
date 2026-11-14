/**
 * `host/browser/screenshot`: a picture of the page, a rectangle of it, or the
 * element a snapshot ref names. The capture is the desktop's existing one
 * (`createBrowserScreenshotService`: CDP and native engines in the order the
 * page's foreground or background state wants, tiled full pages, and the
 * visual-privacy check that withholds a capture while a secret field the host
 * filled still holds a value or a password field has focus), so what is
 * refused today is refused here. A picture whose encoded bytes are over
 * 128 KiB is not sent inline: it goes to the core's blob store and the result
 * carries `blob`.
 */
import type { Rectangle, WebContents } from 'electron';

import type { HostBrowserScreenshotResult } from '../../../../../../packages/protocol/src/index.ts';
import type { createBrowserScreenshotService } from '../../browser/screenshot';
import { normalizeScreenshotOptions } from '../../browser/screenshot-policy';
import { HOST_INVALID_PARAMS, type HostConnection, HostRpcError } from '../connection';
import { uploadBlob } from './blob-upload';
import type { EngineContext } from './context';
import { requireCurrentSnapshot } from './ref-call';
import { registerEngineMethod } from './registry';

export const HOST_BROWSER_SCREENSHOT = 'host/browser/screenshot';

/** The largest encoded picture sent inline (128 KiB). */
export const MAX_INLINE_SCREENSHOT_BYTES = 128 * 1024;

type Screenshots = ReturnType<typeof createBrowserScreenshotService>;

export interface ScreenshotHost {
  screenshots: Pick<Screenshots, 'capture' | 'captureElement'>;
  /** `refPoints.resolveRefRect`: the viewport box of a ref's element, once the page confirms it is there. */
  resolveRefRect(guest: WebContents, ref: string, signal?: AbortSignal): Promise<Rectangle>;
  /** The page's JavaScript evaluation (`cdp.evaluate`), for the viewport geometry. */
  evaluate<T>(guest: WebContents, expression: string, signal?: AbortSignal): Promise<T>;
}

const PAGE_GEOMETRY = `(() => ({
  viewport: { width: Math.round(window.innerWidth), height: Math.round(window.innerHeight) },
  scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
}))()`;

function invalid(message: string): HostRpcError {
  return new HostRpcError(HOST_INVALID_PARAMS, message);
}

type Clip = { kind: 'ref'; snapshotId: string; ref: string } | { kind: 'rect'; rect: Rectangle };

function parseClip(value: unknown): Clip | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid('screenshot clip must be an object.');
  const { snapshotId, ref, x, y, width, height } = value as Record<string, unknown>;
  if (typeof ref === 'string' && typeof snapshotId === 'string' && ref && snapshotId) {
    return { kind: 'ref', snapshotId, ref };
  }
  if ([x, y, width, height].every((part) => typeof part === 'number' && Number.isFinite(part))) {
    return { kind: 'rect', rect: { x, y, width, height } as Rectangle };
  }
  throw invalid('screenshot clip must be {snapshotId, ref} or {x, y, width, height}.');
}

export function registerScreenshot(connection: HostConnection, ctx: EngineContext, host: ScreenshotHost): void {
  registerEngineMethod(connection, ctx, HOST_BROWSER_SCREENSHOT, async (params, signal, page) => {
    const { format, quality, fullPage, background } = params;
    if (format !== 'jpeg' && format !== 'png') throw invalid('screenshot format must be jpeg or png.');
    if (quality !== undefined && quality !== null && typeof quality !== 'number') {
      throw invalid('screenshot quality must be a number.');
    }
    const clip = parseClip(params.clip);
    const encoding = { format, ...(typeof quality === 'number' ? { quality } : {}) };
    try {
      normalizeScreenshotOptions({ ...encoding, fullPage: fullPage === true });
    } catch (error) {
      throw invalid((error as Error).message);
    }
    if (clip && fullPage === true) {
      throw invalid('screenshot fullPage captures the document; drop fullPage to capture a clip.');
    }
    const inBackground = background === true;

    let shot: { data: string; width: number; height: number; mimeType: string };
    if (!clip) {
      shot = await host.screenshots.capture(
        page.guest,
        inBackground,
        { ...encoding, fullPage: fullPage === true },
        signal
      );
    } else {
      let rect: Rectangle;
      if (clip.kind === 'ref') {
        requireCurrentSnapshot(page.state, clip.snapshotId);
        rect = await host.resolveRefRect(page.guest, clip.ref, signal);
      } else {
        rect = clip.rect;
      }
      const geometry = await host.evaluate<{
        viewport: { width: number; height: number };
        scroll: { x: number; y: number };
      }>(page.guest, PAGE_GEOMETRY, signal);
      shot = await host.screenshots.captureElement(page.guest, inBackground, encoding, rect, geometry, signal);
    }

    const { mimeType, width, height } = shot;
    const bytes = Buffer.from(shot.data, 'base64');
    const result: Omit<HostBrowserScreenshotResult, 'facts'> =
      bytes.byteLength <= MAX_INLINE_SCREENSHOT_BYTES
        ? { mimeType, width, height, data: shot.data }
        : { mimeType, width, height, blob: await uploadBlob(connection, bytes, mimeType) };
    return result;
  });
}
