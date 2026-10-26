import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { installEdgeSwipe, installKeyboardFlick } from './touch-gestures.ts';

function setup(edgeInset = 0) {
  const dom = new JSDOM(
    '<div id="page"><pre id="code" style="overflow-x:auto">code</pre><div class="xterm" id="term">t</div><p id="text">hi</p></div>' +
      '<div id="frame"></div><div id="scrim"></div><div id="dock"></div>',
    { pretendToBeVisual: true }
  );
  const win = dom.window;
  const doc = win.document;
  doc.documentElement.setAttribute('data-mixdog-mobile-tabs', '');
  const code = doc.getElementById('code');
  Object.defineProperty(code, 'scrollWidth', { value: 900 });
  Object.defineProperty(code, 'clientWidth', { value: 300 });
  const state = { left: false, right: false };
  const calls = [];
  const frame = doc.getElementById('frame');
  frame.getBoundingClientRect = () => ({ width: 300 });
  const drawers = [
    {
      side: 'left',
      isOpen: () => state.left,
      setOpen: (open) => {
        state.left = open;
        calls.push(`left:${open}`);
      },
      element: () => frame,
      backdrop: () => doc.getElementById('scrim'),
    },
    {
      side: 'right',
      isOpen: () => state.right,
      setOpen: (open) => {
        state.right = open;
        calls.push(`right:${open}`);
      },
      element: () => doc.getElementById('dock'),
    },
  ];
  let clock = 0;
  const dispose = installEdgeSwipe(win, drawers, { now: () => clock, edgeInset });
  const tick = (ms) => {
    clock += ms;
  };
  return { win, doc, frame, state, calls, dispose, tick };
}

const TYPES = { pointerdown: 'touchstart', pointermove: 'touchmove', pointerup: 'touchend' };

function pointer(win, target, type, x, y = 100) {
  const event = new win.Event(TYPES[type], { bubbles: true, cancelable: true });
  const list = [{ identifier: 1, clientX: x, clientY: y }];
  Object.defineProperty(event, 'touches', { value: type === 'pointerup' ? [] : list });
  Object.defineProperty(event, 'changedTouches', { value: list });
  target.dispatchEvent(event);
  return event;
}
/** Drags in 4 steps of `dx` total, `ms` apart. */
function drag(env, target, fromX, dx, ms) {
  pointer(env.win, target, 'pointerdown', fromX);
  for (let step = 1; step <= 4; step += 1) {
    env.tick(ms);
    pointer(env.win, target, 'pointermove', fromX + (dx * step) / 4);
  }
  pointer(env.win, target, 'pointerup', fromX + dx);
}

test('an edge swipe opens the drawer and a swipe back closes it', () => {
  const env = setup();
  const text = env.doc.getElementById('text');
  drag(env, text, 5, 200, 50);
  assert.deepEqual(env.calls, ['left:true']);
  assert.equal(env.frame.style.transform, 'translateX(0%)');
  drag(env, text, 250, -200, 50);
  assert.deepEqual(env.calls, ['left:true', 'left:false']);
  env.dispose();
});

test('a short slow drag snaps back, a short fast flick still opens', () => {
  const env = setup();
  const text = env.doc.getElementById('text');
  drag(env, text, 5, 60, 200);
  assert.deepEqual(env.calls, []);
  drag(env, text, 5, 60, 10);
  assert.deepEqual(env.calls, ['left:true']);
  env.dispose();
});

test('the right edge opens the files dock', () => {
  const env = setup();
  const text = env.doc.getElementById('text');
  drag(env, text, env.win.innerWidth - 5, -400, 50);
  assert.deepEqual(env.calls, ['right:true']);
  env.dispose();
});

test('a swipe from the middle opens the drawer it moves toward', () => {
  const env = setup();
  const text = env.doc.getElementById('text');
  drag(env, text, 200, 250, 50);
  assert.deepEqual(env.calls, ['left:true'], 'rightward opens the session drawer');
  drag(env, text, 250, -200, 50);
  assert.deepEqual(env.calls, ['left:true', 'left:false']);
  drag(env, text, 600, -400, 50);
  assert.deepEqual(env.calls, ['left:true', 'left:false', 'right:true'], 'leftward opens the files dock');
  env.dispose();
});

test('a middle swipe backs off in a code block, a terminal, a dialog, and toward a missing sheet', () => {
  const env = setup();
  const dialog = env.doc.createElement('div');
  dialog.setAttribute('role', 'dialog');
  const inside = env.doc.createElement('p');
  dialog.appendChild(inside);
  env.doc.body.appendChild(dialog);
  for (const id of ['code', 'term']) drag(env, env.doc.getElementById(id), 200, 300, 50);
  drag(env, inside, 200, 300, 50);
  assert.deepEqual(env.calls, []);
  env.doc.getElementById('dock').remove();
  drag(env, env.doc.getElementById('text'), 600, -400, 50);
  assert.deepEqual(env.calls, [], 'no files dock on this screen: nothing slides');
  assert.equal(env.frame.getAttribute('style') ?? '', '', 'the session drawer was never painted');
  env.dispose();
});

