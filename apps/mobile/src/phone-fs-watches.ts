import type { DesktopSectionsPush, RendererProtocolMethod } from '../../desktop/src/shared/contract-sections.ts';
import type { Client, SectionLink } from './phone-section-link.ts';

/** The page's calls to the core, with `fs/watch` kept alive across reconnects and client replacement. */
export function createFsWatchCalls(
  link: Pick<SectionLink, 'upWith' | 'rawCall' | 'currentClient'>,
  emit: (push: DesktopSectionsPush) => void
): (method: RendererProtocolMethod, params: unknown) => Promise<unknown> {
  const { rawCall, currentClient } = link;
  // Only successful watches are replayed. A pending first call still belongs to its caller and must retain its result/error.
  // Unlike the desktop's window registry, this adapter has one page owner; fs/unwatch releases that owner's desired watch.
  type Watch = { params: Record<string, unknown>; active: boolean; epoch: number; wake?: () => void };
  const watches = new Map<string, Watch>();
  let watchEpoch = 0;
  let watchClient: Client | undefined;
  let stopWatches: (() => void) | undefined;
  const stopIdleWatches = (): void => {
    if (watches.size) return;
    stopWatches?.();
    stopWatches = undefined;
    watchClient = undefined;
  };
  const cleanupReleased = (client: Client, watchId: string): void => {
    // Never park cleanup on a dead connection (call would wait for its next ready). Its server already releases its watches.
    if (client.status.state === 'ready') void rawCall(client, 'fs/unwatch', { watchId }).catch(() => undefined);
  };
  const replay = (watchId: string, watch: Watch): void => {
    const client = watchClient;
    if (client?.status.state !== 'ready' || !watch.active || watch.epoch === watchEpoch) return;
    const epoch = watchEpoch;
    watch.epoch = epoch;
    void rawCall(client, 'fs/watch', watch.params).then(
      () => {
        if (!watches.has(watchId)) cleanupReleased(client, watchId);
      },
      (error: unknown) => {
        if (watches.get(watchId) !== watch || watchEpoch !== epoch || watchClient !== client) return;
        emit({
          kind: 'feedError',
          feedId: `fs:${watchId}`,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    );
  };
  const followWatches = (): void => {
    if (stopWatches) return;
    stopWatches = link.upWith((client, current) => {
      watchClient = client;
      watchEpoch++;
      for (const watch of watches.values()) watch.wake?.();
      let ready = client.status.state === 'ready';
      if (ready) for (const [id, watch] of watches) replay(id, watch);
      const off = client.on((event) => {
        if (!current() || event.type !== 'status') return;
        const next = event.status.state === 'ready';
        if (next && !ready) {
          watchEpoch++;
          for (const [id, watch] of watches) replay(id, watch);
        }
        for (const watch of watches.values()) watch.wake?.();
        ready = next;
      });
      return off;
    });
  };
  return async (method, params) => {
    const input = params && typeof params === 'object' ? (params as Record<string, unknown>) : undefined;
    const watchId = typeof input?.watchId === 'string' ? input.watchId : undefined;
    if (method === 'fs/unwatch' && watchId !== undefined) {
      const released = watches.get(watchId);
      watches.delete(watchId);
      released?.wake?.();
      stopIdleWatches();
    }
    if (method !== 'fs/watch' || watchId === undefined) return rawCall(await currentClient(), method, params);
    const watch: Watch = { params: { ...input }, active: false, epoch: -1 };
    const replaced = watches.get(watchId);
    watches.set(watchId, watch);
    // A pending first call may be waiting for ready on the entry this one replaces. It no longer owns the id, but it
    // must still settle: future ready/unwatch events only visit the new entry. A request already sent keeps its own result.
    replaced?.wake?.();
    followWatches();
    try {
      let client = await currentClient();
      // Do not enqueue the first watch inside a disconnected client's ready wait. Its eventual send would be on the next
      // transport while carrying this one's epoch, and a successful answer would cause a duplicate replay.
      while (watches.get(watchId) === watch && client.status.state === 'reconnecting') {
        await new Promise<void>((resolve) => {
          watch.wake = resolve;
        });
        watch.wake = undefined;
        client = await currentClient();
      }
      if (watches.get(watchId) !== watch) return undefined;
      const epoch = watchEpoch;
      watch.epoch = epoch;
      const result = await rawCall(client, method, params);
      if (watches.get(watchId) !== watch) {
        if (!watches.has(watchId)) cleanupReleased(client, watchId);
        return result;
      }
      watch.active = true;
      // A late success on the old transport does not establish a watch on the replacement.
      if (watchClient !== client || watchEpoch !== epoch) replay(watchId, watch);
      return result;
    } catch (error) {
      if (watches.get(watchId) === watch) watches.delete(watchId);
      stopIdleWatches();
      throw error;
    }
  };
}
