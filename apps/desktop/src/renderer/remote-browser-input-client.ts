import type { DesktopBrowserPageAction, DesktopRemoteBrowserControl } from '../shared/contract';

export interface RemoteInputFrame {
  documentId: string;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}

/** The client surface `useBrowserPageInput` drives, backed by the relay
 * stream. Hover/drag motion and wheel ticks coalesce to one per animation
 * frame; anything else flushes them first, so press/release never reorder. */
export function createRemoteBrowserInputClient(options: {
  frame(): RemoteInputFrame | null;
  send(control: DesktopRemoteBrowserControl): Promise<void>;
  failure(message: string): void;
  shortcut(name: string): void;
  requestFrame?(callback: () => void): number;
  cancelFrame?(handle: number): void;
}) {
  const request = options.requestFrame ?? ((callback) => window.requestAnimationFrame(callback));
  const cancel = options.cancelFrame ?? ((handle) => window.cancelAnimationFrame(handle));
  type Pointer = Extract<DesktopBrowserPageAction, { type: 'pointer' }>;
  type Wheel = Extract<DesktopBrowserPageAction, { type: 'wheel' }>;
  let pending: { kind: 'move'; action: Pointer } | { kind: 'wheel'; action: Wheel } | null = null;
  let handle = 0;

  const dispatch = (action: DesktopBrowserPageAction): void => {
    const frame = options.frame();
    if (!frame) {
      options.failure('Browser page is not ready.');
      return;
    }
    const navigation = ['back', 'forward', 'reload', 'stop'].includes(action.type);
    void options.send(
      (navigation ? action : { ...action, documentId: frame.documentId }) as DesktopRemoteBrowserControl
    );
  };
  const flush = (): void => {
    if (handle) cancel(handle);
    handle = 0;
    const next = pending;
    pending = null;
    if (next) dispatch(next.action);
  };
  const inputToken = (): string => options.frame()?.documentId ?? '';

  return {
    frame: options.frame,
    inputToken,
    shortcut: options.shortcut,
    fire(action: DesktopBrowserPageAction, token?: string): void {
      if (token !== undefined && token !== inputToken()) {
        options.failure('Browser page changed; input was not sent.');
        return;
      }
      if (action.type === 'pointer' && action.phase === 'mouseMoved') {
        const held = pending?.kind === 'move' ? pending.action : null;
        if (
          held &&
          held.buttons === action.buttons &&
          held.button === action.button &&
          held.modifiers === action.modifiers
        ) {
          Object.assign(held, action);
          return;
        }
        flush();
        pending = { kind: 'move', action: { ...action } };
        handle = request(flush);
        return;
      }
      if (action.type === 'wheel') {
        const held = pending?.kind === 'wheel' ? pending.action : null;
        if (held && held.x === action.x && held.y === action.y) {
          held.deltaX += action.deltaX;
          held.deltaY += action.deltaY;
          return;
        }
        flush();
        pending = { kind: 'wheel', action: { ...action } };
        handle = request(flush);
        return;
      }
      flush();
      dispatch(action);
    },
    /** Discard coalesced motion/wheel that has not been dispatched. */
    reset(): void {
      if (handle) cancel(handle);
      handle = 0;
      pending = null;
    },
    /** Send anything still waiting for its frame (before unmount). */
    flush,
  };
}
