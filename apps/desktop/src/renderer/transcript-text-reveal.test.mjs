/**
 * transcript-text-reveal.test.mjs — the live reply in a transcript row. The
 * coding transcript reveals it paced and fades its new words in, also for
 * STREAM_FADE_SETTLE_MS after it ends; agent chat paints what it received
 * whole, at most once per 33 ms, unfaded.
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
const { REVEAL_INTERVAL_MS } = await import('./use-transcript-text-reveal.ts');
const { STREAM_FADE_SETTLE_MS } = await import('./markdown-stream-fade.ts');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BIG = '이어지는 긴 문단입니다. '.repeat(60);

/** Wait for the markdown tree of the painted text. */
async function parsed(host) {
  for (let i = 0; i < 400 && host.querySelector('[data-transcript-pending]'); i += 1) {
    await act(async () => sleep(5));
  }
  assert.equal(host.querySelector('[data-transcript-pending]'), null, 'the markdown parse landed');
}

/** A pane: the session's rows inside its MarkdownSessionContext. */
async function mountPane(session, rows) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = async (next) => {
    await act(async () =>
      root.render(
        React.createElement(
          MarkdownSessionContext.Provider,
          { value: session },
          next.map((props) => React.createElement(TranscriptRow, { key: String(props.item.id), ...props }))
        )
      )
    );
    await parsed(host);
  };
  await render(rows);
  return { host, render, cleanup: () => act(async () => root.unmount()) };
}

const prompt = (id) => ({ item: { id, kind: 'user', text: '질문' } });
/** A live reply of the coding transcript (`paced`), or of agent chat. */
const live = (session, id, text, streaming = true, paced = true) => ({
  item: { id, kind: 'assistant', text, streaming },
  revealKey: `${session}:${id}`,
  paced,
});

/** A manual clock for the reveal's steps and the fade placement. */
function installClock(t) {
  let clock = performance.now();
  t.mock.method(performance, 'now', () => clock);
  return (ms) => {
    clock += ms;
  };
}

const fading = (host) => [...host.querySelectorAll('[data-stream-fade]')];
const painted = (host) => (host.querySelectorAll('.message.assistant .markdown')[0]?.textContent ?? '').length;

async function pane(t, session) {
  // The markdown parser loads on first use, in real time.
  const view = await mountPane(session, [prompt('u1')]);
  await act(async () => sleep(300));
  return { view, tick: installClock(t) };
}

/** Advance the clock `ms`, then let the step timer (real time) run. */
async function step(view, tick, ms) {
  tick(ms);
  await act(async () => sleep(40));
  await parsed(view.host);
}

test('coding: the first text shows as a step and its words fade in', async (t) => {
  const { view } = await pane(t, 'fade');
  await view.render([prompt('u1'), live('fade', 'f1', 'Hello there friend, here we go again')]);
  assert.match(view.host.querySelector('.markdown').textContent, /^Hello there friend,\s*$/, 'a first step');
  assert.ok(fading(view.host).length > 0, 'its words fade');
  await view.cleanup();
});

test('coding: later text reveals in steps, each fading in', async (t) => {
  const { view, tick } = await pane(t, 'steps');
  await view.render([prompt('u1'), live('steps', 's1', 'Hi ')]);
  await step(view, tick, 5);
  await view.render([prompt('u1'), live('steps', 's1', `Hi ${'word '.repeat(40)}`)]);
  assert.equal(painted(view.host), 2, 'waits its cadence');
  for (let i = 0; i < 3; i += 1) await step(view, tick, 200);
  const shown = painted(view.host);
  assert.ok(shown > 2 && shown < 200, `in steps (${shown})`);
  assert.ok(fading(view.host).length > 0);
  await view.cleanup();
});

test('coding: the part ending shows the rest at once, still fading; settled, its words unwrap', async (t) => {
  const { view, tick } = await pane(t, 'end');
  await view.render([prompt('u1'), live('end', 'e1', 'Hi ')]);
  await step(view, tick, 5);
  await view.render([prompt('u1'), live('end', 'e1', `Hi ${'word '.repeat(40)}`)]);
  await view.render([prompt('u1'), live('end', 'e1', `Hi ${'word '.repeat(40)}`, false)]);
  assert.equal(view.host.querySelector('.markdown').textContent, `Hi ${'word '.repeat(40)}`.trim());
  assert.ok(fading(view.host).length > 10, 'the rest fades in');
  tick(STREAM_FADE_SETTLE_MS);
  await act(async () => sleep(STREAM_FADE_SETTLE_MS + 100));
  assert.deepEqual(fading(view.host), [], 'settled: unwrapped');
  assert.equal(view.host.querySelector('.markdown').textContent, `Hi ${'word '.repeat(40)}`.trim());
  await view.cleanup();
});

