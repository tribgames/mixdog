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
