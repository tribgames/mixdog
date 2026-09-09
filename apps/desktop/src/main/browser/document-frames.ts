import type { WebContents } from 'electron';
import type { BrowserCdpPort } from './cdp';
import { createBrowserReadPool, settleBrowserReads } from './parallel-read';
import { createBrowserFrameCacheStore } from './frame-cache';

interface FrameTree {
  frame: { id: string };
  childFrames?: FrameTree[];
}
export interface BrowserFrameHost {
  cdp: BrowserCdpPort;
  sessions(guest: WebContents): Map<string, { type?: string; frameId?: string; ready?: Promise<unknown> }>;
}

export function createBrowserFrameCollector(host: BrowserFrameHost) {
  const cacheFor = createBrowserFrameCacheStore();
  async function collect<T>(
    guest: WebContents, expression: string, signal?: AbortSignal, recoverTopology = true,
  ): Promise<T[]> {
    const debuggerPort = await host.cdp.guestDebugger(guest);
    signal?.throwIfAborted();
    const cache = cacheFor(guest, debuggerPort);
    const targets = [
      { sessionId: undefined as string | undefined, frameId: undefined as string | undefined, ready: undefined as Promise<unknown> | undefined },
      ...[...host.sessions(guest)].filter(([, target]) => target.type === 'iframe')
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
        const trees = await settleBrowserReads(targets.map(async (target) => {
          await target.ready;
          signal?.throwIfAborted();
          return read(() => host.cdp.call<{ frameTree: FrameTree }>(
            guest, 'Page.getFrameTree', {}, signal, { sessionId: target.sessionId },
          ));
        }));
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
      const values = await settleBrowserReads([...frames].map(([frameId, sessionId]) => read(async () => {
        assertCurrent();
        const key = JSON.stringify([sessionId, frameId]);
        let executionContextId = cache.contexts.get(key);
        if (executionContextId === undefined) {
          const created = await host.cdp.call<{ executionContextId: number }>(
            guest, 'Page.createIsolatedWorld', { frameId, worldName: 'mixdog-observation' }, signal, { sessionId },
          );
          assertCurrent();
          executionContextId = created.executionContextId;
          cache.contexts.set(key, executionContextId);
        }
        const result = await host.cdp.call<{
          result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } };
        }>(guest, 'Runtime.evaluate', {
          expression, contextId: executionContextId, returnByValue: true, awaitPromise: true,
        }, signal, { sessionId });
        if (result.exceptionDetails || result.result?.value === undefined) {
          throw new Error(`frame observation failed: ${result.exceptionDetails?.exception?.description || result.exceptionDetails?.text || 'missing result'}`);
        }
        return result.result.value;
      })));
      assertCurrent();
      return values;
    } catch (error) {
      const changed = cache.epoch !== epoch;
      cache.invalidate();
      // Only observations are repeated, once, after an actual topology event.
      // Input dispatch never enters this collector.
      if (changed && recoverTopology && !signal?.aborted) {
        return collect<T>(guest, expression, signal, false);
      }
      throw error;
    }
  }
  return <T>(guest: WebContents, expression: string, signal?: AbortSignal) =>
    collect<T>(guest, expression, signal);
}
