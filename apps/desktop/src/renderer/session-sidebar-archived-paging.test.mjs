import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

// Paging rides the scroller's scroll events (no IntersectionObserver, which
// kept Chromium producing a main-thread frame every vsync while any
// compositor animation ran).
test('archived sessions page without narrowing bulk actions', async () => {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><div id="root"></div>',
    jsdom: { url: 'http://localhost/' },
    expose: ['navigator', 'CustomEvent'],
  });
  const { SessionSidebar } = await import('./session-sidebar.tsx');
  const root = createRoot(document.getElementById('root'));
  const sessions = Array.from({ length: 120 }, (_, i) => ({
    id: `archived-${i}`,
    title: `Archived ${i}`,
    preview: '',
    updatedAt: 120 - i,
    activityAt: 120 - i,
    messageCount: 1,
    cwd: '',
    classification: 'task',
    projectPath: null,
    working: false,
    archived: true,
  }));
  const restored = [];
  const deleted = [];
  const props = {
    open: true,
    sessions,
    sessionsReady: true,
    selection: { kind: 'new' },
    onNewTask() {},
    onResumeSession() {},
    async onRenameSession() {},
    async onArchiveSession(id, archived) {
      restored.push([id, archived]);
    },
    async onDeleteSession(id) {
      deleted.push(id);
    },
  };
  const render = async (extra = {}) =>
    act(async () => root.render(React.createElement(SessionSidebar, { ...props, ...extra })));
  const click = async (selector) =>
    act(async () => {
      const target = document.querySelector(selector);
      assert.ok(target, selector);
      target.click();
    });
  const rows = () => document.querySelectorAll('.archived-session-list .session-row').length;
  const scroller = () => document.querySelector('.sidebar-archived').closest('.session-sidebar-scroll');
  const page = async () => act(async () => scroller().dispatchEvent(new dom.window.Event('scroll')));
  try {
    await render();
    assert.equal(rows(), 0);
    await click('.sidebar-archived-toggle');
    const initial = rows();
    assert.ok(initial > 0 && initial < sessions.length);
    await page();
    assert.ok(rows() > initial && rows() < sessions.length);
    await click('.sidebar-archived-toggle');
    assert.equal(rows(), 0);
    await click('.sidebar-archived-toggle');
    assert.equal(rows(), initial, 'reopening does not remount the accumulated pages');

    await click('.sidebar-archived .row-overflow-trigger');
    await click('[data-action-id="restore-all"]');
    assert.deepEqual(new Set(restored.map(([id]) => id)), new Set(sessions.map(({ id }) => id)));
    assert.ok(restored.every(([, archived]) => archived === false));
    await click('.sidebar-archived .row-overflow-trigger');
    await click('[data-action-id="delete-all-archived"]');
    assert.equal(deleted.length, 0);
    await click('[data-action-id="confirm-delete-all-archived"]');
    assert.deepEqual(new Set(deleted), new Set(sessions.map(({ id }) => id)));

    for (let attempts = 0; rows() < sessions.length && attempts < 10; attempts++) await page();
    assert.equal(rows(), sessions.length);
    assert.equal(document.querySelector('.archived-session-list .session-list-sentinel'), null);

    await click('.sidebar-archived-toggle');
    await render({ selection: { kind: 'session', id: sessions.at(-1).id } });
    await click('.sidebar-archived-toggle');
    assert.ok(
      document.querySelector(`[data-session-id="${sessions.at(-1).id}"]`),
      'an active archived session beyond the first page remains reachable'
    );
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});
