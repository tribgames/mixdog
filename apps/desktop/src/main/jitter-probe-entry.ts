/**
 * Cold-entry / tool-toggle pass (MIXDOG_JITTER_PROBE=entry): first entry into
 * a session that already has history, the late worker review bar, queue
 * mount/unmount, re-entry, and tool-card disclosure geometry.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrowserWindow } from 'electron';
import { coldHistoryItems } from './jitter-probe-fixtures';
import {
  PAINTED_SAMPLER,
  sleep,
  TOOL_DISCLOSURE,
  TOOL_DISCLOSURE_HEADERS,
  TOOL_DISCLOSURE_OPEN,
  waitForProbeSessionRow,
} from './jitter-probe-session';
import { contentMotion, type RowSample } from './jitter-probe-metrics';

/** The composer island's review: its Files segment (the desktop opens the
 *  session diff in the side dock instead of expanding the bar in place). */
const REVIEW_IN_ISLAND = '.composer-island-slot .turn-review-segment';

interface EntryProbeDeps {
  window: BrowserWindow;
  baseSnapshot: Record<string, unknown>;
  prepareColdResume(snapshot: Record<string, unknown>): void;
  send(state: Record<string, unknown>): void;
  outPath: string;
}

// Pick the transcript of the VISIBLE route: background tabs keep their own
// (taller, scrolled-away) transcript mounted. Prewarm rows live in a hidden
// sibling container, so only DIRECT children of the virtual space count.
const PICK_TRANSCRIPT = `(() => {
  const nodes = [...document.querySelectorAll('.transcript')]
    .filter((node) => node.getBoundingClientRect().height > 0);
  if (nodes.length === 0) return null;
  return nodes
    .map((node) => ({
      node,
      rows: node.querySelectorAll('.transcript-virtual-space > .transcript-virtual-row').length,
    }))
    .sort((a, b) => b.rows - a.rows || b.node.scrollHeight - a.node.scrollHeight)[0].node;
})()`;
const INSTALL_SAMPLER = `(() => {
  const w = window;
  if (w.__entry && w.__entry.stop) w.__entry.stop();
  w.__entry = { samples: [], raf: 0, stop: null };
  const snapshot = () => {
    const el = ${PICK_TRANSCRIPT};
    if (el) {
      const box = el.getBoundingClientRect();
      const rows = [...el.querySelectorAll('.transcript-virtual-space > .transcript-virtual-row')]
        .map((row) => ({ row, rect: row.getBoundingClientRect() }))
        // Off-screen overscan rows may legitimately shift while the view is
        // pinned; only VISIBLE movement is the reported bounce.
        .filter(({ rect }) => rect.bottom > box.top && rect.top < box.bottom)
        .map(({ row, rect }) => ({
          i: Number(row.getAttribute('data-index')),
          top: Math.round(rect.top - box.top),
        }));
      return {
        t: Math.round(performance.now()),
        // The viewport stays visibility:hidden until the entry reveal; those
        // frames are never seen by the user.
        hidden: el.style.visibility === 'hidden',
        st: Math.round(el.scrollTop),
        sh: Math.round(el.scrollHeight),
        ch: Math.round(el.clientHeight),
        space: Math.round(el.querySelector('.transcript-virtual-space')
          ?.getBoundingClientRect().height || 0),
        // Layout bands around the transcript: a band that appears AFTER
        // entry shrinks the viewport and drags the pinned content with it.
        bands: [
          '.composer-island-slot .turn-review-segment', '.composer-island-slot', '.composer-region', '.composer-context-bar',
          '.runtime-progress', '.inline-error', '.live-work', '.transcript-shell',
        ].map((selector) => {
          const node = document.querySelector(selector);
          return node ? Math.round(node.getBoundingClientRect().height) : 0;
        }),
        dist: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
        following: el.getAttribute('data-following') === 'true',
        plain: el.querySelectorAll('.markdown-plain').length,
        queueHeight: Math.round((el.closest('.conversation') || document)
          .querySelector('.queue-list')?.getBoundingClientRect().height || 0),
        review: (() => {
          const shell = el.closest('.conversation') || document;
          const review = shell.querySelector(${JSON.stringify(REVIEW_IN_ISLAND)});
          if (!review) return null;
          const reviewBox = review.getBoundingClientRect();
          const activity = el.querySelector('.live-activity-status');
          const activityBox = activity?.getBoundingClientRect();
          const composer = shell.querySelector('.composer');
          const composerBox = composer?.getBoundingClientRect();
          // The transcript viewport runs under the absolutely positioned
          // composer dock, so the viewport itself always "overlaps" the
          // island; the segment must not cover the visible rows instead.
          let rowsBottom = box.top;
          for (const row of el.querySelectorAll('.transcript-virtual-space > .transcript-virtual-row')) {
            const rect = row.getBoundingClientRect();
            if (rect.bottom > box.top && rect.top < box.bottom) rowsBottom = Math.max(rowsBottom, rect.bottom);
          }
          return {
            height: Math.round(reviewBox.height),
            overlap: Math.max(0, Math.round(rowsBottom - reviewBox.top)),
            thinkingGap: activityBox ? Math.round(reviewBox.top - activityBox.bottom) : null,
            composerGap: composerBox ? Math.round(composerBox.top - reviewBox.bottom) : null,
          };
        })(),
        subject: (() => {
          const card = w.__entryCard;
          const row = card?.closest('.transcript-virtual-row');
          if (!card || !row || !row.isConnected) return null;
          return {
            open: card.getAttribute('data-open') === 'true',
            rowHeight: Math.round(row.getBoundingClientRect().height),
            cardHeight: Math.round(card.getBoundingClientRect().height),
          };
        })(),
        composer: (() => {
          const region = document.querySelector('.composer-region');
          if (!region) return null;
          const walk = (node, depth) => [...node.children].flatMap((child) => {
            const height = Math.round(child.getBoundingClientRect().height);
            const entry = [String(child.className || child.tagName), height];
            return depth > 0 ? [entry, ...walk(child, depth - 1)] : [entry];
          });
          return walk(region, 2);
        })(),
        rows,
      };
    }
    return null;
  };
  (${PAINTED_SAMPLER})(w.__entry, snapshot);
  return true;
})()`;
const STOP_SAMPLER = `(() => {
  const w = window;
  w.__entry.stop();
  return w.__entry.samples;
})()`;

