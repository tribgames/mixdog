import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ActivityRailNavigation } from './activity-rail-navigation.tsx';
import { installTestDom } from './test-support/test-dom.mjs';

test('More opens destinations, pins append above it, and unpinning never changes the open view', async () => {
  const { restore } = installTestDom(null, {
    html: '<!doctype html><div id="root"></div>',
    jsdom: { url: 'http://localhost/' },
    expose: ['navigator', 'Element', 'HTMLElement', 'Node'],
  });
  let root = createRoot(document.getElementById('root'));
  const selections = [];
  const Icon = () => React.createElement('span');
  const entries = ['sessions', 'agents', 'schedules', 'projects', 'workflows', 'source-control', 'search'].map(
    (id) => ({
      id,
      label: id,
      icon: Icon,
    })
  );
  function App() {
    const [activeId, setActiveId] = useState('agents');
    return React.createElement(ActivityRailNavigation, {
      entries,
      activeId,
      onSelect: (id) => {
        selections.push(id);
        setActiveId(id);
      },
    });
  }
  const click = async (element) => {
    assert.ok(element);
    await act(async () => element.click());
  };
  const more = () => document.querySelector('[data-activity-more]');
  const action = (id) => document.querySelector(`[data-action-id="${id}"]`);
  const pin = (id) => document.querySelector(`[data-pin-id="${id}"]`);
  const pinned = () => [...document.querySelectorAll('[data-side-view]')].map((button) => button.dataset.sideView);
  const open = () =>
    act(async () => {
      more().focus();
      more().click();
    });
  try {
    window.localStorage.setItem('mixdog.desktop.activity-rail-pins.v1', '{broken');
    await act(async () => root.render(React.createElement(App)));
    assert.deepEqual(pinned(), ['sessions', 'agents', 'schedules', 'workflows', 'projects']);
    assert.equal(more().getAttribute('aria-expanded'), 'false');
    assert.equal(document.querySelector('[data-side-view="agents"]').getAttribute('aria-current'), 'page');
    await open();
    assert.equal(document.activeElement, action('sessions'));
    for (const id of ['projects', 'workflows', 'source-control', 'search']) assert.ok(action(id));
    await click(pin('projects'));
    await click(pin('workflows'));
    assert.deepEqual(pinned(), ['sessions', 'agents', 'schedules']);
    await click(action('workflows'));
    assert.deepEqual(selections, ['workflows']);
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.equal(more().getAttribute('aria-current'), 'page');
    assert.equal(document.querySelector('[data-side-view="workflows"]'), null);

    await open();
    assert.equal(action('workflows').getAttribute('aria-current'), 'page');
    assert.equal(pin('projects').querySelector('svg').getAttribute('fill'), 'none');
    assert.equal(pin('projects').querySelector('svg').style.transform, 'rotate(45deg)');
    await click(pin('projects'));
    assert.equal(pin('projects').querySelector('svg').getAttribute('fill'), 'currentColor');
    await click(pin('workflows'));
    assert.deepEqual(pinned(), ['sessions', 'agents', 'schedules', 'projects', 'workflows']);
    assert.equal(more().previousElementSibling.dataset.sideView, 'workflows');
    assert.equal(document.querySelector('[data-side-view="workflows"]').getAttribute('aria-current'), 'page');
    assert.equal(pin('workflows').getAttribute('aria-checked'), 'true');
    assert.ok(document.querySelector('[role="menu"]'));
    await click(pin('projects'));
    await click(pin('workflows'));
    assert.deepEqual(selections, ['workflows']);
    assert.equal(action('workflows').getAttribute('aria-current'), 'page');
    assert.equal(more().getAttribute('aria-current'), 'page');
    await click(pin('source-control'));
    await click(pin('search'));
    assert.deepEqual(pinned(), ['sessions', 'agents', 'schedules', 'source-control', 'search']);
    assert.equal(more().previousElementSibling.dataset.sideView, 'search');

    // Clicking the trigger again closes, including its outside-pointer handler.
    await act(async () => more().dispatchEvent(new window.Event('pointerdown', { bubbles: true })));
    await click(more());
    assert.equal(document.querySelector('[role="menu"]'), null);
    await click(document.querySelector('[data-side-view="search"]'));
    assert.deepEqual(selections, ['workflows', 'search']);
    await act(async () => root.unmount());
    root = createRoot(document.getElementById('root'));
    await act(async () => root.render(React.createElement(App)));
    assert.deepEqual(pinned(), ['sessions', 'agents', 'schedules', 'source-control', 'search']);
    await open();
    // Arrow navigation is covered in Chromium: JSDOM groups mixed-role
    // selector results by role instead of returning document order.
    await act(async () => pin('sessions').focus());
    assert.equal(document.activeElement, pin('sessions'));
    await act(async () =>
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    );
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, more());
    await open();
    await act(async () => document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true })));
    assert.equal(document.querySelector('[role="menu"]'), null);

    window.localStorage.setItem('mixdog.desktop.activity-rail-pins.v1', '[]');
    await act(async () =>
      window.dispatchEvent(
        new window.StorageEvent('storage', {
          key: 'mixdog.desktop.activity-rail-pins.v1',
        })
      )
    );
    assert.deepEqual(pinned(), []);
    await open();
    await click(pin('projects'));
    assert.deepEqual(pinned(), ['projects']);
    assert.equal(more().previousElementSibling.dataset.sideView, 'projects');
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('first launch pins the six default destinations without replacing a saved arrangement', async () => {
  const { restore } = installTestDom(null, {
    html: '<!doctype html><div id="root"></div>',
    jsdom: { url: 'http://localhost/' },
    expose: ['navigator', 'Element', 'HTMLElement', 'Node'],
  });
  let root = createRoot(document.getElementById('root'));
  const entries = ['sessions', 'agents', 'schedules', 'workflows', 'projects', 'extensions'].map((id) => ({
    id,
    label: id,
    icon: () => React.createElement('span'),
  }));
  const view = () => React.createElement(ActivityRailNavigation, { entries, activeId: 'sessions', onSelect() {} });
  const order = () => [...document.querySelectorAll('#root [data-side-view]')].map((button) => button.dataset.sideView);
  try {
    await act(async () => root.render(view()));
    assert.deepEqual(order(), ['sessions', 'agents', 'schedules', 'workflows', 'projects', 'extensions']);
    await act(async () => root.unmount());
    window.localStorage.setItem('mixdog.desktop.activity-rail-pins.v1', '["projects","sessions"]');
    root = createRoot(document.getElementById('root'));
    await act(async () => root.render(view()));
    assert.deepEqual(order(), ['projects', 'sessions']);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('pinned icons drag before and after one another, keep More last, and restore the saved order', async () => {
  const { restore } = installTestDom(null, {
    html: '<!doctype html><div id="root"></div>',
    jsdom: { url: 'http://localhost/' },
    expose: ['navigator', 'Element', 'HTMLElement', 'Node'],
  });
  const storageKey = 'mixdog.desktop.activity-rail-pins.v1';
  window.localStorage.setItem(storageKey, JSON.stringify(['sessions', 'agents', 'schedules', 'projects', 'workflows']));
  let root = createRoot(document.getElementById('root'));
  const selections = [];
  const entries = ['sessions', 'agents', 'schedules', 'projects', 'workflows'].map((id) => ({
    id,
    label: id,
    icon: () => React.createElement('span'),
  }));
  const view = () =>
    React.createElement(ActivityRailNavigation, {
      entries,
      activeId: 'agents',
      onSelect: (id) => selections.push(id),
    });
  const bar = () => document.querySelector('#root .activity-rail-navigation');
  const button = (id) => bar().querySelector(`[data-side-view="${id}"]`);
  const order = () => [...bar().querySelectorAll('[data-side-view]')].map((element) => element.dataset.sideView);
  const measure = () => {
    [...bar().querySelectorAll('button')].forEach((element, index) => {
      element.getBoundingClientRect = () => ({
        top: index * 44,
        bottom: (index + 1) * 44,
        left: 0,
        right: 48,
        width: 48,
        height: 44,
      });
    });
  };
  const transferData = new Map();
  const dataTransfer = {
    effectAllowed: 'none',
    dropEffect: 'none',
    get types() {
      return [...transferData.keys()];
    },
    setData(type, value) {
      transferData.set(type, value);
    },
    getData(type) {
      return transferData.get(type) ?? '';
    },
    setDragImage() {},
  };
  const dragEvent = (type, clientY) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    Object.defineProperty(event, 'clientY', { value: clientY });
    return event;
  };
  const drag = async (source, clientY) => {
    measure();
    await act(async () => button(source).dispatchEvent(dragEvent('dragstart', 0)));
    const over = dragEvent('dragover', clientY);
    await act(async () => bar().dispatchEvent(over));
    assert.equal(over.defaultPrevented, true);
    assert.equal(dataTransfer.dropEffect, 'move');
    await act(async () => bar().dispatchEvent(dragEvent('drop', clientY)));
    await act(async () => button(source).dispatchEvent(dragEvent('dragend', clientY)));
  };
  try {
    await act(async () => root.render(view()));
    await drag('workflows', 46);
    assert.deepEqual(order(), ['sessions', 'workflows', 'agents', 'schedules', 'projects']);
    assert.deepEqual(JSON.parse(window.localStorage.getItem(storageKey)), [
      'sessions',
      'workflows',
      'agents',
      'schedules',
      'projects',
    ]);
    await drag('workflows', 240);
    const expected = ['sessions', 'agents', 'schedules', 'projects', 'workflows'];
    assert.deepEqual(order(), expected);
    assert.equal(bar().lastElementChild.hasAttribute('data-activity-more'), true);
    assert.equal(bar().querySelector('[data-activity-more]').draggable, false);
    assert.equal(button('agents').getAttribute('aria-current'), 'page');
    assert.deepEqual(selections, []);
    assert.equal(bar().querySelector('[data-drop-position]'), null);

    // Self-drops and external payloads cannot reorder or open a destination.
    await drag('sessions', 10);
    await act(async () => bar().dispatchEvent(dragEvent('drop', 240)));
    assert.deepEqual(order(), expected);
    assert.deepEqual(selections, []);
    measure();
    await act(async () => button('projects').dispatchEvent(dragEvent('dragstart', 154)));
    await act(async () => bar().dispatchEvent(dragEvent('dragover', 10)));
    assert.equal(button('sessions').dataset.dropPosition, 'before');
    await act(async () => button('projects').dispatchEvent(dragEvent('dragend', 10)));
    assert.equal(bar().querySelector('[data-drop-position]'), null);
    assert.deepEqual(order(), expected);

    await drag('projects', 10);
    const saved = ['projects', 'sessions', 'agents', 'schedules', 'workflows'];
    assert.deepEqual(order(), saved);
    await act(async () => root.unmount());
    root = createRoot(document.getElementById('root'));
    await act(async () => root.render(view()));
    assert.deepEqual(order(), saved);
    assert.equal(bar().lastElementChild.hasAttribute('data-activity-more'), true);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});
