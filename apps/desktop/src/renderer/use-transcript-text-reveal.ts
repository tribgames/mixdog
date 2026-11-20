/**
 * Paint pacing of the live assistant part.
 *
 * Paced (the coding transcript):
 * - Steps: what was received is revealed in steps of REVEAL_STEP_CHARS,
 *   ending after the last space when that keeps more than half the step, on a
 *   setTimeout chain. The time between steps follows the backlog (received
 *   minus shown), recomputed at every step: TARGET_LAG × STEP / backlog,
 *   within [REVEAL_MIN_STEP_MS, REVEAL_MAX_STEP_MS]. While text arrives at a
 *   steady rate the reveal settles REVEAL_TARGET_LAG_MS behind it (the
 *   backlog is then rate × TARGET_LAG); a lump with nothing after it drains
 *   slower as it shrinks (a 400-character opening of five-letter words: its
 *   first step at once, the other 19 over about 1.5 s).
 * - Catch-up: a backlog the fastest cadence cannot drain in time (above
 *   TARGET_LAG × STEP / MIN_STEP characters) adds its excess to the step,
 *   scaled by how long the step waited, up to REVEAL_CATCH_UP_RAMP_MS.
 * - Rejoin: one delivery growing the text by more than REVEAL_REJOIN_CHARS
 *   while more than that waits shows everything at once; so does what arrived
 *   while the document was hidden, as a new `revision`: it shows unfaded.
 * - A part's first text longer than REVEAL_JOIN_CHARS shows at once, else as
 *   a first step. A remount continues where it was (the reveal is kept per
 *   row key).
 * - Once the backlog is drained the chain idles; the next arrival restarts
 *   it, timed from that arrival.
 * - Hold-back: a line that is only a list or heading marker, and a closing
 *   fence being typed, wait (stream-reveal-hold pacedRevealCeiling).
 *
 * Unpaced (chat): what was received shows whole, at most one paint per
 * REVEAL_INTERVAL_MS, held back at any unfinished line construct
 * (stream-reveal-hold revealHold).
 *
 * The part ending shows the rest at once, paced or not: the backlog is at
 * most about REVEAL_TARGET_LAG_MS of steps, and what it held fades in as one
 * last phrase (the row stays live until that fade ended, transcript-row
 * useStreamFade). Reduced motion shows everything at once,
 * and received text is never delayed upstream: canonical text, persistence,
 * copy and tools all read the full text.
 *
 * A row's reveal outlives its mounts: rows subscribe by key, so a mode change
 * (reduced motion, paced) keeps the reveal and its subscribers, and what
 * already shows stays shown. Steps run only while a row is mounted; a
 * remount continues where the last mount stopped. A deleted session's
 * reveals (and fade timelines) are dropped.
 *
 * Rendering changes nothing: a render works out what it shows from the
 * committed reveal (revealView) and its layout effect records that
 * (recordReveal), so a render React discards leaves the reveal as the
 * committed row shows it.
 */
import { useCallback, useLayoutEffect, useSyncExternalStore } from 'react';
import { onSessionPreviewsDeleted } from './image-preview-store';
import { dropStreamFadeTimelines } from './markdown-stream-fade';
import { pacedRevealCeiling, pacedRevealStep, revealHold } from './stream-reveal-hold';
import { transcriptRowNamespace } from './transcript-virtual-cache';

/** Unpaced: least time between two paints of a growing part. */
export const REVEAL_INTERVAL_MS = 33;
/** Paced: characters a step reveals. */
const REVEAL_STEP_CHARS = 22;
/** Paced: while text arrives steadily, the reveal trails it by this long. */
const REVEAL_TARGET_LAG_MS = 550;
/** Paced: shortest and longest time between steps. */
const REVEAL_MIN_STEP_MS = 25;
const REVEAL_MAX_STEP_MS = 150;
/** Paced: a step that waited this long adds the whole excess backlog. */
const REVEAL_CATCH_UP_RAMP_MS = 75;
/** Paced: a first text longer than this shows at once, and unfaded
 *  (streamFadeTimeline's `primed`): a reply opening with a lump (after a
 *  thinking phase) reads at once instead of spreading over the target lag.
 *  Below it the opening paces and fades like the rest of the reply. */
