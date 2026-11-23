// Follow at the end of a running turn, in a real browser: it holds through everything the page does to the transcript
// (text streaming, tool rows growing and folding, rows leaving the top of the window, the pane's width and height
// changing, at fractional display scales too) and lets go only when the reader scrolls; a click on the text does not,
// and a selection holds it, writing no end under the selected text until the selection collapses.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { launchPuppeteerBrowser } from '../../../../src/runtime/shared/browser-launch.mjs';

const HARNESS = `
  import { useRef, useSyncExternalStore } from 'react';
  import { createRoot } from 'react-dom/client';
  import { flushSync } from 'react-dom';
  import { TurnChangesContext } from './TurnChangesCard';
  import { TranscriptList } from './TranscriptList';
  import { resetTurnChangesCache } from './turn-changes-model';
  import { resetTurnPreviews, runningTurnKeyOf } from './turn-preview-model';
  import { trailingTurnRuns, useConversationLinkSurfaces } from './use-conversation-link-surfaces';
  import { useConversationRowRenderer } from './use-conversation-row-renderer';
  import { useTranscriptRows } from './use-conversation-rows';
  import { useTranscriptFollow } from './use-transcript-follow';
  import { SteerContext } from './steer-actions';

  const releases = [];
  window.mixdogDesktop = {
    invokeCapability: async () => ({ value: null }),
    perfLog(line) { if (line.startsWith('transcript-follow-release')) releases.push(line); },
  };
  const steer = { actions: { sendNow() {}, cancel() {}, retry() {} }, draft: { current: null }, canSendNow: true };
  const noop = () => {};
  let state = { items: [], busy: false };
  const listeners = new Set();
  const store = {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    get: () => state,
  };
  const root = createRoot(document.getElementById('root'));
  const pane = { follow: null };

  function Shell({ sessionId }) {
    const { items, busy, liveItem = null, activityAt = 0 } = useSyncExternalStore(store.subscribe, store.get);
    const viewport = useRef(null), content = useRef(null);
    const scrollToEndRef = useRef(noop), setAnchorBottomRef = useRef(noop);
    const follow = useTranscriptFollow({ viewport, content, sessionKey: sessionId, scrollToEndRef, setAnchorBottomRef });
    pane.follow = follow;
    const { transcriptRows, settledTurnKeys, turnPastEnd, pastLastEnd } = useTranscriptRows({
      identity: sessionId, sessionKey: sessionId, settledItems: items, settledRowItems: items, failedTurnKeys: [],
      precomputedTurnKeys: null, pendingItems: [], steerItems: [], liveItem, busy, commandBusy: false,
      commandActivityVisible: activityAt > 0, commandActivityStartedAt: activityAt, optimisticActivityStartedAt: 0,
    });
    const links = useConversationLinkSurfaces({}, {
      turnChangesSessionId: sessionId, turnChangesBusy: busy,
      turnChangesRunning: trailingTurnRuns(busy, 0, pastLastEnd),
      runningTurnKey: trailingTurnRuns(busy, 0, turnPastEnd)
        ? runningTurnKeyOf(items, settledTurnKeys, settledTurnKeys.at(-1) ?? '') : '',
    });
    const { renderTranscriptRow } = useConversationRowRenderer({
      snapshot: { sessionId, busy }, disclosureScope: sessionId, readOnly: false,
      transitioning: false, onOpenSettings: noop, settledItems: items, settledTurnKeys, optimisticActivityStartedAt: 0,
      submit: async () => true, questionCard: null, agentMode: false,
    });
    return <SteerContext.Provider value={steer}><TurnChangesContext.Provider value={links.turnChangesSurface}>
      <section className="conversation"><div className="transcript-shell">
        <div className="transcript" ref={viewport} role="log" tabIndex={0} onScroll={follow.handleScroll}
          onWheel={follow.handleWheel} onPointerDown={follow.handlePointerDown}
          onPointerUp={follow.handlePointerUp} onPointerCancel={follow.handlePointerUp}
          onKeyDown={follow.handleKeyDown}>
          <div className="thread">
            <TranscriptList sessionKey={sessionId} rows={transcriptRows} viewport={viewport} content={content}
              shouldAnchorBottom={follow.following}
              scrollToEndRef={scrollToEndRef} setAnchorBottomRef={setAnchorBottomRef}
              markProgrammaticScroll={follow.markProgrammaticScroll} hasScrollGesture={follow.hasScrollGesture}
              hasTouchScroll={follow.holdsScrollCorrections} touchHoldsCorrections={follow.touchHoldsCorrections}
              onSelectionAutoScroll={follow.handleSelectionAutoScroll} onSelectionHold={follow.handleSelectionHold}
              renderRow={renderTranscriptRow} />
          </div>
        </div>
      </div></section>
    </TurnChangesContext.Provider></SteerContext.Provider>;
  }

  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const sample = () => {
    const view = document.querySelector('.transcript');
    const selection = document.getSelection();
    return {
      following: pane.follow.following && pane.follow.followingRef.current,
      jump: pane.follow.showJump,
      gap: Math.round(view.scrollHeight - view.clientHeight - view.scrollTop),
      releases: releases.slice(),
      // Where the selected text stands in the window, or null with nothing selected.
      selected: selection && !selection.isCollapsed ? selection.getRangeAt(0).getBoundingClientRect().top : null,
    };
  };
  // Every frame of a change until it settles: follow, and how far the end is.
  const watch = async (count) => {
    const out = [];
    for (let at = 0; at < count; at += 1) { await frame(); out.push(sample()); }
    return out;
  };
  window.fixture = {
    mount(next) {
      resetTurnChangesCache();
      resetTurnPreviews();
      state = next;
      flushSync(() => root.render(<Shell sessionId="s1" />));
      return watch(30);
    },
    step(next, count = 20) {
      state = next;
      for (const listener of listeners) listener();
      return watch(count);
    },
    // The page around the transcript changes: the pane's width, the reserve beside the reading column, its height.
    layout({ width, reserve, height }, count = 20) {
      const host = document.getElementById('root');
      if (width !== undefined) host.style.width = width + 'px';
      if (height !== undefined) host.style.height = height + 'px';
      if (reserve !== undefined) document.querySelector('.transcript').style.paddingRight = reserve + 'px';
      return watch(count);
    },
    sample,
  };
`;