test('the gesture backs off inside a terminal', () => {
  const env = setup();
  drag(env, env.doc.getElementById('term'), 5, 300, 50);
  assert.deepEqual(env.calls, []);
  env.dispose();
});

test('the gesture backs off inside a horizontally scrollable code block', () => {
  const env = setup();
  drag(env, env.doc.getElementById('code'), 5, 300, 50);
  assert.deepEqual(env.calls, []);
  env.dispose();
});

test('the gesture backs off during a text selection', () => {
  const env = setup();
  const text = env.doc.getElementById('text');
  env.win.getSelection().selectAllChildren(text);
  drag(env, text, 5, 300, 50);
  assert.deepEqual(env.calls, []);
  env.dispose();
});

test('a vertical drag from the edge is left to scrolling', () => {
  const env = setup();
  const text = env.doc.getElementById('text');
  pointer(env.win, text, 'pointerdown', 5, 100);
  pointer(env.win, text, 'pointermove', 8, 200);
  pointer(env.win, text, 'pointerup', 8, 200);
  assert.deepEqual(env.calls, []);
  env.dispose();
});

test('a vertical drag never measures the sheet, a horizontal one measures it to slide it', () => {
  const env = setup();
  const text = env.doc.getElementById('text');
  let measured = 0;
  const measure = env.frame.getBoundingClientRect;
  env.frame.getBoundingClientRect = () => {
    measured += 1;
    return measure();
  };
  for (const x of [5, 200]) {
    pointer(env.win, text, 'pointerdown', x, 100);
    pointer(env.win, text, 'pointermove', x + 8, 300);
    pointer(env.win, text, 'pointerup', x + 8, 300);
  }
  assert.equal(measured, 0, 'a fling is rejected before any layout read');
  assert.deepEqual(env.calls, []);
  drag(env, text, 5, 200, 50);
  assert.equal(measured, 1, 'the horizontal drag binds once');
  assert.deepEqual(env.calls, ['left:true']);
  env.dispose();
});

test('a tap on a button at the screen edge still activates it, files panel open or not', () => {
  for (const dockOpen of [false, true]) {
    const env = setup();
    env.state.right = dockOpen;
    const button = env.doc.createElement('button');
    env.doc.body.appendChild(button);
    let clicks = 0;
    button.addEventListener('click', () => {
      clicks += 1;
    });
    for (const x of [2, 12, env.win.innerWidth - 4]) {
      const down = pointer(env.win, button, 'pointerdown', x);
      pointer(env.win, button, 'pointerup', x);
      assert.equal(down.defaultPrevented, false);
      button.click();
    }
    assert.equal(clicks, 3);
    assert.deepEqual(env.calls, []);
    assert.equal(env.doc.querySelector('.edge-swipe-zone'), null, 'no overlay may sit on the edge');
    env.dispose();
  }
});

test('an open files dock is swiped shut from anywhere on it, by fling or by distance', () => {
  const env = setup();
  env.state.right = true;
  const text = env.doc.getElementById('text');
  const dock = env.doc.getElementById('dock');
  drag(env, text, 400, 250, 50);
  assert.deepEqual(env.calls, ['right:false'], 'a fast rightward flick closes it');
  assert.equal(dock.style.transform, 'translateX(100%)', 'it slides away to the edge it came from');
  env.state.right = true;
  drag(env, text, 100, 700, 1000);
  assert.deepEqual(env.calls, ['right:false', 'right:false'], 'a slow drag past half the width closes it');
  env.dispose();
});

test('a short slow swipe snaps the open files dock back; the opposite swipe does nothing', () => {
  const env = setup();
  env.state.right = true;
  const text = env.doc.getElementById('text');
  const dock = env.doc.getElementById('dock');
  drag(env, text, 400, 60, 200);
  assert.deepEqual(env.calls, []);
  assert.equal(dock.style.transform, 'translateX(0%)', 'back at rest, not left mid-drag');
  drag(env, text, 600, -300, 50);
  assert.deepEqual(env.calls, []);
  env.dispose();
});

test('the open files dock leaves a horizontally scrollable region its own scroll', () => {
  const env = setup();
  env.state.right = true;
  drag(env, env.doc.getElementById('code'), 400, 400, 50);
  assert.deepEqual(env.calls, []);
  assert.equal(env.doc.getElementById('dock').getAttribute('style') ?? '', '', 'the dock never moved');
  env.dispose();
});

test('a slider on the open files dock keeps its drag; the dock stays open', () => {
  const env = setup();
  env.state.right = true;
  const dock = env.doc.getElementById('dock');
  const slider = env.doc.createElement('div');
  slider.setAttribute('role', 'slider');
  dock.append(slider);
  drag(env, slider, 400, 400, 50);
  assert.deepEqual(env.calls, []);
  assert.equal(dock.getAttribute('style') ?? '', '', 'the dock never moved');
  env.dispose();
});

test('a Safari tab keeps its own edge: the band starts inside it', () => {
  const env = setup(24);
  const text = env.doc.getElementById('text');
  drag(env, text, 5, 300, 50);
  assert.deepEqual(env.calls, [], 'the very edge belongs to the browser back swipe');
  drag(env, text, 30, 300, 50);
  assert.deepEqual(env.calls, ['left:true']);
  env.dispose();
});

