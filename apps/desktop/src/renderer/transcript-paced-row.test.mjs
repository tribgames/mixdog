/**
 * transcript-paced-row.test.mjs — paced live reply: completion gating and the
 * ordering flush when a later row is inserted.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { pretendToBeVisual: true },
  expose: ['HTMLElement', 'MutationObserver', 'navigator', 'requestAnimationFrame', 'cancelAnimationFrame'],
});
const { TranscriptRow } = await import('./transcript-row.tsx');
const { MarkdownSessionContext } = await import('./MarkdownLink.tsx');
const { appendLiveTranscriptRows, projectSettledTranscriptRows } = await import('./transcript-rows.ts');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const LONG = '긴 답변입니다. '.repeat(30);

async function mountRow(props) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (next) => act(async () => root.render(React.createElement(TranscriptRow, next)));
  await render(props);
  return { host, render, cleanup: () => act(async () => root.unmount()) };
}

test('completion waits for the paced reveal, then shows footer and copy with the full text', async () => {
  const streaming = { id: 'a1', kind: 'assistant', text: 'Hi', streaming: true };
  const view = await mountRow({ item: streaming, paceKey: 's:a1', pace: true });
  await view.render({ item: { ...streaming, text: LONG }, paceKey: 's:a1', pace: true });
  const completion = { id: 'd1', kind: 'turndone', status: 'done', elapsedMs: 10 };
  await view.render({
    item: { id: 'a1', kind: 'assistant', text: LONG },
    completion,
    paceKey: 's:a1',
    pace: true,
  });
  const article = view.host.querySelector('article');
  assert.ok(article.className.includes('streaming'), 'still draining right after completion');
  // The live band's slot stands where the footer lands while the text
  // drains: the band row left in this commit, nothing may shrink.
  assert.ok(view.host.querySelector('.response-footer-band'), 'band slot while draining');
  assert.equal(view.host.querySelector('.response-footer'), null);
  await act(async () => sleep(400));
  assert.ok(view.host.querySelector('article').className.includes('settled'));
  assert.ok(view.host.querySelector('.response-footer'));
  assert.equal(view.host.querySelector('.response-footer-band'), null, 'the footer replaced the slot');
  await view.cleanup();
});

test('a caught-up reply holds the band slot only until its held last word shows, then the footer replaces it', async () => {
  const streaming = { id: 'a3', kind: 'assistant', text: 'Short answer here', streaming: true };
  const view = await mountRow({ item: streaming, paceKey: 's:a3', pace: true });
  await act(async () => sleep(1_500));
  const completion = { id: 'd3', kind: 'turndone', status: 'done', elapsedMs: 10 };
  await view.render({
    item: { id: 'a3', kind: 'assistant', text: streaming.text },
    completion,
    paceKey: 's:a3',
    pace: true,
  });
  const both = () =>
    Boolean(view.host.querySelector('.response-footer')) && Boolean(view.host.querySelector('.response-footer-band'));
  assert.ok(view.host.querySelector('.response-footer') || view.host.querySelector('.response-footer-band'));
  assert.equal(both(), false);
  await act(async () => sleep(300));
  assert.ok(view.host.querySelector('.response-footer'));
  assert.equal(both(), false);
  assert.ok(view.host.textContent.includes('Short answer here'));
  await view.cleanup();
});

test('a later row clears pacing: the row settles in the same commit', async () => {
  const streaming = { id: 'a2', kind: 'assistant', text: 'Hi', streaming: true };
  const view = await mountRow({ item: streaming, paceKey: 's:a2', pace: true });
  await view.render({ item: { ...streaming, text: LONG }, paceKey: 's:a2', pace: true });
  await view.render({ item: { id: 'a2', kind: 'assistant', text: LONG }, paceKey: 's:a2', pace: false });
  assert.ok(view.host.querySelector('article').className.includes('settled'));
  await view.cleanup();
});

const BIG = '이어지는 긴 문단입니다. '.repeat(60);

/** A pane: the session's rows inside its MarkdownSessionContext. */
async function mountPane(session, rows) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (next) =>
    act(async () =>
      root.render(
        React.createElement(
          MarkdownSessionContext.Provider,
          { value: session },
          next.map((props) => React.createElement(TranscriptRow, { key: String(props.item.id), ...props }))
        )
      )
    );
  await render(rows);
  return { host, render, cleanup: () => act(async () => root.unmount()) };
}

