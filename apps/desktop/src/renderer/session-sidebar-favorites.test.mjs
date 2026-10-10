import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const row = (id, extra = {}) => ({
  id,
  title: `Title ${id}`,
  preview: '',
  updatedAt: 1,
  activityAt: Number(id.length),
  messageCount: 1,
  cwd: '',
  classification: 'task',
  projectPath: null,
  working: false,
  ...extra,
});

async function mount(t, sessions, handlers = {}) {
  const { root, document } = installTestDom(t, { rootId: 'root', expose: ['HTMLElement', 'CustomEvent'] });
  const { SessionSidebar } = await import('./session-sidebar.tsx');
  await act(async () =>
    root.render(
      React.createElement(SessionSidebar, {
        open: true,
        sessions,
        sessionsReady: true,
        selection: { kind: 'new' },
        onNewTask() {},
        onNewStudio() {},
        onResumeSession() {},
        async onRenameSession() {},
        async onArchiveSession() {},
        async onFavoriteSession() {},
        async onDeleteSession() {},
        ...handlers,
      })
    )
  );
  return document;
}

const ids = (section) =>
  [...section.querySelectorAll('.session-row[data-session-id]')].map((el) => el.dataset.sessionId);

test('Favorites render first, are excluded from Recent, and never include archived sessions', async (t) => {
  const document = await mount(t, [
    row('fav', { favorite: true }),
    row('plain'),
    row('archived-fav', { favorite: true, archived: true }),
  ]);
  const sections = [...document.querySelectorAll('.session-sidebar-scroll > section')];
  assert.deepEqual(
    sections.map((s) => s.getAttribute('aria-label')),
    ['Favorites', 'Recent sessions', 'Archived sessions']
  );
  assert.deepEqual(ids(sections[0]), ['fav']);
  assert.deepEqual(ids(sections[1]), ['plain']);
  assert.equal(document.querySelector('[data-session-id="archived-fav"]'), null, 'archived row is not in Favorites');
});

test('the Favorites section is hidden when no session is a favorite', async (t) => {
  const document = await mount(t, [row('plain'), row('archived-fav', { favorite: true, archived: true })]);
  assert.equal(document.querySelector('section[aria-label="Favorites"]'), null);
  assert.ok(document.querySelector('section[aria-label="Recent sessions"]'));
});

test('the star button reflects state, toggles through the action and does not open the session', async (t) => {
  const favorites = [];
  const opened = [];
  const document = await mount(t, [row('fav', { favorite: true }), row('plain')], {
    async onFavoriteSession(id, favorite) {
      favorites.push([id, favorite]);
    },
    onResumeSession(id) {
      opened.push(id);
    },
  });
  const star = (id) => document.querySelector(`[data-session-id="${id}"] .session-row-favorite`);
  assert.equal(star('fav').getAttribute('aria-pressed'), 'true');
  assert.equal(star('fav').getAttribute('aria-label'), 'Remove from favorites');
  assert.equal(star('plain').getAttribute('aria-pressed'), 'false');
  assert.equal(star('plain').getAttribute('aria-label'), 'Add to favorites');
  const archive = document.querySelector('[data-session-id="plain"] .session-row-archive');
  assert.ok(star('plain').compareDocumentPosition(archive) & 4, 'the star sits immediately left of Archive');
  await act(async () => star('fav').click());
  await act(async () => star('plain').click());
  assert.deepEqual(favorites, [
    ['fav', false],
    ['plain', true],
  ]);
  assert.deepEqual(opened, []);
});