export const REVEAL_JOIN_CHARS = 400;
/** Paced: one delivery this large over a backlog this large shows at once. */
const REVEAL_REJOIN_CHARS = 600;
/** The backlog the fastest cadence drains within the target lag. */
const CATCH_UP_FROM = (REVEAL_TARGET_LAG_MS * REVEAL_STEP_CHARS) / REVEAL_MIN_STEP_MS;
const REGISTRY_LIMIT = 64;
/** A character that paints something (not whitespace or a markdown marker). */
const PAINTING_CHAR = /[^`*_~[\]()<>#|\\!\s]/;

/** Whether still-streaming `text` paints anything: a row opens only with
 *  text that shows (not only whitespace or markdown markers). */
export function streamingTextPaints(text: string): boolean {
  return PAINTING_CHAR.test(text);
}

/** Paced: time between steps while `backlog` characters wait. */
export function revealStepInterval(backlog: number): number {
  const interval = (REVEAL_TARGET_LAG_MS * REVEAL_STEP_CHARS) / backlog;
  return Math.min(REVEAL_MAX_STEP_MS, Math.max(REVEAL_MIN_STEP_MS, interval));
}

/** Paced: characters of a step taken `elapsed` ms after the last one while
 *  `backlog` characters wait. */
export function revealStepChars(backlog: number, elapsed: number): number {
  const excess = Math.max(0, backlog - CATCH_UP_FROM);
  return REVEAL_STEP_CHARS + Math.ceil(excess * Math.min(1, elapsed / REVEAL_CATCH_UP_RAMP_MS));
}
interface RevealEntry {
  key: string;
  /** Received text. */
  text: string;
  /** End of what shows. */
  shown: number;
  /** What may show: the hold-back of the received text. */
  ceiling: number;
  paced: boolean;
  /** Unpaced: no paint before this. */
  nextAt: number;
  /** Paced: when the last step was taken (or the chain restarted). */
  steppedAt: number;
  /** Paced: the backlog drained and the chain stopped. */
  idle: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** Set on every paint, unique across entries: the store version rows
   *  subscribe to. */
  version: number;
  /** The last rewrite of its received text (0: none), unique across
   *  entries; the word fade starts over on a new one. */
  revision: number;
}

const registry = new Map<string, RevealEntry>();
/** Mounted rows by key; they outlive the key's entry. */
const subscribers = new Map<string, Set<() => void>>();
let versions = 0;
let revisions = 0;

function subscribed(key: string): boolean {
  return (subscribers.get(key)?.size ?? 0) > 0;
}

/** Keeps the registry near REGISTRY_LIMIT by dropping the oldest entries no
 *  row subscribes to. */
function remember(key: string, entry: RevealEntry): void {
  registry.delete(key);
  registry.set(key, entry);
  for (const [oldKey, old] of registry) {
    if (registry.size <= REGISTRY_LIMIT) break;
    if (old === entry || subscribed(oldKey)) continue;
    forget(oldKey, old);
  }
}

function forget(key: string, entry: RevealEntry): void {
  if (entry.timer !== null) clearTimeout(entry.timer);
  entry.timer = null;
  registry.delete(key);
}

function motionReduced(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function documentHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden;
}

function notify(entry: RevealEntry): void {
  versions += 1;
  entry.version = versions;
  for (const listener of [...(subscribers.get(entry.key) ?? [])]) listener();
}

function wake(entry: RevealEntry, ms: number): void {
  if (entry.timer !== null) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => tick(entry), Math.max(0, Math.ceil(ms)));
}

function pause(entry: RevealEntry): void {
  if (entry.timer !== null) clearTimeout(entry.timer);
  entry.timer = null;
}

/** A row of `key` mounts: its reveal runs while any is mounted. */
function subscribe(key: string, listener: () => void): () => void {
  let rows = subscribers.get(key);
  if (!rows) {
    rows = new Set();
    subscribers.set(key, rows);
  }
  rows.add(listener);
  const entry = registry.get(key);
  if (rows.size === 1 && entry && entry.timer === null && entry.ceiling > entry.shown) wake(entry, 0);
  return () => {
    rows.delete(listener);
    if (rows.size > 0) return;
    if (subscribers.get(key) === rows) subscribers.delete(key);
    const current = registry.get(key);
    if (current) pause(current);
  };
}

// A deleted session's rows never reveal again.
onSessionPreviewsDeleted((sessionId) => {
  const prefixes = [...new Set([`${sessionId}:`, `${transcriptRowNamespace(sessionId)}:`])];
  for (const [key, entry] of registry) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) forget(key, entry);
  }
  dropStreamFadeTimelines(prefixes);
});

/** Unpaced: show everything that may show. */
function paint(entry: RevealEntry, now: number): void {
  entry.shown = entry.ceiling;
  entry.nextAt = now + REVEAL_INTERVAL_MS;
}

/** Everything that may show shows at once, not paced in (the document was
 *  hidden meanwhile): a new revision, so it shows unfaded
 *  (markdown-stream-fade). */
function showUnpaced(entry: RevealEntry): void {
  entry.shown = entry.ceiling;
  revisions += 1;
  entry.revision = revisions;
}

function tick(entry: RevealEntry): void {
  entry.timer = null;
  // No row mounted: the next mount resumes it.
  if (!subscribed(entry.key)) return;
  const now = performance.now();
  const backlog = entry.ceiling - entry.shown;
  if (!entry.paced) {
    if (documentHidden() || backlog <= 0) return;
    paint(entry, now);
    notify(entry);
    return;
  }
  if (documentHidden()) {
    if (entry.shown > 0 && backlog > REVEAL_REJOIN_CHARS) {
      showUnpaced(entry);
      notify(entry);
    }
    return;
  }
  if (backlog <= 0) {
    entry.steppedAt = now;
    entry.idle = true;
    return;
  }
  const elapsed = now - entry.steppedAt;
  const interval = revealStepInterval(backlog);
  if (elapsed < interval) {
    wake(entry, interval - elapsed);
    return;
  }
  entry.steppedAt = now;
  const first = entry.text.search(/\S/);
  if (first === -1 || first >= entry.ceiling) {
    entry.idle = true;
    return;
  }
  const end = pacedRevealStep(
    entry.text,
    Math.max(entry.shown, first),
    entry.ceiling,
    revealStepChars(backlog, elapsed)
  );
  if (end > entry.shown) {
    entry.shown = end;
    notify(entry);
  }
  wake(entry, REVEAL_MIN_STEP_MS);
}

if (typeof document !== 'undefined') {
  // Shown again: what arrived meanwhile shows at once.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    const now = performance.now();
    for (const entry of registry.values()) {
      if (entry.ceiling > entry.shown) {
        showUnpaced(entry);
        entry.nextAt = now + REVEAL_INTERVAL_MS;
        notify(entry);
      }
      if (entry.paced && subscribed(entry.key)) wake(entry, 0);
    }
  });
}

/** Paced: what a part's first text shows: all of it when long, else a step. */
function firstShown(text: string, ceiling: number): number {
  const first = text.search(/\S/);
  if (first === -1 || first >= ceiling) return 0;
  return ceiling > REVEAL_JOIN_CHARS ? ceiling : pacedRevealStep(text, first, ceiling, REVEAL_STEP_CHARS);
}

function commonPrefix(left: string, right: string, limit: number): number {
  let at = 0;
  while (at < limit && left.charCodeAt(at) === right.charCodeAt(at)) at += 1;
  return at;
}

/** What one render of a row shows. */
interface RevealView {
  /** End of what shows. */
  shown: number;
  /** What may show. */
  ceiling: number;
  /** The last revision of what shows. */
  revision: number;
}

/** What a render of the row whose committed reveal is `entry` shows of
 *  `text` at `now` (`live`: the part still streams; ended, all of it shows).
 *  Worked out from the committed reveal; nothing is recorded. */
function revealView(
  entry: RevealEntry | undefined,
  text: string,
  now: number,
  paced: boolean,
  live: boolean
): RevealView {
  // Text that does not continue what showed is a rewrite: a new revision.
  const rewritten = entry !== undefined && !text.startsWith(entry.text.slice(0, entry.shown));
  const revision = rewritten ? revisions + 1 : (entry?.revision ?? 0);
  if (!live) return { shown: text.length, ceiling: text.length, revision };
  const held = paced ? pacedRevealCeiling(text) : revealHold(text, text.length, true);
  if (!entry) return { shown: paced ? firstShown(text, held) : held, ceiling: held, revision };
  if (text === entry.text && paced === entry.paced) return { shown: entry.shown, ceiling: entry.ceiling, revision };
  let shown = rewritten ? commonPrefix(entry.text, text, Math.min(entry.shown, text.length)) : entry.shown;
  const ceiling = Math.max(held, shown);
  if (!paced) {
    const paints = rewritten || shown === 0 || paced !== entry.paced || now >= entry.nextAt;
    return { shown: paints ? ceiling : shown, ceiling, revision };
  }
  const growth = text.length - entry.text.length;
  if (shown > 0 && ceiling - shown > REVEAL_REJOIN_CHARS && growth > REVEAL_REJOIN_CHARS) shown = ceiling;
  if (shown === 0) shown = firstShown(text, ceiling);
  return { shown, ceiling, revision };
}

/** A render of row `key` showing `view` of `text` committed at `now`: the
 *  reveal goes on from there (a mode change keeps what shows), or, the part
 *  ended (`live` false), it rests. */
function recordReveal(key: string, text: string, view: RevealView, paced: boolean, live: boolean, now: number): void {
  let entry = registry.get(key);
  if (
    entry?.text === text &&
    entry.shown === view.shown &&
    entry.ceiling === view.ceiling &&
    entry.revision === view.revision &&
    entry.paced === paced
  ) {
    return;
  }
  if (!entry) {
    entry = {
      key,
      text,
      shown: 0,
      ceiling: 0,
      paced,
      nextAt: now,
      steppedAt: now,
      idle: false,
      timer: null,
      version: 0,
      revision: 0,
    };
    remember(key, entry);
  }
  if (entry.paced !== paced) {
    entry.paced = paced;
    entry.nextAt = now;
    entry.steppedAt = now;
    entry.idle = false;
  }
  if (!paced && view.shown !== entry.shown) entry.nextAt = now + REVEAL_INTERVAL_MS;
  // Drained, the chain restarts timed from this arrival.
  if (text !== entry.text && entry.idle) {
    entry.idle = false;
    entry.steppedAt = now;
  }
  entry.text = text;
  entry.shown = view.shown;
  entry.ceiling = view.ceiling;
  entry.revision = view.revision;
  revisions = Math.max(revisions, view.revision);
  if (!live) {
    entry.idle = true;
    pause(entry);
    return;
  }
  if (entry.ceiling <= entry.shown) {
    // Drained: the next arrival restarts the chain, timed from then.
    entry.idle = true;
    return;
  }
  if (!subscribed(key)) return;
  if (paced) wake(entry, 0);
  else if (entry.timer === null) wake(entry, entry.nextAt - now);
}

/** The painted text of one transcript row. A live assistant part (`key`,
 *  `streaming`) shows what it received, paced in steps when `paced`, else
 *  coalesced; anything else shows `text` whole. `revision` names the last
 *  change of the painted text that was not paced in (a rewrite, or what
 *  showed while the document was hidden; a later one is larger; 0: none
 *  known): text shown by it shows unfaded. */
export function useTranscriptTextReveal({
  key,
  text,
  streaming,
  paced = false,
}: {
  key: string;
  text: string;
  streaming: boolean;
  paced?: boolean;
}): { text: string; revision: number } {
  const live = Boolean(key) && streaming;
  const subscribeRow = useCallback((listener: () => void) => (live ? subscribe(key, listener) : () => {}), [key, live]);
  const version = useCallback(() => (live ? (registry.get(key)?.version ?? 0) : 0), [key, live]);
  useSyncExternalStore(subscribeRow, version, version);
  const mode = paced && !motionReduced();
  const entry = key ? registry.get(key) : undefined;
  const view = key && (streaming || entry) ? revealView(entry, text, performance.now(), mode, streaming) : null;
  useLayoutEffect(() => {
    if (view) recordReveal(key, text, view, mode, streaming, performance.now());
  });
  if (!view) return { text: streaming ? text.slice(0, revealHold(text, text.length, true)) : text, revision: 0 };
  return { text: view.shown >= text.length ? text : text.slice(0, view.shown), revision: view.revision };
}
