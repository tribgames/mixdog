import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

async function mount(t, { phone }) {
  const { root, document } = installTestDom(t, {
    rootId: 'root',
    expose: ['HTMLElement', 'CustomEvent'],
    globals: {
      ResizeObserver: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    },
  });
  window.HTMLElement.prototype.attachEvent ??= () => {};
  window.HTMLElement.prototype.detachEvent ??= () => {};
  if (phone) document.documentElement.setAttribute('data-mixdog-mobile-tabs', '');
  const { SessionSidebar } = await import('./session-sidebar.tsx');
  let sliding = false;
  const props = {
    sessions: [],
    sessionsReady: true,
    selection: { kind: 'new' },
    onNewTask() {},
    onNewStudio() {},
    onResumeSession() {},
    async onRenameSession() {},
    async onArchiveSession() {},
    async onDeleteSession() {},
  };
  const render = (open) =>
    act(async () =>
      root.render(
        React.createElement(
          'div',
          {
            className: 'sidebar-drawer-frame',
            ref(frame) {
              if (frame)
                frame.getAnimations = () =>
                  sliding ? [{ transitionProperty: 'transform', playState: 'running' }] : [];
            },
          },
          React.createElement('nav', { className: 'activity-rail' }, [
            React.createElement('button', { key: 'r', 'data-side-view': 'sessions' }, 'rail'),
          ]),
          // biome-ignore lint/correctness/noChildrenProp: props object passed through to createElement
          React.createElement(SessionSidebar, {
            ...props,
            open,
            children: React.createElement('button', { id: 'inside' }, 'in'),
          })
        )
      )
    );
  const frame = () => document.querySelector('.sidebar-drawer-frame');
  const aside = () => document.getElementById('session-sidebar');
  const end = (type) =>
    act(async () => {
      const event = new window.Event(type, { bubbles: true });
      event.propertyName = 'transform';
      frame().dispatchEvent(event);
    });
  return { render, aside, end, document, slide: (value) => (sliding = value) };
}

// On the phone the drawer's inert is owned by its panel (WorkbenchSidePanel),
// never by the sidebar inside it (session-sidebar.tsx); these drive the panel.
test('phone: a closing drawer stays non-inert with focus moved out until the slide ends', async (t) => {
  const { render, aside, end, document, slide } = await mountPanel(t, { phone: true });
  await render(true);
  assert.equal(aside().hasAttribute('inert'), false);
  document.getElementById('inside').focus();
  assert.equal(document.activeElement.id, 'inside');
  slide(true);
  await render(false);
  assert.equal(aside().hasAttribute('inert'), false, 'not inert mid-slide');
  assert.equal(aside().getAttribute('aria-hidden'), 'true');
  assert.equal(aside().hidden, true);
  assert.equal(aside().contains(document.activeElement), false, 'focus left the drawer');
  await end('transitionend');
  assert.equal(aside().hasAttribute('inert'), true);
});

test('phone: open clears inert when the slide ends; a re-open mid-close stays interactive', async (t) => {
  const { render, aside, end, slide } = await mountPanel(t, { phone: true });
  await render(false);
  assert.equal(aside().hasAttribute('inert'), true, 'settled closed drawer is inert');
  slide(true);
  await render(true);
  assert.equal(aside().hasAttribute('inert'), true, 'inert is not flipped in the first frame');
  assert.equal(aside().hasAttribute('aria-hidden'), false);
  await end('transitionend');
  assert.equal(aside().hasAttribute('inert'), false);
  await render(false);
  await render(true);
  await end('transitioncancel');
  await end('transitionend');
  assert.equal(aside().hasAttribute('inert'), false, 'cancelled close never lands inert');
  assert.equal(aside().hidden, false);
});

test('phone: with no slide running the flip is immediate', async (t) => {
  const { render, aside } = await mountPanel(t, { phone: true });
  await render(true);
  await render(false);
  assert.equal(aside().hasAttribute('inert'), true);
  await render(true);
  assert.equal(aside().hasAttribute('inert'), false);
});

test("phone: a reversal's cancel of the old slide does not settle while the replacement runs", async (t) => {
  const { render, aside, end, slide } = await mountPanel(t, { phone: true });
  await render(false);
  slide(true);
  await render(true);
  await render(false);
  await render(true);
  assert.equal(aside().hasAttribute('inert'), true, 'still inert mid-slide');
  await end('transitioncancel');
  assert.equal(aside().hasAttribute('inert'), true, "the old transition's cancel leaves the replacement running");
  await end('transitionend');
  assert.equal(aside().hasAttribute('inert'), false, "the replacement's end settles");
  slide(true);
  await render(false);
  await render(true);
  await render(false);
  assert.equal(aside().hasAttribute('inert'), false);
  await end('transitioncancel');
  assert.equal(aside().hasAttribute('inert'), false, 'cancel mid-replacement does not settle');
  slide(false);
  await end('transitioncancel');
  assert.equal(aside().hasAttribute('inert'), true, 'a cancel with nothing left running settles');
});

test('desktop: inert follows open at once', async (t) => {
  const { render, aside, slide } = await mount(t, { phone: false });
  slide(true);
  await render(true);
  assert.equal(aside().hasAttribute('inert'), false);
  await render(false);
  assert.equal(aside().hasAttribute('inert'), true);
  await render(true);
  assert.equal(aside().hasAttribute('inert'), false);
});

