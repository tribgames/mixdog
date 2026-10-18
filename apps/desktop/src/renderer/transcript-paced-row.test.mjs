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
const { TranscriptRowOffscreenContext } = await import('./use-paced-transcript-text.ts');
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

/** Fade durations (ms) of the words fading in `host`. */
const fadeDurations = (host, selector = '[data-stream-fade]') =>
  [...host.querySelectorAll(selector)].map((node) => Number.parseFloat(node.style.getPropertyValue('--mx-fade-ms')));

/** Wait for the markdown tree of the painted text: it parses asynchronously,
 *  and until it lands the row paints nothing of that text. Waits on that
 *  condition, never on a time window, and the fake clock does not move. */
async function parsed(host) {
  for (let i = 0; i < 400 && host.querySelector('[data-transcript-pending]'); i += 1) {
    await act(async () => sleep(5));
  }
  assert.equal(host.querySelector('[data-transcript-pending]'), null, 'the markdown parse landed');
}

/** A manual frame clock: the pacer reads performance.now and runs on
 *  requestAnimationFrame, so a test that drives both sees every step in order
 *  whatever the runner's load. */
function installFrameClock(t) {
  let clock = performance.now();
  const frames = new Map();
  let handle = 0;
  t.mock.method(performance, 'now', () => clock);
  t.mock.method(globalThis, 'requestAnimationFrame', (callback) => {
    handle += 1;
    frames.set(handle, callback);
    return handle;
  });
  t.mock.method(globalThis, 'cancelAnimationFrame', (id) => frames.delete(id));
  /** Advance the clock `ms`, run the frames due, and wait for the parse. */
  return async (host, ms = 16) => {
    await act(async () => {
      clock += ms;
      const due = [...frames.values()];
      frames.clear();
      for (const callback of due) callback(clock);
    });
    await parsed(host);
  };
}

test('completion drains the rest of a paced reply quickly, then turns the fade off', async (t) => {
  const FULL = `Hi ${LONG}`.trim();
  const streaming = { id: 'a1', kind: 'assistant', text: 'Hi', streaming: true, phase: 'final_answer' };
  const view = await mountRow({ item: streaming, paceKey: 's:a1', pace: true });
  // The markdown parser loads on first use (real time); the frame clock takes
  // over once it has.
  await act(async () => sleep(300));
  const frame = installFrameClock(t);
  // Growth of the received text is paced; a text that does not extend it
  // would be a rewrite, shown whole.
  await view.render({ item: { ...streaming, text: `Hi ${LONG}` }, paceKey: 's:a1', pace: true });
  await parsed(view.host);
  // A few steps of the paced reveal, so the completion finds a backlog mid-way.
  for (let i = 0; i < 10; i += 1) await frame(view.host);
  const revealed = view.host.textContent.length;
  assert.ok(revealed > 0 && revealed < FULL.length, `paced when the turn completes: ${revealed}`);
  const completion = { id: 'd1', kind: 'turndone', status: 'done', elapsedMs: 10 };
  await view.render({
    item: { id: 'a1', kind: 'assistant', text: `Hi ${LONG}`, phase: 'final_answer' },
    completion,
    paceKey: 's:a1',
    pace: true,
  });
  await parsed(view.host);
  assert.ok(view.host.querySelector('article').className.includes('settled'));
  assert.ok(view.host.querySelector('.response-footer'));
  assert.ok(!view.host.textContent.includes(FULL), 'the backlog drains instead of snapping');
  // The drain runs PACER_DRAIN_MS (200 ms): sampled frame by frame, it passes
  // through several states, growing each time, before the whole text shows.
  const lengths = new Set();
  let previous = view.host.textContent.length;
  for (let i = 0; i < 20 && !view.host.textContent.includes(FULL); i += 1) {
    await frame(view.host);
    const length = view.host.textContent.length;
    assert.ok(length >= previous, 'the drain only grows');
    previous = length;
    if (!view.host.textContent.includes(FULL)) lengths.add(length);
  }
  assert.ok(view.host.textContent.includes(FULL), 'drained within the drain time');
  assert.ok(lengths.size >= 2, `the backlog drains over several steps, not one: ${[...lengths]}`);
  // The fade stays on until the drained words are inked (FADE_FLOOR_MS).
  for (let i = 0; i < 20 && view.host.querySelector('[data-stream-fade], [data-stream-fade-box]'); i += 1) {
    await frame(view.host);
  }
  assert.equal(view.host.querySelector('[data-stream-fade], [data-stream-fade-box]'), null, 'the fade is off');
  await view.cleanup();
});
test('commentary shows as it arrives, its fade 150 ms; a final answer is paced, fading 120-500 ms', async () => {
  const commentary = { id: 'c1', kind: 'assistant', text: 'Checking', streaming: true, phase: 'commentary' };
  const view = await mountRow({ item: commentary, paceKey: 's:c1', pace: true });
  // The markdown parser loads on first use.
  await act(async () => sleep(300));
  await view.render({ item: { ...commentary, text: 'Checking the folder' }, paceKey: 's:c1', pace: true });
  assert.ok(view.host.textContent.includes('Checking the folder'), 'commentary is not paced');
  const slow = fadeDurations(view.host);
  assert.ok(slow.length > 0 && slow.every((ms) => ms === 150), `${slow}`);
  await view.render({ item: { ...commentary, text: `Checking the folder ${LONG}` }, paceKey: 's:c1', pace: true });
  assert.ok(view.host.textContent.includes(LONG.trim()), 'a fast burst shows at once');
  assert.ok(
    fadeDurations(view.host).every((ms) => ms === 150),
    'and fades too'
  );
  await view.cleanup();
  const answer = { id: 'f1', kind: 'assistant', text: 'Answer', streaming: true, phase: 'final_answer' };
  const paced = await mountRow({ item: answer, paceKey: 's:f1', pace: true });
  await paced.render({ item: { ...answer, text: `Answer ${LONG}` }, paceKey: 's:f1', pace: true });
  assert.ok(!paced.host.textContent.includes(LONG.trim()), 'a final answer is paced');
  await act(async () => sleep(250));
  const fades = fadeDurations(paced.host);
  assert.ok(fades.length > 0 && fades.every((ms) => ms >= 120 && ms <= 500), `${fades}`);
  await paced.cleanup();
});

