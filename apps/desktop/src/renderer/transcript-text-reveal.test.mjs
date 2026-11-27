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
const { TranscriptResponseFooter, TranscriptRow } = await import('./transcript-row.tsx');
const { MarkdownSessionContext } = await import('./MarkdownLink.tsx');
const { appendLiveTranscriptRows, projectSettledTranscriptRows } = await import('./transcript-rows.ts');
const { REVEAL_INTERVAL_MS } = await import('./use-transcript-text-reveal.ts');
const { STREAM_FADE_DURATION_MS } = await import('./markdown-stream-fade.ts');
const FADE = `${STREAM_FADE_DURATION_MS}ms`;

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
  assert.deepEqual(
    fading(view.host).map((phrase) => [
      phrase.textContent,
      phrase.style.getPropertyValue('--mx-fade-ms'),
      phrase.style.getPropertyValue('--mx-fade-delay'),
    ]),
    [['Hello there friend,', FADE, '0ms']],
    'its words fade as one phrase, at once'
  );
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

test('coding: the part ending shows the rest at once as one last phrase from then; once it ended no wrapper stays', async (t) => {
  const { view, tick } = await pane(t, 'end');
  const full = `Hi ${'word '.repeat(40)}`;
  const article = () => view.host.querySelector('.message.assistant');
  await view.render([prompt('u1'), live('end', 'e1', 'Hi ')]);
  await view.render([prompt('u1'), live('end', 'e1', full)]);
  assert.ok(painted(view.host) < full.trim().length, 'streaming, it paces');
  // 80 ms into the phrase "Hi" opened, the part ends.
  tick(80);
  await view.render([prompt('u1'), live('end', 'e1', full, false)]);
  assert.equal(view.host.querySelector('.markdown').textContent, full.trim(), 'ended: the rest shows at once');
  assert.ok(article().classList.contains('streaming'), 'its last phrase fading: still live');
  const tail = fading(view.host).at(-1);
  assert.deepEqual(
    [tail.textContent, tail.style.getPropertyValue('--mx-fade-delay'), tail.style.getPropertyValue('--mx-fade-ms')],
    [full.trim().slice(3), '0ms', FADE],
    'the rest is one element fading from the moment the part ended'
  );
  const paragraph = view.host.querySelector('.markdown p');
  // The fade timers run in real time.
  tick(STREAM_FADE_DURATION_MS);
  await act(async () => sleep(500));
  assert.ok(article().classList.contains('settled'), 'settled as its last fade ended');
  assert.deepEqual(fading(view.host), [], 'no wrapper outlives its fade');
  assert.equal(view.host.querySelector('.markdown p'), paragraph, 'its blocks stayed in place');
  assert.equal(view.host.querySelector('.markdown').textContent, full.trim());
  await view.cleanup();
});

test('coding: a still-streaming reply drops its fade wrappers even when the timer for the fade end runs early', async (t) => {
  const { view, tick } = await pane(t, 'early');
  await view.render([prompt('u1'), live('early', 'e1', 'Hi there')]);
  assert.equal(fading(view.host).length, 1, 'its words fade in');
  // The timer set for the fade's end runs while the clock still reads just short of it, as Chromium may run a
  // long timer early and setTimeout drops the fraction of its delay.
  tick(STREAM_FADE_DURATION_MS - 0.5);
  await act(async () => sleep(500));
  tick(1000);
  await act(async () => sleep(50));
  assert.deepEqual(fading(view.host), [], 'no wrapper outlives its fade');
  await view.cleanup();
});

test('coding: a reply that showed unfaded settles the moment it ends, with no fade to wait for', async (t) => {
  const { view } = await pane(t, 'unfaded');
  const article = () => view.host.querySelector('.message.assistant');
  // Past 400 characters the first text shows at once, unfaded.
  await view.render([prompt('u1'), live('unfaded', 'n1', BIG)]);
  assert.deepEqual(fading(view.host), []);
  await view.render([prompt('u1'), live('unfaded', 'n1', BIG, false)]);
  assert.ok(article().classList.contains('settled'), 'nothing fades, so nothing holds it live');
  await view.cleanup();
});

test('coding: a part ending with a tail past the parse cap shows it in the commit that ends it, fading in', async (t) => {
  const { view, tick } = await pane(t, 'late');
  const article = () => view.host.querySelector('.message.assistant');
  await view.render([prompt('u1'), live('late', 'l1', 'Intro ')]);
  tick(1000);
  // Past the main-thread parse cap (4,096 units) a streaming tail parses off
  // the main thread; the part ending with it parses it at once.
  const full = `Intro ${'word '.repeat(1000)}end`;
  const host = view.host;
  // Every committed state from the end on: whether its tail had shown.
  const states = [];
  const observer = new MutationObserver(() =>
    states.push({
      settled: article().classList.contains('settled'),
      tail: host.querySelector('.markdown').textContent.endsWith('end'),
    })
  );
  observer.observe(host, { subtree: true, childList: true, attributes: true, characterData: true });
  await view.render([prompt('u1'), live('late', 'l1', full, false)]);
  await act(async () => sleep(0));
  observer.disconnect();
  assert.ok(states.length > 0);
  assert.deepEqual(
    states.filter((state) => !state.tail),
    [],
    'no commit of the ended part without its tail'
  );
  const tail = fading(host).at(-1);
  assert.match(tail.textContent, /word word[\s\S]*end$/);
  assert.equal(tail.style.getPropertyValue('--mx-fade-ms'), FADE);
  assert.equal(tail.style.getPropertyValue('--mx-fade-delay'), '0ms', 'its fade starts as it shows');
  assert.ok(article().classList.contains('streaming'), 'still live while it fades');
  await view.cleanup();
});

