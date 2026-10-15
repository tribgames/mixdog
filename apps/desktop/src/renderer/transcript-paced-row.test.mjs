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
  assert.equal(view.host.querySelector('.response-footer'), null);
  await act(async () => sleep(400));
  assert.ok(view.host.querySelector('article').className.includes('settled'));
  assert.ok(view.host.querySelector('.response-footer'));
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
    liveItem: { id: 'l', kind: 'assistant', text: 'x', streaming: true },
    thinking: true,
  });
  assert.equal(live.find((row) => row._tag === 'AssistantPart')?.newest, true);
});
