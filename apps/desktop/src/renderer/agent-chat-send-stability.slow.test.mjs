import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const resolveDir = fileURLToPath(new URL('.', import.meta.url));
const loader = { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' };

const HARNESS = `
  import { useLayoutEffect, useRef, useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { TranscriptList } from './TranscriptList';
  import { TranscriptRow } from './transcript-row';
  import { AgentChatRow, AgentTypingRow } from './agent-chat-row';
  import { agentChatPlace } from './agent-chat-place';
  import { useTranscriptFollow } from './use-transcript-follow';
  import { appendLiveTranscriptRows, projectSettledTranscriptRows } from './transcript-rows';
  import { transcriptTurnKeys } from './renderer-logic.mjs';
  import { useConversationSteering } from './use-conversation-steering';
  import { useConversationComposerActions } from './conversation-support';
  import { useConversationOptimisticPromptRelease } from './use-conversation-optimistic-prompts';
  import { defaultAgentAvatar } from '../shared/core-src/runtime/shared/agent-avatar.mjs';

  const SESSION = 'sess_home_fixture';
  const BOT = { id: 'fixture', name: 'Fixture', avatar: defaultAgentAvatar('fixture') };
  // The earlier exchange was yesterday: today's first message opens a day.
  const yesterday = Date.now() - 86_400_000;
  const body = (n) => 'Reply paragraph ' + n + ' with enough words to wrap across a few lines of the chat column, so rows have real, uneven heights.';
  const history = Array.from({ length: 12 }, (_, index) => index % 2
    ? { kind: 'assistant', id: 'h' + index, at: yesterday + index * 1000, text: body(index) + '\\n\\n' + body(index + 100) }
    : { kind: 'user', id: 'h' + index, at: yesterday + index * 1000, text: 'Earlier message ' + index });
  // 'queued': the bot is still answering a message sent seconds ago when the
  // next one is sent; it waits behind that turn.
  const queuedScenario = window.SCENARIO === 'queued';
  const running = { kind: 'user', id: 'running', at: Date.now() - 2000, text: 'The message the bot is answering' };
  const initial = queuedScenario ? [...history, running] : history;
  const root = createRoot(document.getElementById('root'));
  const promoted = { current: false };

  function renderRow(row, index, rows) {
    if (row._tag === 'TurnGap') return <div className="transcript-turn-gap" aria-hidden="true" />;
    if (row._tag === 'Thinking') return <AgentTypingRow member={BOT} lead />;
    const place = agentChatPlace(rows, index);
    return <AgentChatRow place={place} member={place?.side === 'agent' ? BOT : null}>
      <TranscriptRow item={row.item} disclosureScope={SESSION} attachedUser={row.attachedUser} />
    </AgentChatRow>;
  }
  function Harness() {
    const [settledItems, setSettledItems] = useState(initial);
    const [optimisticPrompts, setOptimisticPrompts] = useState([]);
    const [busy, setBusy] = useState(queuedScenario);
    const [queued, setQueued] = useState([]);
    const viewport = useRef(null), content = useRef(null);
    const scrollToEndRef = useRef(() => {}), setAnchorBottomRef = useRef(() => {});
    const follow = useTranscriptFollow({ viewport, content, sessionKey: SESSION, scrollToEndRef, setAnchorBottomRef });
    const armRef = useRef(follow.arm);
    armRef.current = follow.arm;
    const armFollowOnSubmitRef = useRef({ current: () => armRef.current() }).current;
    // The core. Idle: publishes the durable row, stamped with its own receipt
    // time, with the turn's start. Queued: publishes the queue entry, the
    // running turn's reply, then the drained row.
    const hostRef = useRef({
      invokeResult: (action) => action(),
      submit: async (content, options) => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        const durable = () => ({ kind: 'user', id: options.id, at: Date.now(), text: String(content) });
        if (!queuedScenario) {
          // The row and the turn's start are one state.
          setTimeout(() => {
            setBusy(true);
            setSettledItems((items) => [...items, durable()]);
          }, 200);
          return true;
        }
        setQueued([{ id: options.id, text: String(content), submittedAt: Date.now() }]);
        setTimeout(() => {
          setSettledItems((items) => [...items, { kind: 'assistant', id: 'reply', at: Date.now(), text: body(1) }]);
          setTimeout(() => {
            setQueued([]);
            setSettledItems((items) => [...items, durable()]);
          }, 200);
        }, 300);
        return true;
      },
    });
    const refs = useRef({
      draftMode: { current: false }, goal: { current: null }, scope: { current: SESSION },
      queued: { current: queuedScenario }, route: { current: SESSION },
      suppress: { current: false },
    }).current;
    const { composerSubmit } = useConversationComposerActions({
      armFollowOnSubmitRef,
      composerActions: hostRef, draftModeRef: refs.draftMode, goalSubmission: refs.goal, goalSubmitScopeRef: refs.scope,
      queuedBehindTurnAtSubmit: refs.queued, routeSessionIdRef: refs.route, setOptimisticPrompts,
      suppressDraftSubmitPaintHandoff: refs.suppress,
    });
    useConversationOptimisticPromptRelease({
      transcriptSessionKey: SESSION, promotedOwnDraft: promoted, settledItems, optimisticPrompts, queued,
      setOptimisticPrompts,
    });
    useLayoutEffect(() => {
      window.sendPrompt = (text) => composerSubmit(text, { id: 'sent-1', submittedAt: Date.now() });
    });
    const { steerItems, transcriptPendingPromptItems: pendingItems } =
      useConversationSteering(optimisticPrompts, settledItems, queued);
    const settled = projectSettledTranscriptRows({
      sessionKey: SESSION, items: settledItems, turnKeys: transcriptTurnKeys(settledItems), failedTurns: new Set(),
    });
    const rows = appendLiveTranscriptRows({
      sessionKey: SESSION, settled, pendingItems, steerItems, liveItem: null,
      thinking: busy || pendingItems.length > 0, turnRunning: busy,
    });
    return <section className="conversation" data-chat-mode="agent">
      <div className="transcript-shell">
        <div className="transcript" ref={viewport} onScroll={follow.handleScroll} onWheel={follow.handleWheel}>
          <div className="thread">
            <TranscriptList sessionKey={SESSION} rows={rows} viewport={viewport} content={content}
              shouldAnchorBottom={follow.following}
              scrollToEndRef={scrollToEndRef} setAnchorBottomRef={setAnchorBottomRef}
              markProgrammaticScroll={follow.markProgrammaticScroll} hasScrollGesture={follow.hasScrollGesture}
              hasTouchScroll={follow.holdsScrollCorrections} touchHoldsCorrections={follow.touchHoldsCorrections}
              onSelectionAutoScroll={follow.handleSelectionAutoScroll} renderRow={renderRow} surface="agent" />
          </div>
        </div>
      </div>
    </section>;
  }
  window.mountFixture = () => root.render(<Harness />);

  const rect = (element) => {
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { top: box.top, height: box.height };
  };
  // Every painted frame: the sent row, the last history row and the
  // transcript's distance from its end.
  window.sampleFrames = (frames) => new Promise((resolve) => {
    const out = [];
    const step = () => {
      const view = document.querySelector('.transcript');
      const sent = document.querySelector('[data-timeline-key="' + SESSION + ':sent-1"]');
      out.push({
        row: rect(sent),
        rowTimed: Boolean(sent && sent.querySelector('.mx-chat-time')),
        last: rect(document.querySelector('[data-timeline-key="' + SESSION + ':h11"]')),
        earlierTimed: Boolean(document.querySelector('[data-timeline-key="' + SESSION + ':running"] .mx-chat-time')),
        gap: view.scrollHeight - view.clientHeight - view.scrollTop,
      });
      if (out.length >= frames) resolve(out);
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
`;

let built = null;
const buildFixture = () =>
  (built ??= Promise.all([
    build({
      stdin: { resolveDir, loader: 'tsx', contents: HARNESS },
      outfile: 'agent-chat-send-stability.js',
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
          '@import "./font-faces.css"; @import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css";',
      },
      outfile: 'agent-chat-send-stability.css',
      bundle: true,
      write: false,
      loader,
    }),
  ]));

