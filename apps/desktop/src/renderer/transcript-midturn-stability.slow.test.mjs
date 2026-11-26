// What the user sees while a turn runs and things happen in the middle of it: every case is a run of states the pane
// renders in a real browser, sampled every frame from the event until it settles. In every frame the rows already on
// screen keep their place: pinned to the bottom, the bottom stays pinned and the rows above move as one; scrolled up, the
// row the user reads stays where it is. No row is drawn twice, changes place, or leaves and comes back.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { launchPuppeteerBrowser } from '../../../../src/runtime/shared/browser-launch.mjs';

const HARNESS = `
  import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
  import { createRoot } from 'react-dom/client';
  import { flushSync } from 'react-dom';
  import { TurnCardsWithheldContext, TurnChangesContext, TurnRowsContext } from './TurnChangesCard';
  import { TranscriptList } from './TranscriptList';
  import { resetTurnChangesCache } from './turn-changes-model';
  import { resetTurnPreviews, runningTurnKeyOf } from './turn-preview-model';
  import { trailingTurnRuns, useConversationLinkSurfaces } from './use-conversation-link-surfaces';
  import { useConversationRowRenderer } from './use-conversation-row-renderer';
  import { useTranscriptRows } from './use-conversation-rows';
  import { useTranscriptFollow } from './use-transcript-follow';
  import { useTranscriptReveal } from './use-transcript-reveal';
  import { QuestionCard } from './QuestionCard';
  import { approvalQuestions } from './question-card-logic';
  import { SteerContext } from './steer-actions';

  const control = { sealed: true };
  // The pane's steer actions (steer-actions.ts): the line under a queued message draws its controls.
  const steer = { actions: { sendNow() {}, cancel() {}, retry() {} }, draft: { current: null }, canSendNow: true };
  window.mixdogDesktop = {
    invokeCapability: async (request) => {
      if (request.capability !== 'getTurnChanges') return { value: null };
      const checkpointId = request.args[0].checkpointId;
      const file = { path: 'src/a.ts', status: 'M', additions: 2, deletions: 1, state: 'applied', revertable: true };
      return { value: { status: control.sealed ? 'ready' : 'pending', checkpointId, revision: 1, root: 'C:/Project/app',
        files: control.sealed ? [file] : [], canUndo: true, canReapply: false } };
    },
  };
  const noop = () => {};
  let state = { items: [], busy: false };
  const listeners = new Set();
  const store = {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    get: () => state,
  };
  const root = createRoot(document.getElementById('root'));
  // The pane's reveal signal: the visit a mount began is shown once the pane's own reveal says so.
  let visit = { shown: false, signal() {} };
  // The mounted pane's follow state (use-transcript-follow.ts).
  const pane = { follow: null };
  const beginVisit = () => {
    visit = { shown: false, signal() { this.shown = true; } };
    return visit;
  };

  function Shell({ sessionId }) {
    const props = useSyncExternalStore(store.subscribe, store.get);
    const { items, busy, liveItem = null, steerItems = [], activityAt = 0, failedTurnKeys = [], approval = null } = props;
    // What the core publishes of the running work: the turn's (spinner) and a command's (commandStatus).
    const { spinner = null, commandStatus = null, commandBusy = false } = props;
    // A waiting question is the live card the pane builds from the pending approval (use-conversation-approvals.tsx).
    const questions = approval?.kind === 'question' ? approvalQuestions(approval.args) : null;
    const draftsRef = useRef([]);
    const questionCard = questions
      ? <QuestionCard key={approval.id} questions={questions} resolve={async () => true} draftsRef={draftsRef} agentMode={false} />
      : null;
    const viewport = useRef(null), content = useRef(null);
    const scrollToEndRef = useRef(noop), setAnchorBottomRef = useRef(noop);
    const follow = useTranscriptFollow({ viewport, content, sessionKey: sessionId, scrollToEndRef, setAnchorBottomRef });
    pane.follow = follow;
    const { transcriptRows, settledTurnKeys, turnPastEnd, pastLastEnd, trailingCheckpointShown } = useTranscriptRows({
      identity: sessionId, sessionKey: sessionId, settledItems: items, settledRowItems: items, failedTurnKeys,
      precomputedTurnKeys: null, pendingItems: [], steerItems, liveItem, busy, commandBusy,
      commandActivityVisible: activityAt > 0, commandActivityStartedAt: activityAt, optimisticActivityStartedAt: 0,
    });
    const links = useConversationLinkSurfaces({}, {
      turnChangesSessionId: sessionId, turnChangesBusy: busy,
      turnChangesRunning: trailingTurnRuns(busy, 0, pastLastEnd),
      trailingCheckpointShown,
      runningTurnKey: trailingTurnRuns(busy, 0, turnPastEnd)
        ? runningTurnKeyOf(items, settledTurnKeys, settledTurnKeys.at(-1) ?? '') : '',
    });
    const { renderTranscriptRow } = useConversationRowRenderer({
      snapshot: { sessionId, busy, commandBusy, toolApproval: approval, spinner, commandStatus }, disclosureScope: sessionId, readOnly: false,
      transitioning: false, onOpenSettings: noop, settledItems: items, settledTurnKeys, optimisticActivityStartedAt: 0,
      submit: async () => true, questionCard, agentMode: false,
    });
    const renderRow = (row, index, rows) => renderTranscriptRow(row, index, rows);
    // As the pane does (use-conversation-timeline.ts): a visit stays hidden until its rows read back steady.
    const revealed = useTranscriptReveal({
      identity: sessionId, enabled: transcriptRows.length > 0, draft: false, viewport, content,
      hasScrollGesture: follow.hasScrollGesture, pinned: follow.following,
    });
    useLayoutEffect(() => { if (revealed) visit.signal(); }, [revealed]);
    // The pane's row contexts (conversation-pane-transcript.tsx): a card reads its turn's records and the view's
    // withheld cards, one set per session shown.
    const shownRows = useRef(transcriptRows);
    shownRows.current = transcriptRows;
    const rowsOf = useCallback(() => shownRows.current, []);
    const withheldCards = useMemo(() => new Set(), [sessionId]);
    // The pane marks an entry still covered (Conversation.tsx) and the follow state (conversation-pane-transcript.tsx):
    // a card's read decides from them whether it would move rows a reader sees.
    return <SteerContext.Provider value={steer}><TurnChangesContext.Provider value={links.turnChangesSurface}>
      <TurnRowsContext.Provider value={rowsOf}><TurnCardsWithheldContext.Provider value={withheldCards}>
      <section className="conversation" data-transcript-entering={revealed ? undefined : 'true'}><div className="transcript-shell">
        <div className="transcript" ref={viewport} role="log" onScroll={follow.handleScroll}
          style={revealed ? undefined : { visibility: 'hidden' }} data-following={follow.following ? 'true' : 'false'}
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
      </div></section>
      </TurnCardsWithheldContext.Provider></TurnRowsContext.Provider>
    </TurnChangesContext.Provider></SteerContext.Provider>;
  }

  const sample = () => {
    const view = document.querySelector('.transcript');
    const box = view.getBoundingClientRect();
    return {
      t: performance.now(),
      // A hidden frame paints nothing the user sees.
      hidden: view.style.visibility === 'hidden',
      gap: view.scrollHeight - view.clientHeight - view.scrollTop,
      viewTop: box.top,
      viewBottom: box.bottom,
      // The room between the last row and the bottom of the pane.
      under: box.bottom - Math.max(...[...document.querySelectorAll('[data-timeline-key]')].map((node) => node.getBoundingClientRect().bottom)),
      // The rows on screen: the list parks the far ones, which no user sees leave.
      rows: [...document.querySelectorAll('[data-timeline-key]')].flatMap((node) => {
        const r = node.getBoundingClientRect();
        if (r.bottom <= box.top || r.top >= box.bottom) return [];
        return [{ key: node.getAttribute('data-timeline-key'), top: r.top, height: r.height,
          tag: node.firstElementChild?.getAttribute('data-tag') || 'TurnGap',
          // A turn's end drawn as the footer of a reply.
          footer: Boolean(node.querySelector('.response-footer .turn-status, .response-footer-trailing .turn-status')),
          text: (node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80) }];
      }),
    };
  };
  // What a frame paints: read after the frame's layout and the list's own resize handling (an observer made in the frame
  // runs after the list's), not at its start, before a row that changed was measured.
  const probe = document.createElement('div');
  document.body.appendChild(probe);
  const painted = () => new Promise((resolve) => {
    requestAnimationFrame(() => {
      const observer = new ResizeObserver(() => { observer.disconnect(); resolve(sample()); });
      observer.observe(probe);
    });
  });
  const frames = async (count) => {
    const out = [];
    while (out.length < count) out.push(await painted());
    return out;
  };

  // Every frame painted from the mount until the pane reveals the visit, then the first frames it shows.
  const untilShown = async (shownVisit, watch) => {
    const out = [];
    while (!shownVisit.shown) out.push(await painted());
    return [...out, ...(await frames(watch))];
  };
  let mounted = 0;
  window.fixture = {
    mount(next) {
      resetTurnChangesCache();
      resetTurnPreviews();
      state = next;
      mounted += 1;
      const shownVisit = beginVisit();
      flushSync(() => root.render(<Shell key={'s1:' + mounted} sessionId="s1" />));
      return untilShown(shownVisit, 2);
    },
    // Hides the pane and shows it again over the same state (a session switch away and back).
    remount(next) {
      flushSync(() => root.render(<div />));
      state = next;
      mounted += 1;
      const shownVisit = beginVisit();
      flushSync(() => root.render(<Shell key={'s1:' + mounted} sessionId="s1" />));
      return untilShown(shownVisit, 24);
    },
    async step(next, count = 24) {
      if ('sealed' in next) control.sealed = next.sealed;
      state = next;
      for (const listener of listeners) listener();
      return frames(count);
    },
    // The reader left the end and the scroll that took them there is over, as the pane's follow state says.
    async reading() {
      while (pane.follow.following || pane.follow.hasScrollGesture()) await painted();
      return painted();
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
      outfile: 'transcript-midturn-stability.js',
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
          '@import "./font-faces.css"; @import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css"; @import "./mobile-web-runtime.css";',
      },
      outfile: 'transcript-midturn-stability.css',
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
async function openPage(t, { phone = false, touch = false } = {}) {
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
  // The phone client marks its surface (mobile-surface.ts): its controls take 44px touch boxes.
  if (phone) await page.setViewport({ width: 412, height: 800, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  // A desktop window whose primary pointer is coarse (a touch screen): the desktop layout with 44px tap targets.
  else if (touch)
    await page.setViewport({ width: 900, height: 700, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  else await page.setViewport({ width: 900, height: 700 });
  await page.setContent(
    `<!doctype html><html ${phone ? 'data-mixdog-mobile-tabs' : ''}><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>`
  );
  await page.addStyleTag({ content: assets.css });
  await page.addStyleTag({ content: '#root { position: fixed; inset: 0; display: flex; container-type: size; }' });
  await page.addScriptTag({ content: assets.script });
  return { page, errors };
}
test.after(async () => {
  if (shared) await (await shared).browser.close();
});

// ---- the conversation

const body = (n) =>
  `Reply paragraph ${n} with enough words to wrap across a couple of lines, so the rows above have real, uneven heights.`;
const history = Array.from({ length: 10 }, (_, index) =>
  index % 2
    ? { kind: 'assistant', id: `h${index}`, text: `${body(index)}\n\n${body(index + 100)}`, at: 100 + index }
    : { kind: 'user', id: `h${index}`, text: `Earlier prompt ${index}`, at: 100 + index }
);
const historyEnd = {
  kind: 'turndone',
  id: 'h-end',
  status: 'done',
  verb: 'Thought',
  checkpointId: 'h8',
  finalAssistantId: 'h9',
  elapsedMs: 20_000,
  at: 120,
};
const base = [...history, historyEnd];
const prompt = { kind: 'user', id: 'u1', text: 'Change the files', checkpointId: 'cp', at: 1_000 };
const words = (count) => Array.from({ length: count }, (_, at) => `word${at}`).join(' ');
const streaming = (count) => ({ kind: 'assistant', id: 'a1', text: words(count), streaming: true, at: 1_100 });
const settledReply = (count) => ({ kind: 'assistant', id: 'a1', text: words(count), at: 1_100 });
const tool = (id, status = 'done') => ({
  kind: 'tool',
  id,
  callId: id,
  name: 'read',
  args: { path: `src/${id}.ts` },
  at: 1_200,
  ...(status === 'done' ? { result: 'ok' } : { status: 'running' }),
});
const patch = { kind: 'tool', id: 'p1', callId: 'p1', name: 'apply_patch', args: { path: 'src/a.ts' }, result: 'ok' };
const queued = (id, text) => ({
  id,
  kind: 'user',
  text,
  pending: true,
  accepted: true,
  submittedAt: 1_500,
  at: 1_500,
  queuedBehindTurn: true,
  steer: 'pending',
  queueEntry: { id, text },
});
const steered = (id, text) => ({ kind: 'user', id, text, steered: true, at: 1_600 });
const end = (extra = {}) => ({
  kind: 'turndone',
  id: 'end',
  status: 'done',
  verb: 'Thought',
  checkpointId: 'cp',
  elapsedMs: 40_000,
  at: 2_000,
  ...extra,
});
const running = (items, extra = {}) => ({
  items: [...base, prompt, ...items],
  busy: true,
  activityAt: 1_000,
  ...extra,
});
const idle = (items, extra = {}) => ({ items: [...base, prompt, ...items], busy: false, ...extra });

// ---- what a frame may and may not do

/** The rows two samples share, in order, with how far each moved and whether its height changed. */
function moves(before, after) {
  const was = new Map(before.rows.map((row) => [row.key, row]));
  return after.rows.map((row) => {
    const old = was.get(row.key);
    return old
      ? { key: row.key, dy: row.top - old.top, grew: Math.abs(row.height - old.height) > 1 }
      : { key: row.key };
  });
}

/** The keys of every sample: each once, in an order no sample breaks, and a row that left never comes back. */
function assertRows(samples, label) {
  for (const [at, sample] of samples.entries()) {
    const keys = sample.rows.map((row) => row.key);
    assert.equal(new Set(keys).size, keys.length, `${label} frame ${at}: a row is drawn twice: ${keys.join(', ')}`);
  }
  for (let at = 1; at < samples.length; at += 1) {
    const before = samples[at - 1].rows.map((row) => row.key);
    const now = samples[at].rows.map((row) => row.key);
    assert.deepEqual(
      now.filter((key) => before.includes(key)),
      before.filter((key) => now.includes(key)),
      `${label} frame ${at}: rows changed places`
    );
    const rise = Math.min(
      0,
      ...moves(samples[at - 1], samples[at]).flatMap((row) => (row.dy === undefined ? [] : [row.dy]))
    );
    for (const row of samples[at - 1].rows) {
      if (now.includes(row.key)) continue;
      // Pushed up out of view by what came in below: it left the screen, not the transcript.
      if (row.top + row.height + rise <= samples[at].viewTop + 1) continue;
      const back = samples.slice(at + 1).some((sample) => sample.rows.some((later) => later.key === row.key));
      assert.ok(!back, `${label} frame ${at}: row ${row.key} leaves and comes back`);
    }
  }
}

const placed = (sample) =>
  sample.rows.map((row) => `${row.key}@${row.top.toFixed(0)}/${row.height.toFixed(0)}`).join(' ');

/** Pinned, the one rule: in every frame the last row ends `under` above the pane's bottom (the room it has at rest: no
 *  band is ever left under the rows) and the rows stand edge to edge. So a row whose size changed, came or left moves the
 *  rows above it in that frame, as one, by exactly that change, and a frame where nothing changed moves nothing. */
function assertPinned(samples, label, under) {
  for (const [at, sample] of samples.entries()) {
    assert.ok(Math.abs(sample.gap) <= 1, `${label} frame ${at}: the bottom is not pinned (${sample.gap}px)`);
    assert.ok(
      Math.abs(sample.under - under) <= 1,
      `${label} frame ${at}: the last row ends ${(sample.under - under).toFixed(1)}px above its place at the bottom: ${placed(sample)}`
    );
    for (let row = 1; row < sample.rows.length; row += 1) {
      const above = sample.rows[row - 1];
      const apart = sample.rows[row].top - (above.top + above.height);
      assert.ok(
        Math.abs(apart) <= 1,
        `${label} frame ${at}: ${sample.rows[row].key} stands ${apart.toFixed(1)}px off the row above it: ${placed(sample)}`
      );
    }
  }
  for (let at = 1; at < samples.length; at += 1) {
    const before = samples[at - 1];
    const now = samples[at];
    const all = moves(before, now);
    const shared = all.filter((row) => row.dy !== undefined);
    if (shared.length === 0) continue;
    // A row coming into or leaving view at the top edge (before every row both frames show) is no change of the content.
    const firstShared = all.findIndex((row) => row.dy !== undefined);
    const firstBefore = before.rows.findIndex((row) => row.key === shared[0].key);
    const kept = new Set(now.rows.map((row) => row.key));
    const changed =
      all.some((row, index) => (row.dy === undefined && index > firstShared) || row.grew) ||
      before.rows.some((row, index) => index > firstBefore && !kept.has(row.key));
    if (changed) continue;
    const moved = shared.filter((row) => Math.abs(row.dy) > 1);
    assert.ok(
      moved.length === 0,
      `${label} frame ${at}: rows move with no row changed (${moved.map((row) => `${row.key}${row.dy > 0 ? '+' : ''}${row.dy.toFixed(1)}`).join(' ')}); before: ${placed(before)}; after: ${placed(now)}`
    );
  }
}

/** A row took another's place in the same role (the end row for the band, a sent message for its queued bubble): every
 *  row shown before stands where it stood, in every frame. */
function assertStill(before, samples, label) {
  for (const [at, sample] of samples.entries()) {
    const moved = moves(before, sample).filter((row) => row.dy !== undefined && Math.abs(row.dy) > 1);
    assert.ok(
      moved.length === 0,
      `${label} frame ${at}: a replacement moves rows (${moved.map((row) => `${row.key}${row.dy > 0 ? '+' : ''}${row.dy.toFixed(1)}`).join(' ')}); before: ${placed(before)}; after: ${placed(sample)}`
    );
  }
}

/** While a turn runs: its working band is drawn, and no reply under the last prompt carries a turn's end as its footer. */
function assertRunning(samples, label) {
  for (const [at, sample] of samples.entries()) {
    assert.equal(
      sample.rows.at(-1)?.tag,
      'Thinking',
      `${label} frame ${at}: the working band is not the last row: ${placed(sample)}`
    );
    const prompt = sample.rows.findLastIndex((row) => row.tag === 'UserMessage');
    const closed = sample.rows.filter((row, index) => index > prompt && row.footer);
    assert.deepEqual(
      closed.map((row) => row.key),
      [],
      `${label} frame ${at}: a reply carries an end footer while its turn runs`
    );
  }
}

/** The working band is one row through the frames: one key, and one height wherever it stands under the turn's output. */
function assertOneBand(samples, label) {
  const bands = samples.flatMap((sample, at) => {
    const index = sample.rows.findIndex((row) => row.tag === 'Thinking');
    return index < 0 ? [] : [{ at, row: sample.rows[index], above: sample.rows[index - 1]?.tag }];
  });
  assert.ok(bands.length > 0, `${label}: a working band is drawn`);
  const keys = [...new Set(bands.map((band) => band.row.key))];
  assert.deepEqual(keys, [keys[0]], `${label}: the working band changes identity`);
  const seated = bands.filter((band) => band.above === 'AssistantPart' || band.above === 'ToolActivity');
  const heights = [...new Set(seated.map((band) => Math.round(band.row.height)))];
  assert.deepEqual(heights, heights.slice(0, 1), `${label}: the working band changes height under the turn's output`);
}

