import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { launchPuppeteerBrowser } from '../../../../src/runtime/shared/browser-launch.mjs';
import { VIRTUAL_CLOCK } from './test-support/virtual-clock.mjs';
import { createBurstyStream } from './test-support/bursty-stream.mjs';
import { completionFlashes, revealSteps, STREAM_FRAME_PROBE } from './test-support/stream-frames.mjs';

const STREAM_SEED = 7;
const FADE_MS = 150;

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
    // Replays the chunks as lane frames at their times; \`completeAfter\` ms
    // after the last one the item completes. Resolves with the last chunk's
    // and the completion's times.
    play(chunks, finalText, completeAfter) {
      return new Promise((resolve) => {
        const startedAt = performance.now();
        let next = 0;
        let text = '';
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
          const lastArrival = performance.now();
          setTimeout(() => {
            const completedAt = performance.now();
            publish([user, { kind: 'assistant', id: 'reply', text: finalText }], null);
            resolve({ lastArrival, completedAt });
          }, completeAfter);
        };
        step();
      });
    },
  };
`;

async function buildAssets() {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const assets = { loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' } };
  const [bundle, styles] = await Promise.all([
    build({
      stdin: { resolveDir, loader: 'tsx', contents: HARNESS },
      outfile: 'transcript-stream-completion.js',
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
      outfile: 'transcript-stream-completion.css',
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

/** Streams the reply in a fresh page, its item completing `completeAfter` ms
 *  after the last chunk, and returns every frame sampled. */
async function streamOnce(browser, assets, stream, completeAfter) {
  const page = await browser.newPage();
  try {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    // Tall enough that the whole reply stays within the parking reach: the frames count the characters in the DOM.
    await page.setViewport({ width: 900, height: 2400 });
    await page.setContent('<!doctype html><html><head></head><body><div id="root"></div></body></html>');
    await page.evaluate(VIRTUAL_CLOCK);
    await page.addStyleTag({ content: assets.css });
    await page.addStyleTag({ content: '#root { position: fixed; inset: 0; display: flex; container-type: size; }' });
    await page.addScriptTag({ content: assets.script });
    await page.evaluate(
      async (session) => {
        window.fixture.mount(session);
        await new Promise((resolve) => setTimeout(resolve, 500));
      },
      `completion-${Math.random().toString(36).slice(2)}`
    );
    await page.evaluate(STREAM_FRAME_PROBE);
    const times = await page.evaluate(
      (chunks, text, after) => window.fixture.play(chunks, text, after),
      stream.chunks,
      stream.text,
      completeAfter
    );
    // Shown, at full ink, settled, the timeline dropped and the far blocks parked.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 2_500)));
    const frames = await page.evaluate(() => window.__streamFrames);
    assert.deepEqual(errors, []);
    return { frames, ...times };
  } finally {
    await page.close();
  }
}

/** When the reply first painted `painted` characters, from `from` on. */
function shownAt(frames, from, painted) {
  return frames.find((frame) => frame.t >= from && frame.painted >= painted)?.t;
}

test('a reply completing mid-reveal shows its rest at once, fading in, and settles at full ink with no visible change', async (t) => {
  const stream = createBurstyStream({ seed: STREAM_SEED });
  const assets = await buildAssets();
  const browser = await launchPuppeteerBrowser(puppeteer, {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const ended = await streamOnce(browser, assets, stream, 120);
  const { frames, completedAt } = ended;

  const before = frames.filter((frame) => frame.t < completedAt && frame.painted !== undefined).at(-1);
  // Read as it settles: parking later takes the far blocks out of the DOM.
  const settledFrame = frames.find((frame) => frame.t >= completedAt && frame.settled);
  assert.ok(settledFrame, 'the reply settled');
  const shownWhole = settledFrame.painted;
  const backlog = shownWhole - before.painted;
  assert.ok(backlog >= 100, `the item completed with text still to show (${backlog})`);
  t.diagnostic(`backlog at completion: ${backlog} painted characters`);

  await t.test(
    'completion: no node in view replaced, no opacity lost or sped up, no height change without text',
    () => {
      const found = completionFlashes(frames, { from: completedAt - 100, to: settledFrame.t + 1_500, fadeMs: FADE_MS });
      assert.deepEqual(found, []);
    }
  );

  await t.test('the switch to completed comes once all of it showed and every character is at full ink', () => {
    const shown = shownAt(frames, completedAt, shownWhole);
    assert.ok(shown !== undefined && shown <= settledFrame.t, 'everything showed before the switch');
    const faint = settledFrame.runs.filter((run) => run[2] < 1);
    assert.deepEqual(faint, [], 'no text below full ink at the frame of the switch');
    const early = frames.filter((frame) => frame.t >= completedAt && frame.t < settledFrame.t && frame.settled);
    assert.deepEqual(early, []);
  });

  await t.test('the rest shows at once on completion and fades in from then', () => {
    const steps = revealSteps(frames, completedAt).filter((step) => step.t <= settledFrame.t);
    t.diagnostic(
      `after completion: ${steps.map((step) => `+${step.chars}@${Math.round(step.t - completedAt)}`).join(' ')}`
    );
    assert.equal(steps.length, 1, 'in one step');
    assert.equal(steps[0].chars, backlog, 'all of the rest');
    assert.ok(steps[0].t - completedAt <= 50, `at completion (${Math.round(steps[0].t - completedAt)} ms)`);
    const settledAfter = settledFrame.t - completedAt;
    assert.ok(
      settledAfter >= FADE_MS - 50 && settledAfter <= FADE_MS + 200,
      `live while its last fade runs (${Math.round(settledAfter)} ms)`
    );
  });
});
