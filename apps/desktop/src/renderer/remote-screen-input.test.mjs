// The phone's whole-PC screen view: fingers on the picture never open the soft
// keyboard, and only a direct tap on the typing bar does. The picture's finger
// layer (bindScreenTouch) and the bar are wired by useScreenInput, the same hook
// the pane renders; the events are the ones a WebView sends.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'KeyboardEvent', 'CustomEvent', 'navigator'],
});
// React's IE input polyfill runs on focus in this jsdom setup and needs these.
window.HTMLElement.prototype.attachEvent = function attachEvent(_name, handler) {
  this.propertyChange = handler;
};
window.HTMLElement.prototype.detachEvent = () => {};

const { ScreenKeyboardBar } = await import('./RemoteScreenPane.tsx');
const { useScreenInput } = await import('./use-screen-input.ts');
const { createScreenGestureAdapter } = await import('./remote-screen-gesture.ts');
const { createScreenCursorStore } = await import('./remote-screen-touch.ts');
const { nextScreenViewport, screenViewportLayout } = await import('./remote-screen-viewport.ts');
const { SEND_BAR_SENTINEL } = await import('./remote-send-bar.ts');

const SIZE = { width: 1920, height: 1080 };

function Harness({ rig, enabled }) {
  const stageRef = React.useRef(null);
  const fieldRef = React.useRef(null);
  const input = useScreenInput({
    stageRef,
    fieldRef,
    live: true,
    mode: 'direct',
    viewport: rig.viewport,
    cursor: rig.cursor,
    adapter: rig.adapter,
    sendAll: rig.sendAll,
    ring: rig.ring,
    releaseRef: rig.releaseRef,
  });
  return React.createElement(
    'div',
    null,
    React.createElement('div', { ref: stageRef, className: 'remote-screen-stage' }),
    React.createElement(ScreenKeyboardBar, {
      fieldRef,
      handlers: input.handlers,
      onSend: input.onSend,
      visible: true,
      enabled,
    })
  );
}

let mounted = null;
afterEach(async () => {
  if (mounted) await act(async () => mounted.unmount());
  mounted?.host.remove();
  mounted = null;
});

async function mount({ enabled = true } = {}) {
  let state = nextScreenViewport(null, { width: 390, height: 700 }, false, SIZE);
  const sent = [];
  const rig = {
    viewport: {
      layout: () => screenViewportLayout(state),
      view: () => state.view,
      setView: (view) => {
        state = { ...state, view };
      },
      origin: () => ({ x: 0, y: 0 }),
    },
    cursor: createScreenCursorStore(() => null),
    adapter: createScreenGestureAdapter({ size: () => SIZE }),
    sendAll: (inputs) => sent.push(...inputs),
    ring: () => {},
    releaseRef: { current: () => {} },
  };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Harness, { rig, enabled })));
  mounted = { unmount: () => root.unmount(), host };
  const stage = host.querySelector('.remote-screen-stage');
  const textarea = host.querySelector('textarea');
  const send = host.querySelector('button.send-button');
  const events = [];
  textarea.addEventListener('focus', () => events.push('focus'));
  textarea.addEventListener('blur', () => events.push('blur'));
  const props = textarea[Object.keys(textarea).find((name) => name.startsWith('__reactProps$'))];
  const touch = (target, type, touches, changed) => {
    const event = new window.TouchEvent(type, { bubbles: true, cancelable: true });
    const list = (points) => points.map(([identifier, clientX, clientY]) => ({ identifier, clientX, clientY, target }));
    Object.defineProperty(event, 'touches', { value: list(touches) });
    Object.defineProperty(event, 'changedTouches', { value: list(changed) });
    target.dispatchEvent(event);
    return event;
  };
  return { stage, textarea, send, sent, events, props, touch, rig };
}

/** Two fingers down, spreading apart, up again: a pinch zoom in. */
function pinch(t) {
  const a = [1, 100, 300];
  const b = [2, 160, 300];
  const events = [t.touch(t.stage, 'touchstart', [a], [a]), t.touch(t.stage, 'touchstart', [a, b], [b])];
  // Both fingers move in every report, a few pixels each, as a hand does.
  for (let step = 1; step <= 20; step += 1) {
    const moved = [
      [1, 100 - step * 4, 300],
      [2, 160 + step * 4, 300],
    ];
    events.push(t.touch(t.stage, 'touchmove', moved, moved));
  }
  events.push(t.touch(t.stage, 'touchend', [[2, 240, 300]], [[1, 20, 300]]));
  events.push(t.touch(t.stage, 'touchend', [], [[2, 240, 300]]));
  return events;
}