/** Scrolled up: the row the user reads, and every row in view above it, keeps its viewport offset in every frame. */
function assertAnchored(before, samples, anchor, label) {
  const above = before.rows.filter((row) => row.top <= anchor.top);
  for (const [at, sample] of samples.entries()) {
    const row = sample.rows.find((candidate) => candidate.key === anchor.key);
    assert.ok(row, `${label} frame ${at}: the row read (${anchor.key}) is gone`);
    for (const was of above) {
      const now = sample.rows.find((candidate) => candidate.key === was.key);
      assert.ok(now, `${label} frame ${at}: ${was.key}, in view above the row read, is gone`);
      assert.ok(
        Math.abs(now.top - was.top) <= 1,
        `${label} frame ${at}: ${was.key}, in view, moved ${(now.top - was.top).toFixed(1)}px`
      );
    }
  }
}

/** Plays `states` from `start` pinned to the bottom, then again scrolled up, and checks every frame. */
async function playCase(
  t,
  start,
  states,
  { remountAt = -1, phone = false, touch = false, band = false, frames = null } = {}
) {
  for (const mode of ['pinned', 'scrolled']) {
    const { page, errors } = await openPage(t, { phone, touch });
    const mounted = await page.evaluate((s) => window.fixture.mount(s), start);
    let anchor = null;
    if (mode === 'scrolled') {
      await page.mouse.move(phone ? 200 : 450, 300);
      await page.mouse.wheel({ deltaY: -260 });
      const now = await page.evaluate(() => window.fixture.reading());
      anchor = now.rows.find((row) => row.top >= now.viewTop + 40 && row.top < now.viewBottom - 200);
      assert.ok(anchor, 'a row to read once scrolled up');
    }
    assert.ok(!mounted.at(-1).hidden, `${mode}: the pane is shown once mounted`);
    // The room under the last row at rest.
    const under = mounted.at(-1).under;
    const all = [mode === 'pinned' ? mounted.at(-1) : await page.evaluate(() => window.fixture.sample())];
    for (const [index, state] of states.entries()) {
      const label = `${mode} state ${index}`;
      const drawn =
        index === remountAt
          ? await page.evaluate((s) => window.fixture.remount(s), state)
          : await page.evaluate((s) => window.fixture.step(s), state);
      const samples = drawn.filter((sample) => !sample.hidden);
      assert.ok(samples.length > 0, `${label}: the pane is shown`);
      if (index === remountAt) {
        // Shown again (or read again, every row under its stored id): each row on screen, counted from the bottom, lands
        // where the one it stands for was left, and stays.
        const left = all.at(-1);
        if (mode === 'pinned') {
          assertPinned(samples, label, under);
          // Whole rows: a sliver at the top edge leaves with the least growth below.
          for (const [back, row] of [...left.rows].reverse().entries()) {
            if (row.top < left.viewTop) continue;
            const missing = samples.findIndex((sample) => !sample.rows.at(-1 - back));
            assert.equal(
              missing,
              -1,
              `${label}: shown again, the row in ${row.key}'s place (${row.top.toFixed(0)}..${(row.top + row.height).toFixed(0)}) is missing at frame ${missing}, back at frame ${samples.findIndex((sample, at) => at > missing && sample.rows.at(-1 - back))}; view from ${samples[missing]?.viewTop}`
            );
            const now = samples[0].rows.at(-1 - back);
            assert.ok(
              now && Math.abs(now.top - row.top) <= 1 && Math.abs(now.height - row.height) <= 1,
              `${label}: shown again, ${row.key} lands as ${now?.key} ${now ? `${(now.top - row.top).toFixed(1)}px away, ${(now.height - row.height).toFixed(1)}px taller` : 'off screen'}; left ${left.rows.map((r) => `${r.key}@${r.top.toFixed(0)}/${r.height.toFixed(0)}`).join(' ')}; shown ${samples[0].rows.map((r) => `${r.key}@${r.top.toFixed(0)}/${r.height.toFixed(0)}`).join(' ')}`
            );
          }
        }
        all.length = 0;
      } else if (mode === 'pinned') {
        assertPinned([all.at(-1) ?? samples[0], ...samples], label, under);
        if (state.still && all.length) assertStill(all.at(-1), samples, label);
      } else if (anchor && samples[0].rows.some((row) => row.key === anchor.key)) {
        assertAnchored(all.at(-1) ?? samples[0], samples, anchor, label);
      }
      // The case's own reading of the state's frames, with the frame they followed.
      if (frames && all.length) frames({ index, samples, label, pinned: mode === 'pinned', before: all.at(-1) });
      all.push(...samples);
      assertRows(all, label);
      if (band && mode === 'pinned' && state.busy) assertRunning(samples, label);
    }
    if (band && mode === 'pinned') assertOneBand(all, 'pinned');
    assert.deepEqual(errors, [], `${mode}: no page errors`);
    t.diagnostic(
      `${mode}: ${all.length} frames, last rows ${all
        .at(-1)
        .rows.map((row) => row.key)
        .join(' ')}`
    );
  }
}

