// The desktop windows that read a turn review, driven the same way against the Node product (the recorder) and against this
// checkout (the replay): each window is a jsdom window with the product's `TurnReviewBar` mounted for one session, its
// `window.mixdogDesktop` a bridge the caller builds, and every capability request the bar makes is queued here and answered
// one at a time by `respond`. Nothing waits on the clock: `act` flushes the bar's effects and promises, a request is answered
// only after the one before it settled, and the window is quiet when no request is queued.
//
// The load is by file URL from `tree` (the desktop package's own test setup must be preloaded with `--import`, which pins one
// React and stubs stylesheets), so the same code mounts the bar of whichever tree it is given.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadWindowKit(tree) {
  const requireFrom = createRequire(join(tree, 'apps/desktop/package.json'));
  const { JSDOM } = await import(pathToFileURL(requireFrom.resolve('jsdom')).href);
  const react = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { TurnReviewBar } = await import(pathToFileURL(join(tree, 'apps/desktop/src/renderer/TurnReview.tsx')).href);
  return { JSDOM, React: react.default ?? react, act: react.act, createRoot, TurnReviewBar };
}

const prompt = (checkpoint) => ({ kind: 'user', id: checkpoint, text: 'Change a file' });
const edit = { kind: 'tool', id: 'edit', name: 'apply_patch', args: {}, result: 'Updated a.txt' };

export class ReviewWindows {
  #kit;
  #respond;
  #dom;
  #pending = [];
  #windows = new Map();
  #requests = [];
  /** Deliveries the caller has made in the running operation: a request is stamped with the count at the moment it was made. */
  deliveries = 0;

  /** `respond({ session, request })` answers one capability request with the value the bar reads. */
  constructor(kit, respond) {
    this.#kit = kit;
    this.#respond = respond;
    this.#dom = new kit.JSDOM('<!doctype html><body></body>', { url: 'https://mixdog.test/', pretendToBeVisual: true });
    const define = (key, value) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    define('window', this.#dom.window);
    define('document', this.#dom.window.document);
    define('IS_REACT_ACT_ENVIRONMENT', true);
  }

  /** The window's end of `invokeCapability`: the request waits here until `settle` answers it. The bar reads `window.mixdogDesktop`
   *  again at each call, so the bridge reached is the last one mounted and the session is the request's own. */
  invoke(request) {
    return new Promise((resolve) => this.#pending.push({ session: request.sessionId, request, resolve, after: this.deliveries }));
  }

  /** Mounts the bar of `session` in a window of its own whose bridge is `api`. */
  async open({ session, checkpoint, api }) {
    const { React, act, createRoot, TurnReviewBar } = this.#kit;
    const container = this.#dom.window.document.createElement('div');
    this.#dom.window.document.body.append(container);
    const root = createRoot(container);
    // The bar reads the bridge of its window when its effects subscribe, inside this render.
    this.#dom.window.mixdogDesktop = api;
    await act(async () => root.render(React.createElement(TurnReviewBar, { items: [prompt(checkpoint), edit], sessionId: session, active: true, busy: false })));
    this.#windows.set(session, { container, root });
  }

  startOperation() {
    this.#requests = [];
    this.deliveries = 0;
  }

  /** Answers the queued requests in the order they were made until none is left; `afterAnswer(n)` runs once the n-th answer has settled. */
  async settle(afterAnswer = async () => {}) {
    const { act } = this.#kit;
    let answered = 0;
    for (;;) {
      await act(async () => {});
      // A delivery is one microtask behind the answer that raised it.
      await null;
      const next = this.#pending.shift();
      if (!next) return;
      const entry = { client: next.session, after: next.after, request: next.request, answer: null, shown: null };
      this.#requests.push(entry);
      entry.answer = await this.#respond(next);
      await act(async () => next.resolve({ value: entry.answer }));
      // What the bar shows once this answer is in: a burst of tells may skip a read, never a state a user could see only here.
      entry.shown = this.shown(next.session);
      answered += 1;
      await afterAnswer(answered);
    }
  }

  /** The text of the bar the window of `session` shows now, null when it draws none. */
  shown(session) {
    return this.#windows.get(session).container.querySelector('.turn-review-bar')?.textContent ?? null;
  }

  /** What the clients asked and showed in the running operation. */
  trace() {
    const shows = {};
    for (const session of [...this.#windows.keys()].sort((a, b) => a.localeCompare(b))) shows[session] = this.shown(session);
    return { deliveries: this.deliveries, requests: this.#requests, shows };
  }

  async close() {
    const { act } = this.#kit;
    for (const { root } of this.#windows.values()) await act(async () => root.unmount());
    this.#dom.window.close();
  }
}
