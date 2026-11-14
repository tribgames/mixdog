// A core failure on the direct (renderer to core) path, as the page saw it through Node's IPC: coreErrorForWindow, then
// the envelope round trip the IPC wrapper applied to a coded error (coded-error.ts ipcErrorEnvelope, then the preload's
// ipcErrorFromEnvelope). A room or schedule code returns as a plain Error with its code, its public params only as
// `details`, and the trailer in its message; any other error is returned as coreErrorForWindow shaped it.
import { coreErrorForWindow } from '../../shared/core-lanes/core-error';
import { ipcErrorEnvelope, ipcErrorFromEnvelope } from '../../shared/coded-error';

export function directError(error: unknown): unknown {
  const shown = coreErrorForWindow(error);
  return ipcErrorFromEnvelope(ipcErrorEnvelope(shown)) ?? shown;
}

/** `p`, with a rejection mapped by directError. */
export function withDirectErrors<T>(p: Promise<T>): Promise<T> {
  return p.catch((error: unknown) => {
    throw directError(error);
  });
}
