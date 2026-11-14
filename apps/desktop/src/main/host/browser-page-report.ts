/**
 * What a streamed browser page shows now, for the core: the document and the
 * geometry its stream locked. The core's media frames carry pixels only; a
 * phone's input coordinates need the geometry, so a change is sent as the
 * notification `host/browser/page`. `geometry: null` means the stream ended.
 */
import type { HostBrowserPageParams } from '../../../../../packages/protocol/src/index.ts';
import type { RemoteWebrtcGeometry } from '../../shared/remote-webrtc';
import type { HostConnection } from './connection';

export const HOST_BROWSER_PAGE = 'host/browser/page';

export interface StreamedPage {
  documentId: string | null;
  geometry: RemoteWebrtcGeometry | null;
}

export function createBrowserPageReporter(
  connection: HostConnection,
  page: (sessionId: string) => StreamedPage | null
) {
  /** The (document, generation) last sent per session. */
  const sent = new Map<string, string>();
  /** The sessions with a streamed page, kept across a connection: a reclaim sends each of them again. */
  const streamed = new Set<string>();
  return {
    /** The session's streamed page or its geometry changed (or its stream ended). */
    changed(sessionId: string): void {
      const current = page(sessionId);
      if (!current) {
        streamed.delete(sessionId);
        // The stream ended: said once, and only if the core was told of a page.
        if (!sent.delete(sessionId)) return;
        send(connection, { tabId: sessionId, geometry: null });
        return;
      }
      streamed.add(sessionId);
      // Before the first lock there is no geometry to report (null means ended).
      if (!current.geometry) return;
      const key = `${current.documentId ?? ''}|${current.geometry.generation}`;
      if (sent.get(sessionId) === key) return;
      sent.set(sessionId, key);
      send(connection, {
        tabId: sessionId,
        ...(current.documentId ? { documentId: current.documentId } : {}),
        // A plain JSON object for the generated `JsonValue`.
        geometry: { ...current.geometry },
      });
    },
    /** The host reclaimed the role (a core restarted, or the connection came back): every live stream's page is sent again,
     *  so its geometry does not wait for the next relock or navigation. */
    resend(): void {
      sent.clear();
      for (const sessionId of [...streamed]) this.changed(sessionId);
    },
    /** The connection closed: what the core was told is forgotten; the streams are not (`resend` reports them). */
    stop(): void {
      sent.clear();
    },
  };
}

function send(connection: HostConnection, params: HostBrowserPageParams): void {
  try {
    connection.notify(HOST_BROWSER_PAGE, params);
  } catch {
    // The connection is closing; the next claim starts from a clean slate.
  }
}
