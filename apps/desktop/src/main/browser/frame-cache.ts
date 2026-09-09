import type { WebContents } from 'electron';

export interface BrowserFrameCache {
  epoch: number;
  targets: string;
  frames?: Map<string, string | undefined>;
  contexts: Map<string, number>;
  invalidate(): void;
}

/** Cache only routing metadata, never page text or observation results. */
export function createBrowserFrameCacheStore() {
  const states = new WeakMap<WebContents, BrowserFrameCache>();
  return (guest: WebContents, debuggerPort: Electron.Debugger): BrowserFrameCache => {
    const existing = states.get(guest);
    if (existing) return existing;
    const state: BrowserFrameCache = {
      epoch: 0, targets: '', contexts: new Map(),
      invalidate() {
        state.epoch++;
        state.frames = undefined;
        state.contexts.clear();
      },
    };
    const message = (_event: unknown, method: string) => {
      if ([
        'Page.frameAttached', 'Page.frameDetached', 'Page.frameNavigated',
        'Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared',
        'Target.attachedToTarget', 'Target.detachedFromTarget',
      ].includes(method)) state.invalidate();
    };
    debuggerPort.on('message', message);
    debuggerPort.on('detach', state.invalidate);
    guest.once('destroyed', () => {
      debuggerPort.removeListener('message', message);
      debuggerPort.removeListener('detach', state.invalidate);
      states.delete(guest);
    });
    states.set(guest, state);
    return state;
  };
}