async function buildAssets() {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const loader = { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' };
  const [bundle, styles] = await Promise.all([
    build({
      stdin: { resolveDir, loader: 'tsx', contents: HARNESS },
      outfile: 'transcript-follow-hold.js',
      bundle: true,
      write: false,
      format: 'iife',
      jsx: 'automatic',
      logLevel: 'error',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': '"http://localhost/renderer/"' },
      loader,
      plugins: [
        {
          name: 'stubs',
          setup(builder) {
            builder.onResolve({ filter: /\?worker$/ }, (args) => ({ path: args.path, namespace: 'worker-stub' }));
            builder.onLoad({ filter: /.*/, namespace: 'worker-stub' }, () => ({
              contents: 'export default class {};',
              loader: 'js',
            }));
            builder.onResolve({ filter: /.*/ }, (args) =>
              args.kind === 'dynamic-import' && !/^\.\/(markdown-ast|MarkdownBody)$/.test(args.path)
                ? { path: args.path, external: true }
                : null
            );
          },
        },
      ],
    }),
    build({
      stdin: {
        resolveDir,
        loader: 'css',
        contents:
          '@import "./font-faces.css"; @import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css";',
      },
      outfile: 'transcript-follow-hold.css',
      bundle: true,
      write: false,
      loader,
    }),
  ]);
  const script = bundle.outputFiles.find((file) => file.path.endsWith('.js')).text;
  const css = [styles.outputFiles[0], ...bundle.outputFiles.filter((file) => file.path.endsWith('.css'))]
    .map((file) => file.text)
    .join('\n');
  return { script, css };
}

let shared;
async function openPage(t, scale = 1) {
  shared ??= (async () => {
    const assets = await buildAssets();
    const browser = await launchPuppeteerBrowser(puppeteer, {
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
      headless: true,
    });
    return { assets, browser };
  })();
  const { assets, browser } = await shared;
  const page = await browser.newPage();
  t.after(() => page.close());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: scale });
  await page.setContent('<!doctype html><html><head></head><body><div id="root"></div></body></html>');
  await page.addStyleTag({ content: assets.css });
  await page.addStyleTag({
    content: '#root { position: fixed; left: 0; top: 0; width: 1200px; height: 800px; display: flex; container-type: size; }',
  });
  await page.addScriptTag({ content: assets.script });
  return { page, errors };
}
test.after(async () => {
  if (shared) await (await shared).browser.close();
});

const body = (n) =>
  `Reply paragraph ${n} with enough words to wrap across a couple of lines, so the rows above have real, uneven heights.`;
const words = (count) => Array.from({ length: count }, (_, at) => `word${at}`).join(' ');
const history = Array.from({ length: 16 }, (_, index) =>
  index % 2
    ? { kind: 'assistant', id: `h${index}`, text: `${body(index)}\n\n${body(index + 100)}`, at: 100 + index }
    : { kind: 'user', id: `h${index}`, text: `Earlier prompt ${index}`, at: 100 + index }
);
const prompt = { kind: 'user', id: 'u1', text: 'Change the files', checkpointId: 'cp', at: 1_000 };
const reply = (id, count, at, streaming = false) => ({ kind: 'assistant', id, text: words(count), at, ...(streaming ? { streaming } : {}) });
const tool = (id, name, at, done = true) => ({
  kind: 'tool',
  id,
  callId: id,
  name,
  args: name === 'grep' ? { pattern: `p${id}` } : { path: `src/${id}.ts` },
  at,
  ...(done ? { result: 'ok' } : { status: 'running' }),
});
const tools = (prefix, count, at, runningLast = false) =>
  Array.from({ length: count }, (_, index) =>
    tool(`${prefix}${index}`, index % 2 ? 'read' : 'grep', at + index, !(runningLast && index === count - 1))
  );