test('coding: a part ending inside a code block settles at once: nothing fades in code', async (t) => {
  const { view, tick } = await pane(t, 'code-end');
  const article = () => view.host.querySelector('.message.assistant');
  await view.render([prompt('u1'), live('code-end', 'c1', 'Run:\n\n```sh\nnpm i')]);
  assert.match(view.host.textContent, /npm i/);
  // The fades of what showed ended long ago.
  tick(1000);
  await view.render([prompt('u1'), live('code-end', 'c1', 'Run:\n\n```sh\nnpm install\nnpm test\n```', false)]);
  assert.match(view.host.textContent, /npm test/);
  assert.deepEqual(fading(view.host), []);
  assert.ok(article().classList.contains('settled'), 'no fade shows, so nothing holds it live');
  await view.cleanup();
});

test('coding: text shown when a hidden tab returns shows at once, unfaded', async (t) => {
  const { view, tick } = await pane(t, 'hidden');
  const full = `Hi ${'word '.repeat(40)}`;
  await view.render([prompt('u1'), live('hidden', 'v1', 'Hi ')]);
  await step(view, tick, 5);
  await view.render([prompt('u1'), live('hidden', 'v1', full)]);
  assert.ok(painted(view.host) < full.trim().length);
  let hidden = true;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  t.after(() => delete document.hidden);
  tick(5000);
  hidden = false;
  await act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
  await parsed(view.host);
  assert.equal(view.host.querySelector('.markdown').textContent, full.trim(), 'all of it shows');
  assert.deepEqual(
    fading(view.host).filter((phrase) => /word/.test(phrase.textContent)),
    [],
    'what showed on return is not faded in'
  );
  await view.cleanup();
});

class DiscardOnError extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
function Throws() {
  throw new Error('discarded render');
}

test('coding: a settled render React never commits leaves the committed reveal where it was', async (t) => {
  const { view, tick } = await pane(t, 'abandon');
  const full = `Hi ${'word '.repeat(80)}`;
  await view.render([prompt('u1'), live('abandon', 'a1', 'Hi ')]);
  await step(view, tick, 5);
  await view.render([prompt('u1'), live('abandon', 'a1', full)]);
  for (let i = 0; i < 10 && painted(view.host) <= 2; i += 1) await step(view, tick, 200);
  const cursor = painted(view.host);
  assert.ok(cursor > 2 && cursor < full.trim().length / 2, `mid-backlog (${cursor} of ${full.trim().length})`);
  // The same reply renders settled, but a sibling throws: React discards
  // that render, so it never commits and none of its effects run.
  t.mock.method(console, 'error', () => {});
  const host = document.createElement('div');
  const discarded = createRoot(host, { onCaughtError() {} });
  await act(async () =>
    discarded.render(
      React.createElement(
        DiscardOnError,
        null,
        React.createElement(TranscriptRow, live('abandon', 'a1', full, false)),
        React.createElement(Throws)
      )
    )
  );
  await act(async () => discarded.unmount());
  await view.render([prompt('u1'), live('abandon', 'a1', full)]);
  assert.equal(painted(view.host), cursor, 'the committed row keeps its cursor');
  for (let i = 0; i < 5 && painted(view.host) === cursor; i += 1) await step(view, tick, 200);
  const next = painted(view.host);
  assert.ok(next > cursor && next < full.trim().length, `it goes on in steps (${next})`);
  assert.equal(fading(view.host).at(-1).style.getPropertyValue('--mx-fade-ms'), FADE, 'still fading in');
  await view.cleanup();
});

