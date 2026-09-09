import type { DesktopBrowserPageAction, DesktopBrowserPageFrame, DesktopBrowserTab } from '../shared/contract';
import { browserPageTransition } from './browser-page-recovery';
import { BROWSER_INPUT_BUSY, BROWSER_INPUT_EXPIRED, BROWSER_INPUT_WAIT_MS, browserInputImmediate, browserTabControl } from '../shared/browser-input-policy';

/** A DOM-sized handle for the pane chrome, with no guest in its focus tree. */
export interface BrowserPageElement extends HTMLDivElement {
  src: string;
  getWebContentsId(): number;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  setZoomFactor(factor: number): void;
  getTabs(): DesktopBrowserTab[];
  createTab(): Promise<void>;
  selectTab(tabId: string): Promise<void>;
  closeTab(tabId: string): Promise<void>;
}

export function createBrowserPageClient(options: {
  api: Pick<NonNullable<Window['mixdogDesktop']>, 'browserPageFrame' | 'browserPageControl'>;
  sessionId: string;
  update(frame: DesktopBrowserPageFrame): void;
  /** Decode pixels before publishing their coordinate metadata. */
  prepare?(frame: DesktopBrowserPageFrame): Promise<void>;
  failure(message: string): void;
  recovered?(): void;
}) {
  let current: DesktopBrowserPageFrame | null = null;
  let presentationKey = '';
  let element: BrowserPageElement | null = null;
  let tail = Promise.resolve();
  let chromeTail = Promise.resolve();
  let inputGeneration = 0;
  let documentRevision = 0;
  let queued = 0;
  let disposed = false;
  let pendingRead: Promise<void> | null = null;
  let refresh = () => {};
  type Pointer = Extract<DesktopBrowserPageAction, { type: 'pointer' }>;
  let pendingMove: { action: Pointer; documentId: string } | null = null;
  type Resize = Extract<DesktopBrowserPageAction, { type: 'resize' }>;
  let pendingResize: Resize | null = null;
  type Wheel = Extract<DesktopBrowserPageAction, { type: 'wheel' }>;
  let pendingWheel: { action: Wheel; documentId: string } | null = null;
  let heldPointer: { action: Pointer; documentId: string } | null = null;
  let failureRevision = 0;

  function reportFailure(message: string): void {
    failureRevision += 1;
    options.failure(message);
  }

  function emit(type: string, detail: Record<string, unknown> = {}): void {
    element?.dispatchEvent(Object.assign(new Event(type), detail));
  }

  function accept(frame: DesktopBrowserPageFrame): void {
    const previous = current;
    if (previous && previous.documentId !== frame.documentId) documentRevision += 1;
    current = frame;
    // frameId owns pixel identity. An unchanged sample still refreshes host
    // state, but must not make React redraw the pane at display cadence.
    const { image: _image, ...metadata } = frame;
    const key = JSON.stringify(metadata);
    if (key !== presentationKey) {
      presentationKey = key;
      options.update(frame);
    }
    if (!previous || previous.webContentsId !== frame.webContentsId) emit('did-attach');
    if (!previous || previous.documentId !== frame.documentId) emit('dom-ready');
    if (previous?.url !== frame.url || previous?.webContentsId !== frame.webContentsId) {
      emit('did-navigate', { url: frame.url, isMainFrame: true });
    }
    if (JSON.stringify(previous?.tabs) !== JSON.stringify(frame.tabs)) emit('tabs-changed');
    if (previous?.loading !== frame.loading) emit(frame.loading ? 'did-start-loading' : 'did-stop-loading');
    if (previous?.loading && !frame.loading) emit('did-finish-load');
    if (frame.fault && frame.fault !== previous?.fault) emit('did-fail-load', {
      errorDescription: frame.fault, isMainFrame: true,
    });
  }

  async function poll(): Promise<void> {
    if (disposed || !options.api.browserPageFrame) return;
    if (pendingRead) return pendingRead;
    const capture = async () => {
      try {
        return await options.api.browserPageFrame!(options.sessionId, current?.frameId);
      } catch (error) {
        if (disposed || !browserPageTransition(error, 'capture')) throw error;
        // A discarded frame is safe to recapture; never publish its old pixels.
        return options.api.browserPageFrame!(options.sessionId);
      }
    };
    pendingRead = capture()
      .then(async next => {
        if (disposed) return;
        await options.prepare?.(next);
        if (!disposed) accept(next);
      })
      .finally(() => { pendingRead = null; });
    return pendingRead;
  }

  function control(action: DesktopBrowserPageAction): Promise<void> {
    // Coalescing may never cross a click, key, or another kind of input.
    // Passive hover may cross scrolling; a pressed pointer remains a barrier.
    const hover = action.type === 'pointer' && action.phase === 'mouseMoved' && action.buttons === 0;
    if (pendingMove?.action !== action
      && !(action.type === 'wheel' && pendingMove?.action.buttons === 0)) pendingMove = null;
    if (pendingWheel?.action !== action && !hover) pendingWheel = null;
    const clearPending = () => {
      if (pendingMove?.action === action) pendingMove = null;
      if (pendingResize === action) pendingResize = null;
      if (pendingWheel?.action === action) pendingWheel = null;
    };
    const recovery = browserInputImmediate(action);
    const release = action.type === 'pointer' && action.phase === 'mouseReleased';
    if (disposed || !current || !options.api.browserPageControl) {
      clearPending();
      // Pane chrome (zoom, geometry, navigation) and hover motion run before
      // the first frame attaches; the pane reapplies them on did-attach and
      // dom-ready, so an early attempt is not a user-facing failure. Only
      // deliberate human input reports that the page cannot take it yet.
      if (!disposed && !current && options.api.browserPageControl && !humanInput(action)) {
        return Promise.reject(new Error('Browser page is attaching.'));
      }
      return rejectInput('Browser page is not ready.');
    }
    if (queued >= 128 && !release && !recovery) {
      clearPending();
      return rejectInput(BROWSER_INPUT_BUSY);
    }
    if (browserTabControl(action)) inputGeneration += 1;
    const generation = inputGeneration;
    const admittedFailureRevision = failureRevision;
    const documentId = current.documentId;
    const enqueuedAt = performance.now();
    queued += 1;
    const work = (recovery ? chromeTail : Promise.all([tail, chromeTail])).then(async () => {
      clearPending();
      if (disposed) return;
      const motion = action.type === 'pointer' && action.phase === 'mouseMoved';
      // A tab switch invalidates unstarted edits even if the user switches
      // back before the stalled input lane resumes. Releases still clean up.
      if (!recovery && !release && generation !== inputGeneration) return;
      if (!release && !recovery && performance.now() - enqueuedAt >= BROWSER_INPUT_WAIT_MS) {
        if (motion || action.type === 'resize') return;
        throw new Error(BROWSER_INPUT_EXPIRED);
      }
      // A display sample must not hold up hover, drag, or later keystrokes.
      // The host checks the document again immediately before dispatch.
      if (motion && current?.documentId !== documentId) return;
      try {
        await options.api.browserPageControl!(options.sessionId, {
          ...action, documentId: action.type === 'resize' ? current!.documentId : documentId,
        });
      } catch (error) {
        // Navigation can win the race after the last displayed frame. Drop
        // obsolete motion, but never replay an edit against the new document.
        if (browserPageTransition(error, 'input')) {
          if (motion) return;
          await poll();
          if (disposed) return;
          // Geometry belongs to the pane, not the old document. Retry once
          // only after the host proved it had not dispatched the resize.
          if (action.type === 'resize') {
            await options.api.browserPageControl!(options.sessionId, { ...action, documentId: current!.documentId });
            return;
          }
        }
        throw error;
      }
      if (action.type === 'pointer') {
        if (action.phase === 'mousePressed') heldPointer = { action, documentId };
        if (action.phase === 'mouseReleased') heldPointer = null;
      }
      if (action.type === 'new-tab' || action.type === 'select-tab' || action.type === 'close-tab') {
        await poll();
      }
      // A release finishing a failed press, or an older queued success, must
      // not immediately erase the failure before the user has seen it.
      if (!disposed && humanInput(action) && !release && admittedFailureRevision === failureRevision) {
        options.recovered?.();
      }
    });
    // Passive geometry can expire silently. Deliberate human edits must
    // report rejection rather than look like a successful click or keystroke.
    const settled = work.catch(error => {
      if (humanInput(action) || !browserPageTransition(error, 'input')) throw error;
    });
    const completion = settled.catch(error => {
      if (!disposed) reportFailure(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      queued -= 1;
      if (!disposed) refresh();
    });
    // Recovery must not replace the fence protecting an in-flight edit.
    if (recovery) chromeTail = completion;
    else tail = completion;
    return settled;
  }

  function humanInput(action: DesktopBrowserPageAction): boolean {
    if (action.type === 'pointer') return action.phase !== 'mouseMoved';
    return action.type === 'wheel' || action.type === 'text' || action.type === 'key'
      || action.type === 'answer-dialog' || action.type === 'choose-files';
  }

  function rejectInput(message: string): Promise<void> {
    if (!disposed) reportFailure(message);
    return Promise.reject(new Error(message));
  }

  function inputToken(): string {
    return `${options.sessionId}:${inputGeneration}:${documentRevision}:${current?.documentId ?? ''}`;
  }

  function fire(action: DesktopBrowserPageAction, token?: string): void {
    if (token !== undefined && token !== inputToken()) {
      if (!disposed) reportFailure('Browser page changed; input was not sent.');
      return;
    }
    if (action.type === 'resize') {
      if (pendingResize) {
        Object.assign(pendingResize, action);
        return;
      }
      pendingResize = action;
    }
    if (action.type === 'pointer' && action.phase === 'mouseMoved') {
      if (pendingMove && pendingMove.documentId === current?.documentId
        && pendingMove.action.buttons === action.buttons
        && pendingMove.action.button === action.button
        && pendingMove.action.modifiers === action.modifiers) {
        Object.assign(pendingMove.action, action);
        return;
      }
      pendingMove = { action, documentId: current?.documentId || '' };
    }
    if (action.type === 'wheel') {
      const previous = pendingWheel?.action;
      if (previous && pendingWheel?.documentId === current?.documentId
        && previous.x === action.x && previous.y === action.y
        && Math.sign(previous.deltaX) === Math.sign(action.deltaX)
        && Math.sign(previous.deltaY) === Math.sign(action.deltaY)
        && Math.abs(previous.deltaX + action.deltaX) <= 20_000
        && Math.abs(previous.deltaY + action.deltaY) <= 20_000) {
        previous.deltaX += action.deltaX;
        previous.deltaY += action.deltaY;
        return;
      }
      pendingWheel = { action, documentId: current?.documentId || '' };
    }
    // control owns reporting for both admission and dispatch failures.
    void control(action).catch(() => {});
  }

  function bind(node: BrowserPageElement, focusInput: () => void): void {
    element = node;
    node.getWebContentsId = () => {
      if (!current) throw new Error('Browser page is attaching.');
      return current.webContentsId;
    };
    node.getURL = () => current?.url || 'about:blank';
    node.canGoBack = () => current?.canGoBack === true;
    node.canGoForward = () => current?.canGoForward === true;
    node.loadURL = url => control({ type: 'navigate', url });
    node.goBack = () => fire({ type: 'back' });
    node.goForward = () => fire({ type: 'forward' });
    node.reload = () => fire({ type: 'reload' });
    node.stop = () => fire({ type: 'stop' });
    node.setZoomFactor = factor => fire({ type: 'zoom', factor });
    node.getTabs = () => current?.tabs ?? [];
    node.createTab = () => control({ type: 'new-tab' });
    node.selectTab = tabId => control({ type: 'select-tab', tabId });
    node.closeTab = tabId => control({ type: 'close-tab', tabId });
    node.focus = focusInput;
    Object.defineProperty(node, 'src', {
      configurable: true, get: node.getURL, set: url => fire({ type: 'navigate', url: String(url) }),
    });
  }

  return {
    poll, fire, control, bind, inputToken,
    shortcut: (shortcut: string) => emit('browser-shortcut', { shortcut }),
    frame: () => current,
    setRefresh: (callback: () => void) => { refresh = callback; },
    activate: () => { disposed = false; },
    dispose: () => {
      disposed = true;
      refresh = () => {};
      // Finish an already-sent press even if the display unmounts mid-drag.
      // Unstarted edits are discarded; cleanup never moves to a new document.
      void tail.then(async () => {
        const held = heldPointer;
        heldPointer = null;
        if (held) await options.api.browserPageControl?.(options.sessionId, {
          ...held.action, documentId: held.documentId, phase: 'mouseReleased', buttons: 0,
        });
      }).catch(() => {});
    },
  };
}
