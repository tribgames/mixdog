import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

// Sending a prompt: the composer clears (its card shrinks and hands the
// followed transcript the freed room) and the optimistic bubble plus the
// working band join the thread. They must reach the screen in ONE frame. When
// the phone deferred the bubble as a transition, the tap's own commit painted
// first — composer shrunk, history slid down, no bubble — and the bubble
// landed frames later, shoving the history back up: the sent prompt popped out
// of the composer. The real list, rows, live band, dock, mobile stylesheet and
// the real submit action (useConversationComposerActions) run in real Chrome
// on a phone and on a desktop surface; every painted frame is sampled.
const resolveDir = fileURLToPath(new URL('.', import.meta.url));
const loader = { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' };
const PHONE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

const HARNESS = `
  import { useLayoutEffect, useRef, useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { ComposerDock } from './ComposerDock';
  import { TranscriptList } from './TranscriptList';
  import { TranscriptRow } from './transcript-row';
  import { LiveActivity } from './transcript-status';
  import { useTranscriptFollow } from './use-transcript-follow';
  import { appendLiveTranscriptRows, projectSettledTranscriptRows } from './transcript-rows';
  import { transcriptTurnKeys } from './renderer-logic.mjs';
  import { pendingPromptTranscriptItems } from './conversation-prompt-items';
  import { useConversationComposerActions } from './conversation-support';
  import { useConversationOptimisticPromptRelease } from './use-conversation-optimistic-prompts';

  window.mixdogDesktop = {
    invokeCapability: async () => ({ value: {
      supported: true, authoritative: true, complete: true, snapshotKind: 'worktree',
      checkpointId: 'prompt', patch: '', files: [], agents: [],
    } }),
  };
  const SESSION = 'fixture';
  const empty = [];
  const body = (n) => 'Reply paragraph ' + n + ' with enough words to wrap across a few lines on a narrow phone screen, so rows have real, uneven heights.';
  const history = Array.from({ length: 16 }, (_, index) => index % 2
    ? { kind: 'assistant', id: 'h' + index, text: body(index) + '\\n\\n' + body(index + 100) }
    : { kind: 'user', id: 'h' + index, text: 'Earlier prompt ' + index + ' that is long enough to wrap onto a second line on the phone' });
  const snapshot = { sessionId: SESSION };
  const root = createRoot(document.getElementById('root'));
  const promoted = { current: false };

  function renderRow(row) {
    if (row._tag === 'TurnGap') return <div className="transcript-turn-gap" aria-hidden="true" />;
    if (row._tag === 'Thinking') {
      return <div className="live-activity-slot" data-busy="true">
        <LiveActivity snapshot={snapshot} optimisticStartedAt={window.submittedAt || 0} turnKey={row.turnKey} />
      </div>;
    }
    // A phone renders a new transcript row slowly; the cost is paid by the
    // pending row's own render, so a deferred (transition) row lands late.
    if (row.item.pending && window.rowCost) for (const until = performance.now() + window.rowCost; performance.now() < until;);
    return <TranscriptRow item={row.item} disclosureScope={SESSION} attachedUser={row.attachedUser} />;
  }
  function Harness() {
    const [settledItems, setSettledItems] = useState(history);
    const [optimisticPrompts, setOptimisticPrompts] = useState([]);
    const [busy, setBusy] = useState(false);
    const [draft, setDraft] = useState('one\\ntwo\\nthree');
    const viewport = useRef(null), content = useRef(null);
    const scrollToEndRef = useRef(() => {}), setAnchorBottomRef = useRef(() => {});
    const follow = useTranscriptFollow({ viewport, content, sessionKey: SESSION, scrollToEndRef, setAnchorBottomRef });
    const armRef = useRef(follow.arm);
    armRef.current = follow.arm;
    const armFollowOnSubmitRef = useRef({ current: () => armRef.current() }).current;
    // The host: acknowledges after a round trip, then publishes the durable row.
    const hostRef = useRef({
      invokeResult: (action) => action(),
      submit: async (content, options) => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        setBusy(true);
        setTimeout(() => setSettledItems((items) => [...items, { kind: 'user', id: options.id, text: String(content) }]), 200);
        return true;
      },
    });
    const refs = useRef({
      draftMode: { current: false }, goal: { current: null }, scope: { current: SESSION },
      queued: { current: false }, route: { current: SESSION }, users: { current: history.length / 2 },
      suppress: { current: false },
    }).current;
    const { composerSubmit } = useConversationComposerActions({
      armFollowOnSubmitRef,
      composerActions: hostRef, draftModeRef: refs.draftMode, goalSubmission: refs.goal, goalSubmitScopeRef: refs.scope,
      queuedBehindTurnAtSubmit: refs.queued, routeSessionIdRef: refs.route, setOptimisticPrompts,
      settledUsersRef: refs.users, suppressDraftSubmitPaintHandoff: refs.suppress,
    });
    useConversationOptimisticPromptRelease({
      transcriptSessionKey: SESSION, promotedOwnDraft: promoted, settledItems, setOptimisticPrompts,
    });
    useLayoutEffect(() => {
      window.sendPrompt = async (text) => {
        // use-composer-submission.ts: after its awaits, in one continuation,
        // the draft clears and the pane's submit action runs.
        await Promise.resolve();
        window.submittedAt = Date.now();
        setDraft('');
        return composerSubmit(text, { id: 'sent-1', submittedAt: window.submittedAt });
      };
    });
    const pendingItems = pendingPromptTranscriptItems(optimisticPrompts, settledItems);
    const settled = projectSettledTranscriptRows({
      sessionKey: SESSION, items: settledItems, turnKeys: transcriptTurnKeys(settledItems), failedTurns: new Set(),
    });
    const rows = appendLiveTranscriptRows({
      sessionKey: SESSION, settled, pendingItems, liveItem: null,
      thinking: busy || pendingItems.length > 0, turnRunning: busy,
    });
    return <section className="conversation">
      <div className="transcript-shell">
        <div className="transcript" ref={viewport} onScroll={follow.handleScroll} onWheel={follow.handleWheel}
          onPointerDown={follow.handlePointerDown} onPointerMove={follow.handlePointerMove}
          onPointerUp={follow.handlePointerUp} onPointerCancel={follow.handlePointerUp}>
          <div className="thread">
            <TranscriptList sessionKey={SESSION} rows={rows} viewport={viewport} content={content}
              shouldAnchorBottom={follow.following}
              scrollToEndRef={scrollToEndRef} setAnchorBottomRef={setAnchorBottomRef}
              markProgrammaticScroll={follow.markProgrammaticScroll} hasScrollGesture={follow.hasScrollGesture}
              hasTouchScroll={follow.holdsScrollCorrections} touchHoldsCorrections={follow.touchHoldsCorrections}
              onSelectionAutoScroll={follow.handleSelectionAutoScroll} renderRow={renderRow} />
          </div>
        </div>
      </div>
      <ComposerDock sessionId={SESSION} goalSubmissionId="" showProjectSelector={false}
        goalIsland={null} approval={null} quotaCard={null}
        reviewItems={empty} reviewActive reviewBusy={false} reviewSessionId={SESSION} reviewCwd="C:/fixture">
        <div className="composer-context-line" />
        <form className="composer" data-card="" onSubmit={(event) => event.preventDefault()}>
          <div className="composer-input-row"><div className="composer-text-field">
            <textarea aria-label="Composer" rows={1} placeholder="Message" value={draft} onChange={(event) => setDraft(event.target.value)} />
          </div></div>
          <div className="composer-footer"><button type="submit" className="send-button">Send</button></div>
        </form>
      </ComposerDock>
    </section>;
  }
  window.mountFixture = () => root.render(<Harness />);

  const rect = (element) => {
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, height: box.height };
  };
  // Every painted frame: where the sent bubble, the last history row, the
  // composer and its field sit, and how far the transcript is from its end.
  window.sampleFrames = (frames, key) => new Promise((resolve) => {
    const out = [];
    const step = () => {
      const view = document.querySelector('.transcript');
      out.push({
        t: performance.now(),
        row: rect(document.querySelector('[data-timeline-key="' + key + '"]')),
        status: rect(document.querySelector('.live-activity-status')),
        last: rect(document.querySelector('[data-timeline-key="fixture:h15"]')),
        field: rect(document.querySelector('.composer textarea')),
        composer: rect(document.querySelector('form.composer')),
        gap: view.scrollHeight - view.clientHeight - view.scrollTop,
      });
      if (out.length >= frames) resolve(out);
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
`;

async function openPage(browser, bundle, styles, { phone }) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.stack.split('\n').slice(0, 4).join(' <- ')));
  if (phone) {
    await page.setUserAgent(PHONE_UA);
    await page.setViewport({ width: 412, height: 800, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  } else {
    await page.setViewport({ width: 1100, height: 800 });
  }
  await page.setContent(
    `<!doctype html><html ${phone ? 'data-mixdog-mobile-tabs' : ''}><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div class="app-shell"><div class="desktop-body"><main class="workspace"><div id="root" style="display:contents"></div></main></div></div></body></html>`
  );
  await page.addStyleTag({ content: styles.outputFiles[0].text });
  await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });
  await page.evaluate(() => window.mountFixture());
  await page.waitForSelector('[data-timeline-key="fixture:h15"]');
  await new Promise((resolve) => setTimeout(resolve, 600));
  return { page, errors };
}

