/** What the page surface remembers per guest and per session: the last sampled
 *  image, geometry revisions, in-flight viewport changes, pane sizes, and which
 *  guest a session currently presents. */
import type { WebContents } from 'electron';
import { browserDocumentId, type BrowserGuestStateStore } from './guest-state';
import type { BrowserScreenshotCapture } from './screenshot';

export type Size = { width: number; height: number };

interface PageSurfaceStateHost {
  state: BrowserGuestStateStore;
  currentGuest?(sessionId: string): WebContents | null;
  resize(guest: WebContents, width: number, height: number): Size | null;
}

export function createPageSurfaceState(host: PageSurfaceStateHost) {
  const images = new WeakMap<
    WebContents,
    { shot: BrowserScreenshotCapture; id: string; documentId: string; geometryKey: string }
  >();
  const geometryRevisions = new WeakMap<WebContents, number>();
  const viewportChanges = new WeakMap<WebContents, number>();
  const paneSizes = new Map<string, { width: number; height: number }>();
  const presentedGuests = new Map<string, WebContents>();
  const invalidateGeometry = (guest: WebContents) => {
    geometryRevisions.set(guest, (geometryRevisions.get(guest) ?? 0) + 1);
    images.delete(guest);
  };
  /** The pane size last requested for a guest and the content size its window
   *  took for it. At a fractional display scale the window may land a DIP off
   *  the request; while it keeps exactly that size, its frames answer the
   *  pane's request and present as the requested surface. */
  const paneRequests = new WeakMap<WebContents, { requested: Size; landed: Size }>();
  /** An offscreen page reads the display scale only when it resizes. The scale
   *  generation counts primary-scale changes; each guest remembers the one it
   *  was last sized at, so a page that was not presented during a change is
   *  moved off its size and back the next time it is sized. */
  let scaleGeneration = 0;
  const sizedAtScale = new WeakMap<WebContents, number>();
  const bumpScale = () => {
    scaleGeneration += 1;
  };
  const resizeGuest = (guest: WebContents, size: Size) => {
    if ((sizedAtScale.get(guest) ?? 0) !== scaleGeneration && guest.isOffscreen()) {
      host.resize(guest, size.width, size.height + 1);
    }
    sizedAtScale.set(guest, scaleGeneration);
    const landed = host.resize(guest, size.width, size.height);
    if (landed) paneRequests.set(guest, { requested: size, landed });
  };
  const paneSurface = (guest: WebContents, content: Size): Size => {
    const request = paneRequests.get(guest);
    return request && request.landed.width === content.width && request.landed.height === content.height
      ? request.requested
      : content;
  };
  const documentId = (guest: WebContents) => browserDocumentId(host.state, guest);
  /** Pixels and input belong to one client only while this session still shows
   *  this document on this page; anything else is a frame from the past. */
  const presenting = (sessionId: string, guest: WebContents, token: string): boolean =>
    !guest.isDestroyed() &&
    token === documentId(guest) &&
    (!host.currentGuest || host.currentGuest(sessionId) === guest);

  return {
    images,
    geometryRevisions,
    viewportChanges,
    paneSizes,
    presentedGuests,
    invalidateGeometry,
    resizeGuest,
    bumpScale,
    paneSurface,
    documentId,
    presenting,
  };
}

export type PageSurfaceState = ReturnType<typeof createPageSurfaceState>;
