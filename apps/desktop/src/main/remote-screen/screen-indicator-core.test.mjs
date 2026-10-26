import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { overlayHtml, overlayScript } from '../computer/overlay/content.ts';
import { overlayBounds, REMOTE_PILL_GAP } from '../computer/overlay/overlay-layout.ts';
import {
  computerUsePillShown,
  onComputerUsePillShownChange,
  setComputerUsePillShown,
} from '../computer/overlay/overlay-presence.ts';
import { createRemoteScreenIndicatorHost, handleRemoteIndicatorControl } from './screen-indicator-core.ts';

const DISPLAYS = [
  { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
  { id: 2, workArea: { x: 1920, y: 0, width: 1280, height: 720 } },
];

function fixture() {
  const state = { cu: false, shown: [], displays: DISPLAYS, handlers: null };
  const cuListeners = new Set();
  const displayListeners = new Set();
  const windows = [];
  const host = createRemoteScreenIndicatorHost({
    displays: () => state.displays,
    primaryDisplayId: () => 1,
    createWindow(bounds, handlers) {
      const window = { bounds, tooltip: '', destroyed: false, moves: [] };
      window.setBounds = (next) => {
        window.bounds = next;
        window.moves.push(next);
      };
      window.setTooltip = (value) => {
        window.tooltip = value;
      };
      window.destroy = () => {
        window.destroyed = true;
      };
      window.handlers = handlers;
      windows.push(window);
      return window;
    },
    retryMs: 5,
    computerPillShown: () => state.cu || computerUsePillShown(),
    onComputerPillChange: (listener) => {
      cuListeners.add(listener);
      const off = onComputerUsePillShownChange(listener);
      return () => {
        cuListeners.delete(listener);
        off();
      };
    },
    onDisplaysChange: (listener) => {
      displayListeners.add(listener);
      return () => displayListeners.delete(listener);
    },
  });
  return {
    host,
    windows,
    state,
    setCu(value) {
      state.cu = value;
      for (const listener of cuListeners) listener();
    },
    changeDisplays(next) {
      state.displays = next;
      for (const listener of displayListeners) listener();
    },
  };
}

const cuY = overlayBounds(DISPLAYS[0]).y;
const belowY = cuY + 50 + REMOTE_PILL_GAP;

test('Computer Use already up: the remote pill sits below it on the same centre line', () => {
  const f = fixture();
  f.state.cu = true;
  f.host.show({ deviceLabel: 'Pixel', onStop() {} });
  const cu = overlayBounds(DISPLAYS[0]);
  assert.deepEqual(f.windows[0].bounds, { ...cu, y: belowY });
  // Pill tops are 10px inside their windows: the pills are exactly 8px apart.
  assert.equal(f.windows[0].bounds.y + 10 - (cu.y + 10 + 50), REMOTE_PILL_GAP);
});

test('alone it takes the top slot, and keeps its place when Computer Use ends', () => {
  const f = fixture();
  f.host.show({ deviceLabel: 'Pixel', onStop() {} });
  assert.equal(f.windows[0].bounds.y, cuY);
  f.setCu(true);
  assert.equal(f.windows[0].bounds.y, belowY);
  f.setCu(false);
  assert.equal(f.windows[0].bounds.y, belowY);
  assert.equal(f.windows[0].moves.length, 1);
  f.setCu(true);
  f.setCu(false);
  assert.equal(f.windows[0].moves.length, 1);
});

test('a pill that began below does not climb when Computer Use ends', () => {
  const f = fixture();
  f.state.cu = true;
  f.host.show({ deviceLabel: 'Pixel', onStop() {} });
  f.setCu(false);
  assert.equal(f.windows[0].bounds.y, belowY);
});

test('after the pill closes, the next one starts fresh in the top slot', () => {
  const f = fixture();
  const first = f.host.show({ deviceLabel: 'Pixel', onStop() {} });
  f.setCu(true);
  first.close();
  f.setCu(false);
  f.host.show({ deviceLabel: 'Pixel', onStop() {} });
  assert.equal(f.windows[1].bounds.y, cuY);
});

test('it follows the viewed display, else the primary, and tracks display changes', () => {
  const f = fixture();
  f.host.show({ deviceLabel: 'Pixel', displayId: 2, onStop() {} });
  assert.equal(f.windows[0].bounds.x, overlayBounds(DISPLAYS[1]).x);
  f.changeDisplays([DISPLAYS[0]]);
  assert.equal(f.windows[0].bounds.x, overlayBounds(DISPLAYS[0]).x);
  const g = fixture();
  g.host.show({ deviceLabel: 'Pixel', displayId: 99, onStop() {} });
  assert.equal(g.windows[0].bounds.x, overlayBounds(DISPLAYS[0]).x);
});

test('Stop ends only the remote sessions, every one of them', async () => {
  const f = fixture();
  const stopped = [];
  f.host.show({ deviceLabel: 'Pixel', onStop: () => void stopped.push('a') });
  f.host.show({
    deviceLabel: 'iPhone',
    onStop: async () => {
      stopped.push('b');
      throw new Error('boom');
    },
  });
  assert.equal(f.windows.length, 1);
  assert.equal(f.windows[0].tooltip, 'Pixel\niPhone');
  await f.windows[0].handlers.stop();
  assert.deepEqual(stopped, ['a', 'b']);
});

test('update renames, close removes one phone, the last close removes the pill', () => {
  const f = fixture();
  const a = f.host.show({ deviceLabel: 'Pixel', onStop() {} });
  const b = f.host.show({ deviceLabel: 'iPhone', onStop() {} });
  a.update('Pixel 9');
  assert.equal(f.windows[0].tooltip, 'Pixel 9\niPhone');
  a.close();
  a.close();
  assert.equal(f.windows[0].tooltip, 'iPhone');
  assert.equal(f.windows[0].destroyed, false);
  b.update('Phone');
  b.close();
  assert.equal(f.windows[0].destroyed, true);
  f.setCu(true);
  assert.equal(f.windows[0].moves.length, 0);
});

test('a shell-drawn Computer Use pill holds the top slot; an Electron fade ending never clears it', (t) => {
  t.after(() => {
    setComputerUsePillShown(false, 'shell');
    setComputerUsePillShown(false, 'electron');
  });
  const f = fixture();
  setComputerUsePillShown(true, 'shell');
  f.host.show({ deviceLabel: 'Pixel', onStop() {} });
  assert.equal(f.windows[0].bounds.y, belowY);
  setComputerUsePillShown(false, 'electron');
  assert.equal(computerUsePillShown(), true);
  setComputerUsePillShown(false, 'shell');
  assert.equal(computerUsePillShown(), false);
  assert.equal(f.windows[0].bounds.y, belowY);
});

test('a display coming back opens exactly one pill when there was none', () => {
  const f = fixture();
  f.state.displays = [];
  f.host.show({ deviceLabel: 'Pixel', onStop() {} });
  assert.equal(f.windows.length, 0);
  f.changeDisplays(DISPLAYS);
  assert.equal(f.windows.length, 1);
  f.changeDisplays(DISPLAYS);
  assert.equal(f.windows.length, 1);
});

test('a display lost during a recreate is recovered when one returns', async () => {
  const f = fixture();
  f.host.show({ deviceLabel: 'Pixel', onStop() {} });
  f.state.displays = [];
  f.windows[0].handlers.gone();
  // A display event while the retry is pending leaves the reopen to the timer.
  f.changeDisplays([]);
  assert.equal(f.windows.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.windows.length, 1);
  f.changeDisplays(DISPLAYS);
  assert.equal(f.windows.length, 2);
  assert.equal(f.windows[1].tooltip, 'Pixel');
});

test('the page may only report a press or Stop', async () => {
  let stops = 0;
  const stop = async () => void (stops += 1);
  assert.deepEqual(await handleRemoteIndicatorControl({ action: 'press', control: 'stop' }, stop), { accepted: true });
  assert.equal(stops, 0);
  assert.deepEqual(await handleRemoteIndicatorControl({ action: 'stop', generation: 0 }, stop), { accepted: true });
  assert.equal(stops, 1);
  for (const bad of [{ action: 'resume' }, null, [], 'stop']) {
    await assert.rejects(handleRemoteIndicatorControl(bad, stop), /Invalid overlay request/);
  }
});

test('the remote page: phone mark, Korean copy, tooltip only on request, Stop posts stop', async (t) => {
  const dom = new JSDOM(overlayHtml('ko', 'remote'), { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const calls = [];
  dom.window.mixdogComputerControl = async (request) => {
    calls.push(request);
    return { accepted: true };
  };
  dom.window.eval(overlayScript('ko', 'remote'));
  const { document } = dom.window;
  assert.equal(document.getElementById('title').textContent, '원격 조작 중');
  assert.equal(document.getElementById('stop').getAttribute('aria-label'), '중단');
  assert.equal(document.getElementById('mark').querySelector('rect') !== null, true);
  assert.equal(document.getElementById('arcs'), null);
  dom.window.mixdogComputerOverlay({ tooltip: 'Pixel', accent: '#30d158', generation: 0, renderRevision: 1 });
  assert.equal(document.getElementById('pill').title, 'Pixel');
  document.getElementById('stop').onclick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), { action: 'stop', generation: 0 });
  assert.equal(overlayHtml('en', 'remote').includes('Remote control'), true);
});