const running = (head, items, extra = {}) => ({ items: [...head, prompt, ...items], busy: true, activityAt: 1_000, ...extra });

/** The states of a long turn: text paragraphs between tool groups that grow and re-summarise, the window letting go of
 *  the oldest rows as the turn goes on. */
function turn() {
  const states = [];
  const done = [];
  let head = history;
  for (let round = 0; round < 4; round += 1) {
    const at = 2_000 + round * 100;
    for (const count of [10, 40, 90]) states.push(running(head, done, { liveItem: reply(`r${round}`, count, at, true) }));
    done.push(reply(`r${round}`, 90, at));
    for (let count = 1; count <= 5; count += 1) states.push(running(head, [...done, ...tools(`t${round}-`, count, at + 10, true)]));
    done.push(...tools(`t${round}-`, 5, at + 10));
    states.push(running(head, done));
    // The window slides: the oldest exchange leaves its top.
    head = head.slice(2);
    states.push(running(head, done));
  }
  return states;
}

async function mountedAtEnd(t, scale = 1) {
  const { page, errors } = await openPage(t, scale);
  const mounted = await page.evaluate((s) => window.fixture.mount(s), running(history, [reply('r', 20, 1_100, true)]));
  assert.ok(mounted.at(-1).following, 'mounted at the end, following');
  return { page, errors };
}

function assertHeld(samples, label) {
  for (const [at, sample] of samples.entries()) {
    assert.deepEqual(sample.releases, [], `${label} frame ${at}: follow was released`);
    assert.ok(sample.following, `${label} frame ${at}: not following`);
  }
  assert.ok(Math.abs(samples.at(-1).gap) <= 1, `${label}: the end is ${samples.at(-1).gap}px below the viewport`);
}

test('follow holds through a long turn: streaming, tool groups growing and folding, the window sliding', async (t) => {
  const { page, errors } = await mountedAtEnd(t);
  for (const [index, state] of turn().entries()) {
    assertHeld(await page.evaluate((s) => window.fixture.step(s), state), `state ${index}`);
  }
  assert.deepEqual(errors, []);
});

test('follow holds while the pane changes width and height as text streams', async (t) => {
  const { page, errors } = await mountedAtEnd(t);
  const states = turn();
  const layouts = [
    { width: 800 },
    { width: 1200 },
    { reserve: 344 },
    { reserve: 0 },
    { height: 560 },
    { height: 800 },
    { width: 760, reserve: 200 },
    { width: 1200, reserve: 0, height: 640 },
  ];
  for (const [index, layout] of layouts.entries()) {
    assertHeld(await page.evaluate((s) => window.fixture.step(s, 2), states[index * 3]), `stream ${index}`);
    assertHeld(await page.evaluate((l) => window.fixture.layout(l), layout), `layout ${JSON.stringify(layout)}`);
  }
  assert.deepEqual(errors, []);
});

for (const scale of [1.25, 1.5]) {
  test(`at a display scale of ${scale}: follow holds through the turn and fractional pane sizes`, async (t) => {
    const { page, errors } = await mountedAtEnd(t, scale);
    const states = turn();
    const layouts = [{ height: 640.4 }, { reserve: 120.6 }, { width: 1033.3 }, { height: 801.2 }, { reserve: 0, width: 1200 }];
    for (const [index, state] of states.entries()) {
      assertHeld(await page.evaluate((s) => window.fixture.step(s, 6), state), `${scale} state ${index}`);
      if (index % 6 === 5) {
        const layout = layouts[(index / 6) % layouts.length | 0];
        assertHeld(await page.evaluate((l) => window.fixture.layout(l, 6), layout), `${scale} ${JSON.stringify(layout)}`);
      }
    }
    assert.deepEqual(errors, []);
  });
}