// ---- the cases

test('streamed text growing, then settling into its stored row', async (t) => {
  await playCase(t, running([streaming(20)]), [
    running([], { liveItem: streaming(60) }),
    running([], { liveItem: streaming(140) }),
    running([settledReply(140)]),
    idle([settledReply(140), end({ finalAssistantId: 'a1' })]),
  ]);
});

test('a tool row appearing while text streams above, and the tools folding into a group', async (t) => {
  await playCase(t, running([settledReply(30)]), [
    running([settledReply(30), tool('t1', 'running')]),
    running([settledReply(30), tool('t1')]),
    running([settledReply(30), tool('t1'), tool('t2', 'running')]),
    running([settledReply(30), tool('t1'), tool('t2'), tool('t3')]),
    running([settledReply(30), tool('t1'), tool('t2'), tool('t3')], { liveItem: { ...streaming(40), id: 'a2' } }),
  ]);
});

test('steering while text streams: queued, taken by the turn, and the turn ends', async (t) => {
  const steer = queued('q1', 'Also update the docs');
  await playCase(t, running([], { liveItem: streaming(30) }), [
    running([], { liveItem: streaming(50), steerItems: [steer] }),
    running([], { liveItem: streaming(80), steerItems: [steer] }),
    running([settledReply(80), steered('q1', 'Also update the docs')]),
    running([settledReply(80), steered('q1', 'Also update the docs')], { liveItem: { ...streaming(30), id: 'a2' } }),
    idle([
      settledReply(80),
      steered('q1', 'Also update the docs'),
      { ...settledReply(30), id: 'a2' },
      end({ finalAssistantId: 'a2' }),
    ]),
  ]);
});

