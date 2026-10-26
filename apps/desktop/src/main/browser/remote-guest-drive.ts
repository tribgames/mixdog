import type { WebContents } from 'electron';

import type { BrowserRemoteControlHost, RemoteStream } from './remote-stream';
import { viewportKey } from './remote-stream';

/** Apply the stream's fit to this page and document unless it already holds
 *  it; a page the stream left behind gets its own viewport back. `driven` is
 *  set only once the fit really applied. A fit that fails is given up: the
 *  page keeps its own geometry and the stream reports `fitFailed`, so a
 *  waiting take-over falls back to watching instead of being shown an
 *  unfitted page as fitted. */
export async function driveGuest(
  drive: BrowserRemoteControlHost['drive'],
  sessionId: string,
  stream: Pick<RemoteStream, 'viewport' | 'driven' | 'fitFailed'>,
  guest: WebContents,
  documentId: string
): Promise<void> {
  const viewport = stream.viewport;
  if (!viewport) return;
  const key = viewportKey(viewport);
  const previous = stream.driven;
  if (previous?.guest === guest && previous.documentId === documentId && previous.key === key) return;
  stream.driven = null;
  if (previous && previous.guest !== guest) await drive?.restore(previous.guest).catch(() => undefined);
  try {
    if (!drive) throw new Error('This host cannot fit a page.');
    await drive.apply(sessionId, guest, viewport);
  } catch {
    // Whatever the failed apply already changed (size, zoom, metrics) is
    // undone here, inside this sync, so it is gone before any later fit —
    // also when the fit changed meanwhile and this one is merely stale.
    await drive?.restore(guest).catch(() => undefined);
    if (stream.viewport === viewport) {
      stream.viewport = null;
      stream.fitFailed = true;
    }
    return;
  }
  // What is applied now, even if the fit changed meanwhile: the next sync, or
  // the unfit queued behind this one, works from it.
  stream.driven = { guest, documentId, key };
}