const ENTRY_DIAGNOSTICS = `(() => {
  const el = ${PICK_TRANSCRIPT};
  const shell = el?.closest('.conversation') || document;
  return {
    transcripts: document.querySelectorAll('.transcript').length,
    coldVisible: (document.body.textContent || '').includes('cold entry question'),
    rows: el ? el.querySelectorAll('.transcript-virtual-space > .transcript-virtual-row').length : 0,
    toolCards: el ? el.querySelectorAll(${JSON.stringify(TOOL_DISCLOSURE)}).length : 0,
    reviewBarHeight: Math.round(shell.querySelector(${JSON.stringify(REVIEW_IN_ISLAND)})?.getBoundingClientRect().height || 0),
    markdownPlainFallbacks: Math.max(0, ...window.__entry.samples.map((sample) => Number(sample.plain || 0))),
    settledMarkdownPlainFallbacks: Math.max(
      0,
      ...window.__entry.samples.slice(-20).map((sample) => Number(sample.plain || 0)),
    ),
    scrollHeight: el ? Math.round(el.scrollHeight) : 0,
    clientHeight: el ? Math.round(el.clientHeight) : 0,
    dist: el ? Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) : null,
  };
})()`;

function coldFixtures(baseSnapshot: Record<string, unknown>) {
  const coldStamp = Date.now() % 100_000;
  // The composer island's files segment folds only patch-publishing tool
  // calls (a shell result no longer counts), so the tail call is an `edit`
  // whose runtime `uiDiff` arrives late (delayedReviewItems below).
  const coldItems = coldHistoryItems(84, coldStamp).map((item) =>
    item.id === `cold-${coldStamp}-tool-tail`
      ? {
          ...item,
          name: 'edit',
          args: { file_path: 'src/probe.ts', old_string: 'const stable = false;', new_string: 'const stable = true;' },
        }
      : item
  );
  // Enter through the real resume path: a snapshot pushed for a foreign
  // session id never reaches the visible route.
  const coldSnapshot = {
    ...baseSnapshot,
    toasts: [],
    sessionId: 'probe_session_cold',
    busy: true,
    spinner: {
      active: true,
      mode: 'responding',
      startedAt: Date.now(),
    },
    items: coldItems,
    streamingTail: null,
  };
  const delayedReviewItems = coldItems.map((item) =>
    item.id === `cold-${coldStamp}-tool-tail`
      ? {
          ...item,
          uiDiff: `diff --git a/src/probe.ts b/src/probe.ts
--- a/src/probe.ts
+++ b/src/probe.ts
@@ -1 +1 @@
-const stable = false;
+const stable = true;
`,
        }
      : item
  );
  const delayedReviewSnapshot = {
    ...coldSnapshot,
    items: delayedReviewItems,
  };
  const queuedSnapshot = {
    ...delayedReviewSnapshot,
    queued: [
      {
        id: `cold-${coldStamp}-queued-followup`,
        text: 'queued follow-up geometry probe',
      },
    ],
  };
  const appendedSnapshot = {
    ...delayedReviewSnapshot,
    items: [
      ...delayedReviewItems,
      {
        id: `cold-${coldStamp}-append-after-toggle`,
        kind: 'assistant',
        text: 'follow remains pinned after a tool disclosure changes height',
      },
    ],
  };
  return { coldSnapshot, delayedReviewSnapshot, queuedSnapshot, appendedSnapshot };
}

