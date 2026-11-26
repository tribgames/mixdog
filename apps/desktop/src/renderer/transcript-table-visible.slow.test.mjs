// Set MIXDOG_TABLE_CAPTURES to a folder to keep screenshots of the table
// scrolled in from the parking reach's edge, and of any blank view found.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { launchPuppeteerBrowser } from '../../../../src/runtime/shared/browser-launch.mjs';
import { VIRTUAL_CLOCK } from './test-support/virtual-clock.mjs';

const CAPTURES = process.env.MIXDOG_TABLE_CAPTURES ?? '';

const HARNESS = `
  import { useRef } from 'react';
  import { createRoot } from 'react-dom/client';
  import { flushSync } from 'react-dom';
  import { transcriptRowNode } from './conversation-support';
  import { desktopStreamingTailSnapshotsEqual } from './desktop-snapshot-store';
  import { createSessionLaneStore, useSessionLane } from './session-lane-store';
  import { TranscriptAssistantRow } from './TranscriptAssistantRow';
  import { TranscriptList } from './TranscriptList';
  import { useStreamingTail, useTranscriptRows } from './use-conversation-rows';
  import { useTranscriptFollow } from './use-transcript-follow';

  window.mixdogDesktop = {};
  const store = createSessionLaneStore();
  const root = createRoot(document.getElementById('root'));
  const noop = () => {};

  function Shell({ sessionId }) {
    const snapshot = useSessionLane(sessionId, store, desktopStreamingTailSnapshotsEqual);
    const viewport = useRef(null);
    const content = useRef(null);
    const scrollToEndRef = useRef(noop);
    const setAnchorBottomRef = useRef(noop);
    const follow = useTranscriptFollow({ viewport, content, sessionKey: sessionId, scrollToEndRef, setAnchorBottomRef });
    const items = snapshot?.items ?? [];
    const { activeStreamingTail, settledRowItems } = useStreamingTail(snapshot?.streamingTail, items);
    const { settledTurnKeys, transcriptRows } = useTranscriptRows({
      identity: sessionId,
      sessionKey: sessionId,
      settledItems: items,
      settledRowItems,
      failedTurnKeys: [],
      precomputedTurnKeys: null,
      pendingItems: [],
      liveItem: activeStreamingTail,
      busy: Boolean(snapshot?.busy),
      commandBusy: false,
      commandActivityVisible: false,
      optimisticActivityStartedAt: 0,
    });
    const renderRow = (row) => transcriptRowNode(row, {
      disclosureScope: sessionId,
      optimisticActivityStartedAt: 0,
      readOnly: false,
      renderAssistantRow: (props) => <TranscriptAssistantRow {...props} />,
      retryDisabled: true,
      settledItems: items,
      settledTurnKeys,
      snapshot: snapshot ?? { sessionId },
      onRetryTurn: noop,
      onOpenSettings: noop,
    });
    return <section className="conversation">
      <div className="transcript-shell">
        <div className="transcript" ref={viewport} role="log" onScroll={follow.handleScroll}
          onWheel={follow.handleWheel} onPointerDown={follow.handlePointerDown}
          onPointerMove={follow.handlePointerMove} onPointerUp={follow.handlePointerUp}
          onPointerCancel={follow.handlePointerUp}>
          <div className="thread">
            <TranscriptList sessionKey={sessionId} rows={transcriptRows} viewport={viewport} content={content}
              shouldAnchorBottom={follow.following}
              scrollToEndRef={scrollToEndRef} setAnchorBottomRef={setAnchorBottomRef}
              markProgrammaticScroll={follow.markProgrammaticScroll} hasScrollGesture={follow.hasScrollGesture}
              hasTouchScroll={follow.hasTouchScroll}
              onSelectionAutoScroll={follow.handleSelectionAutoScroll} renderRow={renderRow} />
          </div>
        </div>
      </div>
    </section>;
  }

  let current = '';
  let items = [];
  function publish(tail) {
    store.apply({
      sessionId: current,
      frameSource: 'live',
      snapshot: { sessionId: current, items, streamingTail: tail, busy: Boolean(tail) },
    });
  }

  window.fixture = {
    mount(sessionId, prompt) {
      current = sessionId;
      items = [{ kind: 'user', id: 'prompt', text: prompt }];
      publish(null);
      flushSync(() => root.render(<Shell key={sessionId} sessionId={sessionId} />));
    },
    // Replays the chunks as lane frames 'gapMs' apart, then completes the
    // item 120 ms after the last one. From chunk 'holdFrom' on, the reader
    // holds the table in view.
    play(id, chunks, gapMs, holdFrom = Infinity) {
      return new Promise((resolve) => {
        let next = 0;
        let text = '';
        const step = () => {
          text += chunks[next];
          next += 1;
          publish({ kind: 'assistant', id, text, streaming: true });
          // The table's block id is learned while it is mounted.
          requestAnimationFrame(() => (next >= holdFrom ? window.revealTable() : window.tableBlock()));
          if (next < chunks.length) {
            setTimeout(step, gapMs);
            return;
          }
          setTimeout(() => {
            items = [...items, { kind: 'assistant', id, text }];
            publish(null);
            resolve();
          }, 120);
        };
        step();
      });
    },
    prompt(id, text) {
      items = [...items, { kind: 'user', id, text }];
      publish(null);
    },
  };
`;

