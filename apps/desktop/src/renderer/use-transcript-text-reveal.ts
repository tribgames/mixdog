import { useCallback, useLayoutEffect, useSyncExternalStore } from 'react';
import { onSessionPreviewsDeleted } from './image-preview-store';
import { dropStreamFadeTimelines, reducedMotion } from './markdown-stream-fade';
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
/** Paced: a first text longer than this shows at once, unfaded (streamFadeTimeline's `primed`). */
export const REVEAL_JOIN_CHARS = 400;
/** Paced: residual buffered backlogs larger than this drain smoothly across frames on live -> settled instead of snapping in one frame. */
export const REVEAL_SETTLE_SNAP_MAX_CHARS = 220;
const REVEAL_DRAIN_MAX_STEP_CHARS = 180;
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
  /** Paced: live ended with a large buffered backlog that is draining smoothly. */
  draining: boolean;
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
  entry.draining = false;
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
    if (entry.draining || (entry.shown > 0 && backlog > REVEAL_REJOIN_CHARS)) {
      showUnpaced(entry);
      notify(entry);
    }
    return;
  }
  if (backlog <= 0) {
    entry.steppedAt = now;
    entry.idle = true;
    if (entry.draining) {
      entry.draining = false;
      notify(entry);
    }
    return;
  }
  const elapsed = now - entry.steppedAt;
  const interval = entry.draining ? REVEAL_MIN_STEP_MS : revealStepInterval(backlog);
  if (elapsed < interval) {
    wake(entry, interval - elapsed);
    return;
  }
  entry.steppedAt = now;
  const first = entry.text.search(/\S/);
  if (first === -1 || first >= entry.ceiling) {
    entry.idle = true;
    if (entry.draining) {
      entry.shown = entry.ceiling;
      entry.draining = false;
      notify(entry);
    }
    return;
  }
  let stepChars: number;
  if (!entry.draining) {
    stepChars = revealStepChars(backlog, elapsed);
  } else if (backlog <= REVEAL_STEP_CHARS * 4) {
    stepChars = backlog;
  } else {
    stepChars = Math.min(REVEAL_DRAIN_MAX_STEP_CHARS, Math.max(REVEAL_STEP_CHARS * 3, Math.ceil(backlog / 4)));
  }
  const end = pacedRevealStep(entry.text, Math.max(entry.shown, first), entry.ceiling, stepChars);
  if (entry.draining && (end >= entry.ceiling || end <= entry.shown)) {
    entry.shown = entry.ceiling;
    entry.draining = false;
    entry.idle = true;
    notify(entry);
    return;
  }
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
  /** True while draining a large residual backlog after live -> settled. */
  draining: boolean;
}

/** What a render of the row whose committed reveal is `entry` shows of
 *  `text` at `now` (`live`: the part still streams; ended, small tails settle
 *  at once while large buffered backlogs drain smoothly across frames).
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
  if (!live) {
    const shouldDrain =
      paced &&
      !rewritten &&
      !documentHidden() &&
      entry !== undefined &&
      entry.shown > 0 &&
      entry.shown < text.length &&
      (entry.draining || entry.text.length - entry.shown > REVEAL_SETTLE_SNAP_MAX_CHARS);
    if (shouldDrain) return { shown: entry.shown, ceiling: text.length, revision, draining: true };
    return { shown: text.length, ceiling: text.length, revision, draining: false };
  }
  const held = paced ? pacedRevealCeiling(text) : revealHold(text, text.length, true);
  if (!entry) return { shown: paced ? firstShown(text, held) : held, ceiling: held, revision, draining: false };
  if (text === entry.text && paced === entry.paced) {
    return { shown: entry.shown, ceiling: entry.ceiling, revision, draining: false };
  }
  let shown = rewritten ? commonPrefix(entry.text, text, Math.min(entry.shown, text.length)) : entry.shown;
  const ceiling = Math.max(held, shown);
  if (!paced) {
    const paints = rewritten || shown === 0 || paced !== entry.paced || now >= entry.nextAt;
    return { shown: paints ? ceiling : shown, ceiling, revision, draining: false };
  }
  const growth = text.length - entry.text.length;
  if (shown > 0 && ceiling - shown > REVEAL_REJOIN_CHARS && growth > REVEAL_REJOIN_CHARS) shown = ceiling;
  if (shown === 0) shown = firstShown(text, ceiling);
  return { shown, ceiling, revision, draining: false };
}

/** A render of row `key` showing `view` of `text` committed at `now`: the
 *  reveal goes on from there (a mode change keeps what shows), or, the part
 *  ended (`live` false), it drains any large residual backlog before resting. */
function recordReveal(key: string, text: string, view: RevealView, paced: boolean, live: boolean, now: number): void {
  let entry = registry.get(key);
  if (
    entry?.text === text &&
    entry.shown === view.shown &&
    entry.ceiling === view.ceiling &&
    entry.revision === view.revision &&
    entry.paced === paced &&
    entry.draining === view.draining
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
      draining: false,
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
  entry.draining = view.draining;
  revisions = Math.max(revisions, view.revision);
  if (!live && !view.draining) {
    entry.idle = true;
    pause(entry);
    return;
  }
  if (entry.ceiling <= entry.shown) {
    // Drained: the next arrival restarts the chain, timed from then.
    entry.draining = false;
    entry.idle = true;
    return;
  }
  if (!subscribed(key)) return;
  if (view.draining) wake(entry, Math.max(0, REVEAL_MIN_STEP_MS - (now - entry.steppedAt)));
  else if (paced) wake(entry, 0);
  else if (entry.timer === null) wake(entry, entry.nextAt - now);
}

/** The painted text of one transcript row. A live assistant part (`key`,
 *  `streaming`) shows what it received, paced in steps when `paced`, else
 *  coalesced; anything else shows `text` whole (draining large residual paced
 *  backlogs smoothly across frames). `revision` names the last change of the
 *  painted text that was not paced in (a rewrite, or what showed while the
 *  document was hidden; a later one is larger; 0: none known): text shown by
 *  it shows unfaded. */
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
}): { text: string; revision: number; draining: boolean } {
  const mode = paced && !reducedMotion();
  const entry = key ? registry.get(key) : undefined;
  const view = key && (streaming || entry) ? revealView(entry, text, performance.now(), mode, streaming) : null;
  const active = Boolean(key) && (streaming || Boolean(view?.draining));
  const subscribeRow = useCallback(
    (listener: () => void) => (active ? subscribe(key, listener) : () => {}),
    [key, active]
  );
  const version = useCallback(() => (active ? (registry.get(key)?.version ?? 0) : 0), [key, active]);
  useSyncExternalStore(subscribeRow, version, version);
  const committed = key ? registry.get(key) : undefined;
  const latest =
    committed !== entry && key && (streaming || committed)
      ? revealView(committed, text, performance.now(), mode, streaming)
      : view;
  useLayoutEffect(() => {
    if (latest) recordReveal(key, text, latest, mode, streaming, performance.now());
  });
  if (!latest)
    return {
      text: streaming ? text.slice(0, revealHold(text, text.length, true)) : text,
      revision: 0,
      draining: false,
    };
  const full = latest.shown >= text.length;
  return {
    text: full ? text : text.slice(0, latest.shown),
    revision: latest.revision,
    draining: !full && latest.draining,
  };
}