function summarizeDelayedReview(entrySamples: RowSample[], firstReviewFrame: number) {
  const delayedReviewSamples = firstReviewFrame >= 0 ? entrySamples.slice(Math.max(0, firstReviewFrame - 2)) : [];
  const visibleReviewSamples = delayedReviewSamples.filter((sample) => sample.review && !sample.hidden);
  const settledReviewSamples = visibleReviewSamples.slice(-5);
  const thinkingGaps = visibleReviewSamples
    .map((sample) => sample.review?.thinkingGap)
    .filter((value): value is number => Number.isFinite(value));
  const composerGaps = visibleReviewSamples
    .map((sample) => sample.review?.composerGap)
    .filter((value): value is number => Number.isFinite(value));
  const settledThinkingGaps = settledReviewSamples
    .map((sample) => sample.review?.thinkingGap)
    .filter((value): value is number => Number.isFinite(value));
  const settledComposerGaps = settledReviewSamples
    .map((sample) => sample.review?.composerGap)
    .filter((value): value is number => Number.isFinite(value));
  const delayedReview = {
    appeared: firstReviewFrame > 0 && entrySamples.slice(0, firstReviewFrame).some((sample) => !sample.review),
    // The settled segment height (the first frame can catch it mid-reveal).
    height: Number(settledReviewSamples.at(-1)?.review?.height || 0),
    maxOverlap: visibleReviewSamples.length
      ? Math.max(...visibleReviewSamples.map((sample) => Number(sample.review?.overlap || 0)))
      : Number.MAX_SAFE_INTEGER,
    minThinkingGap: thinkingGaps.length ? Math.min(...thinkingGaps) : null,
    minComposerGap: composerGaps.length ? Math.min(...composerGaps) : null,
    settledThinkingGap: settledThinkingGaps.length ? Math.min(...settledThinkingGaps) : null,
    settledComposerGap: settledComposerGaps.length ? Math.min(...settledComposerGaps) : null,
    settledMaxDistance: settledReviewSamples.length
      ? Math.max(...settledReviewSamples.map((sample) => sample.dist))
      : Number.MAX_SAFE_INTEGER,
    // The rAF sampler forces the new layout before ResizeObserver callbacks.
    // One raw sample may therefore precede the same-frame pre-paint pin.
    correctionFrames: visibleReviewSamples.findIndex(
      (sample) => sample.dist <= 8 && Number(sample.review?.thinkingGap) >= 18
    ),
    motion: contentMotion(delayedReviewSamples),
  };
  return delayedReview;
}

