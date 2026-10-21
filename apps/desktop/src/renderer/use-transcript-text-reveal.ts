/**
 * Reveal of the live assistant part.
 *
 * - Steps: received text is revealed in steps. A step shows at least
 *   REVEAL_STEP_CHARS more, or a quarter of what waits when more does
 *   (REVEAL_CATCH_UP_SHARE), so a large backlog is caught up within a few
 *   steps. The next step waits until this one's word stagger has played (the
 *   stagger of its characters, markdown-stream-fade), at least
 *   REVEAL_MIN_STEP_MS.
 * - A part's first text shows in one step when it is longer than
 *   REVEAL_JOIN_CHARS (a reply landing whole), else as a first step.
 * - Hold-back: what shows never passes the start of an unfinished line
 *   construct of the received text (stream-reveal-hold), so table rows,
 *   headings, fence and code lines appear whole and a list item with its
 *   marker; and never moves back while the text only grows.
 * - Each step's new words fade in (markdown-stream-fade), staggered top to
 *   bottom within the step.
 * - A live row this renderer did not watch being born (a reload, a session
 *   entered mid-stream) shows the text it mounts with whole and unfaded; only
 *   later growth is revealed in steps. A remount continues where it was.
 * - The part ending shows the rest at once, unfaded. So do a rewrite that
 *   does not extend the text, a document shown again after being hidden, and
 *   reduced motion (always).
 * - Received text is never delayed upstream: canonical text, persistence,
 *   copy and tools all read the full text.
 */
import { useCallback, useLayoutEffect, useSyncExternalStore } from 'react';
import {
  type FadeArrival,
  STREAM_FADE_DURATION_MS,
  STREAM_FADE_STAGGER_MAX_MS,
  STREAM_FADE_STAGGER_MS_PER_CHAR,
} from './markdown-stream-fade';
import { revealHold } from './stream-reveal-hold';

/** Least characters a step reveals. */
export const REVEAL_STEP_CHARS = 22;
/** A step reveals at least this share of what waits. */
export const REVEAL_CATCH_UP_SHARE = 1 / 4;
/** Least time between steps; also the cadence steps are checked at. */
export const REVEAL_MIN_STEP_MS = 25;
/** A part's first text longer than this shows in one step. */
export const REVEAL_JOIN_CHARS = 120;
/** Rows of a session mounted at least this long before a live row was born:
 *  the session was on screen and watched it arrive (its own first commits,
 *  live row included, land within it). */