test('coding: a table row waits for its newline, a code line streams within its line', async (t) => {
  const { view } = await pane(t, 'rows');
  const table = '| a | b |\n| - | - |\n| c | d';
  // Over 400 characters: the first text shows at once.
  const lead = `${'x'.repeat(400)}\n\n`;
  await view.render([prompt('u1'), live('rows', 'b1', `${lead}${table}`)]);
  assert.equal(view.host.querySelectorAll('tr').length, 1, 'the row being typed waits');
  await view.render([prompt('u1'), live('rows', 'b3', `${lead}${table} |\n`)]);
  assert.equal(view.host.querySelectorAll('tr').length, 2, 'the row shows with its newline');
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

test('coding: a large buffered backlog drains smoothly across ticks when live transitions true -> false', async (t) => {
  const { view, tick } = await pane(t, 'drain-large');
  const mid = `Hi ${'word '.repeat(50)}`;
  const full = `Hi ${'word '.repeat(100)}`;
  const completion = { id: 'td1', kind: 'turndone', status: 'complete', elapsedMs: 1_200 };
  await view.render([prompt('u1'), live('drain-large', 'd1', 'Hi ')]);
  await view.render([prompt('u1'), live('drain-large', 'd1', mid)]);
  await view.render([prompt('u1'), live('drain-large', 'd1', full)]);
  const beforeEnd = painted(view.host);
  assert.ok(full.trim().length - beforeEnd > 220, 'large buffered backlog before stream end');
  tick(80);
  await view.render([prompt('u1'), { ...live('drain-large', 'd1', full, false), completion }]);
  const rightAfterEnd = painted(view.host);
  assert.ok(
    rightAfterEnd < full.trim().length,
    `did not dump entire backlog in one frame (${rightAfterEnd}/${full.trim().length})`
  );
  assert.equal(
    view.host.querySelector('.response-footer'),
    null,
    'completion footer waits until the drained body reveals its full text'
  );
  assert.equal(
    view.host.querySelector('.markdown')?.classList.contains('streaming'),
    true,
    'MarkdownResponse stays streaming while draining a buffered prefix'
  );
  for (let i = 0; i < 30 && painted(view.host) < full.trim().length; i += 1) {
    await step(view, tick, REVEAL_INTERVAL_MS);
  }
  assert.equal(view.host.querySelector('.markdown').textContent, full.trim(), 'drains cleanly to full text');
  assert.equal(
    view.host.querySelector('.markdown')?.classList.contains('streaming'),
    false,
    'MarkdownResponse settles once full text is revealed'
  );
  assert.ok(view.host.querySelector('.response-footer'), 'completion footer appears once full text is revealed');
  await view.cleanup();
});

test('coding: a trailing footer after a changes card waits until paced backlog finishes draining', async (t) => {
  const { tick } = await pane(t, 'drain-trailing-init');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(() => act(async () => root.unmount()));

  const mid = `Hi ${'word '.repeat(50)}`;
  const full = `Hi ${'word '.repeat(100)}`;
  const completion = { id: 'td-card', kind: 'turndone', status: 'complete', elapsedMs: 1_200 };
  const revealKey = 'drain-trailing:d1';

  const renderTurn = async (text, streaming, withCompletion) => {
    const item = { id: 'd1', kind: 'assistant', text, streaming };
    await act(async () =>
      root.render(
        React.createElement(
          MarkdownSessionContext.Provider,
          { value: 'drain-trailing' },
          React.createElement(TranscriptRow, {
            item,
            revealKey,
            paced: true,
            completion: withCompletion ? completion : undefined,
            footerAfterCards: true,
          }),
          withCompletion && !streaming
            ? React.createElement(TranscriptResponseFooter, {
                trailing: true,
                revealKey,
                item,
                completion,
              })
            : null
        )
      )
    );
    await parsed(host);
  };

  await renderTurn('Hi ', true, false);
  await renderTurn(mid, true, false);
  await renderTurn(full, true, false);
  assert.ok(full.trim().length - painted(host) > 220, 'large buffered backlog before stream end');

  tick(80);
  await renderTurn(full, false, true);
  assert.ok(painted(host) < full.trim().length, 'still draining prefix after stream end');
  assert.equal(
    host.querySelector('.response-footer-trailing'),
    null,
    'trailing Completed footer waits until paced text finishes draining'
  );

  for (let i = 0; i < 30 && painted(host) < full.trim().length; i += 1) {
    tick(REVEAL_INTERVAL_MS);
    await act(async () => sleep(40));
    await parsed(host);
  }
  assert.equal(host.querySelector('.markdown').textContent, full.trim(), 'drains cleanly to full text');
  assert.ok(
    host.querySelector('.response-footer-trailing'),
    'trailing Completed footer appears once full text is revealed'
  );
});

test('MarkdownDocumentView UnitWaiting renders height-preserving plain-text fallback for non-fenced pending prose', async (t) => {
  const { MarkdownDocumentView } = await import('./MarkdownDocumentView.tsx');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(() => act(async () => root.unmount()));
  const prose = 'Waiting for async worker parse to settle.';
  await act(async () =>
    root.render(
      React.createElement(MarkdownDocumentView, {
        root: {
          key: 'root',
          items: [{ key: 'u0', node: null, text: prose, pending: true, base: 0, from: 0, end: 0, held: false }],
        },
        fadeTimeline: null,
        copyControl: () => null,
      })
    )
  );
  const plain = host.querySelector('p.markdown-plain');
  assert.ok(plain, 'renders plain-text paragraph fallback while pending');
  assert.equal(plain.textContent, prose);
  assert.ok(host.querySelector('[data-transcript-pending]'), 'retains pending marker until parsed');
});