async function toggleQueue(
  window: BrowserWindow,
  send: EntryProbeDeps['send'],
  label: string,
  nextSnapshot: Record<string, unknown>,
  targetVisible: boolean
) {
  await window.webContents.executeJavaScript(INSTALL_SAMPLER);
  await sleep(100);
  send(nextSnapshot);
  await sleep(700);
  const samples = (await window.webContents.executeJavaScript(STOP_SAMPLER)) as RowSample[];
  const baseline = samples.slice(0, Math.min(5, samples.length));
  const settled = samples.slice(-5);
  const visibleBefore = baseline.some((sample) => Number(sample.queueHeight || 0) > 0);
  const visibleAfter = settled.some((sample) => Number(sample.queueHeight || 0) > 0);
  return {
    label,
    targetVisible,
    transitioned: targetVisible ? !visibleBefore && visibleAfter : visibleBefore && !visibleAfter,
    finalHeight: Number(samples.at(-1)?.queueHeight || 0),
    followingAfter: samples.at(-1)?.following ?? null,
    finalDistance: samples.at(-1)?.dist ?? null,
    motion: contentMotion(samples),
    samples,
  };
}

// Re-entry: leave the session and come back. Everything the first visit
// resolved asynchronously (worker review bar, row heights) must now be
// known up front, so the second entry may not move at all.
async function reenterColdSession(
  window: BrowserWindow,
  send: EntryProbeDeps['send'],
  snapshot: Record<string, unknown>,
  settleMs: number
) {
  await window.webContents.executeJavaScript(`(async () => {
  const link = document.querySelector('button[aria-label="New task"]');
  if (link instanceof HTMLElement) link.click();
  await new Promise((resolve) => setTimeout(resolve, 700));
  return true;
})()`);
  await window.webContents.executeJavaScript(INSTALL_SAMPLER);
  await window.webContents.executeJavaScript(`(async () => {
  const row = ${waitForProbeSessionRow('probe_session_cold', 'Missing cold probe session row')};
  row.click();
  await new Promise((resolve) => setTimeout(resolve, 400));
  return true;
})()`);
  send(snapshot);
  await sleep(settleMs);
}

// Select (and if needed scroll to) the subject card BEFORE sampling, so
// the recorded frames contain only the toggle's own motion.
async function prepareToggleHeader(window: BrowserWindow, pinned: boolean) {
  return (await window.webContents.executeJavaScript(`(async () => {
    const el = ${PICK_TRANSCRIPT};
    if (!el) return false;
    let box = el.getBoundingClientRect();
    const headers = [...el.querySelectorAll(${JSON.stringify(TOOL_DISCLOSURE_HEADERS)})]
      .filter((node) => !node.disabled);
    const visible = headers.filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.top >= box.top && rect.bottom <= box.bottom;
    });
    const pinnedPass = ${pinned ? 'true' : 'false'};
    let header = pinnedPass ? visible[visible.length - 1] : visible[0];
    if (!header && !pinnedPass && headers.length > 0) {
      // Reading position: bring a mid-transcript card into view first.
      header = headers[Math.floor(headers.length / 2)];
      header.scrollIntoView({ block: 'center' });
      await new Promise((resolve) => setTimeout(resolve, 400));
      box = el.getBoundingClientRect();
    }
    window.__entryHeader = header || null;
    return Boolean(header);
  })()`)) as boolean;
}

async function clickToggleHeader(window: BrowserWindow, targetExpanded: boolean) {
  return (await window.webContents.executeJavaScript(`(() => {
    const el = ${PICK_TRANSCRIPT};
    const header = window.__entryHeader;
    if (!el || !header || !header.isConnected) return null;
    const box = el.getBoundingClientRect();
    const card = header.closest(${JSON.stringify(TOOL_DISCLOSURE)});
    const row = card.closest('.transcript-virtual-row');
    const space = el.querySelector('.transcript-virtual-space');
    const before = {
      top: Math.round(card.getBoundingClientRect().top - box.top),
      scrollTop: Math.round(el.scrollTop),
      scrollHeight: Math.round(el.scrollHeight),
      spaceHeight: Math.round(space?.getBoundingClientRect().height || 0),
      rowHeight: Math.round(row?.getBoundingClientRect().height || 0),
      cardHeight: Math.round(card.getBoundingClientRect().height),
    };
    window.__entryCard = card;
    const open = card.getAttribute('data-open') === 'true';
    if (open !== ${targetExpanded ? 'true' : 'false'}) {
      header.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, button: 0, buttons: 1, pointerId: 1,
      }));
      header.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, button: 0, buttons: 0, pointerId: 1,
      }));
      header.click();
    }
    return { before, open };
  })()`)) as {
    before: {
      top: number;
      scrollTop: number;
      scrollHeight: number;
      spaceHeight: number;
      rowHeight: number;
      cardHeight: number;
    };
    open: boolean;
  } | null;
}

