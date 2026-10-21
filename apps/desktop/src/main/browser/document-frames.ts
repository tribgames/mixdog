import type { WebContents } from 'electron';
import type { BrowserCdpPort } from './cdp';
import { createBrowserReadPool, settleBrowserReads } from './parallel-read';
import { createBrowserFrameCacheStore } from './frame-cache';
import { pause } from './settle';

/** Ad slots and embedded widgets attach frames in bursts, so a page can change
 *  its topology faster than one immediate repeat can catch. Observations have
 *  no side effects: wait for the burst to settle and read again, with a small
 *  bounded ceiling so a page that never settles still answers. */
const TOPOLOGY_SETTLE_DELAYS_MS = [50, 150, 350];

interface FrameTree {
  frame: { id: string };
  childFrames?: FrameTree[];
}
export interface BrowserFrameHost {
  cdp: BrowserCdpPort;
  sessions(guest: WebContents): Map<string, { type?: string; frameId?: string; ready?: Promise<unknown> }>;
}

/** Waits for a shared promise without being held by it: cancellation ends this
 *  wait only, the initialization other observations share keeps running. */
function untilReady(ready: Promise<unknown> | undefined, signal?: AbortSignal): Promise<unknown> | undefined {
  if (!ready || !signal) return ready;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    ready.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export function createBrowserFrameCollector(host: BrowserFrameHost) {
  const cacheFor = createBrowserFrameCacheStore();
  async function collect<T>(
    guest: WebContents,
    expression: string,
    signal?: AbortSignal,
    skip?: ReadonlyMap<string, number>,
    attempt = 0
  ): Promise<Array<[string, T, number]>> {
    const debuggerPort = await host.cdp.guestDebugger(guest);
    signal?.throwIfAborted();
    const cache = cacheFor(guest, debuggerPort);
    const targets = [
      {
        sessionId: undefined as string | undefined,
        frameId: undefined as string | undefined,
        ready: undefined as Promise<unknown> | undefined,
      },
      ...[...host.sessions(guest)]
        .filter(([, target]) => target.type === 'iframe')
        .map(([sessionId, target]) => ({ sessionId, frameId: target.frameId, ready: target.ready })),
    ];
    if (targets.length > 32) throw new Error('too many frame targets for a complete observation');
    const targetKey = JSON.stringify(targets.map(({ sessionId, frameId }) => [sessionId, frameId]));
    if (cache.targets !== targetKey) {
      cache.invalidate();
      cache.targets = targetKey;
    }
    const epoch = cache.epoch;
    const assertCurrent = () => {
      signal?.throwIfAborted();
      if (cache.epoch !== epoch) throw new Error('frame topology changed during observation');
    };
    try {
      const read = createBrowserReadPool();
      let frames = cache.frames;
      if (!frames) {
        const trees = await settleBrowserReads(
          targets.map(async (target) => {
            await untilReady(target.ready, signal);
            signal?.throwIfAborted();
            return read(() =>
              host.cdp.call<{ frameTree: FrameTree }>(guest, 'Page.getFrameTree', {}, signal, {
                sessionId: target.sessionId,
              })
            );
          })
        );
        frames = new Map<string, string | undefined>();
        const discovered = frames;
        targets.forEach((target, index) => {
          const visit = (node: FrameTree) => {
            if (!discovered.has(node.frame.id)) discovered.set(node.frame.id, target.sessionId);
            for (const child of node.childFrames || []) visit(child);
          };
          visit(trees[index].frameTree);
          // A child target owns its frame even if its parent also listed it.
          if (target.frameId) discovered.set(target.frameId, target.sessionId);
        });
        if (frames.size > 64) throw new Error('too many frames for a complete observation');
        assertCurrent();
        cache.frames = frames;
      }
      const values = await settleBrowserReads(
        [...frames].map(([frameId, sessionId]) =>
          read(async () => {
            assertCurrent();
            const key = JSON.stringify([sessionId, frameId]);
            let executionContextId = cache.contexts.get(key);
            if (executionContextId === undefined) {
              const created = await host.cdp.call<{ executionContextId: number }>(
                guest,
                'Page.createIsolatedWorld',
                { frameId, worldName: 'mixdog-observation' },
                signal,
                { sessionId }
              );
              assertCurrent();
              executionContextId = created.executionContextId;
              cache.contexts.set(key, executionContextId);
            }
            // Skipped only while the frame is still in the very context it was
            // read in: a navigation keeps the frame id but replaces the context.
            if (skip?.get(frameId) === executionContextId) return undefined;
            const result = await host.cdp.call<{
              result?: { value?: T };
              exceptionDetails?: { text?: string; exception?: { description?: string } };
            }>(
              guest,
              'Runtime.evaluate',
              {
                expression,
                contextId: executionContextId,
                returnByValue: true,
                awaitPromise: true,
              },
              signal,
              { sessionId }
            );
            if (result.exceptionDetails || result.result?.value === undefined) {
              throw new Error(
                `frame observation failed: ${result.exceptionDetails?.exception?.description || result.exceptionDetails?.text || 'missing result'}`
              );
            }
            return [frameId, result.result.value, executionContextId] as [string, T, number];
          })
        )
      );
      assertCurrent();
      return values.filter((value) => value !== undefined);
    } catch (error) {
      const changed = cache.epoch !== epoch;
      cache.invalidate();
      // Only observations are repeated, and only after an actual topology
      // event. Input dispatch never enters this collector.
      const settleDelay = TOPOLOGY_SETTLE_DELAYS_MS[attempt];
      if (changed && settleDelay !== undefined && !signal?.aborted) {
        await pause(settleDelay, signal);
        return collect<T>(guest, expression, signal, skip, attempt + 1);
      }
      throw error;
    }
  }
  const collectValues = async <T>(guest: WebContents, expression: string, signal?: AbortSignal) =>
    (await collect<T>(guest, expression, signal)).map(([, value]) => value);
  /** Each value with the frame and execution context that produced it. A frame
   *  whose current context is the one recorded in `skip` is not read. */
  const collectByFrame = <T>(
    guest: WebContents,
    expression: string,
    signal?: AbortSignal,
    skip?: ReadonlyMap<string, number>
  ) => collect<T>(guest, expression, signal, skip);
  return Object.assign(collectValues, { byFrame: collectByFrame });
}