/** A two-finger tap (the right click) and a one-finger tap. */
function taps(t) {
  const a = [1, 100, 300];
  const b = [2, 160, 300];
  return [
    t.touch(t.stage, 'touchstart', [a], [a]),
    t.touch(t.stage, 'touchstart', [a, b], [b]),
    t.touch(t.stage, 'touchend', [b], [a]),
    t.touch(t.stage, 'touchend', [], [b]),
    t.touch(t.stage, 'touchstart', [a], [a]),
    t.touch(t.stage, 'touchend', [], [a]),
  ];
}

test('a pinch, a two-finger tap and a tap leave the typing bar alone: no focus, no keyboard', async () => {
  const t = await mount();
  // Even with the IME's composition flag left running by a keyboard that was dismissed.
  await act(async () => t.props.onCompositionStart({ currentTarget: t.textarea }));
  const scale = t.rig.viewport.view().scale;
  await act(async () => {
    for (const event of [...pinch(t), ...taps(t)]) assert.equal(event.defaultPrevented, true);
  });
  assert.notEqual(document.activeElement, t.textarea);
  assert.deepEqual(t.events, []);
  assert.ok(t.rig.viewport.view().scale > scale, 'the pinch zoomed the picture');
  // The two-finger tap and the tap are PC clicks: delivered, still without focus.
  assert.ok(
    t.sent.some((input) => input.type === 'screen-pointer' && input.action === 'down' && input.button === 'right')
  );
  assert.ok(
    t.sent.some((input) => input.type === 'screen-pointer' && input.action === 'down' && input.button === 'left')
  );
});

test('with the keyboard already open a pinch and the clicks keep it: no blur, no second focus', async () => {
  const t = await mount();
  await act(async () => t.textarea.focus());
  await act(async () => t.props.onCompositionStart({ currentTarget: t.textarea }));
  t.events.length = 0;
  await act(async () => {
    pinch(t);
    taps(t);
  });
  assert.equal(document.activeElement, t.textarea);
  assert.deepEqual(t.events, [], 'neither toggled off nor re-raised');
});

test('only a direct tap on the bar focuses it; the platform’s focus puts the bar in typing state', async () => {
  const t = await mount();
  // The bar's own touch is not cancelled, so the platform focuses the field.
  const touch = t.touch(t.textarea, 'touchstart', [[1, 40, 680]], [[1, 40, 680]]);
  assert.equal(touch.defaultPrevented, false);
  await act(async () => t.textarea.focus());
  assert.equal(document.activeElement, t.textarea);
  assert.deepEqual(t.events, ['focus']);
  assert.equal(t.textarea.value, SEND_BAR_SENTINEL);
  assert.deepEqual(t.sent, [], 'focusing sends nothing');
});

test('typing stays in the bar; send delivers the whole text once, clears it and keeps focus', async () => {
  const t = await mount();
  await act(async () => t.textarea.focus());
  const type = async (value) => {
    t.textarea.value = value;
    await act(async () => t.textarea.dispatchEvent(new window.Event('input', { bubbles: true })));
  };
  await type(`${SEND_BAR_SENTINEL}hello 한`);
  assert.deepEqual(t.sent, []);
  await act(async () => t.send.click());
  assert.deepEqual(t.sent, [{ type: 'screen-text', text: 'hello 한' }]);
  assert.equal(t.textarea.value, SEND_BAR_SENTINEL);
  assert.equal(document.activeElement, t.textarea);
  // Enter in the bar sends the same way; an empty bar's send is one Enter key.
  t.sent.length = 0;
  await type(`${SEND_BAR_SENTINEL}ls`);
  await act(async () => {
    t.textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  assert.deepEqual(t.sent, [{ type: 'screen-text', text: 'ls' }]);
  t.sent.length = 0;
  await act(async () => t.send.click());
  assert.deepEqual(
    t.sent.map((input) => [input.action, input.vk]),
    [
      ['down', 0x0d],
      ['up', 0x0d],
    ]
  );
});

/** The phone bar driven by native events, as an Android WebView sends them. */
async function drive(t) {
  const fire = (event) => act(async () => t.textarea.dispatchEvent(event));
  return {
    keydown: (init) => fire(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })),
    input: (value) => {
      t.textarea.value = value;
      return fire(new window.Event('input', { bubbles: true }));
    },
    beforeinput: async (inputType) => {
      const event = new window.Event('beforeinput', { bubbles: true, cancelable: true });
      event.inputType = inputType;
      await fire(event);
      return event;
    },
    compositionend: () => act(async () => t.props.onCompositionEnd({ currentTarget: t.textarea, data: '' })),
    compositionstart: () => act(async () => t.props.onCompositionStart({ currentTarget: t.textarea })),
  };
}

