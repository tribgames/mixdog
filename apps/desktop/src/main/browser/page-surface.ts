/** Local, user-initiated controls address a document, not a sampled image.
 * Agent and remote controls retain their own stricter observation contracts.
 * Frames come from page-surface-frame, controls from page-surface-control; the
 * per-guest presentation state they share lives in page-surface-state. */
import type { WebContents } from 'electron';
import type { DesktopBrowserTab } from '../../shared/contract';
import type { BrowserGuestCdp } from './cdp';
import type { BrowserGuestStateStore } from './guest-state';
import type { BrowserUrlPolicy } from './url-policy';
import type { BrowserScreenshotCapture } from './screenshot';
import type { BrowserDisplayTexture } from './display-textures';
import type { createBrowserInputDispatch } from './input-dispatch';
import type { createBrowserLocalPrompts } from './local-prompts';
import { createPageSurfaceState } from './page-surface-state';
import { createPageSurfaceFrame } from './page-surface-frame';
import { createPageSurfaceControl } from './page-surface-control';

export interface BrowserPageSurfaceHost {
  ensureGuest(sessionId: string, options: { reveal: false }): Promise<WebContents>;
  state: BrowserGuestStateStore;
  cdp: BrowserGuestCdp;
  dispatchInput?: ReturnType<typeof createBrowserInputDispatch>;
  prompts?: ReturnType<typeof createBrowserLocalPrompts>;
  urlPolicy: BrowserUrlPolicy;
  assertUrl(url: string, pageGenerated: boolean): Promise<void>;
  resize(guest: WebContents, width: number, height: number): void;
  viewport(guest: WebContents): { width: number; height: number; zoom: number };
  capture(
    guest: WebContents,
    geometryKey: string,
    viewport: { width: number; height: number },
    signal?: AbortSignal
  ): Promise<BrowserScreenshotCapture>;
  captureTexture?(
    guest: WebContents,
    documentId: string,
    viewport: { width: number; height: number }
  ): BrowserDisplayTexture | undefined;
  currentGuest?(sessionId: string): WebContents | null;
  tabs?: {
    list(sessionId: string): DesktopBrowserTab[];
    select(sessionId: string, tabId: string): void;
    create(sessionId: string): void;
    close(sessionId: string, tabId: string): void;
  };
}

export function createBrowserPageSurface(host: BrowserPageSurfaceHost) {
  const state = createPageSurfaceState(host);
  const { viewportChanges, paneSizes, presentedGuests, invalidateGeometry } = state;

  return {
    frame: createPageSurfaceFrame(host, state),
    control: createPageSurfaceControl(host, state),
    beginViewportChange(guest: WebContents): () => void {
      viewportChanges.set(guest, (viewportChanges.get(guest) ?? 0) + 1);
      invalidateGeometry(guest);
      return () => {
        const remaining = (viewportChanges.get(guest) ?? 1) - 1;
        if (remaining) viewportChanges.set(guest, remaining);
        else viewportChanges.delete(guest);
        invalidateGeometry(guest);
      };
    },
    release(sessionId: string) {
      paneSizes.delete(sessionId);
      presentedGuests.delete(sessionId);
    },
  };
}