test('steering while tools run, and several queued messages with one removed', async (t) => {
  const first = queued('q1', 'First note');
  const second = queued('q2', 'Second note');
  const third = queued('q3', 'Third note');
  await playCase(t, running([tool('t1', 'running')]), [
    running([tool('t1', 'running')], { steerItems: [first] }),
    running([tool('t1', 'running')], { steerItems: [first, second, third] }),
    running([tool('t1', 'running')], { steerItems: [first, third] }),
    running([tool('t1')], { steerItems: [first, third] }),
    running([tool('t1'), steered('q1', 'First note'), steered('q3', 'Third note')]),
  ]);
});

test('send now: the queued message takes the turn over, the end and change card arrive, the next turn runs', async (t) => {
  const steer = queued('q1', 'Use the other file');
  const takenOver = { ...end({ status: 'cancelled', cause: 'message', toolCount: 1 }), id: 'end' };
  const next = { kind: 'user', id: 'q1', text: 'Use the other file', at: 1_700 };
  await playCase(t, running([patch]), [
    running([patch], { steerItems: [steer] }),
    running([patch], { steerItems: [{ ...steer, steer: 'sending' }] }),
    // The change card's record is read once the session idles: the end stands without it meanwhile.
    running([patch, takenOver], { steerItems: [{ ...steer, steer: 'sending' }], activityAt: 1_700, sealed: false }),
    // The stopped turn is over and the next one has not started: the core still lists the message, sent now.
    idle([patch, takenOver], { steerItems: [{ ...steer, steer: 'sending' }], sealed: false }),
    running([patch, takenOver], { steerItems: [{ ...steer, steer: 'sending' }], activityAt: 2_100, sealed: false }),
    // Its own row takes the sent bubble's place.
    running([patch, takenOver, next], { activityAt: 2_100, still: true }),
    idle(
      [
        patch,
        takenOver,
        next,
        { ...settledReply(20), id: 'a2' },
        { ...end({ id: 'end2', checkpointId: 'q1', finalAssistantId: 'a2' }) },
      ],
      { sealed: true }
    ),
  ]);
});

