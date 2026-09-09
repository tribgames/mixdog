import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserPageClient } from './browser-page-client.ts';
import { BROWSER_INPUT_BUSY, BROWSER_INPUT_WAIT_MS } from '../shared/browser-input-policy.ts';
import { normalizeBrowserPageControl } from '../shared/browser-page-control.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
const pointer = (phase, x, buttons = 0) => ({
  type: 'pointer', phase, x, y: 10, buttons, button: buttons ? 'left' : 'none',
  modifiers: 0, clickCount: 1,
});
const wheel = (deltaY = 10, x = 10) => ({ type: 'wheel', x, y: 10, deltaX: 0, deltaY });

test('interleaved passive motion and scrolling retain distance without overflowing', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 200; i++) {
      f.client.fire(wheel());
      f.client.fire(pointer('mouseMoved', 10));
    }
    assert.deepEqual(f.failures, []);
    f.release();
    await f.held;
    await f.client.control({ type: 'key', key: 'Tab' });
    const wheels = f.sent.filter(a => a.type === 'wheel');
    const moves = f.sent.filter(a => a.phase === 'mouseMoved');
    assert.equal(wheels.reduce((sum, a) => sum + a.deltaY, 0), 2000);
    assert.ok(wheels.length < 128);
    assert.equal(moves.at(-1).x, 10);
    assert.deepEqual(f.failures, []);
  } finally { f.release(); f.client.dispose(); }
});

test('latest geometry survives the input deadline and applies while an edit is still blocked', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const f = await fixture();
  try {
    f.client.fire({ type: 'resize', width: 900, height: 600 });
    f.client.fire(pointer('mouseMoved', 10));
    f.client.fire({ type: 'resize', width: 1100, height: 700 });
    now += BROWSER_INPUT_WAIT_MS + 1;
    // A native control behind resize drains only the independent chrome lane.
    await f.client.control({ type: 'stop' });
    assert.deepEqual(f.sent.filter(a => a.type === 'resize').map(a => [a.width, a.height]), [[1100, 700]]);
    assert.deepEqual(f.failures, []);
  } finally { f.release(); await f.held; f.client.dispose(); }
});

test('tab controls escape stalled edits and invalidate unstarted input even after switching back', async () => {
  const f = await fixture();
  try {
    const oldEdit = f.client.control({ type: 'text', text: 'do not revive' });
    await f.client.control({ type: 'select-tab', tabId: 'p2' });
    await f.client.control({ type: 'select-tab', tabId: 'p1' });
    await f.client.control({ type: 'new-tab' });
    await f.client.control({ type: 'close-tab', tabId: 'p2' });
    assert.deepEqual(f.sent.slice(1).map(a => a.type), ['select-tab', 'select-tab', 'new-tab', 'close-tab']);
    f.release();
    await Promise.all([f.held, oldEdit]);
    await f.client.control({ type: 'text', text: 'fresh' });
    assert.equal(f.sent.some(a => a.text === 'do not revive'), false);
    assert.equal(f.sent.at(-1).text, 'fresh');
  } finally { f.release(); f.client.dispose(); }
});

async function fixture() {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const sent = [];
  const failures = [];
  let recoveries = 0;
  const client = createBrowserPageClient({
    sessionId: 's', update() {}, failure: error => failures.push(error),
    recovered: () => { recoveries++; },
    api: {
      browserPageFrame: async () => ({
        documentId: 'p1:1', frameId: 'f1', webContentsId: 1, url: 'https://example.test',
        width: 800, height: 600, viewportWidth: 800, viewportHeight: 600,
      }),
      browserPageControl: async (_session, action) => {
        normalizeBrowserPageControl(action);
        sent.push({ ...action });
        if (action.text === 'hold') await gate;
      },
    },
  });
  await client.poll();
  const held = client.control({ type: 'text', text: 'hold' });
  await tick();
  return { client, sent, failures, release, held, recoveries: () => recoveries };
}

test('wheel bursts preserve distance within transport limits without overflowing the input queue', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 1000; i++) f.client.fire(wheel(120));
    assert.deepEqual(f.failures, []);
    f.release();
    await f.held;
    await f.client.control({ type: 'key', key: 'Tab' });
    const wheels = f.sent.filter(action => action.type === 'wheel');
    assert.equal(wheels.reduce((total, action) => total + action.deltaY, 0), 120_000);
    assert.ok(wheels.length < 128);
    assert.deepEqual(f.failures, []);
  } finally { f.release(); f.client.dispose(); }
});

