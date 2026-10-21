/**
 * transcript-text-reveal.test.mjs — the live reply reveals what it received in
 * steps (at least 22 characters, a quarter of the backlog when larger, each
 * waiting for the last one's stagger; a first text over 120 characters in one); new words fade in (100 ms, staggered
 * 2.5 ms per character up to 150 ms), unless the pane did not watch the row.
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
const { STREAM_FADE_DURATION_MS, STREAM_FADE_STAGGER_MAX_MS } = await import('./markdown-stream-fade.ts');
const { REVEAL_STEP_CHARS, REVEAL_JOIN_CHARS } = await import('./use-transcript-text-reveal.ts');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BIG = '이어지는 긴 문단입니다. '.repeat(60);

/** Wait for the markdown tree of the painted text: it parses asynchronously,
 *  and until it lands the row paints nothing of that text. */
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
const live = (session, id, text, streaming = true) => ({
  item: { id, kind: 'assistant', text, streaming },
  revealKey: `${session}:${id}`,
});

/** A manual clock for the reveal's arrival times and the fade placement. */
function installClock(t) {
  let clock = performance.now();
  t.mock.method(performance, 'now', () => clock);
  return (ms) => {
    clock += ms;
  };
}

const fading = (host) => [...host.querySelectorAll('[data-stream-fade]')];
const delayOf = (node) => Number.parseFloat(node.style.getPropertyValue('--mx-fade-delay'));
const durationOf = (node) => Number.parseFloat(node.style.getPropertyValue('--mx-fade-ms'));

/** A pane that has shown session `session` long enough to watch a reply. */
async function watchingPane(t, session) {
  // The markdown parser loads on first use, in real time.
  const view = await mountPane(session, [prompt('u1')]);
  await act(async () => sleep(300));
  const tick = installClock(t);
  tick(1000);
  return { view, tick };
}

/** Advance the clock `ms`, then let the step timer (every 25 ms, real time)
 *  run: one step at most, as each step holds the next for its stagger. */
async function step(view, tick, ms) {
  tick(ms);
  await act(async () => sleep(60));
  await parsed(view.host);
}

const painted = (host) => (host.querySelectorAll('.message.assistant .markdown')[0]?.textContent ?? '').length;

test('growth is revealed in steps: at least 22 characters, a quarter of the backlog, until it is all shown', async (t) => {
  const { view, tick } = await watchingPane(t, 'steps');
  await view.render([prompt('u1'), live('steps', 'r1', 'Hi')]);
  assert.equal(painted(view.host), 2, 'a short first text shows as the first step');
  tick(300);
  const full = `Hi ${BIG}`;
  await view.render([prompt('u1'), live('steps', 'r1', full)]);
  assert.equal(painted(view.host), 2, 'growth waits for the next step');
  const sizes = [];
  let before = painted(view.host);
  for (let i = 0; i < 40 && painted(view.host) < full.trim().length; i += 1) {
    await step(view, tick, 200);
    sizes.push(painted(view.host) - before);
    before = painted(view.host);
  }
  assert.equal(view.host.querySelector('.markdown').textContent, full.trim(), `all shown: ${sizes}`);
  const backlog = full.length - 2;
  assert.ok(Math.abs(sizes[0] - Math.ceil(backlog / 4)) <= 2, `the first step is a quarter: ${sizes}`);
  assert.ok(
    sizes.every((size) => size >= REVEAL_STEP_CHARS - 1 || size === sizes.at(-1)),
    `${sizes}`
  );
  assert.ok(sizes.length > 4 && sizes.length < 20, `caught up within a few steps: ${sizes}`);
  await view.cleanup();
});

test('a mounted live row keeps revealing when more than 64 other live rows are recorded', async (t) => {
  const { view, tick } = await watchingPane(t, 'evict');
  await view.render([prompt('u1'), live('evict', 'e1', 'Hi')]);
  const others = await mountPane(
    'evict-others',
    Array.from({ length: 70 }, (_, index) => live('evict-others', `o${index}`, `다른 답 ${index}`))
  );
  tick(300);
  const full = `Hi ${BIG}`;
  await view.render([prompt('u1'), live('evict', 'e1', full)]);
  for (let i = 0; i < 40 && painted(view.host) < full.trim().length; i += 1) await step(view, tick, 200);
  assert.equal(view.host.querySelector('.markdown').textContent, full.trim(), 'the reveal reached the end');
  await others.cleanup();
  await view.cleanup();
});

test('a step holds the next for its stagger (at least 25 ms, at most 150 ms)', async (t) => {
  const { view, tick } = await watchingPane(t, 'hold');
  await view.render([prompt('u1'), live('hold', 'h1', 'Hi')]);
  tick(300);
  await view.render([prompt('u1'), live('hold', 'h1', `Hi ${BIG}`)]);
  await step(view, tick, 200);
  const first = painted(view.host);
  await step(view, tick, 100);
  assert.equal(painted(view.host), first, 'a 200-character step holds the next 150 ms');
  await step(view, tick, 60);
  assert.ok(painted(view.host) > first, 'then the next step shows');
  await view.cleanup();
});