const prompt = (id) => ({ item: { id, kind: 'user', text: '질문' } });
const live = (session, id, text) => ({
  item: { id, kind: 'assistant', text, streaming: true },
  paceKey: `${session}:${id}`,
  pace: true,
});

// The reply's opening commit gives its row a line and the band its step, so
// the followed transcript moves: that commit must paint the first word.
test('a watched reply row paints its first word in the commit that mounts it', async () => {
  const view = await mountPane('open', [prompt('u1')]);
  await act(async () => sleep(300));
  await view.render([prompt('u1'), live('open', 'r1', 'After long reply')]);
  assert.match(view.host.textContent, /After/);
  await view.cleanup();
});

test('a streaming reply opens no row until a word can paint; the band stays under the prompt', () => {
  const settled = projectSettledTranscriptRows({
    sessionKey: 's',
    items: [{ id: 'u', kind: 'user', text: 'q' }],
    turnKeys: ['t1'],
    failedTurns: new Set(),
  });
  const rows = (text) =>
    appendLiveTranscriptRows({
      sessionKey: 's',
      settled,
      liveItem: { id: 'l', kind: 'assistant', text, streaming: true },
      thinking: true,
    }).map((row) => row._tag);
  assert.deepEqual(rows(''), ['UserMessage', 'Thinking']);
  assert.deepEqual(rows('Aft'), ['UserMessage', 'Thinking'], 'an unfinished first word opens nothing');
  assert.deepEqual(rows('After long'), ['UserMessage', 'AssistantPart', 'Thinking']);
});

test('a long live row mounting with its pane (session entered mid-stream) shows whole', async () => {
  const view = await mountPane('entered', [prompt('u1'), live('entered', 'm1', BIG)]);
  assert.ok(view.host.textContent.includes(BIG.trim()), 'shown whole');
  await view.cleanup();
});

test("a fresh session's first reply over 600 characters is paced in the pane that sent the prompt", async () => {
  const view = await mountPane('fresh', [prompt('u1')]);
  await act(async () => sleep(300));
  await view.render([prompt('u1'), live('fresh', 'p1', BIG)]);
  const painted = view.host.textContent.length;
  assert.ok(painted < BIG.length / 2, `painted ${painted} of ${BIG.length}`);
  await act(async () => sleep(150));
  assert.ok(view.host.textContent.length > painted, 'the reveal advances');
  await view.cleanup();
});

test('only the pane that watched a row arrive paces it: a pane opened mid-stream shows it whole', async () => {
  const watching = await mountPane('shared', [prompt('u1')]);
  await act(async () => sleep(300));
  await watching.render([prompt('u1'), live('shared', 'x1', BIG)]);
  const opened = await mountPane('shared', [prompt('u1'), live('shared', 'x1', BIG)]);
  assert.ok(opened.host.textContent.includes(BIG.trim()), 'the new pane shows the row whole');
  assert.ok(watching.host.textContent.length < BIG.length / 2, 'the watching pane keeps pacing');
  await opened.cleanup();
  await watching.cleanup();
});

test('render order does not matter: a pane opened mid-stream rendering first leaves the watching pane pacing', async () => {
  const watching = await mountPane('order', [prompt('u1')]);
  await act(async () => sleep(300));
  const opened = await mountPane('order', [prompt('u1'), live('order', 'x1', BIG)]);
  await watching.render([prompt('u1'), live('order', 'x1', BIG)]);
  assert.ok(opened.host.textContent.includes(BIG.trim()), 'the new pane shows the row whole');
  assert.ok(watching.host.textContent.length < BIG.length / 2, 'the watching pane paces the first arrival');
  await act(async () => sleep(150));
  assert.ok(watching.host.textContent.length < BIG.length, 'still pacing');
  await opened.cleanup();
  await watching.cleanup();
});