test('wheel merging preserves target, direction, and intervening input order', async () => {
  const f = await fixture();
  try {
    f.client.fire(wheel(10));
    f.client.fire(wheel(-10));
    f.client.fire(wheel(-10, 20));
    f.client.fire({ type: 'key', key: 'Tab' });
    f.client.fire(wheel(-10, 20));
    f.release();
    await f.held;
    await f.client.control({ type: 'text', text: 'barrier' });
    assert.deepEqual(f.sent.slice(1, -1).map(a => [a.type, a.x, a.deltaY]), [
      ['wheel', 10, 10], ['wheel', 10, -10], ['wheel', 20, -10],
      ['key', undefined, undefined], ['wheel', 20, -10],
    ]);
  } finally { f.release(); f.client.dispose(); }
});

test('rejected motion can be sent again after congestion clears and successful input signals recovery', async () => {
  const f = await fixture();
  try {
    const pending = Array.from({ length: 127 }, (_, i) => f.client.control({ type: 'text', text: String(i) }));
    f.client.fire(pointer('mouseMoved', 1));
    assert.deepEqual(f.failures, [BROWSER_INPUT_BUSY]);
    assert.equal(f.recoveries(), 0);
    f.release();
    await Promise.all([f.held, ...pending]);
    await tick();
    f.client.fire(pointer('mouseMoved', 9));
    await f.client.control({ type: 'key', key: 'Tab' });
    assert.deepEqual(f.sent.filter(a => a.phase === 'mouseMoved').map(a => a.x), [9]);
    assert.ok(f.recoveries() > 0);
  } finally { f.release(); f.client.dispose(); }
});

test('coalescing never moves drag motion across a press, release, or direct control call', async () => {
  const f = await fixture();
  try {
    f.client.fire(pointer('mouseMoved', 10));
    const down = f.client.control(pointer('mousePressed', 10, 1));
    f.client.fire(pointer('mouseMoved', 20, 1));
    f.client.fire(pointer('mouseMoved', 30, 1));
    f.client.fire(pointer('mouseReleased', 30));
    f.client.fire(pointer('mouseMoved', 40));
    f.release();
    await Promise.all([f.held, down]);
    await f.client.control({ type: 'text', text: 'barrier' });
    assert.deepEqual(f.sent.filter(a => a.type === 'pointer').map(a => [a.phase, a.x, a.buttons]), [
      ['mouseMoved', 10, 0], ['mousePressed', 10, 1], ['mouseMoved', 30, 1],
      ['mouseReleased', 30, 0], ['mouseMoved', 40, 0],
    ]);
  } finally { f.release(); f.client.dispose(); }
});

test('expired unstarted edits are not replayed, while an already-sent press is released', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const f = await fixture();
  try {
    const press = f.client.control(pointer('mousePressed', 10, 1));
    f.release();
    await Promise.all([f.held, press]);
    // Enqueue both before their promise callbacks start.
    const edit = f.client.control({ type: 'text', text: 'expired' });
    const release = f.client.control(pointer('mouseReleased', 10));
    now += BROWSER_INPUT_WAIT_MS + 1;
    await assert.rejects(edit, /input expired; input was not sent/);
    await release;
    assert.equal(f.sent.some(a => a.text === 'expired'), false);
    assert.equal(f.sent.at(-1).phase, 'mouseReleased');
    await f.client.control({ type: 'text', text: 'fresh' });
    assert.equal(f.sent.at(-1).text, 'fresh');
  } finally { f.release(); f.client.dispose(); }
});

test('stop and reload bypass a blocked client without releasing the fence for ordinary input', async () => {
  const f = await fixture();
  try {
    const queued = f.client.control({ type: 'text', text: 'queued' });
    await f.client.control({ type: 'stop' });
    await f.client.control({ type: 'reload' });
    assert.deepEqual(f.sent.map(a => a.type), ['text', 'stop', 'reload']);
    assert.equal(f.sent.some(a => a.text === 'queued'), false);
    f.release();
    await Promise.all([f.held, queued]);
  } finally { f.release(); f.client.dispose(); }
});