test('the turn end and change card arriving at the end of a turn, then the stored end replacing the live one', async (t) => {
  await playCase(t, running([patch, settledReply(40)]), [
    running([patch, settledReply(40), end({ finalAssistantId: 'a1' })], { sealed: false }),
    idle([patch, settledReply(40), end({ finalAssistantId: 'a1' })], { sealed: true }),
    idle([patch, settledReply(40), end({ id: 'a1:2', finalAssistantId: 'a1' })]),
  ]);
});

test('a stopped turn: the cancelled end and its card arrive under the tools', async (t) => {
  await playCase(t, running([patch, tool('t1', 'running')]), [
    running([patch, tool('t1')]),
    // The end lands before the card's record is ready: the card comes a moment later.
    idle([patch, tool('t1'), end({ status: 'cancelled' })], { sealed: false, still: true }),
    idle([patch, tool('t1'), end({ status: 'cancelled' })], { sealed: true }),
  ]);
});

test('an error ending the turn while its text stands above', async (t) => {
  await playCase(t, running([settledReply(40), tool('t1', 'running')]), [
    idle([settledReply(40), tool('t1'), end({ status: 'failed', detail: 'Error: the provider refused' })], {
      failedTurnKeys: ['turn:u1'],
    }),
  ]);
});

test('a sub-agent report and a goal update arriving while text streams', async (t) => {
  const report = {
    kind: 'notice',
    id: 'n1',
    text: 'agent task: t2\nstatus: completed',
    tone: 'info',
    at: 1_300,
  };
  const goal = { kind: 'statusdone', id: 'g1', status: 'done', label: 'Goal updated', at: 1_350 };
  await playCase(t, running([], { liveItem: streaming(30) }), [
    running([report], { liveItem: streaming(50) }),
    running([report, goal], { liveItem: streaming(70) }),
    running([report, goal, settledReply(70)]),
  ]);
});

test('the session hidden and shown again mid-turn, then the turn going on and ending', async (t) => {
  const steer = queued('q1', 'And the tests');
  await playCase(
    t,
    running([tool('t1')], { liveItem: streaming(40) }),
    [
      running([tool('t1')], { liveItem: streaming(60), steerItems: [steer] }),
      running([tool('t1')], { liveItem: streaming(60), steerItems: [steer] }),
      running([tool('t1')], { liveItem: streaming(80), steerItems: [steer] }),
      running([tool('t1'), settledReply(80), steered('q1', 'And the tests')]),
      idle([tool('t1'), settledReply(80), steered('q1', 'And the tests'), end({ finalAssistantId: 'a1' })]),
    ],
    { remountAt: 1 }
  );
});

test('read again after a restart: every live row replaced by its stored record', async (t) => {
  const live = [patch, settledReply(40), end({ finalAssistantId: 'a1' })];
  const restored = [
    { ...patch, id: 'r-p1' },
    { ...settledReply(40), id: 'r-a1' },
    end({ id: 'r-end', finalAssistantId: 'r-a1' }),
  ];
  await playCase(t, idle(live), [idle(restored)], { remountAt: 0 });
});

test('send now after reply text and a tool: the end taken over stands where the band stood, under the tool', async (t) => {
  const steer = queued('q1', 'Use the other file');
  const takenOver = { ...end({ status: 'cancelled', cause: 'message', toolCount: 1 }), id: 'end' };
  const next = { kind: 'user', id: 'q1', text: 'Use the other file', at: 1_700 };
  await playCase(t, running([settledReply(30), patch], { steerItems: [steer] }), [
    running([settledReply(30), patch], { steerItems: [{ ...steer, steer: 'sending' }] }),
    running([settledReply(30), patch, takenOver], {
      steerItems: [{ ...steer, steer: 'sending' }],
      activityAt: 1_700,
      sealed: false,
    }),
    running([settledReply(30), patch, takenOver, next], { activityAt: 1_700, still: true }),
  ]);
});

test('phone: a stopped turn’s end takes the working band’s place', async (t) => {
  await playCase(
    t,
    running([patch, tool('t1', 'running')]),
    [
      running([patch, tool('t1')]),
      idle([patch, tool('t1'), end({ status: 'cancelled' })], { sealed: false, still: true }),
      idle([patch, tool('t1'), end({ status: 'cancelled' })], { sealed: true }),
    ],
    { phone: true }
  );
});

// ---- cards and waits in the middle of a turn

const reply2 = (count) => ({ ...streaming(count), id: 'a2', at: 1_400 });
const settled2 = (count) => ({ ...settledReply(count), id: 'a2', at: 1_400 });
const askArgs = { questions: [{ question: 'Which file?', options: [{ label: 'a.ts' }, { label: 'b.ts' }] }] };
const ask = (result) => ({
  kind: 'tool',
  id: 'ask1',
  callId: 'ask1',
  name: 'ask_user',
  args: askArgs,
  at: 1_300,
  ...(result ? { result } : { status: 'running' }),
});
const question = { id: 'ap1', kind: 'question', toolCallId: 'ask1', args: askArgs };
const answeredText =
  'User has answered your questions: "Which file?"="a.ts". You can now continue with these answers in mind.';

