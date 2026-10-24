import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { EventEmitter } from 'node:events';
import {
  BROWSER_OBSERVATION_REVISION,
  browserDocumentChanged,
  createBrowserDocuments,
  filterBrowserReadLines,
} from './documents.ts';

// Frames are jsdom windows evaluated synchronously, like CDP Runtime.evaluate
// on a non-promise value. `timers` shapes each frame's event loop: 'normal',
// a delay in ms, or 'blocked' (a sandbox without allow-scripts never fires one).
function checkpointFixture(frames, checkpointDeadlineMs = 120, { sessions = new Map(), beforeEvaluate } = {}) {
  const windows = new Map();
  const generations = new Map();
  const evaluations = [];
  const port = new EventEmitter();
  const ids = [];
  const add = (id, timers) => {
    if (!ids.includes(id)) ids.push(id);
    const { window } = new JSDOM('<!doctype html>', { runScripts: 'outside-only' });
    if (timers === 'blocked') {
      window.setTimeout = () => 0;
      window.requestAnimationFrame = () => 0;
    } else if (timers === 'held') {
      // Timers run only when the test releases them, never by the wall clock.
      window.__held = [];
      window.setTimeout = (callback) => window.__held.push(callback);
      window.requestAnimationFrame = (callback) => window.__held.push(callback);
    } else if (typeof timers === 'number') {
      window.setTimeout = (callback) => globalThis.setTimeout(callback, timers);
      window.requestAnimationFrame = (callback) => globalThis.setTimeout(callback, timers);
    }
    windows.set(id, window);
  };
  for (const [id, timers] of Object.entries(frames)) add(id, timers);
  const documents = createBrowserDocuments(
    {
      sessions: () => sessions,
      cdp: {
        guestDebugger: async () => port,
        call: async (_guest, method, args) => {
          if (method === 'Page.getFrameTree') {
            return { frameTree: { frame: { id: ids[0] }, childFrames: ids.slice(1).map((id) => ({ frame: { id } })) } };
          }
          // A context id names the frame and the document generation it lives in.
          if (method === 'Page.createIsolatedWorld') {
            return { executionContextId: `${args.frameId}#${generations.get(args.frameId) || 0}` };
          }
          await beforeEvaluate?.(args);
          const frame = args.contextId.split('#')[0];
          const value = windows.get(frame).eval(args.expression);
          evaluations.push({ frame, context: args.contextId, value });
          return { result: { value } };
        },
      },
    },
    { checkpointDeadlineMs }
  );
  const marks = () =>
    Object.fromEntries([...windows].map(([id, window]) => [id, { ...window.__mixdogRenderCheckpoints }]));
  return {
    documents,
    evaluations,
    marks,
    windows,
    // A navigation keeps the frame id but replaces its document and context.
    navigate(id, timers) {
      generations.set(id, (generations.get(id) || 0) + 1);
      add(id, timers);
      port.emit('message', {}, 'Page.frameNavigated', {});
    },
    // A frame attached while a checkpoint is polling.
    attach(id, timers) {
      add(id, timers);
      port.emit('message', {}, 'Page.frameAttached', {});
    },
  };
}
const noMarks = (marks) => Object.values(marks).every((frame) => Object.keys(frame).length === 0);
const guestFor = () => new EventEmitter();

test('the render checkpoint waits for a slow frame and confirms every frame', async () => {
  const { documents, evaluations } = checkpointFixture({ top: 'normal', slow: 150 }, 1_000);
  const startedAt = Date.now();
  assert.equal(await documents.renderCheckpoint(new EventEmitter(), false), true);
  assert.ok(Date.now() - startedAt >= 140, 'the slow frame is part of the barrier');
  assert.ok(
    evaluations.every(({ value }) => typeof value === 'boolean'),
    'frames answer synchronously: no awaited promise is left in any page'
  );
});

test('a frame that never runs timers is skipped at the deadline and reported unconfirmed', async () => {
  const { documents } = checkpointFixture({ top: 'normal', sandboxed: 'blocked' });
  const startedAt = Date.now();
  assert.equal(await documents.renderCheckpoint(new EventEmitter(), false), false);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 100 && elapsed < 1_000, `finished near the deadline, took ${elapsed}ms`);
  // The healthy frame's marker was consumed and a later checkpoint is independent.
  const { documents: healthy } = checkpointFixture({ top: 'normal', second: 'normal' });
  assert.equal(await healthy.renderCheckpoint(new EventEmitter(), true), true);
});

test('cancelling a checkpoint stops polling at once', async () => {
  const { documents } = checkpointFixture({ top: 'blocked' }, 5_000);
  const controller = new AbortController();
  const pending = documents.renderCheckpoint(new EventEmitter(), false, controller.signal);
  setTimeout(() => controller.abort(new Error('cancelled')), 30);
  await assert.rejects(pending, /cancelled/);
});