async function readToggledCard(window: BrowserWindow) {
  return (await window.webContents.executeJavaScript(`(() => {
    const el = ${PICK_TRANSCRIPT};
    const card = window.__entryCard;
    if (!el || !card || !card.isConnected) return null;
    const row = card.closest('.transcript-virtual-row');
    const space = el.querySelector('.transcript-virtual-space');
    return {
      top: Math.round(card.getBoundingClientRect().top - el.getBoundingClientRect().top),
      open: card.getAttribute('data-open'),
      subjectKey: row?.getAttribute('data-timeline-key') || '',
      scrollTop: Math.round(el.scrollTop),
      scrollHeight: Math.round(el.scrollHeight),
      spaceHeight: Math.round(space?.getBoundingClientRect().height || 0),
      rowHeight: Math.round(row?.getBoundingClientRect().height || 0),
      cardHeight: Math.round(card.getBoundingClientRect().height),
    };
  })()`)) as {
    top: number;
    open: string;
    subjectKey: string;
    scrollTop: number;
    scrollHeight: number;
    spaceHeight: number;
    rowHeight: number;
    cardHeight: number;
  } | null;
}

async function toggleToolCard(window: BrowserWindow, label: string, pinned: boolean, targetExpanded: boolean) {
  const prepared = await prepareToggleHeader(window, pinned);
  await sleep(300);
  await window.webContents.executeJavaScript(INSTALL_SAMPLER);
  const clicked = await clickToggleHeader(window, targetExpanded);
  await sleep(1_000);
  const samples = (await window.webContents.executeJavaScript(STOP_SAMPLER)) as RowSample[];
  const card = await readToggledCard(window);
  const scrollDelta = clicked && card ? card.scrollTop - clicked.before.scrollTop : null;
  const scrollHeightDelta = clicked && card ? card.scrollHeight - clicked.before.scrollHeight : null;
  const spaceHeightDelta = clicked && card ? card.spaceHeight - clicked.before.spaceHeight : null;
  const rowHeightDelta = clicked && card ? card.rowHeight - clicked.before.rowHeight : null;
  const cardHeightDelta = clicked && card ? card.cardHeight - clicked.before.cardHeight : null;
  const pinnedScrollHeightDelta = pinned ? (scrollHeightDelta ?? 0) : 0;
  return {
    label,
    prepared,
    clicked: Boolean(clicked),
    targetExpanded,
    subjectKey: card?.subjectKey ?? null,
    cardShift: clicked && card ? card.top - clicked.before.top : null,
    openAfter: card?.open ?? null,
    scrollDelta,
    scrollHeightDelta,
    spaceHeightDelta,
    rowHeightDelta,
    cardHeightDelta,
    scrollError: scrollDelta === null || scrollHeightDelta === null ? null : scrollDelta - pinnedScrollHeightDelta,
    rowGeometryError: rowHeightDelta === null || cardHeightDelta === null ? null : rowHeightDelta - cardHeightDelta,
    spaceGeometryError:
      spaceHeightDelta === null || cardHeightDelta === null ? null : spaceHeightDelta - cardHeightDelta,
    followingAfter: samples.at(-1)?.following ?? null,
    finalDistance: samples.at(-1)?.dist ?? null,
    motion: contentMotion(samples),
    samples,
  };
}

/** The tool-toggle passes need a scrolled-up (reading) position: disarm follow
 *  with a wheel event, then scroll away from the bottom. */