function touch(win, target, type, y, x = 100) {
  const event = new win.Event(type, { bubbles: true });
  const list = [{ clientX: x, clientY: y }];
  Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : list });
  Object.defineProperty(event, 'changedTouches', { value: list });
  target.dispatchEvent(event);
}

function flickSetup({ phone = true, composerField = true } = {}) {
  const dom = new JSDOM(
    '<div class="transcript"><p id="row">row</p></div>' +
      (composerField
        ? '<form class="composer"><textarea id="field"></textarea></form>'
        : '<textarea id="field"></textarea>') +
      '<p id="other">x</p>'
  );
  const win = dom.window;
  const doc = win.document;
  if (phone) doc.documentElement.setAttribute('data-mixdog-mobile-tabs', '');
  let clock = 0;
  const dispose = installKeyboardFlick(win, () => clock);
  const composer = doc.getElementById('field');
  composer.focus();
  const flick = (target, ms) => {
    touch(win, target, 'touchstart', 100);
    for (const y of [140, 180, 220]) {
      clock += ms;
      touch(win, target, 'touchmove', y);
    }
    touch(win, target, 'touchend', 220);
  };
  return { doc, composer, flick, dispose };
}

test('a downward flick on the transcript dismisses the keyboard', () => {
  const env = flickSetup();
  assert.equal(env.doc.activeElement, env.composer);
  env.flick(env.doc.getElementById('row'), 20);
  assert.notEqual(env.doc.activeElement, env.composer);
  env.dispose();
});

test('a slow scroll or a flick outside the transcript keeps the keyboard', () => {
  const env = flickSetup();
  env.flick(env.doc.getElementById('row'), 200);
  assert.equal(env.doc.activeElement, env.composer);
  env.flick(env.doc.getElementById('other'), 20);
  assert.equal(env.doc.activeElement, env.composer);
  env.dispose();
});

test('the flick leaves desktop focus alone', () => {
  const env = flickSetup({ phone: false });
  env.flick(env.doc.getElementById('row'), 20);
  assert.equal(env.doc.activeElement, env.composer);
  env.dispose();
});

test('the flick only dismisses the composer, not other fields', () => {
  const env = flickSetup({ composerField: false });
  env.flick(env.doc.getElementById('row'), 20);
  assert.equal(env.doc.activeElement, env.composer);
  env.dispose();
});

test('a second finger puts the dragged sheet back and leaves no paint behind', async () => {
  const env = setup();
  const text = env.doc.getElementById('text');
  pointer(env.win, text, 'pointerdown', 5);
  env.tick(30);
  pointer(env.win, text, 'pointermove', 105);
  assert.equal(env.frame.style.visibility, 'visible', 'dragging paints the sheet');
  const second = new env.win.Event('touchstart', { bubbles: true });
  const fingers = [
    { identifier: 1, clientX: 105, clientY: 100 },
    { identifier: 2, clientX: 200, clientY: 100 },
  ];
  Object.defineProperty(second, 'touches', { value: fingers });
  Object.defineProperty(second, 'changedTouches', { value: [fingers[1]] });
  text.dispatchEvent(second);
  assert.deepEqual(env.calls, []);
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(env.frame.getAttribute('style') ?? '', '');
  assert.equal(env.doc.getElementById('scrim').getAttribute('style') ?? '', '');
  env.dispose();
});

test('teardown clears active and settling paint', async () => {
  const mid = setup();
  const text = mid.doc.getElementById('text');
  pointer(mid.win, text, 'pointerdown', 5);
  mid.tick(30);
  pointer(mid.win, text, 'pointermove', 105);
  mid.dispose();
  assert.equal(mid.frame.getAttribute('style') ?? '', '');
  assert.equal(mid.doc.getElementById('scrim').getAttribute('style') ?? '', '');

  const settling = setup();
  drag(settling, settling.doc.getElementById('text'), 5, 200, 50);
  assert.notEqual(settling.frame.getAttribute('style') ?? '', '', 'settling holds the end state');
  settling.dispose();
  assert.equal(settling.frame.getAttribute('style') ?? '', '');
});

test('a fast drag held still before release does not fling the drawer open', () => {
  const env = setup();
  const text = env.doc.getElementById('text');
  pointer(env.win, text, 'pointerdown', 5);
  for (let step = 1; step <= 4; step += 1) {
    env.tick(10);
    pointer(env.win, text, 'pointermove', 5 + step * 15);
  }
  env.tick(2000);
  pointer(env.win, text, 'pointerup', 65);
  assert.deepEqual(env.calls, []);
  env.dispose();
});

test('the open session drawer does not force pan-y on its contents', () => {
  const css = readFileSync(new URL('./desktop/07-mobile-chrome.css', import.meta.url), 'utf8');
  const blanket = /sidebar-drawer-frame\[data-state="open"\]\s*\*[^{}]*\{[^}]*touch-action/;
  assert.equal(blanket.test(css), false);
});