test('coding: a table row and a code line stream within their line', async (t) => {
  const { view } = await pane(t, 'rows');
  const table = '| a | b |\n| - | - |\n| c | d';
  // Over 400 characters: the first text shows at once.
  const lead = `${'x'.repeat(400)}\n\n`;
  await view.render([prompt('u1'), live('rows', 'b1', `${lead}${table}`)]);
  assert.equal(view.host.querySelectorAll('tr').length, 2, 'the row being typed shows');
  await view.render([prompt('u1'), live('rows', 'b2', `${lead}\`\`\`ts\nconst a = 1;\nconst b`)]);
  assert.match(view.host.textContent, /const b/, 'the code line being typed shows');
  await view.cleanup();
});

test('coding: a bare list marker waits for its first glyph', async (t) => {
  const { view } = await pane(t, 'list');
  await view.render([prompt('u1'), live('list', 'l1', 'Steps:\n- ')]);
  assert.equal(view.host.querySelector('.markdown').textContent.trim(), 'Steps:');
  await view.cleanup();
});

test('agent chat: deltas closer than 33 ms land in one paint, unfaded; unfinished rows are held', async (t) => {
  const { view, tick } = await pane(t, 'chat');
  await view.render([prompt('u1'), live('chat', 'h1', 'Hi', true, false)]);
  tick(10);
  await view.render([prompt('u1'), live('chat', 'h1', 'Hi there', true, false)]);
  assert.equal(painted(view.host), 2, 'a delta 10 ms after the last paint waits');
  tick(5);
  await view.render([prompt('u1'), live('chat', 'h1', 'Hi there friend', true, false)]);
  await step(view, tick, REVEAL_INTERVAL_MS);
  assert.equal(view.host.querySelector('.markdown').textContent, 'Hi there friend', 'both land together');
  assert.deepEqual(fading(view.host), []);
  tick(REVEAL_INTERVAL_MS);
  await view.render([prompt('u1'), live('chat', 'h1', 'Hi there friend\n\n| a | b', true, false)]);
  assert.doesNotMatch(view.host.textContent, /\| a/, 'the unfinished row is held back');
  await view.cleanup();
});

test('a mounted live row keeps revealing when more than 64 other live rows are recorded', async (t) => {
  const { view, tick } = await pane(t, 'evict');
  await view.render([prompt('u1'), live('evict', 'e1', 'Hi')]);
  const others = await mountPane(
    'evict-others',
    Array.from({ length: 70 }, (_, index) => live('evict-others', `o${index}`, `다른 답 ${index}`))
  );
  const full = `Hi ${BIG}`;
  await view.render([prompt('u1'), live('evict', 'e1', full)]);
  for (let i = 0; i < 40 && painted(view.host) < full.trim().length; i += 1) await step(view, tick, 200);
  assert.equal(view.host.querySelector('.markdown').textContent, full.trim(), 'the reveal reached the end');
  await others.cleanup();
  await view.cleanup();
});

test('reduced motion shows what arrives at once, with no fade', async (t) => {
  const { view, tick } = await pane(t, 'reduced');
  const original = globalThis.matchMedia;
  globalThis.matchMedia = (query) => ({
    matches: /reduce/.test(query),
    addEventListener() {},
    removeEventListener() {},
  });
  try {
    await view.render([prompt('u1'), live('reduced', 'x1', 'Hi')]);
    tick(300);
    await view.render([prompt('u1'), live('reduced', 'x1', `Hi ${BIG}`)]);
    assert.ok(view.host.textContent.includes(BIG.trim()));
    assert.deepEqual(fading(view.host), []);
  } finally {
    globalThis.matchMedia = original;
  }
  await view.cleanup();
});

test('a streaming reply opens no row until text shows; the band stays under the prompt', () => {
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
  assert.deepEqual(rows('**'), ['UserMessage', 'Thinking'], 'markers alone open nothing');
  assert.deepEqual(rows('Aft'), ['UserMessage', 'AssistantPart', 'Thinking']);
});
