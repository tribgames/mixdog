// The shared popup dismiss/focus contract (menu-dismiss.ts) and every menu that
// follows it. A pointer open leaves focus on the TRIGGER, outside the portaled
// panel, so panel-scoped key handlers never saw Tab or Escape there:
// the usage menu and ⋯ menus stayed open while focus walked away, and the
// model picker sheet let Tab leave it.
import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['history', 'navigator', 'Element', 'HTMLElement', 'Node', 'KeyboardEvent', 'MouseEvent'],
});

const { useMenuDismiss } = await import('./menu-dismiss.ts');
const { RowOverflowMenu } = await import('./RowOverflowMenu.tsx');
const { SidebarUsageMenu } = await import('./SidebarUsageMenu.tsx');
const { useRouteDismissal } = await import('./route-editor-effects.ts');
const { useHoverPopover } = await import('./hover-popover.ts');

async function mount(element) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  return {
    host,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const press = (key, init = {}) =>
  act(async () => {
    const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    (document.activeElement || document.body).dispatchEvent(event);
    await Promise.resolve();
  });
const pointerDown = (target) =>
  act(async () => {
    target.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    await Promise.resolve();
  });
const click = (target) =>
  act(async () => {
    target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await Promise.resolve();
  });
// A mouse open: pointerdown shows the menu, then the browser focuses the trigger.
const pointerOpen = async (trigger) => {
  await pointerDown(trigger);
  await act(async () => {
    trigger.focus();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(document.activeElement, trigger, 'a pointer open keeps focus on the trigger');
};

function Harness({ onClose, onEscape }) {
  const [open, setOpen] = React.useState(true);
  const trigger = React.useRef(null);
  const panel = React.useRef(null);
  useMenuDismiss({
    open,
    close: () => {
      onClose?.();
      setOpen(false);
    },
    trigger,
    panels: () => [panel.current],
    onEscape,
  });
  return React.createElement(
    React.Fragment,
    null,
    React.createElement('button', { type: 'button', ref: trigger, id: 'trigger' }, 'trigger'),
    React.createElement('button', { type: 'button', id: 'after' }, 'after'),
    open &&
      React.createElement(
        'div',
        { ref: panel, id: 'panel' },
        React.createElement('button', { type: 'button', id: 'item' }, 'item')
      )
  );
}

test('Escape closes and returns focus to the trigger, from the panel or the trigger', async () => {
  for (const startOn of ['item', 'trigger']) {
    const view = await mount(React.createElement(Harness));
    document.getElementById(startOn).focus();
    await press('Escape');
    assert.equal(document.getElementById('panel'), null, `still open (focus on ${startOn})`);
    assert.equal(document.activeElement, document.getElementById('trigger'));
    await view.cleanup();
  }
});

test('an outside pointer closes; one inside the panel or on the trigger does not', async () => {
  const view = await mount(React.createElement(Harness));
  await pointerDown(document.getElementById('item'));
  await pointerDown(document.getElementById('trigger'));
  assert.ok(document.getElementById('panel'), 'closed by a pointer on the popup or its trigger');
  await pointerDown(document.getElementById('after'));
  assert.equal(document.getElementById('panel'), null);
  await view.cleanup();
});

test('Tab closes whether focus is on the trigger or inside the panel, and ends on the trigger from the panel', async () => {
  let view = await mount(React.createElement(Harness));
  document.getElementById('trigger').focus();
  await press('Tab');
  assert.equal(document.getElementById('panel'), null, 'stayed open after Tab from the trigger');
  assert.equal(document.activeElement, document.getElementById('trigger'));
  await view.cleanup();

  view = await mount(React.createElement(Harness));
  document.getElementById('item').focus();
  await press('Tab');
  assert.equal(document.getElementById('panel'), null, 'stayed open after Tab from the panel');
  assert.equal(document.activeElement, document.getElementById('trigger'), 'focus stranded in the closed portal');
  await view.cleanup();
});

test('onEscape can take the key first (a nested pane steps out before the sheet closes)', async () => {
  let handled = 0;
  const view = await mount(
    React.createElement(Harness, {
      onEscape: () => {
        handled += 1;
        return handled === 1;
      },
    })
  );
  await press('Escape');
  assert.ok(document.getElementById('panel'), 'the first Escape belonged to the nested pane');
  await press('Escape');
  assert.equal(document.getElementById('panel'), null);
  await view.cleanup();
});

test('⋯ row menu: after a pointer open, Tab closes it and Escape returns focus to the trigger', async () => {
  const view = await mount(
    React.createElement(RowOverflowMenu, { label: 'Row', items: [{ id: 'a', label: 'Alpha', onSelect() {} }] })
  );
  const trigger = view.host.querySelector('.row-overflow-trigger');
  await pointerOpen(trigger);
  assert.ok(document.querySelector('.row-overflow-menu'));
  await press('Tab');
  assert.equal(document.querySelector('.row-overflow-menu'), null, 'menu stayed open after Tab');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');

  await pointerOpen(trigger);
  await press('Escape');
  assert.equal(document.querySelector('.row-overflow-menu'), null);
  assert.equal(document.activeElement, trigger);

  await pointerOpen(trigger);
  await pointerDown(document.body);
  assert.equal(document.querySelector('.row-overflow-menu'), null, 'outside pointer did not close');
  await view.cleanup();
});

test('⋯ row menu: a programmatic scroll elsewhere leaves it open; a user wheel outside closes it', async () => {
  const view = await mount(
    React.createElement(RowOverflowMenu, { label: 'Row', items: [{ id: 'a', label: 'Alpha', onSelect() {} }] })
  );
  const transcript = document.createElement('div');
  document.body.append(transcript);
  const trigger = view.host.querySelector('.row-overflow-trigger');
  await pointerOpen(trigger);
  // An agent turn pins the transcript to its end on every streamed token.
  await act(async () => transcript.dispatchEvent(new window.Event('scroll')));
  assert.ok(document.querySelector('.row-overflow-menu'), 'a live programmatic scroll closed the menu');
  await act(async () =>
    document.querySelector('.row-overflow-menu').dispatchEvent(new window.WheelEvent('wheel', { bubbles: true }))
  );
  assert.ok(document.querySelector('.row-overflow-menu'), 'a wheel over the menu itself closed it');
  await act(async () => transcript.dispatchEvent(new window.WheelEvent('wheel', { bubbles: true })));
  assert.equal(document.querySelector('.row-overflow-menu'), null, 'a user scroll outside left the menu open');
  transcript.remove();
  await view.cleanup();
});

test('⋯ row menu: a scrolling key from the trigger closes it; the menu keys and Space on the trigger do not', async () => {
  const view = await mount(
    React.createElement(RowOverflowMenu, {
      label: 'Row',
      items: [
        { id: 'a', label: 'Alpha', onSelect() {} },
        { id: 'b', label: 'Beta', onSelect() {} },
      ],
    })
  );
  const trigger = view.host.querySelector('.row-overflow-trigger');
  const entry = (id) => document.querySelector(`.row-overflow-menu [data-action-id="${id}"]`);
  await pointerOpen(trigger);
  await press(' ');
  assert.ok(document.querySelector('.row-overflow-menu'), 'Space activates the trigger, it scrolls nothing');
  entry('a').focus();
  await press('ArrowDown');
  assert.ok(document.querySelector('.row-overflow-menu'), "the menu's own arrow key closed it");
  assert.equal(document.activeElement, entry('b'), 'arrow navigation inside the menu still works');
  await press('End');
  assert.ok(document.querySelector('.row-overflow-menu'), "the menu's own End key closed it");
  trigger.focus();
  await press('PageDown');
  assert.equal(document.querySelector('.row-overflow-menu'), null, 'PageDown from the trigger scrolled the list under it');

  for (const key of ['ArrowDown', 'Home', 'PageUp']) {
    await pointerOpen(trigger);
    await press(key);
    assert.equal(document.querySelector('.row-overflow-menu'), null, `${key} from the trigger left the menu open`);
  }
  await view.cleanup();
});

test('⋯ row menu: a touch drag that starts on the trigger closes it; the opening tap and a held finger do not', async () => {
  const view = await mount(
    React.createElement(RowOverflowMenu, { label: 'Row', items: [{ id: 'a', label: 'Alpha', onSelect() {} }] })
  );
  const trigger = view.host.querySelector('.row-overflow-trigger');
  const touch = (type, target, x, y, { prevent = false } = {}) =>
    act(async () => {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'changedTouches', { value: [{ identifier: 1, clientX: x, clientY: y }] });
      if (prevent) event.preventDefault();
      target.dispatchEvent(event);
      await Promise.resolve();
    });
  // The tap that opens it: pointerdown opens, the touch lands and lifts in place.
  await pointerDown(trigger);
  await touch('touchstart', trigger, 20, 20);
  await touch('touchmove', trigger, 23, 22);
  await touch('touchend', trigger, 23, 22);
  await click(trigger);
  assert.ok(document.querySelector('.row-overflow-menu'), 'the opening tap closed the menu');

  await pointerDown(document.body);
  assert.equal(document.querySelector('.row-overflow-menu'), null);

  // A press that opens it and stays down: moves within the slop, or held still by a guard.
  await pointerDown(trigger);
  await touch('touchstart', trigger, 20, 20);
  assert.ok(document.querySelector('.row-overflow-menu'));
  await touch('touchmove', trigger, 25, 24);
  await touch('touchmove', trigger, 20, 80, { prevent: true });
  assert.ok(document.querySelector('.row-overflow-menu'), 'a move that scrolled nothing closed the menu');
  // The drag goes on and scrolls the list under the menu.
  await touch('touchmove', trigger, 20, 60);
  assert.equal(document.querySelector('.row-overflow-menu'), null, 'a touch drag from the trigger left the menu open');
  await touch('touchend', trigger, 20, 60);
  await view.cleanup();
});

test('usage menu: after a pointer open, Tab closes it and Escape returns focus to the trigger', async () => {
  const view = await mount(
    React.createElement(SidebarUsageMenu, {
      pinned: false,
      onTogglePin() {},
      railBars: 'long',
      onRailBarsChange() {},
    })
  );
  const trigger = view.host.querySelector('.sidebar-usage-menu');
  await pointerOpen(trigger);
  assert.ok(document.querySelector('.usage-menu'));
  await press('Tab');
  assert.equal(document.querySelector('.usage-menu'), null, 'menu stayed open after Tab');

  await pointerOpen(trigger);
  await press('Escape');
  assert.equal(document.querySelector('.usage-menu'), null);
  assert.equal(document.activeElement, trigger);

  await pointerOpen(trigger);
  await pointerDown(document.body);
  assert.equal(document.querySelector('.usage-menu'), null, 'outside pointer did not close');
  await view.cleanup();
});

// A popup whose anchor sits inside a transcript that a streaming turn keeps
// appending to, pinning to its end and re-rendering. Real dismissals still work.
function StreamingTranscript({ lines, popup }) {
  return React.createElement(
    'section',
    { id: 'transcript', style: { overflow: 'auto' } },
    popup,
    Array.from({ length: lines }, (_, index) => React.createElement('p', { key: index }, `token ${index}`))
  );
}
const streamTick = async (view, transcript, lines, popup) => {
  await act(async () => view.render(React.createElement(StreamingTranscript, { lines, popup })));
  await act(async () => {
    transcript.scrollTop = transcript.scrollHeight;
    transcript.dispatchEvent(new window.Event('scroll', { bubbles: false }));
    document.dispatchEvent(new window.Event('scroll'));
    window.dispatchEvent(new window.Event('scroll'));
  });
};

test('usage menu stays open through streaming scrolls and re-renders, and closes on the user wheel', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const popup = React.createElement(SidebarUsageMenu, {
    pinned: false,
    onTogglePin() {},
    railBars: 'long',
    onRailBarsChange() {},
  });
  await act(async () => root.render(React.createElement(StreamingTranscript, { lines: 1, popup })));
  const transcript = document.getElementById('transcript');
  await pointerOpen(host.querySelector('.sidebar-usage-menu'));
  assert.ok(document.querySelector('.usage-menu'));
  for (let lines = 2; lines < 8; lines += 1) {
    await streamTick(root, transcript, lines, popup);
    assert.ok(document.querySelector('.usage-menu'), `a streaming scroll closed the menu at ${lines} lines`);
  }
  await act(async () => transcript.dispatchEvent(new window.WheelEvent('wheel', { bubbles: true })));
  assert.equal(document.querySelector('.usage-menu'), null, 'a user wheel outside left the menu open');
  await act(async () => root.unmount());
  host.remove();
});

test('tab context menu: streaming scrolls keep it open; outside pointer, Escape and a user wheel close it', async () => {
  const { useTabMenuDismiss } = await import('./workspace-tab-strip-state.ts');
  function TabMenu() {
    const [menu, setMenu] = React.useState({ x: 1, y: 1 });
    const node = React.useRef(null);
    useTabMenuDismiss(menu, node, setMenu);
    return menu ? React.createElement('div', { ref: node, id: 'tab-menu' }, 'menu') : null;
  }
  for (const dismiss of [
    () => pointerDown(document.body),
    () => press('Escape'),
    () => act(async () => document.body.dispatchEvent(new window.WheelEvent('wheel', { bubbles: true }))),
  ]) {
    const view = await mount(React.createElement(TabMenu));
    await act(async () => {
      document.body.dispatchEvent(new window.Event('scroll'));
      window.dispatchEvent(new window.Event('scroll'));
    });
    assert.ok(document.getElementById('tab-menu'), 'a streaming scroll closed the tab menu');
    await dismiss();
    assert.equal(document.getElementById('tab-menu'), null);
    await view.cleanup();
  }
});

function RouteHarness({ calls, pane = null }) {
  const trigger = React.useRef(null);
  const sheet = React.useRef(null);
  const modelFlyout = React.useRef(null);
  const optionFlyout = React.useRef(null);
  useRouteDismissal({
    mounted: true,
    pane,
    layout: () => {},
    closeAll: (restoreFocus) => calls.push(['closeAll', Boolean(restoreFocus)]),
    closePane: (closed, restoreFocus) => calls.push(['closePane', closed, Boolean(restoreFocus)]),
    trigger,
    sheet,
    modelFlyout,
    optionFlyout,
  });
  return React.createElement(
    React.Fragment,
    null,
    React.createElement('button', { type: 'button', ref: trigger, id: 'trigger' }),
    React.createElement(
      'div',
      { ref: sheet, id: 'sheet' },
      React.createElement('button', { type: 'button', id: 'row' })
    ),
    React.createElement(
      'div',
      { ref: modelFlyout },
      React.createElement('button', { type: 'button', id: 'add', className: 'model-provider-add' })
    ),
    React.createElement('button', { type: 'button', id: 'outside' })
  );
}

test('model picker sheet: Escape closes it (flyout first), Tab and outside pointer close it', async () => {
  const calls = [];
  let view = await mount(React.createElement(RouteHarness, { calls }));
  document.getElementById('row').focus();
  await press('Escape');
  assert.deepEqual(calls.splice(0), [['closeAll', true]]);
  await pointerDown(document.getElementById('row'));
  assert.deepEqual(calls.splice(0), [], 'a pointer inside the sheet must not close it');
  await pointerDown(document.getElementById('outside'));
  assert.deepEqual(calls.splice(0), [['closeAll', false]]);
  document.getElementById('trigger').focus();
  await press('Tab');
  assert.deepEqual(calls.splice(0), [['closeAll', false]], 'Tab left the sheet open');
  await view.cleanup();

  view = await mount(React.createElement(RouteHarness, { calls, pane: 'model' }));
  document.getElementById('add').focus();
  await press('Escape');
  assert.deepEqual(calls.splice(0), [['closePane', 'model', true]], 'Escape inside the flyout steps out of the pane');
  await press('Tab');
  assert.deepEqual(calls.splice(0), [['closeAll', false]]);
  assert.equal(document.activeElement, document.getElementById('trigger'), 'focus escaped into the flyout button');
  await view.cleanup();
});

function ClickCard() {
  const popover = useHoverPopover({ hoverOpens: false });
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      'div',
      { className: 'slot', ...popover.hostProps },
      React.createElement('button', {
        type: 'button',
        id: 'gauge',
        'aria-expanded': popover.open,
        ...popover.triggerProps,
      }),
      React.createElement('div', { className: 'card', hidden: !popover.open })
    ),
    React.createElement('button', { type: 'button', id: 'elsewhere' })
  );
}

test('click-only context card: Escape, an outside pointer and re-clicking the trigger all close it', async () => {
  const view = await mount(React.createElement(ClickCard));
  const gauge = document.getElementById('gauge');
  const open = () => gauge.getAttribute('aria-expanded') === 'true';
  await click(gauge);
  assert.equal(open(), true);
  await press('Escape');
  assert.equal(open(), false);

  await click(gauge);
  assert.equal(open(), true);
  await pointerDown(document.getElementById('elsewhere'));
  assert.equal(open(), false);

  await click(gauge);
  assert.equal(open(), true);
  await click(gauge);
  assert.equal(open(), false);
  assert.equal(view.host.querySelector('.card').hidden, true);
  await view.cleanup();
});
