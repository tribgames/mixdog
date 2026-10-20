import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { installTestDom } from '../test-support/test-dom.mjs';
import { ServerFolderDialog } from './connection-dialogs.tsx';

const DOM = { rootId: 'root', expose: ['HTMLElement', 'Node', 'KeyboardEvent', 'Event'] };

const TREE = {
  '/home/me': {
    entries: [
      { name: 'demo', git: true },
      { name: 'notes', git: false },
    ],
  },
  '/home/me/demo': { entries: [{ name: 'src', git: false }] },
  '/home/me/notes': { entries: [] },
  '/home': { entries: [{ name: 'me', git: false }] },
  '/': { entries: [{ name: 'home', git: false }] },
};

/** A server whose listing is TREE; '' is the home. Every request is recorded. */
function fakeServer() {
  const asked = [];
  const list = async (path) => {
    asked.push(path);
    const at = path === '' ? '/home/me' : path;
    if (!TREE[at]) throw new Error('ENOENT');
    return { path: at, entries: TREE[at].entries, truncated: false };
  };
  return { asked, list };
}

const settle = () =>
  act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });
const rows = (document) => [...document.querySelectorAll('.conn-list .conn-row')];
const rowNamed = (document, name) => rows(document).find((row) => row.querySelector('b').textContent === name);
const buttonNamed = (document, name) =>
  [...document.querySelectorAll('.conn-dialog footer button')].find((b) => b.textContent === name);

async function mountPicker(t, extra = {}) {
  const dom = installTestDom(t, DOM);
  const server = fakeServer();
  const selected = [];
  const closed = [];
  await act(async () =>
    dom.root.render(
      React.createElement(ServerFolderDialog, {
        serverName: 'My VPS',
        list: server.list,
        onSelect: (path) => selected.push(path),
        onClose: () => closed.push(true),
        ...extra,
      })
    )
  );
  await settle();
  return { ...dom, ...server, selected, closed };
}

test('D1: opens at the server home with the server named, git folders marked', async (t) => {
  const { document, asked } = await mountPicker(t);
  assert.deepEqual(asked, ['']);
  const dialog = document.querySelector('.conn-dialog');
  assert.equal(dialog.querySelector('h3').textContent, 'Choose a Mixdog project folder');
  assert.equal(dialog.querySelector('header p').textContent, 'These folders are on My VPS.');
  assert.equal(dialog.querySelector('input.conn-input').value, '/home/me');
  assert.deepEqual(
    rows(document).map((row) => row.textContent),
    ['..', 'demoGit', 'notes']
  );
  assert.equal(rowNamed(document, 'demo').querySelector('.conn-row-meta').textContent, 'Git');
  assert.equal(rowNamed(document, 'notes').querySelector('.conn-row-meta'), null);
});

test('D1: a folder row enters it, ".." goes up, and Choose returns the listed server path', async (t) => {
  const { document, asked, selected } = await mountPicker(t);
  await act(async () => rowNamed(document, 'demo').click());
  await settle();
  assert.deepEqual(asked, ['', '/home/me/demo']);
  assert.equal(document.querySelector('input.conn-input').value, '/home/me/demo');
  await act(async () => rowNamed(document, '..').click());
  await settle();
  assert.equal(document.querySelector('input.conn-input').value, '/home/me');
  await act(async () => rowNamed(document, 'notes').click());
  await settle();
  assert.equal(document.querySelector('.conn-field-msg').textContent, 'No folders');
  await act(async () => buttonNamed(document, 'Choose').click());
  assert.deepEqual(selected, ['/home/me/notes']);
});

test('D1: the root has no ".." row', async (t) => {
  const { document, window } = await mountPicker(t);
  const input = document.querySelector('input.conn-input');
  const set = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value').set;
  await act(async () => {
    set.call(input, '/');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  await settle();
  assert.deepEqual(
    rows(document).map((row) => row.textContent),
    ['home']
  );
});

test('D1: Enter in the path field navigates; an unreadable path shows an error and cannot be chosen', async (t) => {
  const { document, window, asked, selected } = await mountPicker(t);
  const input = document.querySelector('input.conn-input');
  const type = async (value) => {
    const set = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value').set;
    await act(async () => {
      set.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  const enter = () =>
    act(async () => {
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
  await type(' /home/me/demo ');
  await enter();
  await settle();
  assert.deepEqual(asked, ['', '/home/me/demo']);
  assert.deepEqual(
    rows(document).map((row) => row.textContent),
    ['..', 'src']
  );
  await type('/nope');
  await enter();
  await settle();
  assert.match(document.querySelector('.conn-field-msg').textContent, /cannot be opened on the server/);
  assert.equal(buttonNamed(document, 'Choose').disabled, true);
  assert.deepEqual(selected, []);
  // Going back to a readable folder clears the error.
  await type('/home');
  await enter();
  await settle();
  assert.equal(document.querySelector('.conn-field-msg .conn-field-msg--error'), null);
  assert.equal(buttonNamed(document, 'Choose').disabled, false);
});

test('D1: Cancel and Escape close without choosing', async (t) => {
  const { document, window, selected, closed } = await mountPicker(t);
  await act(async () => buttonNamed(document, 'Cancel').click());
  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  assert.equal(closed.length, 2);
  assert.deepEqual(selected, []);
});

test('D1: an unreachable home shows the error with nothing to choose', async (t) => {
  const { document } = await mountPicker(t, {
    list: async () => {
      throw new Error('boom');
    },
  });
  assert.match(document.querySelector('.conn-field-msg').textContent, /cannot be opened on the server/);
  assert.equal(buttonNamed(document, 'Choose').disabled, true);
});
