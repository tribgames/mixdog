// slow-span.mjs
// Passive per-request timing spans. Every traced call is timed on the same
// monotonic clock the owner heartbeat uses (performance.now), completed spans
// over `minMs` land in a bounded ring, and spans over `slowMs` are logged as
// `[slow-op] <label> <ms>`. When the event loop stalls, `describe(from, to)`
// names the spans that overlapped the stall window. Spans carry labels and
// phase durations only — never payloads.

import { performance } from 'node:perf_hooks';
import { runtimeAsyncLocalStorage } from './root-async-context.mjs';

export const SPAN_RING_MIN_MS = 25;
export const SPAN_SLOW_MS = 1000;
export const SPAN_RING_CAPACITY = 64;

const current = runtimeAsyncLocalStorage();

/** Short, log-safe id of a session id. */
export function shortId(id) {
  const text = String(id ?? '');
  return text ? text.slice(0, 8) : '';
}

/** Appends detail (e.g. the action name) to the label of the span the caller runs in. */
export function annotateSpan(detail) {
  const span = current.getStore();
  if (span && detail) span.label += `:${detail}`;
}

/** Closes the running phase of the caller's span at `now`, under `name`. */
export function markPhase(name) {
  const span = current.getStore();
  if (!span) return;
  const t = span.now();
  span.phases.push([name, t - span.mark]);
  span.mark = t;
}

/** Adds `ms` to the named cost of the caller's span. Unlike markPhase these
 *  phases may overlap each other and the sequential ones (parallel git children,
 *  a gate wait inside an action), so each name reports its summed time. */
export function notePhase(name, ms) {
  const span = current.getStore();
  if (!span || !(ms >= 0)) return;
  span.costs.set(name, (span.costs.get(name) ?? 0) + ms);
}

/** Runs `task`, adding its elapsed time to the caller's span under `name`. */
export async function timePhase(name, task) {
  const span = current.getStore();
  if (!span) return task();
  const started = span.now();
  try {
    return await task();
  } finally {
    notePhase(name, span.now() - started);
  }
}

const round = (ms) => Math.round(ms);

function formatSpan(span) {
  const phases = [...span.phases, ...span.costs].map(([name, ms]) => `${name}=${round(ms)}`).join(' ');
  return `${span.label} ${round(span.ms)}ms${phases ? ` ${phases}` : ''}`;
}

export function createSlowSpans({
  now = () => performance.now(),
  capacity = SPAN_RING_CAPACITY,
  minMs = SPAN_RING_MIN_MS,
  slowMs = SPAN_SLOW_MS,
  log = () => {},
} = {}) {
  const ring = [];
  let sink = log;

  function complete(span) {
    span.end = now();
    span.ms = span.end - span.start;
    if (span.ms >= minMs) {
      ring.push({
        label: span.label,
        start: span.start,
        end: span.end,
        ms: span.ms,
        phases: span.phases,
        costs: span.costs,
      });
      if (ring.length > capacity) ring.shift();
    }
    if (span.ms >= slowMs) {
      try {
        sink(`[slow-op] ${formatSpan(span)}`);
      } catch {
        /* logging must not fail the call */
      }
    }
  }

  return {
    setLog(next) {
      sink = typeof next === 'function' ? next : () => {};
    },
    /** Runs `fn` inside a span; markPhase/annotateSpan inside it attach to this span. */
    async trace(label, fn) {
      const start = now();
      const span = { label: String(label), start, mark: start, now, phases: [], costs: new Map() };
      try {
        return await current.run(span, fn);
      } finally {
        complete(span);
      }
    },
    /** Completed spans overlapping [from, to], longest overlap first. */
    overlapping(from, to, limit = 3) {
      return ring
        .map((span) => ({ span, overlap: Math.min(span.end, to) - Math.max(span.start, from) }))
        .filter((row) => row.overlap > 0)
        .sort((a, b) => b.overlap - a.overlap || b.span.end - a.span.end)
        .slice(0, limit)
        .map((row) => row.span);
    },
    /** One-line description of the spans overlapping a stall window ('' when none). */
    describe(from, to, limit = 3) {
      const spans = this.overlapping(from, to, limit);
      return spans.length ? `spans: ${spans.map((span) => formatSpan({ ...span })).join('; ')}` : '';
    },
    get recent() {
      return ring.slice();
    },
  };
}

/** Process-wide recorder; the daemon points its log at daemon.log. */
export const slowSpans = createSlowSpans();