test("a click on a reply's text keeps follow while the turn streams; a selection dragged out of it holds follow, the selected text still, until it collapses", async (t) => {
  const { page, errors } = await mountedAtEnd(t);
  const states = turn();
  await page.evaluate((s) => window.fixture.step(s), states[1]);
  // A word of a reply in view above the streaming one: the first line of its text.
  const text = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.transcript-virtual-row-content[data-tag="AssistantPart"]')];
    const row = rows.filter((node) => node.getBoundingClientRect().top > 40).at(-2);
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (/word/.test(node.textContent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    const range = document.createRange();
    range.selectNodeContents(walker.nextNode());
    const line = range.getClientRects()[0];
    return { x: line.left + 4, y: line.top + line.height / 2 };
  });
  await page.mouse.click(text.x, text.y);
  assertHeld(await page.evaluate((s) => window.fixture.step(s), states[2]), 'after a click on the text');
  await page.mouse.move(text.x, text.y);
  await page.mouse.down();
  await page.mouse.move(text.x + 160, text.y, { steps: 6 });
  await page.mouse.up();
  const selectedAt = (await page.evaluate(() => window.fixture.sample())).selected;
  assert.notEqual(selectedAt, null, 'the drag selected text');
  for (const state of states.slice(2, 7)) {
    for (const [at, sample] of (await page.evaluate((s) => window.fixture.step(s), state)).entries()) {
      assert.deepEqual(sample.releases, [], `frame ${at}: a selection released follow`);
      assert.ok(sample.following, `frame ${at}: not following`);
      assert.equal(sample.selected, selectedAt, `frame ${at}: the selected text moved`);
    }
  }
  assert.ok((await page.evaluate(() => window.fixture.sample())).gap > 1, 'the turn grew below the held view');
  await page.evaluate(() => document.getSelection().removeAllRanges());
  assertHeld(await page.evaluate((s) => window.fixture.step(s), states[7]), 'after the selection collapsed');
  assert.deepEqual(errors, []);
});

test('a selection inside the reply that is still streaming holds follow: the selected words stay put as more stream in, and the jump control says the end is not kept', async (t) => {
  const { page, errors } = await mountedAtEnd(t);
  // The reply streams a second paragraph under a first one it has written.
  const streaming = (count) =>
    running(history, [{ kind: 'assistant', id: 'r', text: `${body(1)}\n\n${words(count)}`, at: 1_100, streaming: true }]);
  await page.evaluate((s) => window.fixture.step(s), streaming(40));
  // The first paragraph is written out: all of it revealed, none of it still fading in.
  await page.waitForFunction(
    (written) => {
      const row = [...document.querySelectorAll('.transcript-virtual-row-content[data-tag="AssistantPart"]')].at(-1);
      const first = row?.querySelector('[data-md-unit="p@0"]');
      return first?.textContent === written && !first.querySelector('mx-fade');
    },
    { timeout: 10_000, polling: 100 },
    body(1)
  );
  // The first words of the streaming reply's first paragraph, in the last row.
  const text = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.transcript-virtual-row-content[data-tag="AssistantPart"]')].at(-1);
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        /Reply paragraph/.test(node.textContent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
    });
    const range = document.createRange();
    range.selectNodeContents(walker.nextNode());
    const line = range.getClientRects()[0];
    return { x: line.left + 4, y: line.top + line.height / 2 };
  });
  await page.mouse.move(text.x, text.y);
  await page.mouse.down();
  await page.mouse.move(text.x + 160, text.y, { steps: 6 });
  await page.mouse.up();
  const selectedAt = (await page.evaluate(() => window.fixture.sample())).selected;
  assert.notEqual(selectedAt, null, 'the drag selected text of the streaming reply');
  for (const count of [60, 90, 120, 160, 200]) {
    for (const [at, sample] of (await page.evaluate((s) => window.fixture.step(s), streaming(count))).entries()) {
      assert.deepEqual(sample.releases, [], `${count} words, frame ${at}: a selection released follow`);
      assert.ok(sample.following, `${count} words, frame ${at}: not following`);
      assert.equal(sample.selected, selectedAt, `${count} words, frame ${at}: the selected words moved`);
    }
  }
  const held = await page.evaluate(() => window.fixture.sample());
  assert.ok(held.gap > 1, 'the reply grew below the held view');
  assert.equal(held.jump, true, 'the jump control shows while the end is not kept');
  await page.evaluate(() => document.getSelection().removeAllRanges());
  const after = await page.evaluate((s) => window.fixture.step(s), streaming(220));
  assertHeld(after, 'after the selection collapsed');
  assert.equal(after.at(-1).jump, false, 'following again: no jump control');
  assert.deepEqual(errors, []);
});

test('a wheel up by the reader still releases follow while the turn streams', async (t) => {
  const { page, errors } = await mountedAtEnd(t);
  await page.evaluate((s) => window.fixture.step(s), turn()[1]);
  await page.mouse.move(600, 300);
  await page.mouse.wheel({ deltaY: -240 });
  const after = await page.evaluate((s) => window.fixture.step(s), turn()[2]);
  assert.equal(after.at(-1).following, false, 'the wheel let go of the end');
  assert.ok(after.at(-1).gap > 100, 'and the end stays below the viewport');
  assert.deepEqual(errors, []);
});
