// Streamed-reply smoothness regression gate for the real transcript.
//
// A seeded bursty stream (test-support/bursty-stream.mjs) is published through
// the real session lane store into the real transcript pipeline (rows, virtual
// list, follow/pin, live markdown) in headless Chrome. The production stream
// metrics (transcript-stream-metrics.ts, enabled by the scroll-diagnostics
// flag) sample what is painted every frame; this file only reads their output.
//
// Thresholds below were taken from measured runs of this exact stream, not
// guessed. See the BASELINES comment for the numbers and how they were chosen.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { launchPuppeteerBrowser } from '../../../../src/runtime/shared/browser-launch.mjs';
import { BURSTY_MARKDOWN, createBurstyStream } from './test-support/bursty-stream.mjs';

const STREAM_SEED = 7;
const VIEWPORT = { width: 900, height: 560 };
// After the reply has painted completely and stopped growing, the transcript
// must stay still for this long.
const QUIET_WINDOW_MS = 1_000;

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

  const user = { kind: 'user', id: 'prompt', text: 'Summarise the rollout.' };
  let current = '';
  function publish(items, tail) {
    store.apply({
      sessionId: current,
      frameSource: 'live',
      snapshot: { sessionId: current, items, streamingTail: tail, busy: Boolean(tail) },
    });
  }

  window.fixture = {
    mount(sessionId) {
      current = sessionId;
      publish([user], null);
      flushSync(() => root.render(<Shell key={sessionId} sessionId={sessionId} />));
    },
    // Replays the chunks as separate lane frames at their scheduled times,
    // then settles the reply. A due chunk is never merged with its neighbour.
    play(chunks, finalText, shrinkAtMs) {
      return new Promise((resolve) => {
        const startedAt = performance.now();
        let next = 0;
        let text = '';
        if (shrinkAtMs !== undefined) {
          setTimeout(() => {
            const row = [...document.querySelectorAll('.transcript-live-part[data-streaming-tail="true"]')].pop();
            if (!row) return;
            row.style.height = row.getBoundingClientRect().height - 40 + 'px';
            setTimeout(() => { row.style.height = ''; }, 150);
          }, shrinkAtMs);
        }
        const step = () => {
          const now = performance.now() - startedAt;
          while (next < chunks.length && chunks[next].atMs <= now + 0.5) {
            text += chunks[next].text;
            next += 1;
            publish([user], { kind: 'assistant', id: 'reply', text, streaming: true });
          }
          if (next < chunks.length) {
            setTimeout(step, Math.max(0, chunks[next].atMs - (performance.now() - startedAt)));
            return;
          }
          setTimeout(() => {
            publish([user, { kind: 'assistant', id: 'reply', text: finalText }], null);
            resolve();
          }, 120);
        };
        step();
      });
    },
  };

  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const readTranscript = () => {
    const viewport = document.querySelector('.transcript');
    const row = document.querySelector('.transcript-live-part');
    return {
      scrollTop: viewport.scrollTop,
      scrollHeight: viewport.scrollHeight,
      rowHeight: row ? row.getBoundingClientRect().height : -1,
      text: row ? row.textContent : '',
    };
  };
  // The reply has stopped changing (text, row height, scroll extent) for 20
  // frames, then the transcript is watched for the quiet window.
  window.watchQuiet = async (quietMs) => {
    let previous = '';
    let stable = 0;
    while (stable < 20) {
      await frame();
      const now = JSON.stringify(readTranscript());
      stable = now === previous ? stable + 1 : 0;
      previous = now;
    }
    const viewport = document.querySelector('.transcript');
    const settled = readTranscript();
    let scrollEvents = 0;
    let moved = 0;
    const count = () => { scrollEvents += 1; };
    viewport.addEventListener('scroll', count);
    const until = performance.now() + quietMs;
    let lastTop = settled.scrollTop;
    while (performance.now() < until) {
      await frame();
      const top = viewport.scrollTop;
      if (top !== lastTop) moved += 1;
      lastTop = top;
    }
    viewport.removeEventListener('scroll', count);
    const live = document.querySelector('.transcript-live-part');
    return {
      scrollEvents,
      moved,
      settledScrollTop: settled.scrollTop,
      endScrollTop: lastTop,
      pinnedToEnd: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 2,
      scrolls: viewport.scrollHeight > viewport.clientHeight,
      settledArticle: Boolean(live?.querySelector('article.message.settled')),
      hasTable: Boolean(live?.querySelector('table')),
      codeFences: live ? live.querySelectorAll('pre').length : 0,
      listItems: live ? live.querySelectorAll('li').length : 0,
    };
  };
  window.waitForMetricsRun = async () => {
    for (let tick = 0; tick < 200; tick += 1) {
      const raw = window.__mixdogStreamMetrics.raw();
      if (raw && raw.endedAt > 0) return true;
      await wait(50);
    }
    return false;
  };