for (const surface of ['phone', 'desktop']) {
  test(`${surface}: the sent bubble, the composer and the history move together in one frame`, async (t) => {
    const [bundle, styles] = await Promise.all([
      build({
        stdin: { resolveDir, loader: 'tsx', contents: HARNESS },
        outfile: 'transcript-send-stability.js',
        bundle: true,
        write: false,
        format: 'iife',
        jsx: 'automatic',
        define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': '"http://localhost/renderer/"' },
        loader,
        plugins: [
          {
            name: 'worker-stub',
            setup(builder) {
              // The editor and markdown workers are not part of a sent bubble.
              builder.onResolve({ filter: /\?worker$/ }, (args) => ({ path: args.path, namespace: 'worker-stub' }));
              builder.onLoad({ filter: /.*/, namespace: 'worker-stub' }, () => ({
                contents: 'export default class {};',
                loader: 'js',
              }));
            },
          },
        ],
      }),
      build({
        stdin: {
          resolveDir,
          loader: 'css',
          contents:
            '@import "./font-faces.css"; @import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css"; @import "./mobile-web-runtime.css";',
        },
        outfile: 'transcript-send-stability.css',
        bundle: true,
        write: false,
        loader,
      }),
    ]);
    const browser = await puppeteer.launch({
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
      headless: true,
    });
    t.after(() => browser.close());
    const { page, errors } = await openPage(browser, bundle, styles, { phone: surface === 'phone' });
    // A phone's slow render of the new row: long enough that a deferred row
    // would land several frames after the tap's own commit.
    await page.evaluate(() => {
      window.rowCost = 60;
    });
    const before = await page.evaluate(async () => (await window.sampleFrames(2, 'fixture:sent-1')).at(-1));
    const frames = await page.evaluate(async () => {
      const sampling = window.sampleFrames(60, 'fixture:sent-1');
      window.sendPrompt('hello from the phone');
      return sampling;
    });
    assert.deepEqual(errors, []);

    const landed = frames.findIndex((frame) => frame.row);
    assert.ok(landed >= 0, 'the sent bubble reaches the screen');
    const shrunk = frames.findIndex((frame) => frame.composer.height < before.composer.height - 1);
    assert.ok(shrunk >= 0, 'the composer card clears and shrinks');
    // The heart of it: the composer never shrinks without the bubble.
    assert.equal(shrunk, landed, 'the composer shrinks in the very frame the bubble lands');

    // The same frame carries the final layout: from there nothing moves, not
    // the bubble, the history above it, nor the composer, through the host's
    // acknowledgement and the durable row replacing the optimistic one.
    const resting = frames[landed];
    for (const [index, frame] of frames.slice(landed).entries()) {
      for (const part of ['row', 'last', 'composer']) {
        assert.ok(
          Math.abs(frame[part].top - resting[part].top) <= 1,
          `${surface}: ${part} moved ${frame[part].top - resting[part].top}px at frame ${landed + index}`
        );
      }
      assert.ok(Math.abs(frame.gap) <= 1, `${surface}: the transcript stays at its end (${frame.gap})`);
    }
    // The bubble rests just above the working band, that above the composer.
    assert.ok(resting.row.bottom <= resting.status.top + 1, 'the bubble sits above the working band');
    assert.ok(resting.status.bottom <= resting.composer.top, 'the working band sits above the composer');
  });
}