test("a pane's own pacer turning off pacing never flushes the shared entry a watching pane paces", async () => {
  const watching = await mountPane('off', [prompt('u1')]);
  await act(async () => sleep(300));
  await watching.render([prompt('u1'), live('off', 'x1', BIG)]);
  const opened = await mountPane('off', [prompt('u1'), live('off', 'x1', BIG)]);
  assert.ok(opened.host.textContent.includes(BIG.trim()));
  await opened.render([prompt('u1'), { ...live('off', 'x1', BIG), pace: false }]);
  assert.ok(opened.host.textContent.includes(BIG.trim()));
  await watching.render([prompt('u1'), live('off', 'x1', `${BIG}더 `)]);
  assert.ok(watching.host.textContent.length < BIG.length / 2, 'the watching pane still paces');
  await opened.cleanup();
  await watching.cleanup();
});

test('hiding the window reveals pane-local pacers too', async () => {
  let hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  const Event = document.defaultView.Event;
  try {
    const opened = await mountPane('hide', [prompt('u1'), live('hide', 'x1', BIG)]);
    const MORE = '새로 도착한 긴 내용입니다. '.repeat(30);
    await opened.render([prompt('u1'), live('hide', 'x1', `${BIG}${MORE}`)]);
    assert.ok(!opened.host.textContent.includes(MORE.trim()), 'the growth is paced');
    hidden = true;
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    assert.ok(opened.host.textContent.includes(`${BIG}${MORE}`.trim()), 'revealed whole while hidden');
    hidden = false;
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await opened.cleanup();
  } finally {
    delete document.hidden;
  }
});

test('the whole-reveal threshold counts graphemes: 120 emoji graphemes in 720 UTF-16 units are paced', async () => {
  const emoji = '👨‍👩‍👧‍👦 '.repeat(60);
  assert.ok(emoji.length > 600);
  const view = await mountPane('emoji', [prompt('u1'), live('emoji', 'e1', emoji)]);
  assert.ok(!view.host.textContent.includes(emoji.trim()), 'not shown whole');
  await view.cleanup();
});

test('unmounting reveals a held unfinished word; a remount with the same text shows it', async () => {
  const row = live('held', 'h1', 'alpha beta');
  const first = await mountPane('held', [row]);
  await act(async () => sleep(800));
  assert.ok(first.host.textContent.includes('alpha'), first.host.textContent);
  assert.ok(!first.host.textContent.includes('beta'), 'the unfinished final word waits');
  await first.cleanup();
  const again = await mountPane('held', [row]);
  assert.ok(again.host.textContent.includes('alpha beta'), again.host.textContent);
  await again.cleanup();
});

test('only the newest content row paces; a tool row after it flushes the text', () => {
  const settled = (items) =>
    projectSettledTranscriptRows({ sessionKey: 's', items, turnKeys: items.map(() => 't1'), failedTurns: new Set() });
  const user = { id: 'u', kind: 'user', text: 'q' };
  const reply = { id: 'r', kind: 'assistant', text: 'answer' };
  const tool = { id: 'tool', kind: 'tool', name: 'read', status: 'done' };
  const before = appendLiveTranscriptRows({ sessionKey: 's', settled: settled([user, reply]), thinking: true });
  assert.equal(before.find((row) => row._tag === 'AssistantPart')?.newest, true);
  const after = appendLiveTranscriptRows({ sessionKey: 's', settled: settled([user, reply, tool]), thinking: true });
  assert.notEqual(after.find((row) => row._tag === 'AssistantPart')?.newest, true);
  const live = appendLiveTranscriptRows({
    sessionKey: 's',
    settled: settled([user]),
    liveItem: { id: 'l', kind: 'assistant', text: 'x y', streaming: true },
    thinking: true,
  });
  assert.equal(live.find((row) => row._tag === 'AssistantPart')?.newest, true);
});