const SCROLL_UP_FROM_BOTTOM = `(async () => {
  const el = ${PICK_TRANSCRIPT};
  if (!el) return false;
  el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
  el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 1_200);
  await new Promise((resolve) => setTimeout(resolve, 500));
  return true;
})()`;

async function measureExpandedReentry(window: BrowserWindow) {
  const samples = (await window.webContents.executeJavaScript(STOP_SAMPLER)) as RowSample[];
  const motion = contentMotion(samples);
  const openTools = (await window.webContents.executeJavaScript(
    `document.querySelectorAll(${JSON.stringify(TOOL_DISCLOSURE_OPEN)}).length`
  )) as number;
  return { samples, motion, openTools };
}

async function measurePinnedAppend(
  window: BrowserWindow,
  send: EntryProbeDeps['send'],
  snapshot: Record<string, unknown>
) {
  await window.webContents.executeJavaScript(INSTALL_SAMPLER);
  send(snapshot);
  await sleep(700);
  const samples = (await window.webContents.executeJavaScript(STOP_SAMPLER)) as RowSample[];
  const summary = {
    followingAfter: samples.at(-1)?.following ?? null,
    finalDistance: samples.at(-1)?.dist ?? null,
    motion: contentMotion(samples),
  };
  return { samples, summary };
}

function withoutSamples<T extends { samples: unknown }>(result: T): Omit<T, 'samples'> {
  const { samples: _samples, ...rest } = result;
  return rest;
}

function writeEntryReport(outPath: string, summary: Record<string, unknown>, samples: Record<string, unknown>) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ summary, ...samples }, null, 1));
  console.log(`[jitter-probe] ${JSON.stringify(summary)}`);
}

async function measureColdEntry(
  window: BrowserWindow,
  send: EntryProbeDeps['send'],
  coldSnapshot: Record<string, unknown>,
  delayedReviewSnapshot: Record<string, unknown>
) {
  await window.webContents.executeJavaScript(INSTALL_SAMPLER);
  const coldClick = (await window.webContents.executeJavaScript(`(async () => {
  const row = ${waitForProbeSessionRow('probe_session_cold', 'Missing cold probe session row')};
  row.click();
  await new Promise((resolve) => setTimeout(resolve, 600));
  return {
    tabs: [...document.querySelectorAll('.workspace-tab')].map((tab) => tab.textContent.slice(0, 24)),
    errors: [...document.querySelectorAll('.inline-error, .runtime-progress')]
      .map((node) => node.textContent.slice(0, 120)),
  };
})()`)) as Record<string, unknown>;
  // The route is now bound to the cold session id, so the history batch
  // lands through the normal state push (one commit, like a real resume).
  send(coldSnapshot);
  // Cover the 6s worker-review poll as well as any delayed renderer idle work.
  await sleep(5_800);
  // A worker-only diff becomes known late without adding a transcript row.
  // The bottom stack must grow once, retain the followed bottom, preserve the
  // thinking gap, and never cover transcript content.
  send(delayedReviewSnapshot);
  await sleep(1_200);
  const entrySamples = (await window.webContents.executeJavaScript(STOP_SAMPLER)) as RowSample[];
  const firstReviewFrame = entrySamples.findIndex((sample) => Number(sample.review?.height || 0) > 0);
  const entry = contentMotion(firstReviewFrame > 0 ? entrySamples.slice(0, firstReviewFrame) : entrySamples);
  const delayedReview = summarizeDelayedReview(entrySamples, firstReviewFrame);
  const entryDiag = (await window.webContents.executeJavaScript(ENTRY_DIAGNOSTICS)) as Record<string, unknown>;
  Object.assign(entryDiag, { click: coldClick });
  return { entrySamples, entry, delayedReview, entryDiag };
}