test('a live row off screen shows what it received, unfaded; back on screen its growth is paced again', async () => {
  // The list marks rows outside its visible range (overscan) off screen.
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (props, offscreen) =>
    act(async () =>
      root.render(
        React.createElement(
          TranscriptRowOffscreenContext.Provider,
          { value: offscreen },
          React.createElement(TranscriptRow, props)
        )
      )
    );
  const live = { id: 'o1', kind: 'assistant', text: 'Answer', streaming: true, phase: 'final_answer' };
  await render({ item: live, paceKey: 's:o1', pace: true }, false);
  // Past the first word's own fade.
  await act(async () => sleep(600));
  // The range change renders first; the next burst lands off screen.
  await render({ item: live, paceKey: 's:o1', pace: true }, true);
  await render({ item: { ...live, text: `Answer ${LONG}` }, paceKey: 's:o1', pace: true }, true);
  assert.ok(host.textContent.includes(LONG.trim()), 'shown whole off screen');
  assert.equal(host.querySelector('[data-stream-fade]'), null, 'unfaded');
  await render({ item: { ...live, text: `Answer ${LONG}` }, paceKey: 's:o1', pace: true }, false);
  await render({ item: { ...live, text: `Answer ${LONG}${LONG}` }, paceKey: 's:o1', pace: true }, false);
  assert.ok(!host.textContent.includes(`${LONG}${LONG}`.trim()), 'paced on screen');
  await act(async () => root.unmount());
});

