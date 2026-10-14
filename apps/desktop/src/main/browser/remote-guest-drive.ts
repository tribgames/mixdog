import type { WebContents } from 'electron';

import type { BrowserRemoteControlHost, RemoteStream } from './remote-stream';
import { viewportKey } from './remote-stream';

/** Apply the client's viewport to this page and document unless it already
 *  holds it; a page the stream left behind gets its pane's viewport back. */
export async function driveGuest(
  drive: BrowserRemoteControlHost['drive'],
  sessionId: string,
  stream: Pick<RemoteStream, 'viewport' | 'driven'>,
  guest: WebContents,
  documentId: string
): Promise<void> {
  const viewport = stream.viewport;
  if (!drive || !viewport) return;
  const key = viewportKey(viewport);
  const previous = stream.driven;
  if (previous?.guest === guest && previous.documentId === documentId && previous.key === key) return;
  stream.driven = { guest, documentId, key };
  // Driving is best effort: a page that refuses its viewport still streams.
  await drive.apply(sessionId, guest, viewport).catch(() => undefined);
  if (previous && previous.guest !== guest) await drive.restore(previous.guest).catch(() => undefined);
}