const WATCH_SETTLE_MS = 200;
const REGISTRY_LIMIT = 64;
/** A character that paints something (not whitespace or a markdown marker). */
const PAINTING_CHAR = /[^`*_~[\]()<>#|\\!\s]/;

/** Whether still-streaming `text` paints anything: a row opens only with
 *  text that shows (not only whitespace or markdown markers). */
export function streamingTextPaints(text: string): boolean {
  return PAINTING_CHAR.test(text);
}

/** How long a step of `chars` characters holds the next one: its stagger. */
function stepHoldMs(chars: number): number {
  return Math.max(REVEAL_MIN_STEP_MS, Math.min(STREAM_FADE_STAGGER_MAX_MS, chars * STREAM_FADE_STAGGER_MS_PER_CHAR));
}

/** Never end inside a surrogate pair. */
function wholeChar(text: string, at: number): number {
  return at > 0 && at < text.length && (text.charCodeAt(at) & 0xfc00) === 0xdc00 ? at - 1 : at;
}

interface RevealEntry {
  /** Received text. */
  text: string;
  /** End of what shows. */
  shown: number;
  /** The reveal never passes this: the hold-back of the received text. */
  ceiling: number;
  /** No step before this. */
  nextAt: number;
  /** The latest step, and how long its words fade (0: unfaded). */
  arrival: FadeArrival;
  fadeMs: number;
  /** Bumped on every step: the store version rows subscribe to. */
  version: number;
  listeners: Set<() => void>;
}

const registry = new Map<string, RevealEntry>();
const active = new Set<RevealEntry>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** Keeps the registry near REGISTRY_LIMIT by dropping the oldest entries no
 *  row subscribes to and no step waits on: a mounted or still revealing row
 *  keeps its entry, so its subscription never points at a discarded one. */
function remember(key: string, entry: RevealEntry): void {
  registry.delete(key);
  registry.set(key, entry);
  for (const [oldKey, old] of registry) {
    if (registry.size <= REGISTRY_LIMIT) break;
    if (old === entry || old.listeners.size > 0 || active.has(old)) continue;
    registry.delete(oldKey);
  }
}

function motionReduced(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function notify(entry: RevealEntry): void {
  entry.version += 1;
  for (const listener of [...entry.listeners]) listener();
}

/** Show up to `end` as one step at `now`. */
function reveal(entry: RevealEntry, end: number, now: number, fadeMs = STREAM_FADE_DURATION_MS): void {
  const chars = end - entry.shown;
  entry.shown = end;
  entry.arrival = { at: now };
  entry.fadeMs = fadeMs;
  entry.nextAt = now + stepHoldMs(chars);
}

/** The next step's end: at least the step size, at a point the hold-back
 *  allows, never past the ceiling. */
function stepEnd(entry: RevealEntry): number {
  const size = Math.max(REVEAL_STEP_CHARS, Math.ceil((entry.ceiling - entry.shown) * REVEAL_CATCH_UP_SHARE));
  let cut = entry.shown;
  let end = entry.shown;
  while (end <= entry.shown && cut < entry.ceiling) {
    cut = Math.min(entry.ceiling, cut + size);
    end = cut >= entry.ceiling ? entry.ceiling : revealHold(entry.text, cut, true);
  }
  return wholeChar(entry.text, Math.max(end, entry.shown));
}

function run(): void {
  timer = null;
  if (typeof document !== 'undefined' && document.hidden) return;
  const now = performance.now();
  for (const entry of [...active]) {
    if (entry.shown >= entry.ceiling) {
      active.delete(entry);
      continue;
    }
    if (now < entry.nextAt) continue;
    reveal(entry, stepEnd(entry), now);
    notify(entry);
  }
  schedule();
}

function schedule(): void {
  if (timer !== null || active.size === 0) return;
  timer = setTimeout(run, REVEAL_MIN_STEP_MS);
}

if (typeof document !== 'undefined') {
  // Shown again: what arrived meanwhile shows at once.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    for (const entry of [...active]) {
      if (entry.shown < entry.ceiling) {
        reveal(entry, entry.ceiling, performance.now(), 0);
        notify(entry);
      }
      active.delete(entry);
    }
  });
}

/** Per session: mounted transcript rows and since when the session shows. */
const watching = new Map<string, { rows: number; since: number }>();

function watched(scope: string, at: number): boolean {
  const session = scope ? watching.get(scope) : undefined;
  return Boolean(session) && at - (session?.since ?? at) >= WATCH_SETTLE_MS;
}

function watchScope(scope: string, now: number): () => void {
  const session = watching.get(scope) ?? { rows: 0, since: now };
  session.rows += 1;
  watching.set(scope, session);
  return () => {
    session.rows -= 1;
    if (session.rows <= 0 && watching.get(scope) === session) watching.delete(scope);
  };
}

/** Record `text` received by the live row `key` at `now`. */
function receive(key: string, scope: string, text: string, now: number): RevealEntry {
  const ceiling = revealHold(text, text.length, true);
  const known = registry.get(key);
  if (!known) {
    const entry: RevealEntry = {
      text,
      shown: 0,
      ceiling,
      nextAt: now,
      arrival: { at: now },
      fadeMs: 0,
      version: 0,
      listeners: new Set(),
    };
    remember(key, entry);
    if (!watched(scope, now) || motionReduced()) reveal(entry, ceiling, now, 0);
    else if (ceiling > REVEAL_JOIN_CHARS) reveal(entry, ceiling, now);
    else if (ceiling > 0) reveal(entry, stepEnd(entry), now);
  } else if (text !== known.text) {
    const grew = text.startsWith(known.text.slice(0, known.shown));
    known.text = text;
    known.ceiling = grew ? Math.max(ceiling, known.shown) : ceiling;
    if (!grew || motionReduced()) reveal(known, known.ceiling, now, 0);
    else if (known.shown === 0 && known.ceiling > 0) reveal(known, stepEnd(known), now);
  }
  const entry = registry.get(key) as RevealEntry;
  if (entry.shown < entry.ceiling) {
    active.add(entry);
    schedule();
  }
  return entry;
}

interface TranscriptTextReveal {
  /** What the row paints. */
  text: string;
  /** How long the latest step's new words fade (0: unfaded). */
  fadeMs: number;
  /** The latest step: its new words fade staggered from their first. */
  arrival: FadeArrival | null;
}

/** The painted text of one transcript row. A live assistant part (`key`,
 *  `streaming`) reveals what it received in steps, each fading in; anything
 *  else shows `text` whole. Every transcript row passes its session `scope`:
 *  rows mounted before a live row was born mean the session watched it. */
export function useTranscriptTextReveal({
  key,
  scope = '',
  text,
  streaming,
}: {
  key: string;
  scope?: string;
  text: string;
  streaming: boolean;
}): TranscriptTextReveal {
  useLayoutEffect(() => (scope ? watchScope(scope, performance.now()) : undefined), [scope]);
  const live = Boolean(key) && streaming;
  const subscribe = useCallback(
    (listener: () => void) => {
      const entry = live ? registry.get(key) : undefined;
      if (!entry) return () => {};
      entry.listeners.add(listener);
      return () => entry.listeners.delete(listener);
    },
    [key, live]
  );
  const version = useCallback(() => (live ? (registry.get(key)?.version ?? 0) : 0), [key, live]);
  useSyncExternalStore(subscribe, version, version);
  if (!streaming) {
    const ended = key ? registry.get(key) : undefined;
    if (ended) {
      active.delete(ended);
      registry.delete(key);
    }
    return { text, fadeMs: 0, arrival: null };
  }
  if (!key) {
    const cut = revealHold(text, text.length, true);
    return { text: text.slice(0, cut), fadeMs: 0, arrival: null };
  }
  // Recording received text is idempotent per text, so it happens while
  // rendering: a first step paints in the commit that receives it.
  const entry = receive(key, scope, text, performance.now());
  return {
    text: entry.shown >= text.length ? text : text.slice(0, entry.shown),
    fadeMs: entry.fadeMs,
    arrival: entry.arrival,
  };
}