test('an ask_user card appearing under streamed text, answered, and the turn going on', async (t) => {
  await playCase(t, running([], { liveItem: streaming(30) }), [
    running([settledReply(30), ask()], { approval: question }),
    running([settledReply(30), ask()], { approval: question }),
    running([settledReply(30), ask(answeredText)]),
    running([settledReply(30), ask(answeredText)], { liveItem: reply2(40) }),
    idle([settledReply(30), ask(answeredText), settled2(40), end({ finalAssistantId: 'a2' })]),
  ]);
});

test('an ask_user card dismissed, and the turn going on', async (t) => {
  await playCase(t, running([settledReply(30)]), [
    running([settledReply(30), ask()], { approval: question }),
    running([settledReply(30), ask('User dismissed the question.')]),
    running([settledReply(30), ask('User dismissed the question.')], { liveItem: reply2(40) }),
  ]);
});

test('an ask_user card dismissed and the turn ending with no more output: the rows move once, with the card', async (t) => {
  await playCase(t, running([settledReply(30), ask()], { approval: question }), [
    running([settledReply(30), ask('User dismissed the question.')]),
    // The card's room went with the card, in that frame: none is kept under the rows to land with the end.
    idle([settledReply(30), ask('User dismissed the question.'), end({ toolCount: 1 })]),
  ]);
});

test('steering while a question waits: the message answers it, and the turn goes on', async (t) => {
  const steer = queued('q1', 'Use a.ts');
  const replied = `User replied in chat: "Use a.ts". ${answeredText}`;
  await playCase(t, running([settledReply(30), ask()], { approval: question }), [
    running([settledReply(30), ask()], { approval: question, steerItems: [steer] }),
    running([settledReply(30), ask(replied)]),
    running([settledReply(30), ask(replied)], { liveItem: reply2(40) }),
  ]);
});

test('a visualize card created mid-turn, with text streaming before and after it', async (t) => {
  const open = {
    kind: 'tool',
    id: 'v1',
    callId: 'v1',
    name: 'visualize',
    args: { action: 'open', input: { targets: ['site/a.html'], label: 'Pricing draft' } },
    result: 'Showing site/a.html (html) in the side panel as tab v1.',
    status: 'done',
    startedAt: 1_300,
    completedAt: 1_301,
    at: 1_300,
  };
  await playCase(t, running([], { liveItem: streaming(30) }), [
    running([settledReply(30), { ...open, result: undefined, status: 'running' }]),
    running([settledReply(30), open]),
    running([settledReply(30), open], { liveItem: reply2(40) }),
    running([settledReply(30), open, settled2(40)]),
    idle([settledReply(30), open, settled2(40), end({ finalAssistantId: 'a2' })]),
  ]);
});

test('a to-do update and a sub-agent task card report arriving while text streams', async (t) => {
  const plan = (done) => ({
    kind: 'tool',
    id: 'plan1',
    callId: 'plan1',
    name: 'update_plan',
    args: {
      plan: [
        { step: 'Read the files', status: 'completed' },
        { step: 'Change them', status: done ? 'completed' : 'in_progress' },
      ],
    },
    result: 'ok',
    at: 1_250,
  });
  const report = (status) => ({
    kind: 'notice',
    id: 'n1',
    text: '🛠 Agent task',
    at: 1_350,
    routine: {
      kind: 'task',
      name: 'Fence fix',
      status,
      summary: 'Fixed the fence',
      sessionId: 'sess_task_9',
      sendId: 'atask_1',
    },
  });
  await playCase(t, running([], { liveItem: streaming(30) }), [
    running([settledReply(30), plan(false)], { liveItem: reply2(20) }),
    running([settledReply(30), plan(false), report('working')], { liveItem: reply2(40) }),
    running([settledReply(30), plan(false), report('completed')], { liveItem: reply2(60) }),
    running([settledReply(30), plan(true), report('completed'), settled2(60)]),
  ]);
});

const longError = `Error: ${Array.from({ length: 12 }, (_, at) => `the provider refused the request (${at})`).join('; ')}`;

test('an error card with long text ending the turn', async (t) => {
  await playCase(t, running([settledReply(40), tool('t1', 'running')]), [
    idle([settledReply(40), tool('t1'), end({ status: 'failed', detail: longError, errorDetails: longError })], {
      failedTurnKeys: ['turn:u1'],
    }),
  ]);
});

test('a usage-limit card ending the turn', async (t) => {
  const limit = end({
    status: 'failed',
    detail: 'Usage limit reached for this provider. It resets in 3 hours.',
    errorKind: { kind: 'quota_exhausted', code: 'usage_limit_reached', status: 429 },
    quota: { provider: 'anthropic', resetAt: 9_999_999_999_999 },
  });
  await playCase(t, running([settledReply(40)], { liveItem: reply2(20) }), [
    idle([settledReply(40), settled2(20), limit], { failedTurnKeys: ['turn:u1'] }),
  ]);
});

const wait = (name, args, result) => ({
  kind: 'tool',
  id: 'w1',
  callId: 'w1',
  name,
  args,
  at: 1_300,
  ...(result ? { result } : { status: 'running' }),
});

test('steering while the agent waits on a background task', async (t) => {
  const steer = queued('q1', 'Stop waiting, check the log');
  const args = { action: 'wait', taskId: 'job_1' };
  await playCase(t, running([settledReply(30), wait('task', args)]), [
    running([settledReply(30), wait('task', args)], { steerItems: [steer] }),
    running([settledReply(30), wait('task', args, 'Not waiting: a user message is waiting.')], { steerItems: [steer] }),
    running([
      settledReply(30),
      wait('task', args, 'Not waiting: a user message is waiting.'),
      steered('q1', 'Stop waiting, check the log'),
    ]),
  ]);
});

test('steering while a sub-agent runs', async (t) => {
  const steer = queued('q1', 'Tell it to skip the docs');
  const args = { prompt: 'Fix the fence in cdp.ts', agent: 'worker' };
  await playCase(t, running([settledReply(30), wait('agent', args)]), [
    running([settledReply(30), wait('agent', args)], { steerItems: [steer] }),
    running([settledReply(30), wait('agent', args), steered('q1', 'Tell it to skip the docs')]),
    running([settledReply(30), wait('agent', args, 'done'), steered('q1', 'Tell it to skip the docs')], {
      liveItem: reply2(30),
    }),
  ]);
});