test('Gboard and Samsung soft-keyboard Enter (keydown 229, compositionend, line break) sends once, no Enter key', async () => {
  const t = await mount();
  const d = await drive(t);
  await act(async () => t.textarea.focus());
  // Gboard: beforeinput insertLineBreak after the composition ends.
  await d.compositionstart();
  await d.keydown({ key: 'Process', keyCode: 229 });
  await d.input(`${SEND_BAR_SENTINEL}한`);
  await d.compositionend();
  const event = await d.beforeinput('insertLineBreak');
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(t.sent, [{ type: 'screen-text', text: '한' }]);
  // Samsung: no beforeinput, the newline arrives in the input.
  t.sent.length = 0;
  await d.compositionstart();
  await d.keydown({ key: 'Process', keyCode: 229 });
  t.textarea.value = `${SEND_BAR_SENTINEL}글\n`;
  await d.compositionend();
  assert.deepEqual(t.sent, [{ type: 'screen-text', text: '글' }]);
  assert.equal(t.textarea.value, SEND_BAR_SENTINEL);
  // A multi-line paste is text.
  t.sent.length = 0;
  await act(async () => t.textarea.dispatchEvent(new window.Event('paste', { bubbles: true })));
  await d.input(`${SEND_BAR_SENTINEL}a\nb\n`);
  assert.deepEqual(t.sent, []);
  await act(async () => t.send.click());
  assert.deepEqual(t.sent, [{ type: 'screen-text', text: 'a\nb\n' }]);
});

test('special keys and chords reach the PC, never local focus; paste stays in the bar', async () => {
  const t = await mount();
  const d = await drive(t);
  await act(async () => t.textarea.focus());
  const vks = () => t.sent.filter((input) => input.action === 'down').map((input) => input.vk);
  for (const [init, expected] of [
    [{ key: 'Escape', code: 'Escape' }, [0x1b]],
    [{ key: 'Tab', code: 'Tab' }, [0x09]],
    [{ key: 'ArrowLeft', code: 'ArrowLeft' }, [0x25]],
    [{ key: 'c', code: 'KeyC', ctrlKey: true }, [0xa2, 0x43]],
  ]) {
    t.sent.length = 0;
    const before = document.activeElement;
    await d.keydown(init);
    assert.deepEqual(vks(), expected, init.key);
    assert.equal(document.activeElement, before, 'Tab leaves focus alone');
  }
  // The key's default is cancelled so the browser does not also act on it.
  const tab = new window.KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true });
  await act(async () => t.textarea.dispatchEvent(tab));
  assert.equal(tab.defaultPrevented, true);
  const paste = new window.KeyboardEvent('keydown', {
    key: 'v',
    code: 'KeyV',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  t.sent.length = 0;
  await act(async () => t.textarea.dispatchEvent(paste));
  assert.equal(paste.defaultPrevented, false);
  assert.deepEqual(t.sent, []);
  // With text buffered the arrows edit it; Esc still goes to the PC.
  await d.input(`${SEND_BAR_SENTINEL}abc`);
  await d.keydown({ key: 'ArrowLeft', code: 'ArrowLeft' });
  assert.deepEqual(t.sent, []);
  await d.keydown({ key: 'Escape', code: 'Escape' });
  assert.deepEqual(vks(), [0x1b]);
});

test('disabled (the PC accepts no control): the bar takes no typing and sends nothing', async () => {
  const t = await mount({ enabled: false });
  assert.equal(t.textarea.disabled, true);
  assert.equal(t.send.disabled, true);
  await act(async () => t.send.click());
  assert.deepEqual(t.sent, []);
});