async function mountPanel(t, { phone }) {
  const { root, document } = installTestDom(t, {
    rootId: 'root',
    expose: ['HTMLElement', 'CustomEvent'],
    globals: {
      ResizeObserver: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    },
  });
  window.HTMLElement.prototype.attachEvent ??= () => {};
  window.HTMLElement.prototype.detachEvent ??= () => {};
  globalThis.CSSTransition = class {};
  t.after(() => {
    delete globalThis.CSSTransition;
  });
  if (phone) document.documentElement.setAttribute('data-mixdog-mobile-tabs', '');
  const { WorkbenchSidePanel } = await import('./workbench-side-view-layout.tsx');
  let sliding = false;
  const descriptors = new Map([['sessions', { id: 'sessions', label: 'Sessions', icon: () => null }]]);
  const render = (open) =>
    act(async () =>
      root.render(
        React.createElement(
          'div',
          {
            className: 'sidebar-drawer-frame',
            ref(frame) {
              if (frame)
                frame.getAnimations = () =>
                  sliding
                    ? [Object.assign(new CSSTransition(), { transitionProperty: 'transform', playState: 'running' })]
                    : [];
            },
          },
          React.createElement('nav', { key: 'rail', className: 'activity-rail' }, [
            React.createElement('button', { key: 'r', type: 'button', 'data-side-view': 'sessions' }, 'rail'),
          ]),
          React.createElement(WorkbenchSidePanel, {
            key: 'panel',
            side: 'left',
            open,
            groups: [['sessions']],
            activeRoot: 'sessions',
            descriptors,
            onSelect() {},
            onMoveGroup() {},
            onMoveView() {},
            renderView: () => React.createElement('button', { id: 'inside', type: 'button' }, 'in'),
          })
        )
      )
    );
  const aside = () => document.querySelector('.workbench-side-panel');
  const end = (type) =>
    act(async () => {
      const event = new window.Event(type, { bubbles: true });
      event.propertyName = 'transform';
      document.querySelector('.sidebar-drawer-frame').dispatchEvent(event);
    });
  return { render, aside, end, document, slide: (value) => (sliding = value) };
}

const flipMarker = (document, phone) =>
  act(async () => {
    if (phone) document.documentElement.setAttribute('data-mixdog-mobile-tabs', '');
    else document.documentElement.removeAttribute('data-mixdog-mobile-tabs');
  });

test('the sidebar follows a layout flip with unchanged props', async (t) => {
  const { render, aside, end, document, slide } = await mount(t, { phone: false });
  await render(false);
  assert.equal(aside().hasAttribute('inert'), true);
  await flipMarker(document, true);
  assert.equal(aside().hasAttribute('inert'), false, 'phone: the drawer panel owns inert, not the sidebar');
  slide(true);
  await render(true);
  await end('transitionend');
  await render(false);
  assert.equal(aside().hasAttribute('inert'), false, 'phone: the sidebar never takes inert itself');
  await render(true);
  await flipMarker(document, false);
  slide(true);
  await render(false);
  assert.equal(aside().hasAttribute('inert'), true, 'desktop: inert follows open at once');
  await render(true);
  assert.equal(aside().hasAttribute('inert'), false);
});

test('the drawer panel follows a layout flip with unchanged props', async (t) => {
  const { render, aside, end, document, slide } = await mountPanel(t, { phone: false });
  await render(true);
  slide(true);
  await flipMarker(document, true);
  await render(false);
  assert.equal(aside().hasAttribute('inert'), false, 'phone: not inert mid-slide');
  await end('transitionend');
  assert.equal(aside().hasAttribute('inert'), true);
  await flipMarker(document, false);
  await render(true);
  assert.equal(aside().hasAttribute('inert'), false);
  await render(false);
  assert.equal(aside().hasAttribute('inert'), true, 'desktop: inert follows open at once');
});

test('phone: the drawer panel stays non-inert through the close slide and takes inert at its end', async (t) => {
  const { render, aside, end, slide } = await mountPanel(t, { phone: true });
  await render(true);
  assert.equal(aside().hasAttribute('inert'), false);
  slide(true);
  await render(false);
  assert.equal(aside().hasAttribute('inert'), false, 'not inert mid-slide');
  assert.equal(aside().hidden, true);
  assert.equal(aside().getAttribute('aria-hidden'), 'true');
  assert.equal(aside().dataset.closing, 'true', 'the existing closing display is kept');
  await end('transitionend');
  assert.equal(aside().hasAttribute('inert'), true);
  assert.equal(aside().dataset.closing, undefined);
});

test('phone: the drawer panel clears inert at the open slide end; a reversal does not settle early', async (t) => {
  const { render, aside, end, slide } = await mountPanel(t, { phone: true });
  await render(false);
  assert.equal(aside().hasAttribute('inert'), true, 'the settled closed panel is inert');
  slide(true);
  await render(true);
  assert.equal(aside().hasAttribute('inert'), true, 'not flipped in the first frame');
  await render(false);
  await render(true);
  await end('transitioncancel');
  assert.equal(aside().hasAttribute('inert'), true, "the old slide's cancel does not settle the replacement");
  await end('transitionend');
  assert.equal(aside().hasAttribute('inert'), false);
});

test('desktop: the panel keeps inert tied to open at once', async (t) => {
  const { render, aside, slide } = await mountPanel(t, { phone: false });
  slide(true);
  await render(true);
  assert.equal(aside().hasAttribute('inert'), false);
  await render(false);
  assert.equal(aside().hasAttribute('inert'), true);
  await render(true);
  assert.equal(aside().hasAttribute('inert'), false);
});
