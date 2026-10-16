/**
 * Opt-in streamed-text smoothness metrics, behind the transcript scroll
 * diagnostics flag (transcript-scroll-diagnostics.ts) and free while it is off.
 *
 * One run spans one streamed reply: it opens on the first live tail the lane
 * store receives and closes one second after the reply settled on screen.
 * Every boundary the text crosses is timestamped — IPC receipt, lane publish,
 * the live markdown commit, worker parse round trips, main-thread parses — and
 * a per-frame sampler reads what is actually painted: visible graphemes,
 * empty frames while text is waiting, live-row height shrinks, long tasks and
 * long animation frames, and the transcript's scroll writes.
 *
 *   window.__mixdogStreamMetrics.summary()   // last (or current) run
 *   window.__mixdogStreamMetrics.reset()
 */
import { setTranscriptScrollEventSink, transcriptScrollDiagnosticsEnabled } from './transcript-scroll-diagnostics';

interface TimedSize {
  t: number;
  size: number;
}

interface FrameSample {
  t: number;
  grew: number;
  backlog: boolean;
  scrollWrites: number;
}

interface StreamRun {
  startedAt: number;
  endedAt: number;
  itemId: string;
  ipc: TimedSize[];
  publish: number[];
  commits: TimedSize[];
  workerLatency: number[];
  syncParse: TimedSize[];
  frames: FrameSample[];
  longTasks: number[];
  longFrames: number[];
  scroll: Record<string, number>;
  shrinks: number;
  shrinkPx: number;
  firstIpcAt: number;
  firstVisibleAt: number;
  completeAt: number;
  settledAt: number;
  receivedGraphemes: number;
  visibleGraphemes: number;
}

const SETTLE_TAIL_MS = 1_000;
// A reply whose row never settles on screen (scrolled away, pane closed).
const ABANDON_MS = 5_000;

let segmenter: Intl.Segmenter | null = null;

/** Grapheme count, the unit a reader perceives as one character. */
export function graphemeCount(text: string): number {
  if (!text) return 0;
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let count = 0;
  for (const _ of segmenter.segment(text)) count += 1;
  return count;
}

let run: StreamRun | null = null;
let lastRun: StreamRun | null = null;
let ipcTail = { sessionId: '', id: '', text: '' };
let frame = 0;
let trackedRow: Element | null = null;
let visibleText = '';
let visibleCount = 0;
let lastHeight = -1;
let receivedAtLastGrowth = 0;
let frameScrollWrites = 0;
let pacerBacklog: () => boolean = () => false;
let observers: PerformanceObserver[] = [];

function newRun(now: number, itemId: string): StreamRun {
  return {
    startedAt: now,
    endedAt: 0,
    itemId,
    ipc: [],
    publish: [],
    commits: [],
    workerLatency: [],
    syncParse: [],
    frames: [],
    longTasks: [],
    longFrames: [],
    scroll: {},
    shrinks: 0,
    shrinkPx: 0,
    firstIpcAt: 0,
    firstVisibleAt: 0,
    completeAt: 0,
    settledAt: 0,
    receivedGraphemes: 0,
    visibleGraphemes: 0,
  };
}

function observePerformance(): void {
  for (const type of ['longtask', 'long-animation-frame']) {
    try {
      const observer = new PerformanceObserver((list) => {
        if (!run) return;
        for (const entry of list.getEntries()) {
          if (entry.startTime < run.startedAt) continue;
          (type === 'longtask' ? run.longTasks : run.longFrames).push(entry.duration);
        }
      });
      observer.observe({ type, buffered: false });
      observers.push(observer);
    } catch {
      // Unsupported entry type: that series stays empty.
    }
  }
}

function startRun(now: number, itemId: string): void {
  run = newRun(now, itemId);
  trackedRow = null;
  visibleText = '';
  visibleCount = 0;
  lastHeight = -1;
  receivedAtLastGrowth = 0;
  frameScrollWrites = 0;
  setTranscriptScrollEventSink((event) => {
    if (!run) return;
    run.scroll[event] = (run.scroll[event] ?? 0) + 1;
    if (event === 'end-pin' || event === 'core-scroll' || event === 'reading-anchor') frameScrollWrites += 1;
  });
  observePerformance();
  if (!frame) frame = requestAnimationFrame(sample);
}