`;

async function buildAssets() {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const assets = { loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' } };
  const [bundle, styles] = await Promise.all([
    build({
      stdin: { resolveDir, loader: 'tsx', contents: HARNESS },
      outfile: 'transcript-stream-smoothness.js',
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
            // Reply rendering loads its Markdown parser and body lazily; every
            // other lazy surface (editors, dialogs) stays unopened here.
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
      outfile: 'transcript-stream-smoothness.css',
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

/** Streams the reply once in a fresh page and returns what was measured. */
async function streamOnce(browser, assets, { reducedMotion = false, shrinkAtMs, seed = STREAM_SEED } = {}) {
  const stream = createBurstyStream({ seed });
  const page = await browser.newPage();
  try {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewport(VIEWPORT);
    if (reducedMotion) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.setContent('<!doctype html><html><head></head><body><div id="root"></div></body></html>');
    await page.evaluate(() => {
      // The stream metrics run behind the scroll-diagnostics flag.
      window.__mixdogTranscriptScroll = true;
    });
    await page.addStyleTag({ content: assets.css });
    await page.addStyleTag({ content: '#root { position: fixed; inset: 0; display: flex; container-type: size; }' });
    await page.addScriptTag({ content: assets.script });
    await page.evaluate(
      async (session) => {
        window.fixture.mount(session);
        // The pane must have shown the session before the reply is born in it.
        await new Promise((resolve) => setTimeout(resolve, 500));
      },
      `smoothness-${seed}-${Math.random().toString(36).slice(2)}`
    );
    await page.evaluate(
      (chunks, text, shrink) => window.fixture.play(chunks, text, shrink),
      stream.chunks,
      stream.text,
      shrinkAtMs
    );
    const quiet = await page.evaluate((ms) => window.watchQuiet(ms), QUIET_WINDOW_MS);
    const ended = await page.evaluate(() => window.waitForMetricsRun());
    assert.equal(
      ended,
      true,
      `the metrics run ended: ${JSON.stringify(
        await page.evaluate(() => {
          const run = window.__mixdogStreamMetrics.raw();
          return run && { ...run, frames: run.frames.length, ipc: run.ipc.length, commits: run.commits.length };
        })
      )}`
    );
    const raw = await page.evaluate(() => {
      const run = window.__mixdogStreamMetrics.raw();
      return { frames: run.frames, shrinks: run.shrinks, shrinkPx: run.shrinkPx };
    });
    const summary = await page.evaluate(() => window.__mixdogStreamMetrics.summary());
    assert.deepEqual(errors, []);
    return { stream, raw, summary, quiet };
  } finally {
    await page.close();
  }
}

/** The per-frame painted graphemes across the streamed window, empty frames
 *  included: first visible growth through last growth. */
function streamedWindow(frames) {
  const first = frames.findIndex((frame) => frame.grew > 0);
  let last = -1;
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    if (frames[index].grew > 0) {
      last = index;
      break;
    }
  }
  return first < 0 ? [] : frames.slice(first, last + 1);
}

function coefficientOfVariation(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.round((Math.sqrt(variance) / mean) * 100) / 100;
}

function describe({ raw, summary, quiet }) {
  const window = streamedWindow(raw.frames);
  const perFrame = window.map((frame) => frame.grew);
  const growth = perFrame.filter((value) => value > 0);
  const windowMs = window.length > 1 ? window.at(-1).t - window[0].t : 0;
  return {
    windowMs: Math.round(windowMs),
    fps: Math.round((window.length * 1000) / windowMs),
    streamFrames: perFrame.length,
    visibleFrames: growth.length,
    receivedGraphemes: summary.receivedGraphemes,
    visibleGraphemes: summary.visibleGraphemes,
    meanPerFrame: Math.round((growth.reduce((sum, value) => sum + value, 0) / perFrame.length) * 100) / 100,
    cvPerFrame: coefficientOfVariation(perFrame),
    cvVisibleFrames: coefficientOfVariation(growth),
    maxBurst: Math.max(0, ...perFrame),
    p95GapMs: summary.paintGrowthGapMs.p95,
    maxGapMs: summary.paintGrowthGapMs.max,
    rowShrinks: raw.shrinks,
    rowShrinkPx: Math.round(raw.shrinkPx),
    emptyFramesWithBacklog: summary.emptyFramesWithBacklog,
    longTasks: summary.longTasks.n,
    longTaskMaxMs: summary.longTasks.max,
    scrollEventsAfterSettle: quiet.scrollEvents,
    scrollMovesAfterSettle: quiet.moved,
  };
}

// BASELINES (headless Chrome on Windows, seed 7, 900x560 pane, 1839 graphemes
// arriving over ~7.3 s, ~163 fps). Pacer on versus pacer off
// (prefers-reduced-motion, which paints every arrival at once). Ranges are over
// the measured runs (pacer on: 6 runs, pacer off: 4 runs; the widest values
// come from one run on a loaded machine, ~66 fps and 15 long tasks unpaced):
//
//                                   pacer on         pacer off
//   cvVisibleFrames (stdev/mean     0.55 - 0.72      1.48 - 2.52
//     of graphemes per painting frame)
//   maxBurst (graphemes in 1 frame)  29 - 41          451
//   p95GapMs (between visible        42.5 - 48.5      431 - 1838
//     updates)
//   rowShrinks / scroll moves        0 / 0            0 / 0
//
// Each threshold sits between the two columns: roughly twice the worst pacer-on
// run, and far below the unpaced run, so scheduler noise on a busy runner does
// not trip it while a disabled pacer always does. Row shrinks and scroll moves
// after settling have a baseline of zero, so their threshold is zero; the
// injected-shrink control proves the shrink check can fail.
const THRESHOLDS = {
  cvVisibleFrames: 1.2,
  maxBurst: 60,
  p95GapMs: 100,
  rowShrinks: 0,
  scrollEventsAfterSettle: 0,
  scrollMovesAfterSettle: 0,
};

/** Every threshold the measurement breaks, by name. */
function violations(measured) {
  const broken = [];
  if (measured.cvVisibleFrames > THRESHOLDS.cvVisibleFrames) broken.push('cvVisibleFrames');
  if (measured.maxBurst > THRESHOLDS.maxBurst) broken.push('maxBurst');
  if (measured.p95GapMs > THRESHOLDS.p95GapMs) broken.push('p95GapMs');
  if (measured.rowShrinks > THRESHOLDS.rowShrinks) broken.push('rowShrinks');
  if (measured.scrollEventsAfterSettle > THRESHOLDS.scrollEventsAfterSettle) broken.push('scrollEventsAfterSettle');
  if (measured.scrollMovesAfterSettle > THRESHOLDS.scrollMovesAfterSettle) broken.push('scrollMovesAfterSettle');
  return broken;
}

test('a bursty streamed reply paints evenly, never shrinks and rests when settled', async (t) => {
  const stream = createBurstyStream({ seed: STREAM_SEED });
  assert.equal(stream.text, BURSTY_MARKDOWN);
  assert.ok(stream.pauses >= 2 && stream.lumps >= 3, 'the stream has pauses and lumps');
  const assets = await buildAssets();
  const browser = await launchPuppeteerBrowser(puppeteer, {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());

  const steady = await streamOnce(browser, assets);
  const measured = describe(steady);
  t.diagnostic(`pacer on: ${JSON.stringify(measured)}`);
  assert.equal(steady.quiet.settledArticle, true, 'the reply settled');
  assert.equal(steady.quiet.hasTable, true, 'the table rendered');
  assert.ok(steady.quiet.codeFences >= 2, 'the code fences rendered');
  assert.ok(steady.quiet.listItems >= 8, 'the lists rendered');
  assert.equal(steady.quiet.scrolls, true, 'the reply overflows the pane, so following is exercised');
  assert.equal(steady.quiet.pinnedToEnd, true, 'the settled reply is pinned to the end');
  assert.deepEqual(violations(measured), []);

  await t.test('negative control: without the pacer the gate fails', async () => {
    const unpaced = describe(await streamOnce(browser, assets, { reducedMotion: true }));
    t.diagnostic(`pacer off: ${JSON.stringify(unpaced)}`);
    const broken = violations(unpaced);
    for (const name of ['cvVisibleFrames', 'maxBurst', 'p95GapMs'])
      assert.ok(broken.includes(name), `${name}: ${broken}`);
  });

  await t.test('negative control: an injected row shrink fails the gate', async () => {
    const shrunk = describe(await streamOnce(browser, assets, { shrinkAtMs: 3_000 }));
    t.diagnostic(`shrink injected: ${JSON.stringify(shrunk)}`);
    assert.ok(violations(shrunk).includes('rowShrinks'), JSON.stringify(shrunk));
  });
});
