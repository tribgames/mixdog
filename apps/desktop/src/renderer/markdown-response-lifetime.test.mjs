import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { parseMarkdownToHast } from './markdown-ast';
import { preloadSyncMarkdownParser, SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS } from './markdown-worker-client';
import { MarkdownResponse } from './MarkdownResponse';

/** What the markdown parser's worker was asked, in order; each case answers it. */
const asked = [];
class ParserWorker {
  listeners = new Map();
  constructor(_url, options) {
    this.parser = options?.name === 'mixdog-markdown-parser';
  }
  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }
  postMessage(message) {
    if (!this.parser) return;
    const answer = (root) => this.listeners.get('message')?.({ data: { id: message.id, root } });
    asked.push({ text: message.text, answer });
  }
  terminate() {}
}
globalThis.Worker = ParserWorker;

async function mount(t) {
  const { root, document } = installTestDom(t, { rootId: 'root' });
  await preloadSyncMarkdownParser();
  const render = (text, streaming) =>
    act(async () => root.render(text === null ? null : React.createElement(MarkdownResponse, { text, streaming })));
  // Every step of a parse's answer runs before the case looks.
  const answer = (request, root) =>
    act(async () => {
      request.answer(root);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  return { document, render, answer };
}

test('a settled reply too long for the parse cache shows its parse once the worker answers', async (t) => {
  const { document, render, answer } = await mount(t);
  const text = `## Long reply\n\n${'word '.repeat(30_000)}`;
  assert.ok(text.length > 128 * 1024, 'past what the parse cache keeps of one text');
  await render(text, false);
  assert.ok(document.querySelector('[data-transcript-pending]'), 'pending while the worker parses');
  const request = asked.find((entry) => entry.text === text);
  assert.ok(request, 'the worker parses it');
  await answer(request, parseMarkdownToHast('## Long reply\n\nBody.'));
  assert.equal(document.querySelector('[data-transcript-pending]'), null, 'nothing is left pending');
  assert.equal(document.querySelector('h2')?.textContent, 'Long reply');
});

test('a reply unmounted while it streams asks the worker for none of its live parses still waiting', async (t) => {
  const { render, answer } = await mount(t);
  // One open block past the main-thread bound: each of its parses goes to the worker, one at a time.
  const open = `Streaming ${'word '.repeat(SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS / 4)}`;
  const before = asked.length;
  await render(open, true);
  await render(`${open}more`, true);
  assert.equal(asked.length, before + 1, 'the newer parse waits for the one out');
  await render(null);
  await answer(asked[before], parseMarkdownToHast(open));
  assert.equal(asked.length, before + 1, 'the waiting parse is never sent');
});