test('a first text longer than 120 characters shows in one step, fading 100 ms, staggered 2.5 ms/char up to 150 ms', async (t) => {
  const { view } = await watchingPane(t, 'stagger');
  assert.ok(BIG.length > REVEAL_JOIN_CHARS);
  await view.render([prompt('u1'), live('stagger', 's1', BIG)]);
  assert.equal(view.host.querySelector('.markdown').textContent, BIG.trim(), 'shown whole');
  const words = fading(view.host);
  assert.ok(words.length > 30);
  assert.ok(words.every((node) => durationOf(node) === STREAM_FADE_DURATION_MS && durationOf(node) === 100));
  let chars = 0;
  for (const [index, node] of words.entries()) {
    // (The placement rounds to whole ms.)
    assert.equal(delayOf(node), Math.round(Math.min(150, chars * 2.5)), `word ${index}`);
    chars += node.textContent.length;
  }
  assert.equal(Math.max(...words.map(delayOf)), STREAM_FADE_STAGGER_MAX_MS);
  await view.cleanup();
});

test('an unfinished table line is held back; what shows never shrinks', async (t) => {
  const { view, tick } = await watchingPane(t, 'hold-back');
  const intro = 'Intro line here.\n\n';
  await view.render([prompt('u1'), live('hold-back', 'b1', `${intro}| a | b`)]);
  assert.match(view.host.textContent, /Intro line here\./);
  assert.doesNotMatch(view.host.textContent, /\| a/, 'the unfinished row is held back');
  const shown = painted(view.host);
  await view.render([prompt('u1'), live('hold-back', 'b1', `${intro}| a | b |\n| -`)]);
  await step(view, tick, 200);
  assert.ok(painted(view.host) >= shown, 'never shrinks');
  await view.cleanup();
});

test('the part ending shows the rest at once, unfaded', async (t) => {
  const { view, tick } = await watchingPane(t, 'end');
  await view.render([prompt('u1'), live('end', 'e1', 'Hi')]);
  tick(300);
  await view.render([prompt('u1'), live('end', 'e1', `Hi ${BIG}`)]);
  const before = fading(view.host).length;
  await view.render([prompt('u1'), live('end', 'e1', `Hi ${BIG}`, false)]);
  assert.equal(view.host.querySelector('.markdown').textContent, `Hi ${BIG}`.trim());
  assert.equal(fading(view.host).length, before, 'the rest is not faded');
  await view.cleanup();
});

test('a row the pane did not watch being born shows whole and unfaded; later growth fades', async (t) => {
  // Mounted with the pane (a reload, a session entered mid-stream).
  const view = await mountPane('unseen', [prompt('u1'), live('unseen', 'n1', `Already here. ${BIG}`)]);
  const tick = installClock(t);
  assert.ok(view.host.textContent.includes(BIG.trim()), 'whole');
  assert.deepEqual(fading(view.host), [], 'the text it mounts with is unfaded');
  tick(300);
  await view.render([prompt('u1'), live('unseen', 'n1', `Already here. ${BIG}And new`)]);
  await step(view, tick, 200);
  assert.deepEqual(
    fading(view.host).map((node) => node.textContent),
    ['And ', 'new'],
    'only what arrives after it was seen fades'
  );
  await view.cleanup();
});

test('a remount finds the fades where they are: nothing replays', async (t) => {
  const { view, tick } = await watchingPane(t, 'remount');
  await view.render([prompt('u1'), live('remount', 'm1', 'Hello there friend')]);
  assert.ok(fading(view.host).length > 0);
  await view.cleanup();
  tick(2000);
  const again = await mountPane('remount', [prompt('u1'), live('remount', 'm1', 'Hello there friend')]);
  const delays = fading(again.host).map(delayOf);
  // Placed in the past by more than a fade: they show inked at once.
  assert.ok(delays.length > 0 && delays.every((ms) => ms <= -100 - 1000), `ended fades resume ended: ${delays}`);
  await again.cleanup();
});

test('a fade ending and the reply settling never change the text DOM', async (t) => {
  const { view, tick } = await watchingPane(t, 'shape');
  await view.render([prompt('u1'), live('shape', 'd1', 'One two')]);
  tick(50);
  await view.render([prompt('u1'), live('shape', 'd1', 'One two three four')]);
  await step(view, tick, 200);
  const shape = () => view.host.querySelector('.markdown').innerHTML.replace(/ style="[^"]*"/g, '');
  const during = shape();
  assert.match(view.host.textContent, /four/);
  assert.ok(fading(view.host).length >= 4, during);
  tick(5000);
  // The same text again (a new item object re-renders the row).
  await view.render([prompt('u1'), live('shape', 'd1', 'One two three four')]);
  assert.equal(shape(), during, 'fades over: same elements');
  await view.render([prompt('u1'), live('shape', 'd1', 'One two three four', false)]);
  assert.equal(shape(), during, 'settled: same elements');
  await view.cleanup();
});

test('reduced motion shows what arrives at once, with no fade', async (t) => {
  const { view, tick } = await watchingPane(t, 'reduced');
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