test('a frame attached while the checkpoint polls is scheduled and awaited, never confirmed unseen', async () => {
  const delayed = checkpointFixture({ top: 60 }, 1_000);
  const guest = guestFor();
  setTimeout(() => delayed.attach('late', 150), 20);
  const startedAt = Date.now();
  assert.equal(await delayed.documents.renderCheckpoint(guest, false), true);
  assert.ok(Date.now() - startedAt >= 160, 'the late frame is part of the barrier');
  assert.ok(delayed.evaluations.some(({ frame }) => frame === 'late'));

  const blocked = checkpointFixture({ top: 60 }, 250);
  setTimeout(() => blocked.attach('late', 'blocked'), 20);
  assert.equal(await blocked.documents.renderCheckpoint(guestFor(), false), false);
});

test('a frame that has no marker yet is checkpointed, not assumed done', async () => {
  // A recreated isolated world loses its marker: the next poll must schedule the
  // checkpoint there and report it pending rather than confirm.
  const { documents, evaluations, windows } = checkpointFixture({ top: 'normal' }, 1_000);
  const original = documents.collect.byFrame;
  let polls = 0;
  documents.collect.byFrame = async (...args) => {
    if (++polls === 2) for (const window of windows.values()) delete window.__mixdogRenderCheckpoints;
    return original(...args);
  };
  assert.equal(await documents.renderCheckpoint(guestFor(), false), true);
  assert.ok(evaluations.length >= 3, `the wiped frame was checkpointed again (${evaluations.length} reads)`);
});

test('markers are cleared when a checkpoint ends at its deadline or is cancelled, and late timers recreate nothing', async () => {
  const slow = checkpointFixture({ top: 'normal', slow: 300 }, 100);
  assert.equal(await slow.documents.renderCheckpoint(guestFor(), false), false);
  assert.ok(noMarks(slow.marks()), 'deadline clears every marker');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(noMarks(slow.marks()), 'a timer firing after the checkpoint ended is a no-op');

  const blocked = checkpointFixture({ top: 'blocked' }, 5_000);
  const controller = new AbortController();
  const pending = blocked.documents.renderCheckpoint(guestFor(), false, controller.signal);
  setTimeout(() => controller.abort(new Error('cancelled')), 30);
  await assert.rejects(pending, /cancelled/);
  assert.ok(noMarks(blocked.marks()), 'cancellation clears every marker');
});

test('polling reads only the frames still pending', async () => {
  // The slow frame's timers are held until it has been read ten times, so the
  // count depends on the polling logic, not on how fast the machine is.
  let slowReads = 0;
  const fixture = checkpointFixture({ fast: 'normal', slow: 'held' }, 1_000, {
    beforeEvaluate: ({ contextId }) => {
      if (contextId.split('#')[0] !== 'slow' || ++slowReads !== 10) return;
      for (const callback of fixture.windows.get('slow').__held.splice(0)) callback();
    },
  });
  const { documents, evaluations } = fixture;
  assert.equal(await documents.renderCheckpoint(guestFor(), false), true);
  const reads = (id) => evaluations.filter(({ frame }) => frame === id).length;
  assert.ok(reads('fast') <= 3, `a completed frame is not read again (${reads('fast')} reads)`);
  assert.ok(reads('slow') > reads('fast') + 5, `the pending frame keeps being polled (${reads('slow')} reads)`);
});

test('document change ignores pointer activity and scrolling unless asked', () => {
  const at = (version, dom, scrollY = 0) => `1700000000:${version}:800:600:0:${scrollY}:${dom}`;
  assert.equal(browserDocumentChanged(at(1, 1), at(2, 1)), false, 'a pointer press alone is not a change');
  assert.equal(browserDocumentChanged(at(1, 1), at(2, 2)), true, 'a mutation or value change is');
  assert.equal(browserDocumentChanged(at(1, 1), at(2, 1, 300)), false);
  assert.equal(browserDocumentChanged(at(1, 1), at(2, 1, 300), { includeScroll: true }), true);
  assert.equal(browserDocumentChanged(at(1, 1), `${at(1, 1)}|${at(1, 1)}`), true, 'a frame appeared');
  assert.equal(browserDocumentChanged('1700:1:800:600:0:0', at(1, 1)), undefined, 'an old-format revision is unknown');
  assert.equal(browserDocumentChanged(undefined, at(1, 1)), undefined);
});