test('a live row under a hidden pane shows what it received; shown again its growth is paced', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  // jsdom computes no rendering: the pane's hidden state is its checkVisibility().
  let paneShown = true;
  const Element = document.defaultView.Element;
  Element.prototype.checkVisibility = () => paneShown;
  try {
    const render = (props) => act(async () => root.render(React.createElement(TranscriptRow, props)));
    const live = { id: 'h2', kind: 'assistant', text: 'Answer', streaming: true, phase: 'final_answer' };
    await render({ item: live, paceKey: 's:h2', pace: true });
    await act(async () => sleep(600));
    paneShown = false;
    // The burst that lands while hidden re-reads the pane after its commit.
    await render({ item: { ...live, text: 'Answer more' }, paceKey: 's:h2', pace: true });
    await render({ item: { ...live, text: `Answer more ${LONG}` }, paceKey: 's:h2', pace: true });
    assert.ok(host.textContent.includes(LONG.trim()), 'shown whole while hidden');
    paneShown = true;
    await render({ item: { ...live, text: `Answer more ${LONG}.` }, paceKey: 's:h2', pace: true });
    await render({ item: { ...live, text: `Answer more ${LONG}.${LONG}` }, paceKey: 's:h2', pace: true });
    assert.ok(!host.textContent.includes(`${LONG}.${LONG}`.trim()), 'paced once shown');
    await act(async () => root.unmount());
  } finally {
    delete Element.prototype.checkVisibility;
  }
});

test('a very long reply shows as it arrives, unfaded', async () => {
  const live = { id: 'v1', kind: 'assistant', text: 'Answer', streaming: true, phase: 'final_answer' };
  const view = await mountRow({ item: live, paceKey: 's:v1', pace: true });
  // Past the first word's own fade.
  await act(async () => sleep(600));
  const huge = `Answer ${'긴 문장입니다. '.repeat(2000)}`;
  await view.render({ item: { ...live, text: huge }, paceKey: 's:v1', pace: true });
  assert.ok(view.host.textContent.includes(huge.trim().slice(-200)), 'not paced');
  assert.equal(view.host.querySelector('[data-stream-fade]'), null, 'unfaded');
  await view.cleanup();
});