const PROBE = `
  window.frames = (count = 6) => new Promise((resolve) => {
    let seen = 0;
    const next = () => (++seen > count ? resolve() : requestAnimationFrame(next));
    next();
  });
  window.settle = async (ms = 1500) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await window.frames();
  };
  window.viewport = () => document.querySelector('.transcript');
  // The table's block, mounted or parked (its box carries the block's id).
  let tableId = '';
  window.tableBlock = () => {
    const frame = document.querySelector('.markdown-table-frame');
    if (frame) {
      tableId = frame.getAttribute('data-md-unit') ?? frame.closest('[data-md-unit]')?.getAttribute('data-md-unit') ?? '';
    }
    return frame ?? document.querySelector('[data-md-parked="' + tableId + '"]');
  };
  window.tableTop = () => window.tableBlock().getBoundingClientRect().top - window.viewport().getBoundingClientRect().top;
  // The reply's top-level blocks in view: a parked box, or text painted at
  // less than full ink once every fade ended, is an empty area on screen.
  window.blankInView = () => {
    const view = window.viewport().getBoundingClientRect();
    const blank = [];
    for (const markdown of document.querySelectorAll('.markdown')) {
      for (const block of markdown.children) {
        const rect = block.getBoundingClientRect();
        if (rect.height <= 0 || rect.bottom <= view.top || rect.top >= view.bottom) continue;
        const label = block.getAttribute('data-md-parked') ?? block.getAttribute('data-md-unit') ?? block.tagName;
        if (block.hasAttribute('data-md-parked')) {
          blank.push({ parked: label, top: Math.round(rect.top - view.top), height: Math.round(rect.height) });
          continue;
        }
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!/\\S/.test(node.nodeValue ?? '')) continue;
          let opacity = 1;
          for (let element = node.parentElement; element && element !== markdown; element = element.parentElement) {
            opacity *= Number(getComputedStyle(element).opacity);
          }
          if (opacity < 0.99) {
            blank.push({ faded: label, opacity, text: node.nodeValue.slice(0, 24) });
            break;
          }
        }
      }
    }
    return blank;
  };
  // Scrolls the transcript so the table's top sits 'offset' px into the view.
  window.revealTable = async (offset = 80) => {
    window.viewport().scrollTop += window.tableTop() - offset;
    await window.frames(10);
  };
  window.scrollToRatio = async (ratio) => {
    const viewport = window.viewport();
    viewport.scrollTop = (viewport.scrollHeight - viewport.clientHeight) * ratio;
    await window.frames(10);
  };
`;