export async function runEntryProbe({
  window,
  baseSnapshot,
  prepareColdResume,
  send,
  outPath,
}: EntryProbeDeps): Promise<{ reversals: number }> {
  // ── Phase A: COLD FIRST ENTRY into a session that already has history ────
  // Runs before every other phase on purpose: this is the user's "최초 진입"
  // — no cached row heights, and the markdown/diff chunks are as cold as they
  // are right after launch. The transcript must land bottom-pinned and hold
  // still while the estimated rows are re-measured.
  const { coldSnapshot, delayedReviewSnapshot, queuedSnapshot, appendedSnapshot } = coldFixtures(baseSnapshot);
  prepareColdResume(coldSnapshot);
  const { entrySamples, entry, delayedReview, entryDiag } = await measureColdEntry(
    window,
    send,
    coldSnapshot,
    delayedReviewSnapshot
  );

  const queueMount = await toggleQueue(window, send, 'queue-mount', queuedSnapshot, true);
  const queueUnmount = await toggleQueue(window, send, 'queue-unmount', delayedReviewSnapshot, false);
  prepareColdResume(delayedReviewSnapshot);

  await reenterColdSession(window, send, delayedReviewSnapshot, 2_000);
  const reentrySamples = (await window.webContents.executeJavaScript(STOP_SAMPLER)) as RowSample[];
  const reentry = contentMotion(reentrySamples);

  // ── Phase B: tool-card expand / collapse ────────────────────────────────
  // The toggled card's own top must not move, and neither may the rest of
  // the visible transcript (user: 도구 사용 표기 펼침/접힘도 같은 출렁임).
  // Pinned pass first (the common case: the newest tool card at the bottom of
  // a followed transcript), then the scrolled-up reading case.
  const pinnedExpand = await toggleToolCard(window, 'pinned-expand', true, true);
  await reenterColdSession(window, send, delayedReviewSnapshot, 1_200);
  const expandedReentry = await measureExpandedReentry(window);
  // Re-entry reset every disclosure to collapsed, so the card is expanded again
  // first; only then does the collapse pass toggle a real expansion back.
  const pinnedExpandAgain = await toggleToolCard(window, 'pinned-expand-again', true, true);
  const pinnedCollapse = await toggleToolCard(window, 'pinned-collapse', true, false);
  const pinnedAppend = await measurePinnedAppend(window, send, appendedSnapshot);
  await window.webContents.executeJavaScript(SCROLL_UP_FROM_BOTTOM);
  const expand = await toggleToolCard(window, 'expand', false, true);
  const collapse = await toggleToolCard(window, 'collapse', false, false);
  const toggleSamples = {
    pinnedExpand: pinnedExpand.samples,
    pinnedCollapse: pinnedCollapse.samples,
    pinnedAppend: pinnedAppend.samples,
    expand: expand.samples,
    collapse: collapse.samples,
  };

  const entrySummary = {
    coldEntry: entry,
    coldReentry: reentry,
    delayedReview,
    queueMount: withoutSamples(queueMount),
    queueUnmount: withoutSamples(queueUnmount),
    coldEntryDiag: entryDiag,
    expandedToolReentry: {
      motion: expandedReentry.motion,
      openTools: expandedReentry.openTools,
    },
    toolTogglePinnedExpand: withoutSamples(pinnedExpand),
    toolTogglePinnedExpandAgain: withoutSamples(pinnedExpandAgain),
    toolTogglePinnedCollapse: withoutSamples(pinnedCollapse),
    toolTogglePinnedAppend: pinnedAppend.summary,
    toolToggleExpand: withoutSamples(expand),
    toolToggleCollapse: withoutSamples(collapse),
  };
  writeEntryReport(outPath, entrySummary, {
    entrySamples,
    reentrySamples,
    expandedReentrySamples: expandedReentry.samples,
    queueMountSamples: queueMount.samples,
    queueUnmountSamples: queueUnmount.samples,
    toggleSamples,
  });
  return {
    reversals: Math.max(
      entry.reversals,
      reentry.reversals,
      delayedReview.motion.reversals,
      expandedReentry.motion.reversals,
      queueMount.motion.reversals,
      queueUnmount.motion.reversals,
      pinnedExpand.motion.reversals,
      pinnedExpandAgain.motion.reversals,
      pinnedCollapse.motion.reversals,
      expand.motion.reversals,
      collapse.motion.reversals
    ),
    ...entrySummary,
  } as unknown as { reversals: number };
}
