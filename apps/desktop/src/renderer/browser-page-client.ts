import type {
  DesktopBrowserPageAction,
  DesktopBrowserPageFrame,
  DesktopBrowserTab,
  DesktopBrowserTabControlResult,
} from '../shared/contract';
import { browserPageResample } from '../shared/browser-page-frame';
import { browserCaptureTransient, browserPageTransition } from './browser-page-recovery';
import { isAbortedLoad } from './browser-load-failure';
import {
  BROWSER_INPUT_BUSY,
  BROWSER_INPUT_EXPIRED,
  BROWSER_INPUT_WAIT_MS,
  browserInputImmediate,
  browserInputPresentation,
  browserTabControl,
  browserTypingInput,
} from '../shared/browser-input-policy';

/** A DOM-sized handle for the pane chrome, with no guest in its focus tree. */
export interface BrowserPageElement extends HTMLDivElement {
  src: string;
  getWebContentsId(): number;
  loadURL(url: string): Promise<DesktopBrowserTabControlResult | void>;
  getURL(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  setZoomFactor(factor: number): void;
  getTabs(): DesktopBrowserTab[];
  getAgentPage(): { tabId: string; turn: number; paused: boolean } | undefined;
  /** `requestId`: the open request this tab is for (see requestBrowserPage). */
  createTab(requestId?: string): Promise<DesktopBrowserTabControlResult | void>;
  selectTab(tabId: string, follow?: 'agent' | 'resume'): Promise<DesktopBrowserTabControlResult | void>;
  closeTab(tabId: string): Promise<DesktopBrowserTabControlResult | void>;
}

export function createBrowserPageClient(options: {
  api: Pick<NonNullable<Window['mixdogDesktop']>, 'browserPageFrame' | 'browserPageControl' | 'browserPageMetadata'>;
  sessionId: string;
  /** The page draws itself natively: read its facts, never its pixels. */
  metadataOnly?(): boolean;
  update(frame: DesktopBrowserPageFrame): void;
  /** Native chrome facts do not certify pixels or their input coordinates. */
  updateMetadata?(frame: DesktopBrowserPageFrame): void;
  /** Decode pixels before publishing their coordinate metadata. */
  prepare?(frame: DesktopBrowserPageFrame): Promise<void>;
  failure(message: string): void;
  recovered?(): void;
  /** In-memory recovery only; never log or persist potentially sensitive text. */
  unconfirmedText?(text: string): void;
}) {
  let current: DesktopBrowserPageFrame | null = null;
  let metadata: DesktopBrowserPageFrame | null = null;
  let metadataKey = '';
  let presentationKey = '';
  let element: BrowserPageElement | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  let chromeTail: Promise<unknown> = Promise.resolve();
  let inputGeneration = 0;
  let documentRevision = 0;
  let queued = 0;
  let disposed = false;
  let pendingRead: Promise<void> | null = null;
  let pendingMetadata: Promise<void> | null = null;
  let refresh = () => {};
  type Pointer = Extract<DesktopBrowserPageAction, { type: 'pointer' }>;
  let pendingMove: { action: Pointer; documentId: string } | null = null;
  type Resize = Extract<DesktopBrowserPageAction, { type: 'resize' }>;
  let pendingResize: Resize | null = null;
  type Wheel = Extract<DesktopBrowserPageAction, { type: 'wheel' }>;
  let pendingWheel: { action: Wheel; documentId: string } | null = null;
  let heldPointer: { action: Pointer; documentId: string } | null = null;
  let failureRevision = 0;
  const unconfirmedText = new Map<number, string>();
  const inputOrder = new WeakMap<object, number>();
  let nextInputOrder = 0;
  type TextInput = Extract<DesktopBrowserPageAction, { type: 'text' }>;
  type CompositionInput = Extract<DesktopBrowserPageAction, { type: 'composition' }>;
  let pendingText: { action: TextInput; token: string } | null = null;
  let pendingComposition: { action: CompositionInput; token: string } | null = null;

  function preserveText(action?: DesktopBrowserPageAction): void {
    if ((action?.type === 'text' || action?.type === 'composition-end') && action.text) {
      if (!inputOrder.has(action)) inputOrder.set(action, ++nextInputOrder);
      unconfirmedText.set(inputOrder.get(action)!, action.text);
      options.unconfirmedText?.(
        [...unconfirmedText]
          .sort(([a], [b]) => a - b)
          .map(([, text]) => text)
          .join('')
      );
    }
  }

  function reportFailure(message: string): void {
    failureRevision += 1;
    options.failure(message);
  }

  function emit(type: string, detail: Record<string, unknown> = {}): void {
    element?.dispatchEvent(Object.assign(new Event(type), detail));
  }

  function acceptMetadata(frame: DesktopBrowserPageFrame): void {
    const previous = metadata;
    metadata = frame;
    const {
      image: _image,
      frameId: _frame,
      textureId: _texture,
      width: _width,
      height: _height,
      viewportWidth: _viewportWidth,
      viewportHeight: _viewportHeight,
      ...facts
    } = frame;
    const key = JSON.stringify(facts);
    if (key !== metadataKey) {
      metadataKey = key;
      options.updateMetadata?.({ ...frame, image: undefined });
    }
    publishEvents(previous, frame);
  }

  function accept(frame: DesktopBrowserPageFrame, previousMetadata: DesktopBrowserPageFrame | null): void {
    const previous = current;
    // frameId owns pixel identity. An unchanged sample still refreshes host
    // state, but must not make React redraw the pane at display cadence.
    const { image: _image, ...presentation } = frame;
    const key = JSON.stringify(presentation);
    if (key !== presentationKey) {
      options.update(frame);
      presentationKey = key;
    }
    if (previous && previous.documentId !== frame.documentId) documentRevision += 1;
    current = frame;
    // A slow decode must not roll chrome back past a newer native read.
    if (metadata === previousMetadata) acceptMetadata(frame);
  }

  function publishEvents(previous: DesktopBrowserPageFrame | null, frame: DesktopBrowserPageFrame): void {
    if (!previous || previous.webContentsId !== frame.webContentsId) emit('did-attach');
    if (!previous || previous.documentId !== frame.documentId) emit('dom-ready');
    if (previous?.url !== frame.url || previous?.webContentsId !== frame.webContentsId) {
      emit('did-navigate', { url: frame.url, isMainFrame: true });
    }
    if (JSON.stringify(previous?.tabs) !== JSON.stringify(frame.tabs)) emit('tabs-changed');
    if (JSON.stringify(previous?.agentPage) !== JSON.stringify(frame.agentPage)) emit('agent-page');
    if (previous?.loading !== frame.loading) emit(frame.loading ? 'did-start-loading' : 'did-stop-loading');
    if (previous?.loading && !frame.loading) emit('did-finish-load');
    if (frame.fault && frame.fault !== previous?.fault)
      emit('did-fail-load', {
        errorDescription: frame.fault,
        isMainFrame: true,
      });
    // The host cleared the fault (a reloaded page, a page that answers
    // again). A same-address reload between two samples shows no loading
    // state, navigation or attach, so the pane learns it only from here.
    if (previous?.fault && !frame.fault) emit('fault-cleared');
  }

  function pollMetadata(): Promise<void> {
    if (disposed || !options.api.browserPageMetadata) return Promise.resolve();
    if (pendingMetadata) return pendingMetadata;
    pendingMetadata = options.api
      .browserPageMetadata(options.sessionId)
      .then((next) => {
        if (!disposed) acceptMetadata(next);
      })
      .finally(() => {
        pendingMetadata = null;
      });
    return pendingMetadata;
  }

  async function poll(): Promise<void> {
    if (disposed || !options.api.browserPageFrame) return;
    if (options.metadataOnly?.() && options.api.browserPageMetadata) return pollMetadata();
    if (pendingRead) return pendingRead;
    const capture = async (): Promise<DesktopBrowserPageFrame> => {
      // A discarded frame is safe to recapture; never publish its old pixels.
      const resample = async () => {
        const fresh = await options.api.browserPageFrame!(options.sessionId);
        if (browserPageResample(fresh)) throw new Error('Browser page changed during capture.');
        return fresh;
      };
      try {
        const frame = await options.api.browserPageFrame!(options.sessionId, current?.frameId);
        return browserPageResample(frame) ? await resample() : frame;
      } catch (error) {
        if (disposed || !browserPageTransition(error, 'capture')) throw error;
        return await resample();
      }
    };
    const previousMetadata = metadata;
    pendingRead = capture()
      .then(async (next) => {
        if (disposed) return;
        await options.prepare?.(next);
        if (!disposed) accept(next, previousMetadata);
      })
      .finally(() => {
        pendingRead = null;
      });
    return pendingRead;
  }

  function control(action: DesktopBrowserPageAction): Promise<DesktopBrowserTabControlResult | void> {
    // Navigation and tab chrome can initialize without any compositor sample.
    // Page edits still require the exact frame the person actually saw.
    const needsPixels = action.type === 'pointer' || action.type === 'wheel' || browserTypingInput(action);
    const page = needsPixels ? current : (metadata ?? current);
    if (!disposed && !page && !needsPixels && options.api.browserPageMetadata) {
      return pollMetadata().then(() => control(action));
    }
    if (!inputOrder.has(action)) inputOrder.set(action, ++nextInputOrder);
    if (pendingText?.action !== action) pendingText = null;
    if (pendingComposition?.action !== action) pendingComposition = null;
    // Coalescing may never cross a click, key, or another kind of input.
    // Passive hover may cross scrolling; a pressed pointer remains a barrier.
    const hover = action.type === 'pointer' && action.phase === 'mouseMoved' && action.buttons === 0;
    if (pendingMove?.action !== action && !(action.type === 'wheel' && pendingMove?.action.buttons === 0))
      pendingMove = null;
    if (pendingWheel?.action !== action && !hover) pendingWheel = null;
    const clearPending = () => {
      if (pendingText?.action === action) pendingText = null;
      if (pendingComposition?.action === action) pendingComposition = null;
      if (pendingMove?.action === action) pendingMove = null;
      if (pendingResize === action) pendingResize = null;
      if (pendingWheel?.action === action) pendingWheel = null;
    };
    const recovery = browserInputImmediate(action);
    const release = action.type === 'pointer' && action.phase === 'mouseReleased';
    // While the page shows its own dialog the page itself takes no input, as
    // in an ordinary browser: the prompt card answers it. Nothing is queued
    // or reported; a release still goes out so no press stays held.
    if (
      (metadata ?? current)?.dialog &&
      !release &&
      (action.type === 'pointer' || action.type === 'wheel' || browserTypingInput(action))
    ) {
      clearPending();
      return Promise.resolve();
    }
    if (disposed || !page || !options.api.browserPageControl) {
      clearPending();
      // Pane chrome (zoom, geometry, navigation) and hover motion run before
      // the first frame attaches; the pane reapplies them on did-attach and
      // dom-ready, so an early attempt is not a user-facing failure. Only
      // deliberate human input reports that the page cannot take it yet.
      if (!disposed && !page && options.api.browserPageControl && !humanInput(action)) {
        return Promise.reject(new Error('Browser page is attaching.'));
      }
      return rejectInput('Browser page is not ready.', action);
    }
    if (queued >= 128 && !release && !recovery) {
      clearPending();
      return rejectInput(BROWSER_INPUT_BUSY, action);
    }
    if (browserTabControl(action)) inputGeneration += 1;
    const generation = inputGeneration;
    const admittedFailureRevision = failureRevision;
    const documentId = page.documentId;
    const enqueuedAt = performance.now();
    queued += 1;
    const work = (recovery ? chromeTail : Promise.all([tail, chromeTail])).then(async () => {
      clearPending();
      if (disposed) return;
      const motion = action.type === 'pointer' && action.phase === 'mouseMoved';
      // A tab switch invalidates unstarted edits even if the user switches
      // back before the stalled input lane resumes. Releases still clean up.
      if (!recovery && !release && generation !== inputGeneration) {
        preserveText(action);
        return;
      }
      if (
        !release &&
        !recovery &&
        !browserTypingInput(action) &&
        performance.now() - enqueuedAt >= BROWSER_INPUT_WAIT_MS
      ) {
        if (motion || action.type === 'resize') return;
        throw new Error(BROWSER_INPUT_EXPIRED);
      }
      // A display sample must not hold up hover, drag, or later keystrokes.
      // The host checks the document again immediately before dispatch.
      if (motion && current?.documentId !== documentId) return;
      let reply: DesktopBrowserTabControlResult | void;
      try {
        reply = await options.api.browserPageControl!(options.sessionId, {
          ...action,
          documentId: browserInputPresentation(action) ? (metadata ?? current)!.documentId : documentId,
        });
      } catch (error) {
        // Navigation can win the race after the last displayed frame. Drop
        // obsolete motion, but never replay an edit against the new document.
        if (browserPageTransition(error, 'input')) {
          if (motion) return;
          await refreshAfterControl();
          if (disposed) return;
          // Geometry belongs to the pane, not the old document, and a requested
          // address is meant for whichever page the pane shows now (a parked
          // pane's last frame may name a tab the host has since replaced).
          // Retry once only after the host proved it had not dispatched it.
          if (action.type === 'resize' || action.type === 'navigate') {
            await options.api.browserPageControl!(options.sessionId, {
              ...action,
              documentId: (metadata ?? current)!.documentId,
            });
            return;
          }
        }
        throw error;
      }
      if (action.type === 'pointer') {
        if (action.phase === 'mousePressed') heldPointer = { action, documentId };
        if (action.phase === 'mouseReleased') heldPointer = null;
      }
      if (browserTabControl(action)) {
        await refreshAfterControl();
      }
      // A release finishing a failed press, or an older queued success, must
      // not immediately erase the failure before the user has seen it.
      if (!disposed && humanInput(action) && !release && admittedFailureRevision === failureRevision) {
        options.recovered?.();
      }
      return browserTabControl(action) ? reply : undefined;
    });
    // Passive geometry can expire silently. Deliberate human edits must
    // report rejection rather than look like a successful click or keystroke.
    const settled = work.catch((error) => {
      if (humanInput(action) || !browserPageTransition(error, 'input')) throw error;
    });
    const completion = settled
      .catch((error) => {
        preserveText(action);
        if (error instanceof Error && error.message === BROWSER_INPUT_EXPIRED && generation === inputGeneration) {
          // One stalled input rejects the unstarted batch, not each queued
          // keystroke in turn. New input gets a fresh generation; releases
          // still clean up any press that actually reached the page.
          inputGeneration += 1;
        }
        // A navigation superseded by a newer one (ERR_ABORTED, -3) is not a failure.
        if (!disposed && !isAbortedLoad(error)) reportFailure(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        queued -= 1;
        if (!disposed) refresh();
      });
    // Recovery must not replace the fence protecting an in-flight edit.
    if (recovery) chromeTail = completion;
    else tail = completion;
    return settled;
  }

  /** The control itself already succeeded; a compositor miss on the display
   *  sample that follows belongs to the frame loop's display health, not to
   *  this input (as an input failure it would stay until the next click). */
  function refreshAfterControl(): Promise<void> {
    if (options.api.browserPageMetadata) return pollMetadata();
    return poll().catch((error) => {
      if (!browserCaptureTransient(error)) throw error;
    });
  }

  function humanInput(action: DesktopBrowserPageAction): boolean {
    if (action.type === 'pointer') return action.phase !== 'mouseMoved';
    return (
      action.type === 'wheel' ||
      browserTypingInput(action) ||
      action.type === 'answer-dialog' ||
      action.type === 'choose-files'
    );
  }

  function rejectInput(message: string, action?: DesktopBrowserPageAction): Promise<void> {
    preserveText(action);
    if (!disposed) reportFailure(message);
    return Promise.reject(new Error(message));
  }

  function inputToken(): string {
    return `${options.sessionId}:${inputGeneration}:${documentRevision}:${current?.documentId ?? ''}`;
  }

  function fire(action: DesktopBrowserPageAction, token?: string): void {
    if (token !== undefined && token !== inputToken()) {
      preserveText(action);
      if (!disposed) reportFailure('Browser page changed; input was not sent.');
      return;
    }
    if (action.type === 'text') {
      if (pendingText?.token === inputToken() && pendingText.action.text.length + action.text.length <= 32_000) {
        pendingText.action.text += action.text;
        return;
      }
      pendingText = { action, token: inputToken() };
    }
    if (action.type === 'composition') {
      if (pendingComposition?.token === inputToken()) {
        Object.assign(pendingComposition.action, action);
        return;
      }
      pendingComposition = { action, token: inputToken() };
    }
    if (action.type === 'resize') {
      if (pendingResize) {
        Object.assign(pendingResize, action);
        return;
      }
      pendingResize = action;
    }
    if (action.type === 'pointer' && action.phase === 'mouseMoved') {
      if (
        pendingMove &&
        pendingMove.documentId === current?.documentId &&
        pendingMove.action.buttons === action.buttons &&
        pendingMove.action.button === action.button &&
        pendingMove.action.modifiers === action.modifiers
      ) {
        Object.assign(pendingMove.action, action);
        return;
      }
      pendingMove = { action, documentId: current?.documentId || '' };
    }
    if (action.type === 'wheel') {
      const previous = pendingWheel?.action;
      if (
        previous &&
        pendingWheel?.documentId === current?.documentId &&
        previous.x === action.x &&
        previous.y === action.y &&
        Math.sign(previous.deltaX) === Math.sign(action.deltaX) &&
        Math.sign(previous.deltaY) === Math.sign(action.deltaY) &&
        Math.abs(previous.deltaX + action.deltaX) <= 20_000 &&
        Math.abs(previous.deltaY + action.deltaY) <= 20_000
      ) {
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
      if (!metadata) throw new Error('Browser page is attaching.');
      return metadata.webContentsId;
    };
    node.getURL = () => metadata?.url || 'about:blank';
    node.canGoBack = () => metadata?.canGoBack === true;
    node.canGoForward = () => metadata?.canGoForward === true;
    node.loadURL = (url) => control({ type: 'navigate', url });
    node.goBack = () => fire({ type: 'back' });
    node.goForward = () => fire({ type: 'forward' });
    node.reload = () => fire({ type: 'reload' });
    node.stop = () => fire({ type: 'stop' });
    node.setZoomFactor = (factor) => fire({ type: 'zoom', factor });
    node.getTabs = () => metadata?.tabs ?? [];
    node.getAgentPage = () => metadata?.agentPage;
    node.createTab = (requestId) => control({ type: 'new-tab', ...(requestId ? { requestId } : {}) });
    node.selectTab = (tabId, follow) => control({ type: 'select-tab', tabId, ...(follow ? { follow } : {}) });
    node.closeTab = (tabId) => control({ type: 'close-tab', tabId });
    node.focus = focusInput;
    Object.defineProperty(node, 'src', {
      configurable: true,
      get: node.getURL,
      set: (url) => fire({ type: 'navigate', url: String(url) }),
    });
  }

  return {
    poll,
    pollMetadata,
    fire,
    control,
    bind,
    inputToken,
    clearUnconfirmedText: () => {
      unconfirmedText.clear();
      options.unconfirmedText?.('');
    },
    shortcut: (shortcut: string) => emit('browser-shortcut', { shortcut }),
    frame: () => current,
    metadata: () => metadata,
    setRefresh: (callback: () => void) => {
      refresh = callback;
    },
    activate: () => {
      disposed = false;
    },
    dispose: () => {
      disposed = true;
      refresh = () => {};
      // Finish an already-sent press even if the display unmounts mid-drag.
      // Unstarted edits are discarded; cleanup never moves to a new document.
      void tail
        .then(async () => {
          const held = heldPointer;
          heldPointer = null;
          if (held)
            await options.api.browserPageControl?.(options.sessionId, {
              ...held.action,
              documentId: held.documentId,
              phase: 'mouseReleased',
              buttons: 0,
            });
        })
        .catch(() => {});
    },
  };
}