const filler = (count, seed) =>
  Array.from(
    { length: count },
    (_, index) =>
      `(${index + seed}) 빌드 로그와 테스트 결과를 다시 확인했습니다. The renderer keeps the transcript rows measured and the reader's place steady while the reply grows, and paragraph ${index + seed} restates the result in more words so it wraps over several lines.`
  ).join('\n\n');

const TABLE = [
  '| 항목 | 내용 |',
  '| --- | --- |',
  ...Array.from(
    { length: 8 },
    (_, index) =>
      `| **영역 ${index + 1}** | 지금까지 본 것은 **${index + 1}번째 변경**이고, this cell is long enough to wrap across the column so the row takes more than one line of text in the table |`
  ),
].join('\n');

const AFTER_TABLE =
  '이 표 아래 문단은 표가 끝난 뒤에 이어지는 설명입니다. The paragraph after the table closes the comparison.';

const REPLY = [
  filler(24, 1),
  '…Rust 전체 테스트를 시작했습니다.',
  '**지금까지 본 것과 이번에 새로 보는 것**',
  TABLE,
  AFTER_TABLE,
  filler(14, 40),
].join('\n\n');

function chunksOf(text, size) {
  const chunks = [];
  for (let at = 0; at < text.length; at += size) chunks.push(text.slice(at, at + size));
  return chunks;
}