function endRun(now: number): void {
  if (!run) return;
  run.endedAt = now;
  lastRun = run;
  run = null;
  setTranscriptScrollEventSink(null);
  for (const observer of observers) observer.disconnect();
  observers = [];
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
}

function liveRow(): Element | null {
  const rows = document.querySelectorAll('.transcript-live-part[data-streaming-tail="true"]');
  const live = rows[rows.length - 1] ?? null;
  if (live) trackedRow = live;
  return trackedRow?.isConnected ? trackedRow : null;
}

function readVisibleGraphemes(row: Element | null): number {
  const text = row?.querySelector('.message-body')?.textContent ?? '';
  if (text === visibleText) return visibleCount;
  const count =
    text.startsWith(visibleText) && visibleText
      ? visibleCount + graphemeCount(text.slice(visibleText.length))
      : graphemeCount(text);
  visibleText = text;
  visibleCount = count;
  return count;
}

function sample(now: number): void {
  frame = 0;
  const current = run;
  if (!current) return;
  const before = visibleCount;
  const row = liveRow();
  const count = readVisibleGraphemes(row);
  const grew = count - before;
  if (grew > 0) {
    if (!current.firstVisibleAt && current.firstIpcAt) current.firstVisibleAt = now;
    receivedAtLastGrowth = current.receivedGraphemes;
  }
  const settled = Boolean(row?.querySelector('article.message.settled'));
  if (settled && current.completeAt && !current.settledAt) current.settledAt = now;
  if (!current.completeAt || !settled) {
    const height = row ? row.getBoundingClientRect().height : -1;
    if (lastHeight >= 0 && height >= 0 && height < lastHeight - 1) {
      current.shrinks += 1;
      current.shrinkPx += lastHeight - height;
    }
    lastHeight = height;
    current.frames.push({
      t: now,
      grew,
      backlog: current.receivedGraphemes > receivedAtLastGrowth || pacerBacklog(),
      scrollWrites: frameScrollWrites,
    });
  }
  frameScrollWrites = 0;
  current.visibleGraphemes = count;
  if (
    (current.settledAt && now - current.settledAt >= SETTLE_TAIL_MS) ||
    (current.completeAt && now - current.completeAt >= ABANDON_MS)
  ) {
    endRun(now);
    return;
  }
  frame = requestAnimationFrame(sample);
}

/** Lane store: every accepted session frame, with its live tail. */
export function noteStreamLaneFrame(
  sessionId: string,
  tail: { id?: unknown; text?: unknown; streaming?: unknown } | null | undefined
): void {
  if (!transcriptScrollDiagnosticsEnabled()) return;
  const now = performance.now();
  const id = tail ? String(tail.id ?? '') : '';
  const text = tail && typeof tail.text === 'string' ? tail.text : '';
  const live = Boolean(tail) && tail?.streaming !== false;
  if (!live) {
    if (run && ipcTail.sessionId === sessionId && ipcTail.text && !run.completeAt) run.completeAt = now;
    if (ipcTail.sessionId === sessionId) ipcTail = { sessionId, id: '', text: '' };
    return;
  }
  if (!text) return;
  if (!run || (run.completeAt && id !== run.itemId)) {
    if (run) endRun(now);
    startRun(now, id);
  }
  const current = run;
  if (!current) return;
  const continues = ipcTail.sessionId === sessionId && ipcTail.id === id && text.startsWith(ipcTail.text);
  const added = continues ? graphemeCount(text.slice(ipcTail.text.length)) : graphemeCount(text);
  ipcTail = { sessionId, id, text };
  if (added <= 0) return;
  if (!current.firstIpcAt) current.firstIpcAt = now;
  current.receivedGraphemes += added;
  current.ipc.push({ t: now, size: added });
}

/** Lane store: a subscribed pane was notified. */
export function noteStreamPublish(): void {
  if (run && !run.completeAt) run.publish.push(performance.now());
}

/** Live assistant markdown committed `length` source characters. */
export function noteStreamCommit(length: number): void {
  if (run && !run.settledAt) run.commits.push({ t: performance.now(), size: length });
}