test('the page-side revision counts mutations and value changes apart from gestures', () => {
  const dom = new JSDOM('<!doctype html><input id="field"><div id="box"></div>', { runScripts: 'outside-only' });
  try {
    const { window } = dom;
    const parts = () => window.eval(BROWSER_OBSERVATION_REVISION).split(':');
    const first = parts();
    assert.equal(parts()[6], first[6]);
    window.document.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
    const pressed = parts();
    assert.notEqual(pressed[1], first[1], 'activity moves the version');
    assert.equal(pressed[6], first[6], 'but not the document counter');
    window.document.querySelector('#box').textContent = 'changed';
    const mutated = parts();
    assert.equal(Number(mutated[6]), Number(pressed[6]) + 1);
    window.document.querySelector('#field').dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(Number(parts()[6]), Number(mutated[6]) + 1, 'a typed value counts as a document change');
  } finally {
    dom.window.close();
  }
});

test('read filters lines by OR keywords or a regular expression with two lines of context', () => {
  const text = ['Title', 'Price: 10', 'Stock: none', 'Shipping', 'Footer', 'Contact', 'Legal'].join('\n');
  assert.deepEqual(filterBrowserReadLines(text, 'stock contact').split('\n'), [
    'Title',
    'Price: 10',
    'Stock: none',
    'Shipping',
    'Footer',
    'Contact',
    'Legal',
  ]);
  assert.deepEqual(filterBrowserReadLines(text, '/^legal$/i').split('\n'), ['Footer', 'Contact', 'Legal']);
  assert.equal(filterBrowserReadLines(text, 'nothing here'), '');
  assert.equal(filterBrowserReadLines(text, '   '), text);
});

test('nested and shadow-root scrolling changes the scroll revision without claiming a DOM edit', () => {
  const dom = new JSDOM('<div id="list"></div><div id="host"></div>', { runScripts: 'outside-only' });
  try {
    const { window } = dom;
    const shadow = window.document.querySelector('#host').attachShadow({ mode: 'open' });
    shadow.innerHTML = '<div id="inner"></div>';
    const revision = () => window.eval(BROWSER_OBSERVATION_REVISION);
    for (const target of [window.document.querySelector('#list'), shadow.querySelector('#inner')]) {
      const before = revision();
      target.dispatchEvent(new window.Event('scroll'));
      const after = revision();
      assert.equal(browserDocumentChanged(before, after), false);
      assert.equal(browserDocumentChanged(before, after, { includeScroll: true }), true);
      assert.equal(before.split(':')[5], after.split(':')[5], 'the outer document did not scroll');
      const state = window.__mixdogObservationRevision;
      target.scrollTop = 100;
      state.recordScroll(target);
      const moved = revision();
      assert.equal(browserDocumentChanged(after, moved, { includeScroll: true }), true);
      target.dispatchEvent(new window.Event('scroll'));
      assert.equal(revision(), moved, 'a deferred event must not count the same movement again');
    }
  } finally {
    dom.window.close();
  }
});

test('a navigation that keeps the frame id gets its new document checkpointed, not assumed confirmed', async () => {
  const f = checkpointFixture({ top: 'normal', slow: 250 }, 600);
  setTimeout(() => f.navigate('top', 'blocked'), 150);
  assert.equal(await f.documents.renderCheckpoint(guestFor(), false), false);
  assert.ok(
    f.evaluations.some(({ context }) => context === 'top#1'),
    'the new root was read in its own context'
  );

  const healthy = checkpointFixture({ top: 'normal', slow: 250 }, 1_000);
  setTimeout(() => healthy.navigate('top', 'normal'), 150);
  assert.equal(await healthy.documents.renderCheckpoint(guestFor(), false), true);
  assert.ok(healthy.evaluations.some(({ context, value }) => context === 'top#1' && value === true));
});

test('a child target that never becomes ready cannot hold the checkpoint past its deadline or cleanup bound', async () => {
  let becomeReady;
  const ready = new Promise((resolve) => {
    becomeReady = resolve;
  });
  const sessions = new Map([['oop', { type: 'iframe', frameId: 'oop', ready }]]);
  const f = checkpointFixture({ top: 'normal', oop: 'normal' }, 20, { sessions });
  const startedAt = Date.now();
  const keepAlive = setInterval(() => {}, 50); // AbortSignal.timeout does not hold the event loop open
  assert.equal(await f.documents.renderCheckpoint(guestFor(), false), false);
  clearInterval(keepAlive);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 900, `deadline and 500ms cleanup bound were exceeded: ${elapsed}ms`);
  // Only this wait was cancelled: the shared initialization still completes for later observations.
  becomeReady();
  const later = checkpointFixture({ top: 'normal', oop: 'normal' }, 1_000, { sessions });
  assert.equal(await later.documents.renderCheckpoint(guestFor(), false), true);
});

test('a genuine read failure after the deadline still throws instead of reporting unconfirmed', async () => {
  const f = checkpointFixture({ top: 'blocked' }, 30, {
    beforeEvaluate: async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      throw new Error('frame observation failed: boom');
    },
  });
  await assert.rejects(f.documents.renderCheckpoint(guestFor(), false), /boom/);
});