async function buildAssets() {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const assets = { loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' } };
  const [bundle, styles] = await Promise.all([
    build({
      stdin: { resolveDir, loader: 'tsx', contents: HARNESS },
      outfile: 'transcript-table-visible.js',
      bundle: true,
      write: false,
      format: 'iife',
      jsx: 'automatic',
      logLevel: 'error',
      define: { 'process.env.NODE_ENV': '"production"' },
      ...assets,
      plugins: [
        {
          name: 'markdown-only-lazy-imports',
          setup(builder) {
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
      outfile: 'transcript-table-visible.css',
      bundle: true,
      write: false,
      ...assets,
    }),
  ]);
  const script = bundle.outputFiles.find((file) => file.path.endsWith('.js')).text;
  const css = [styles.outputFiles[0], ...bundle.outputFiles.filter((file) => file.path.endsWith('.css'))]
    .map((file) => file.text)
    .join('\n');
  return { script, css };
}

/** A page with the reply streamed in and completed, its fades over and its
 *  far blocks parked. */
async function openReply(t, browser, assets, { session, prompt = 'Compare the runs.', width = 900, holdFrom }) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.bringToFront();
  await page.setViewport({ width, height: 560 });
  await page.setContent(
    '<!doctype html><html><head></head><body><div id="surface"><div id="root"></div></div></body></html>'
  );
  await page.evaluate(VIRTUAL_CLOCK);
  await page.addStyleTag({ content: assets.css });
  await page.addStyleTag({
    content: '#surface, #root { position: fixed; inset: 0; display: flex; container-type: size; }',
  });
  await page.addScriptTag({ content: assets.script });
  await page.evaluate(PROBE);
  t.after(() => page.close());
  await page.evaluate(
    async (id, text) => {
      window.fixture.mount(id, text);
      await new Promise((resolve) => setTimeout(resolve, 300));
    },
    session,
    prompt
  );
  await page.evaluate((chunks, from) => window.fixture.play('reply', chunks, 30, from), chunksOf(REPLY, 60), holdFrom);
  await page.evaluate('window.settle(2500)');
  return { page, errors };
}

async function capture(page, name) {
  if (!CAPTURES) return;
  mkdirSync(CAPTURES, { recursive: true });
  await page.screenshot({ path: join(CAPTURES, `${name}.png`) });
}

async function expectShown(page, label) {
  const blank = await page.evaluate('window.blankInView()');
  if (blank.length > 0) await capture(page, `blank-${label.replace(/\W+/g, '-')}`);
  assert.deepEqual(blank, [], `${label}: every block in view shows its content`);
}

async function expectTableParked(page, label) {
  const parked = await page.evaluate('window.tableBlock().hasAttribute("data-md-parked")');
  assert.ok(parked, `${label}: the table is parked`);
}

test('a table in view always shows its content', async (t) => {
  const assets = await buildAssets();
  const browser = await launchPuppeteerBrowser(puppeteer, {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());

  await t.test('a parked box that stopped at the edge of the reach returns once it scrolls into view', async (t) => {
    const { page, errors } = await openReply(t, browser, assets, { session: 'table-edge' });
    await page.evaluate('window.scrollToRatio(0)');
    await expectTableParked(page, 'at the top');
    // The box's top exactly on the reach's far edge (one viewport below the
    // view): the observer counts the touching box as within reach.
    await page.evaluate(`(async () => {
      const viewport = window.viewport();
      viewport.scrollTop += window.tableTop() - 2 * viewport.clientHeight;
      await window.frames(10);
    })()`);
    const edge = await page.evaluate('window.tableTop() - 2 * window.viewport().clientHeight');
    assert.equal(edge, 0, 'the table box touches the reach edge');
    // Then the reader scrolls on until the table is in the middle of the view.
    while ((await page.evaluate('window.tableTop()')) > 150) {
      await page.evaluate('window.viewport().scrollTop += 60; window.frames(3)');
    }
    await page.evaluate('window.frames(6)');
    await capture(page, 'table-scrolled-in-from-the-reach-edge');
    await expectShown(page, 'scrolled in from the reach edge');
    assert.deepEqual(errors, []);
  });

  await t.test('scrolled back to the table from every part of the reply', async (t) => {
    const { page, errors } = await openReply(t, browser, assets, { session: 'table-scroll', width: 640 });
    await expectShown(page, 'completed at the bottom');
    await page.evaluate('window.revealTable()');
    await expectShown(page, 'scrolled to the table');
    for (const ratio of [0, 1, 0.5, 0]) {
      await page.evaluate(`window.scrollToRatio(${ratio})`);
      await page.evaluate('window.revealTable(120)');
      await expectShown(page, `back to the table from ${ratio}`);
    }
    assert.deepEqual(errors, []);
  });

  await t.test('resized wider at the top and stepped through', async (t) => {
    const { page, errors } = await openReply(t, browser, assets, { session: 'table-resize', width: 640 });
    // Wider at the top: the text above takes fewer lines and every box below
    // was measured at the narrower width. The reader then steps down through
    // the whole reply.
    await page.evaluate('window.scrollToRatio(0)');
    await page.setViewport({ width: 1400, height: 560 });
    await page.evaluate('window.frames(10)');
    await expectShown(page, 'wider at the top');
    const steps = await page.evaluate('Math.ceil(window.viewport().scrollHeight / 90)');
    for (let step = 0; step < steps; step += 1) {
      await page.evaluate('window.viewport().scrollTop += 90; window.frames(3)');
      await expectShown(page, `wider, step ${step}`);
    }
    for (const width of [640, 1200, 900]) {
      await page.setViewport({ width, height: 560 });
      await page.evaluate('window.frames(10)');
      await expectShown(page, `resized to ${width}`);
      await page.evaluate('window.revealTable()');
      await expectShown(page, `resized to ${width}, table revealed`);
    }
    assert.deepEqual(errors, []);
  });

  await t.test('zoomed in and back', async (t) => {
    const { page, errors } = await openReply(t, browser, assets, { session: 'table-zoom', width: 640 });
    // Zoom: the CSS viewport shrinks and the device scale grows.
    const session = await page.createCDPSession();
    await page.evaluate('window.scrollToRatio(0)');
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: 600,
      height: 373,
      deviceScaleFactor: 1.5,
      mobile: false,
    });
    await page.evaluate('window.frames(10)');
    await page.evaluate('window.revealTable()');
    await expectShown(page, 'zoomed in');
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: 900,
      height: 560,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.evaluate('window.frames(10)');
    await expectShown(page, 'zoomed back');
    assert.deepEqual(errors, []);
  });

  await t.test('the surface hidden and shown again', async (t) => {
    const { page, errors } = await openReply(t, browser, assets, { session: 'table-hidden' });
    await page.evaluate('window.revealTable()');
    // A surface hidden (another tab or session) and shown again elsewhere.
    for (const hide of ['display: none', 'content-visibility: hidden']) {
      await page.evaluate('window.scrollToRatio(1)');
      await page.evaluate(`document.getElementById('surface').style.cssText = '${hide}'; window.frames(10)`);
      await page.evaluate('window.viewport().scrollTop -= 2000');
      await page.evaluate(`document.getElementById('surface').style.cssText = ''; window.frames(10)`);
      await expectShown(page, `shown again after ${hide}`);
      await page.evaluate('window.revealTable()');
      await expectShown(page, `shown again after ${hide}, table revealed`);
    }
    assert.deepEqual(errors, []);
  });

  await t.test('the window minimized and restored at another place', async (t) => {
    const { page, errors } = await openReply(t, browser, assets, { session: 'table-minimized', width: 640 });
    const session = await page.createCDPSession();
    await page.evaluate('window.scrollToRatio(1)');
    const { windowId } = await session.send('Browser.getWindowForTarget');
    await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await page.evaluate('new Promise((resolve) => setTimeout(resolve, 300))');
    await page.evaluate('window.viewport().scrollTop = 0');
    await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await page.evaluate('window.frames(10)');
    await page.evaluate('window.revealTable()');
    await expectShown(page, 'window restored');
    assert.deepEqual(errors, []);
  });

  await t.test('the next turn arrives while the table is in view', async (t) => {
    const { page, errors } = await openReply(t, browser, assets, { session: 'table-next-turn', width: 640 });
    await page.evaluate('window.revealTable()');
    await page.evaluate(`window.fixture.prompt('next', 'And the next run?')`);
    await page.evaluate('window.frames(10)');
    await expectShown(page, 'the next message arrived');
    await page.evaluate((chunks) => window.fixture.play('reply-2', chunks, 30), chunksOf(filler(6, 90), 60));
    await page.evaluate('window.settle()');
    await page.evaluate('window.revealTable()');
    await expectShown(page, 'after the next reply');
    assert.deepEqual(errors, []);
  });

  await t.test('paragraphs of the reply keep the block gap between them', async (t) => {
    const { page, errors } = await openReply(t, browser, assets, { session: 'block-gap' });
    await page.evaluate('window.scrollToRatio(0)');
    const gap = await page.evaluate(`(() => {
      const [first, second] = document.querySelectorAll('.markdown > .markdown-unit > p');
      return second.getBoundingClientRect().top - first.getBoundingClientRect().bottom;
    })()`);
    // `.message-body p` (12-transcript.css): one 14px block-gap unit.
    assert.equal(gap, 14);
    assert.deepEqual(errors, []);
  });

  await t.test('the turn ends with the table on screen', async (t) => {
    // Once the table streamed in, the reader holds it in view to the end.
    const holdFrom = Math.ceil(REPLY.indexOf(AFTER_TABLE) / 60) + 2;
    const { page, errors } = await openReply(t, browser, assets, { session: 'table-on-screen', holdFrom });
    await expectShown(page, 'settled with the table in view');
    for (const ratio of [0, 1]) {
      await page.evaluate(`window.scrollToRatio(${ratio})`);
      await page.evaluate('window.revealTable(40)');
      await expectShown(page, `back to the table from ${ratio}`);
    }
    assert.deepEqual(errors, []);
  });
});