test('a part of unknown phase shows as commentary until a list starts; the list is paced', async () => {
  const part = { id: 'p1', kind: 'assistant', text: 'Let me check', streaming: true };
  const view = await mountRow({ item: part, paceKey: 's:p1', pace: true });
  await act(async () => sleep(300));
  await view.render({ item: { ...part, text: 'Let me check the folder' }, paceKey: 's:p1', pace: true });
  assert.ok(view.host.textContent.includes('Let me check the folder'), 'a preamble is not paced');
  assert.ok(fadeDurations(view.host).every((ms) => ms > 0 && ms <= 150));
  const head = 'Let me check the folder.\n\nFound:\n\n';
  const list = `- ${LONG}`;
  await view.render({ item: { ...part, text: `${head}${list}` }, paceKey: 's:p1', pace: true });
  assert.ok(view.host.textContent.includes('Found:'), 'text before the list shows at once');
  assert.ok(!view.host.textContent.includes(LONG.trim()), 'the list is paced');
  await act(async () => sleep(400));
  const fades = fadeDurations(view.host, 'li [data-stream-fade]');
  assert.ok(fades.length > 0, 'list words reveal');
  assert.ok(
    fades.every((ms) => ms >= 120 && ms <= 500),
    `words after the promotion fade by the reveal rate: ${fades}`
  );
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
// Pacing mechanics: a part marked as a final answer is paced throughout.
const live = (session, id, text) => ({
  item: { id, kind: 'assistant', text, streaming: true, phase: 'final_answer' },
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

test('a long live row mounting with its pane (session entered mid-stream) shows whole', async () => {
  const view = await mountPane('entered', [prompt('u1'), live('entered', 'm1', BIG)]);
  assert.ok(view.host.textContent.includes(BIG.trim()), 'shown whole');
  await view.cleanup();
});

const MORE = '새로 도착한 긴 내용입니다. '.repeat(30);

test("a reply's first text paints whole in the pane that sent the prompt; its growth is paced", async () => {
  const view = await mountPane('fresh', [prompt('u1')]);
  await act(async () => sleep(300));
  await view.render([prompt('u1'), live('fresh', 'p1', BIG)]);
  assert.ok(view.host.textContent.includes(BIG.trim()), 'the first text paints with the row');
  await view.render([prompt('u1'), live('fresh', 'p1', `${BIG}${MORE}`)]);
  const painted = view.host.textContent.length;
  assert.ok(!view.host.textContent.includes(MORE.trim()), 'the growth is paced');
  await act(async () => sleep(200));
  assert.ok(view.host.textContent.length > painted, 'the reveal advances');
  await view.cleanup();
});

test('only the pane that watched a row arrive paces it: a pane opened mid-stream shows it whole', async () => {
  const watching = await mountPane('shared', [prompt('u1')]);
  await act(async () => sleep(300));
  await watching.render([prompt('u1'), live('shared', 'x1', 'Hi')]);
  await watching.render([prompt('u1'), live('shared', 'x1', `Hi ${BIG}`)]);
  const opened = await mountPane('shared', [prompt('u1'), live('shared', 'x1', `Hi ${BIG}`)]);
  assert.ok(opened.host.textContent.includes(BIG.trim()), 'the new pane shows the row whole');
  assert.ok(watching.host.textContent.length < BIG.length / 2, 'the watching pane keeps pacing');
  await opened.cleanup();
  await watching.cleanup();
});

test('render order does not matter: the row a pane opened mid-stream created still paces its growth', async () => {
  const watching = await mountPane('order', [prompt('u1')]);
  await act(async () => sleep(300));
  const opened = await mountPane('order', [prompt('u1'), live('order', 'x1', BIG)]);
  await watching.render([prompt('u1'), live('order', 'x1', BIG)]);
  assert.ok(opened.host.textContent.includes(BIG.trim()), 'the new pane shows the row whole');
  assert.ok(watching.host.textContent.includes(BIG.trim()), 'so does the watching pane: it is the first text');
  await watching.render([prompt('u1'), live('order', 'x1', `${BIG}${MORE}`)]);
  assert.ok(!watching.host.textContent.includes(MORE.trim()), 'the growth is paced');
  await opened.cleanup();
  await watching.cleanup();
});

test("a pane's own pacer turning off pacing never flushes the shared entry a watching pane paces", async () => {
  const watching = await mountPane('off', [prompt('u1')]);
  await act(async () => sleep(300));
  await watching.render([prompt('u1'), live('off', 'x1', 'Hi')]);
  await watching.render([prompt('u1'), live('off', 'x1', `Hi ${BIG}`)]);
  const opened = await mountPane('off', [prompt('u1'), live('off', 'x1', `Hi ${BIG}`)]);
  assert.ok(opened.host.textContent.includes(BIG.trim()));
  await opened.render([prompt('u1'), { ...live('off', 'x1', `Hi ${BIG}`), pace: false }]);
  assert.ok(opened.host.textContent.includes(BIG.trim()));
  await watching.render([prompt('u1'), live('off', 'x1', `Hi ${BIG}더 `)]);
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

test('the whole-reveal threshold counts graphemes: 240 emoji graphemes in 1440 UTF-16 units stay paced', async () => {
  const emoji = '👨‍👩‍👧‍👦 '.repeat(120);
  assert.ok(emoji.length > 600);
  const watching = await mountPane('emoji', [prompt('u1')]);
  await act(async () => sleep(300));
  await watching.render([prompt('u1'), live('emoji', 'e1', 'Hi')]);
  await watching.render([prompt('u1'), live('emoji', 'e1', `Hi ${emoji}`)]);
  // Under the threshold, a pane opened mid-stream shares the paced reveal.
  const opened = await mountPane('emoji', [prompt('u1'), live('emoji', 'e1', `Hi ${emoji}`)]);
  assert.ok(!opened.host.textContent.includes(emoji.trim()), 'not shown whole');
  await opened.cleanup();
  await watching.cleanup();
});

test('unmounting reveals the rest; a remount with the same text shows it whole', async () => {
  const first = await mountPane('held', [live('held', 'h1', 'Hi')]);
  await first.render([live('held', 'h1', `Hi ${LONG}`)]);
  assert.ok(!first.host.textContent.includes(LONG.trim()), 'paced while mounted');
  await first.cleanup();
  const again = await mountPane('held', [live('held', 'h1', `Hi ${LONG}`)]);
  assert.ok(again.host.textContent.includes(LONG.trim()), again.host.textContent);
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
