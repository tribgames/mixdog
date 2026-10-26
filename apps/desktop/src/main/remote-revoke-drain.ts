// Applies revocations queued in the client cache once the relay answers. Entries
// leave the queue only after the relay acknowledges; anything else stays for the
// next successful (re)connection, which calls the drain again.
import type { RemoteClientCache } from './remote-client-cache';

interface RevokableRelay {
  listClients(): Promise<unknown>;
  revokeClient(clientId: string): Promise<void>;
}

export function createPendingRevokeDrain(deps: {
  cache: Pick<RemoteClientCache, 'pending' | 'revocation' | 'applied'>;
  relay: () => RevokableRelay | null;
  retryDelayMs?: number;
}): () => Promise<void> {
  const retryDelayMs = deps.retryDelayMs ?? 250;
  let running: Promise<void> | null = null;
  let again = false;
  const pass = async (): Promise<void> => {
    for (let attempt = 0; attempt < 80 && deps.cache.pending().length; attempt += 1) {
      const relay = deps.relay();
      if (!relay) return;
      try {
        await relay.listClients();
      } catch {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }
      for (const id of deps.cache.pending()) {
        // Checked right before the send (which goes out synchronously): an
        // entry withdrawn meanwhile (re-paired, or confirmed) is not sent.
        const revocation = deps.cache.revocation(id);
        if (revocation === null) continue;
        try {
          await relay.revokeClient(id);
          // Clears only this instance: one queued anew meanwhile stays.
          await deps.cache.applied(id, revocation);
        } catch {
          /* stays queued for the next connection */
        }
      }
      return;
    }
  };
  return () => {
    if (running) {
      // A connection that opened mid-drain still gets its own pass.
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await pass();
      } while (again);
    })().finally(() => {
      running = null;
    });
    return running;
  };
}