test('steering while a tool approval waits', async (t) => {
  const steer = queued('q1', 'Approve it, then continue');
  const shell = wait('shell', { command: 'npm test' });
  const approval = { id: 'ap2', kind: 'tool', toolCallId: 'w1', name: 'shell', args: { command: 'npm test' } };
  await playCase(t, running([settledReply(30), shell], { approval }), [
    running([settledReply(30), shell], { approval, steerItems: [steer] }),
    running([settledReply(30), wait('shell', { command: 'npm test' }, 'ok')], { steerItems: [steer] }),
    running([
      settledReply(30),
      wait('shell', { command: 'npm test' }, 'ok'),
      steered('q1', 'Approve it, then continue'),
    ]),
  ]);
});

test('a queued message edited: taken back and sent again', async (t) => {
  const first = queued('q1', 'Use the old name');
  const edited = queued('q2', 'Use the new name, and update the tests that mention it');
  await playCase(t, running([tool('t1', 'running')], { steerItems: [first] }), [
    running([tool('t1', 'running')]),
    running([tool('t1', 'running')], { steerItems: [edited] }),
    running([tool('t1'), steered('q2', 'Use the new name, and update the tests that mention it')]),
  ]);
});

for (const [surface, options] of [
  ['phone', { phone: true }],
  ['touch', { touch: true }],
])
  test(`${surface}: a queued message becoming a sent one, taken by the turn and by send now`, async (t) => {
    const steer = queued('q1', 'Also the docs');
    const next = queued('q2', 'Use the other file');
    const takenOver = { ...end({ status: 'cancelled', cause: 'message', toolCount: 1 }), id: 'end' };
    await playCase(
      t,
      running([patch], { liveItem: streaming(20) }),
      [
        running([patch], { liveItem: streaming(30), steerItems: [steer] }),
        running([patch, settledReply(30), steered('q1', 'Also the docs')]),
        running([patch, settledReply(30), steered('q1', 'Also the docs')], { steerItems: [next] }),
        running([patch, settledReply(30), steered('q1', 'Also the docs')], {
          steerItems: [{ ...next, steer: 'sending' }],
          still: true,
        }),
        // The change card's record is read once the session idles: the end stands without it meanwhile.
        running([patch, settledReply(30), steered('q1', 'Also the docs'), takenOver], {
          steerItems: [{ ...next, steer: 'sending' }],
          activityAt: 1_700,
          sealed: false,
        }),
        running(
          [
            patch,
            settledReply(30),
            steered('q1', 'Also the docs'),
            takenOver,
            { kind: 'user', id: 'q2', text: 'Use the other file', at: 1_700 },
          ],
          {
            activityAt: 1_700,
            still: true,
          }
        ),
      ],
      options
    );
  });

// ---- the working band through a turn

const divider = {
  kind: 'statusdone',
  id: 'divider:k1',
  status: 'compacted',
  label: 'Conversation compacted',
  at: 1_950,
};
const settled3 = (count) => ({ ...settledReply(count), id: 'a3', at: 2_050 });

// The core names a turn's attempt on every row of the turn and on its end.
const ofTurn = (item) => ({ ...item, attemptId: 'att1' });

test('an end written while its turn goes on, and a compaction: one working band, no end footer while the turn runs', async (t) => {
  const first = [settledReply(30), tool('t1')].map(ofTurn);
  const firstEnd = ofTurn(end({ id: 'e1', finalAssistantId: 'a1', at: 1_250 }));
  const second = [...first, firstEnd, ofTurn(settled2(30)), ofTurn(tool('t2')), divider];
  const lastEnd = ofTurn(end({ id: 'e2', finalAssistantId: 'a3', at: 2_100 }));
  const third = (count) => ofTurn({ ...streaming(count), id: 'a3', at: 2_050 });
  await playCase(
    t,
    running(first),
    [
      running(first, { liveItem: ofTurn(reply2(20)) }),
      // An end is written while a reply of the same turn arrives: the turn goes on.
      running([...first, firstEnd], { liveItem: ofTurn(reply2(30)) }),
      running([...first, firstEnd, ofTurn(settled2(30)), ofTurn(tool('t2'))]),
      // The compaction's divider; the work reported restarts its clock after the end before it.
      running(second, { activityAt: 1_950 }),
      running(second, { activityAt: 1_950, liveItem: third(20) }),
      running([...second, lastEnd], { activityAt: 1_950, liveItem: third(30) }),
      idle([...second, ofTurn(settled3(30)), lastEnd]),
    ],
    { band: true }
  );
});

test('back-to-back turns: the working band stays one row from one turn into the next', async (t) => {
  const first = [settledReply(30), tool('t1')];
  const firstEnd = end({ finalAssistantId: 'a1', at: 1_250 });
  const next = { kind: 'user', id: 'u2', text: 'And the tests', checkpointId: 'cp2', at: 1_300 };
  await playCase(
    t,
    running(first),
    [
      // The first turn's end and the next turn's prompt: the session never idles between them.
      running([...first, firstEnd, next], { activityAt: 1_300 }),
      running([...first, firstEnd, next], { activityAt: 1_300, liveItem: reply2(20) }),
      running([...first, firstEnd, next, settled2(20), tool('t2')], { activityAt: 1_300 }),
      idle([
        ...first,
        firstEnd,
        next,
        settled2(20),
        tool('t2'),
        end({ id: 'e2', checkpointId: 'cp2', finalAssistantId: 'a2', at: 1_500 }),
      ]),
    ],
    { band: true }
  );
});

// ---- what the band says: a stop, and a compaction's end

const SURFACES = [
  ['desktop', {}],
  ['touch', { touch: true }],
  ['phone', { phone: true }],
];
const working = (mode, extra = {}) => ({ active: true, verb: 'Working', startedAt: 1_000, mode, ...extra });
const bandOf = (sample) => sample.rows.find((row) => row.tag === 'Thinking');
const sameBox = (row, other) => Math.abs(row.top - other.top) <= 1 && Math.abs(row.height - other.height) <= 1;

for (const [surface, options] of SURFACES)
  test(`${surface}: Stop pressed while a tool runs: the band says stopping in place until the end row takes its seat`, async (t) => {
    const tools = [patch, tool('t1', 'running')];
    const stopping = working('tool-use', { stopping: true });
    const stopped = [patch, tool('t1'), end({ status: 'cancelled' })];
    await playCase(
      t,
      running(tools, { spinner: working('tool-use') }),
      [
        running(tools, { spinner: stopping, still: true }),
        // The tool ignores the abort: the turn goes on reporting its work.
        running(tools, { spinner: { ...stopping, mode: 'requesting', outputTokens: 40 }, still: true }),
        running([patch, tool('t1')], { spinner: stopping }),
        idle(stopped, { sealed: false, still: true }),
        idle(stopped, { sealed: true }),
      ],
      {
        ...options,
        frames({ index, samples, label, pinned, before }) {
          const was = bandOf(before);
          for (const [at, sample] of samples.entries()) {
            const band = bandOf(sample);
            if (index >= 3) {
              assert.equal(band, undefined, `${label} frame ${at}: no working band once the turn has ended`);
              if (index === 3 && pinned) {
                assert.ok(
                  sameBox(sample.rows.at(-1), was),
                  `${label} frame ${at}: the end row sits in the band's seat`
                );
              }
              continue;
            }
            if (pinned) assert.ok(band, `${label} frame ${at}: the working band is drawn`);
            if (!band) continue;
            assert.match(band.text, /Stopping…/, `${label} frame ${at}: the band says it is stopping`);
            if (!was) continue;
            assert.equal(band.key, was.key, `${label} frame ${at}: the band is the row it was`);
            if (index < 2) assert.ok(sameBox(band, was), `${label} frame ${at}: the band keeps its slot`);
          }
        },
      }
    );
  });

