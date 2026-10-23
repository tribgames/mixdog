import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { TranscriptRow } = await import('./transcript-row.tsx');

function mount(t) {
  const { dom, root } = installTestDom(t, {
    expose: ['HTMLElement', 'Element', 'Node', 'MouseEvent', 'PointerEvent', 'Event', 'KeyboardEvent'],
    rootId: 'root',
  });
  dom.window.mixdogDesktop = new Proxy({}, { get: () => async () => undefined });
  const render = (item) => act(async () => root.render(React.createElement(TranscriptRow, { item })));
  return { render, document: dom.window.document };
}

const user = (reactions) => ({
  kind: 'user',
  id: 'u1',
  messageId: 'msg_1',
  text: 'we shipped it',
  ...(reactions ? { reactions } : {}),
});

test("the bots' reactions show as chips under the user's bubble, each naming its bot, and update live", async (t) => {
  const { render, document } = mount(t);
  await render(user());
  assert.equal(document.querySelector('.message-reactions'), null, 'no reactions, no chips');

  // A reaction arrives on the live row (a patched item): the chips appear without a reload.
  await render(
    user([
      { agentId: 'reviewer', emoji: '👍', at: 1 },
      { agentId: 'bench', emoji: '❤️', at: 2 },
    ])
  );
  const bubble = document.querySelector('.message.user');
  const list = bubble.querySelector(':scope > .message-reactions');
  assert.ok(list, 'the chips sit in the user message, under its body');
  const children = [...bubble.children].map((node) => node.className);
  assert.ok(children.indexOf('message-body') < children.indexOf('message-reactions'), children.join(' | '));
  const chips = [...list.querySelectorAll('.message-reaction')];
  assert.deepEqual(
    chips.map((chip) => [chip.querySelector('[aria-hidden]').textContent, chip.getAttribute('title')]),
    [
      ['👍', 'reviewer'],
      ['❤️', 'bench'],
    ]
  );
  assert.match(chips[0].textContent, /reviewer/);

  // A bot that replaces its reaction, then removes it.
  await render(user([{ agentId: 'reviewer', emoji: '🙏', at: 3 }]));
  assert.deepEqual(
    [...document.querySelectorAll('.message-reaction [aria-hidden]')].map((node) => node.textContent),
    ['🙏']
  );
  await render(user([]));
  assert.equal(document.querySelector('.message-reactions'), null);
});

test('a reply row never shows reaction chips, and malformed entries are skipped', async (t) => {
  const { render, document } = mount(t);
  await render({ kind: 'assistant', id: 'a1', text: 'ok', reactions: [{ agentId: 'reviewer', emoji: '👍' }] });
  assert.equal(document.querySelector('.message-reactions'), null);
  await render(user([{ agentId: '', emoji: '👍' }, { agentId: 'reviewer' }, 'x', { agentId: 'gh', emoji: '😮' }]));
  assert.equal(document.querySelectorAll('.message-reaction').length, 1);
});