/** One worker parse round trip of live markdown. */
export function noteStreamWorkerParse(startedAt: number): void {
  if (run) run.workerLatency.push(performance.now() - startedAt);
}

/** One main-thread parse of live markdown. */
export function noteStreamSyncParse(durationMs: number, length: number): void {
  if (run) run.syncParse.push({ t: durationMs, size: length });
}

/** The paced reveal reports whether it still holds received text. */
export function setStreamPacerBacklogProbe(probe: () => boolean): void {
  pacerBacklog = probe;
}

function stats(values: number[]) {
  if (values.length === 0) return { n: 0, p50: 0, p90: 0, p95: 0, max: 0, mean: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    n: values.length,
    p50: round(at(0.5)),
    p90: round(at(0.9)),
    p95: round(at(0.95)),
    max: round(sorted[sorted.length - 1]),
    mean: round(values.reduce((sum, value) => sum + value, 0) / values.length),
  };
}

function gaps(times: number[]): number[] {
  const out: number[] = [];
  for (let index = 1; index < times.length; index += 1) out.push(times[index] - times[index - 1]);
  return out;
}

export function summarizeStreamRun(target: StreamRun | null = run ?? lastRun) {
  if (!target) return null;
  // The streamed window: first visible grapheme through the last growth.
  const firstGrowth = target.frames.findIndex((sample) => sample.grew > 0);
  let lastGrowth = -1;
  for (let index = target.frames.length - 1; index >= 0; index -= 1) {
    if (target.frames[index].grew > 0) {
      lastGrowth = index;
      break;
    }
  }
  const window = firstGrowth >= 0 ? target.frames.slice(firstGrowth, lastGrowth + 1) : [];
  const growth = window.filter((sample) => sample.grew > 0).map((sample) => sample.grew);
  const perFrame = stats(growth);
  const growthTimes = window.filter((sample) => sample.grew > 0).map((sample) => sample.t);
  return {
    durationMs: Math.round((target.endedAt || performance.now()) - target.startedAt),
    receivedGraphemes: target.receivedGraphemes,
    visibleGraphemes: target.visibleGraphemes,
    ipcGapMs: stats(gaps(target.ipc.map((entry) => entry.t))),
    ipcSize: stats(target.ipc.map((entry) => entry.size)),
    publishGapMs: stats(gaps(target.publish)),
    commitGapMs: stats(gaps(target.commits.map((entry) => entry.t))),
    workerLatencyMs: stats(target.workerLatency),
    syncParseMs: stats(target.syncParse.map((entry) => entry.t)),
    syncParseChars: stats(target.syncParse.map((entry) => entry.size)),
    paintGrowthGapMs: stats(gaps(growthTimes)),
    graphemesPerGrowthFrame: perFrame,
    p95OverMedian: perFrame.p50 ? Math.round((perFrame.p95 / perFrame.p50) * 100) / 100 : 0,
    streamFrames: window.length,
    emptyFramesWithBacklog: window.filter((sample) => sample.grew <= 0 && sample.backlog).length,
    maxScrollWritesPerFrame: Math.max(0, ...target.frames.map((sample) => sample.scrollWrites)),
    longTasks: stats(target.longTasks),
    longAnimationFrames: stats(target.longFrames),
    rowHeightShrinks: target.shrinks,
    rowHeightShrinkPx: Math.round(target.shrinkPx),
    scrollEvents: target.scroll,
    firstVisibleDelayMs:
      target.firstIpcAt && target.firstVisibleAt ? Math.round(target.firstVisibleAt - target.firstIpcAt) : null,
    completionToSettledMs:
      target.completeAt && target.settledAt ? Math.round(target.settledAt - target.completeAt) : null,
  };
}

if (typeof window !== 'undefined') {
  (window as typeof window & { __mixdogStreamMetrics?: unknown }).__mixdogStreamMetrics = {
    summary: () => summarizeStreamRun(),
    raw: () => run ?? lastRun,
    reset: () => {
      if (run) endRun(performance.now());
      lastRun = null;
      ipcTail = { sessionId: '', id: '', text: '' };
    },
  };
}