/** Mounts the fixture for `scenario` in real Chrome and samples every
 *  painted frame across one send. */
async function sendFrames(t, scenario) {
  const [bundle, styles] = await buildFixture();
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.stack.split('\n').slice(0, 4).join(' <- ')));
  await page.setViewport({ width: 1100, height: 700 });
  await page.setContent(
    '<!doctype html><html><head></head><body><div class="app-shell"><div class="desktop-body"><main class="workspace"><div id="root" style="display:contents"></div></main></div></div></body></html>'
  );
  await page.addStyleTag({ content: styles.outputFiles[0].text });
  // The chat rows' own stylesheet (agent-chat.css) comes with their module.
  const chatCss = bundle.outputFiles.find((file) => file.path.endsWith('.css'));
  if (chatCss) await page.addStyleTag({ content: chatCss.text });
  await page.evaluate((name) => {
    window.SCENARIO = name;
  }, scenario);
  await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });
  await page.evaluate(() => window.mountFixture());
  await page.waitForSelector('[data-timeline-key="sess_home_fixture:h11"]', { timeout: 10_000 }).catch((error) => {
    throw new Error(errors.join('\n') || error.message);
  });
  await new Promise((resolve) => setTimeout(resolve, 600));

  const frames = await page.evaluate(async () => {
    const sampling = window.sampleFrames(90);
    window.sendPrompt('hello bot');
    return sampling;
  });
  assert.deepEqual(errors, []);
  return frames;
}

test('bot chat: the sent bubble lands at its final height; the durable row moves nothing', async (t) => {
  const frames = await sendFrames(t, 'idle');
  const landed = frames.findIndex((frame) => frame.row);
  assert.ok(landed >= 0, 'the sent bubble reaches the screen');
  // From the landing frame on nothing moves: not the bubble's height, not the
  // history above it, through the acknowledgement and the durable row's arrival.
  const resting = frames[landed];
  for (const [index, frame] of frames.slice(landed).entries()) {
    assert.ok(
      Math.abs(frame.row.height - resting.row.height) <= 1,
      `the sent row changed height by ${frame.row.height - resting.row.height}px at frame ${landed + index}`
    );
    assert.ok(
      Math.abs(frame.last.top - resting.last.top) <= 1,
      `the history moved ${frame.last.top - resting.last.top}px at frame ${landed + index}`
    );
    assert.ok(Math.abs(frame.gap) <= 1, `the chat stays at its end (${frame.gap})`);
  }
});

test('bot chat: a message queued behind the running turn leaves the bubble before it as it is', async (t) => {
  const frames = await sendFrames(t, 'queued');
  const landed = frames.findIndex((frame) => frame.row);
  assert.ok(landed >= 0, 'the queued bubble reaches the screen');
  // The bubble the bot is answering keeps its time line through the send, the
  // reply landing under it and the queued message's durable row; the queued
  // bubble carries its own from its first frame, as its durable row will.
  for (const [index, frame] of frames.entries()) {
    assert.ok(frame.earlierTimed, `the earlier bubble lost its time line at frame ${index}`);
    if (index >= landed) assert.ok(frame.rowTimed, `the queued bubble has no time line at frame ${index}`);
    assert.ok(Math.abs(frame.gap) <= 1, `the chat stays at its end (${frame.gap})`);
  }
});
