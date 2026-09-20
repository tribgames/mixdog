/** What the page surface remembers per guest and per session: the last sampled
 *  image, geometry revisions, in-flight viewport changes, pane sizes, and which
 *  guest a session currently presents. */
import type { WebContents } from 'electron';
import { browserDocumentId, type BrowserGuestStateStore } from './guest-state';
import type { BrowserScreenshotCapture } from './screenshot';

export interface PageSurfaceStateHost {
  state: BrowserGuestStateStore;
  currentGuest?(sessionId: string): WebContents | null;
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
    documentId,
    presenting,
  };
}

export type PageSurfaceState = ReturnType<typeof createPageSurfaceState>;