/** The frames a compaction's divider arrives in: it has the box the working band had, and no band still says compacting. */
function assertDividerSeated({ samples, label, pinned, before }, { goesOn }) {
  const was = bandOf(before);
  for (const [at, sample] of samples.entries()) {
    const index = sample.rows.findIndex((row) => row.tag !== 'TurnGap' && row.key.includes('divider:k1'));
    if (pinned) assert.ok(index >= 0, `${label} frame ${at}: the divider is drawn: ${placed(sample)}`);
    const band = bandOf(sample);
    if (band) assert.doesNotMatch(band.text, /Compacting/, `${label} frame ${at}: the band still says compacting`);
    if (goesOn && pinned) assert.equal(sample.rows.at(-1).tag, 'Thinking', `${label} frame ${at}: the band goes on`);
    if (index < 0 || !was) continue;
    const row = sample.rows[index];
    assert.ok(
      Math.abs(row.height - was.height) <= 1,
      `${label} frame ${at}: the divider is ${(row.height - was.height).toFixed(1)}px taller than the band it follows; before: ${placed(before)}; after: ${placed(sample)}`
    );
    if (band) {
      assert.equal(sample.rows[index + 1]?.key, band.key, `${label} frame ${at}: the band stands under the divider`);
      assert.ok(
        Math.abs(band.height - was.height) <= 1,
        `${label} frame ${at}: under the divider the band is ${(band.height - was.height).toFixed(1)}px taller`
      );
    }
  }
}

for (const [surface, options] of SURFACES) {
  test(`${surface}: a compaction ending mid-turn: its divider takes the band's seat and the band goes on under it`, async (t) => {
    const before = [settledReply(30), tool('t1')];
    await playCase(
      t,
      running(before, { spinner: working('compacting') }),
      [
        // The divider is read before the turn's next phase is.
        running([...before, divider], { spinner: working('compacting') }),
        running([...before, divider], { spinner: working('requesting'), still: true }),
        running([...before, divider], { spinner: working('responding'), liveItem: reply2(20) }),
        idle([...before, divider, settled2(20), end({ finalAssistantId: 'a2' })]),
      ],
      {
        ...options,
        frames(read) {
          if (read.index === 0) {
            assert.match(bandOf(read.before)?.text ?? 'Compacting', /Compacting/, 'the band said compacting');
            assertDividerSeated(read, { goesOn: true });
          }
        },
      }
    );
  });

  test(`${surface}: a compaction as the last act: its divider stands where the band stood and nothing moves`, async (t) => {
    const turn = [settledReply(30), end({ finalAssistantId: 'a1' })];
    // A compaction on its own (the command): no turn runs, the band is the command's.
    const compacting = {
      ...idle(turn),
      commandBusy: true,
      activityAt: 2_100,
      commandStatus: working('compacting', { startedAt: 2_100 }),
    };
    const read = (state) => ({
      ...options,
      frames(frame) {
        if (frame.index !== 0) return;
        assertDividerSeated(frame, { goesOn: false });
        for (const sample of frame.samples) assert.equal(bandOf(sample), undefined, `${frame.label}: the band is gone`);
        if (frame.pinned && state.still) {
          assert.ok(
            sameBox(frame.samples[0].rows.at(-1), bandOf(frame.before)),
            `${frame.label}: the divider sits in the band's seat`
          );
        }
      },
    });
    const done = idle([...turn, divider], { still: true });
    await playCase(t, compacting, [done], read(done));
    // The same at the end of a turn's work, the turn's end written after it.
    const work = [settledReply(30), tool('t1')];
    const ended = idle([...work, divider, end({ toolCount: 1 })]);
    await playCase(t, running(work, { spinner: working('compacting') }), [ended], read(ended));
  });
}

/** The row `pick` takes from what is drawn once `state` is mounted, then from what is drawn once `next` replaced it. */
async function rowsAcross(t, options, state, next, pick = (rows) => rows.at(-1)) {
  const { page } = await openPage(t, options);
  const mounted = await page.evaluate((s) => window.fixture.mount(s), state);
  const touch = await page.evaluate(() => Boolean(document.querySelector('.message-steer[data-touch]')));
  const after = await page.evaluate((s) => window.fixture.step(s), next);
  return { before: pick(mounted.at(-1).rows), after: pick(after.at(-1).rows), touch };
}

for (const [surface, options, height] of [
  ['desktop', {}, 24],
  ['touch', { touch: true }, 24],
  ['phone', { phone: true }, 28],
])
  test(`${surface}: a Stop directly after the prompt leaves an end row of the working band's ${height}px`, async (t) => {
    // The end as it lands, before the record of the turn's changes is read.
    const stopped = idle([end({ status: 'cancelled' })], { sealed: false, still: true });
    await playCase(t, running([]), [stopped], options);
    const { before, after } = await rowsAcross(t, options, running([]), stopped);
    assert.notEqual(after.key, before.key, 'the end row took the band’s place');
    assert.equal(before.height, height, 'the working band');
    assert.equal(after.height, height, 'the end row');
  });

for (const [surface, options] of [
  ['desktop', {}],
  ['touch', { touch: true }],
  ['phone', { phone: true }],
])
  test(`${surface}: a queued bubble and the sent message it becomes are one height`, async (t) => {
    const steer = queued('q1', 'Also the docs');
    for (const sent of [steered('q1', 'Also the docs'), { kind: 'user', id: 'q1', text: 'Also the docs', at: 1_600 }]) {
      const { before, after, touch } = await rowsAcross(
        t,
        options,
        running([tool('t1')], { steerItems: [steer] }),
        running([tool('t1'), sent]),
        (rows) => rows.find((row) => /Also the docs/.test(row.text))
      );
      assert.equal(touch, surface !== 'desktop', 'the queued line draws its touch targets on a coarse pointer only');
      assert.ok(before && after, 'the bubble, then its message');
      const what = sent.steered ? 'the message a turn read' : 'the prompt of the turn it opens';
      assert.equal(after.height, before.height, `${what} is ${after.height - before.height}px taller than its bubble`);
    }
  });
