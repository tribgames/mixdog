import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { historyPositionOf } from '../../../../packages/protocol-client/src/rows.ts';
import { WINDOW_LEAD_ROWS } from '../../../../packages/protocol-client/src/transcript-window.ts';
import type { DesktopTranscriptMove } from '../shared/contract-session';
import type { TranscriptItem } from './desktop-types';
import { usePaneKey } from './pane-key-context';
import { transcriptTurnKeys } from './renderer-logic.mjs';
import { useSurfaceActive } from './surface-activity';
import { createSettledProjector } from './transcript-rows';
import { prefetchTurnChanges, type TurnChangesRef } from './turn-changes-model';
import { defaultSessionLaneStore } from './session-lane-store';
import { noteHistoryPageRequest } from './tool-output-prefetch';
import { parseStreamingMarkdownAst, readCachedStreamingMarkdownAst } from './markdown-worker-client';
import {
  pendingReaderPlace,
  readerPlace,
  rowOfPlace,
  type ReaderPlace,
  useReaderPlaceVersion,
  voidReaderPlace,
} from './transcript-list-reader-place';
import { TRANSCRIPT_MIN_ROW_PX } from './transcript-virtual-cache';
import {
  nextTranscriptHistoryLimit,
  nextTranscriptTailLimit,
  TRANSCRIPT_HISTORY_PAGE_ITEMS,
  TranscriptHistoryPager,
  type TranscriptPagingOutcome,
} from './transcript-history';
import { transcriptScrollExtent, transcriptScrollGeometryRegistered } from './use-transcript-follow';

/** The floor of the scroll lead (an unmeasured or tiny pane). */
export const TRANSCRIPT_HISTORY_TOP_PX = 320;

/** Viewport heights above the reader at which a scroll asks for older history:
 *  covers a page's round trip at the 15k px/s a repeated fling is boosted to (#104, Android). */
const TRANSCRIPT_HISTORY_LEAD_VIEWPORTS = 10;

/** Pages one entry may ask for to extend a scrollable first window toward the
 *  lead (see useTranscriptHistoryFill). */
const TRANSCRIPT_HISTORY_FILL_LEAD_PAGES = 4;

/** Scroll offset at or below which older history is requested. */
export function transcriptHistoryLead(viewportHeight: number): number {
  return Math.max(TRANSCRIPT_HISTORY_TOP_PX, viewportHeight * TRANSCRIPT_HISTORY_LEAD_VIEWPORTS);
}

/** While the whole transcript sits within the scroll lead, asks for older
 *  history, again whenever what the paging holds changes (`revision`:
 *  useTranscriptWindow's) or the rows' measured height changes. Each time it
 *  only asks: whether a page is already on its way, or none can come, is
 *  `requestEarlier`'s to answer from the window held then, so no order of a
 *  page's publication and its acknowledgement leaves the pane unasked. A pane
 *  that already scrolls extends toward the lead by at most
 *  TRANSCRIPT_HISTORY_FILL_LEAD_PAGES pages per entry; past that the scroll
 *  lead asks. Returns whether the rows shown are yet to be checked: until
 *  then, a read of older rows may still be asked for them. */
export function useTranscriptHistoryFill(
  viewport: RefObject<HTMLElement | null>,
  requestEarlier: () => void,
  revision: unknown,
  ready: boolean
): () => boolean {
  const requestRef = useRef(requestEarlier);
  requestRef.current = requestEarlier;
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const checkedAt = useRef<unknown>(UNCHECKED);
  const checkRef = useRef<(() => void) | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the trigger that re-checks after a page lands
  useEffect(() => {
    checkRef.current?.();
  }, [revision]);
  useEffect(() => {
    const root = viewport.current;
    if (!ready || !root) return undefined;
    let overflowing = false;
    let space: Element | null = null;
    // Revisions a lead page was asked at, this entry.
    const leadPages = new Set<unknown>();
    // The virtual list writes its total height to this spacer directly.
    const observer =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver((entries) => {
            // Once the rows overflow the lead, scrolling takes over: only a viewport
            // resize can make the pane unfilled again.
            if (overflowing && !entries.some((entry) => entry.target === root)) return;
            check();
          })
        : null;
    const check = (): void => {
      checkedAt.current = revisionRef.current;
      // No timeline yet, no rows to fill: the extent would come from a forced
      // layout of an empty pane. The row count that mounts it checks again.
      if (!transcriptScrollGeometryRegistered(root)) return;
      const next = root.querySelector('.transcript-virtual-space');
      if (observer && next !== space) {
        if (space) observer.unobserve(space);
        space = next;
        if (space) observer.observe(space);
      }
      const extent = transcriptScrollExtent(root);
      overflowing = extent.maxScrollTop > transcriptHistoryLead(extent.viewportHeight);
      if (overflowing) return;
      if (extent.maxScrollTop > TRANSCRIPT_HISTORY_TOP_PX) {
        const revision = revisionRef.current;
        if (!leadPages.has(revision) && leadPages.size >= TRANSCRIPT_HISTORY_FILL_LEAD_PAGES) return;
        leadPages.add(revision);
      }
      requestRef.current();
    };
    observer?.observe(root);
    checkRef.current = check;
    check();
    return () => {
      observer?.disconnect();
      checkedAt.current = UNCHECKED;
      if (checkRef.current === check) checkRef.current = null;
    };
  }, [viewport, ready]);
  return useCallback(() => readyRef.current && !Object.is(checkedAt.current, revisionRef.current), []);
}

const UNCHECKED = Symbol('unchecked');

/** The one page asked of the host. It belongs to the window it was asked of, named by where that window began and by its
 *  generation: everything else about it (whether it is still on its way, whether another may be asked) is read from the window
 *  held at the moment of the question (`standing`). */
interface PageRequest {
  /** Where the window began when the page was asked. */
  at: unknown;
  /** The window's generation then: a rewind makes another window of it, though it begins at the same item. */
  generation: unknown;
  /** The rows the page asked the window to hold. */
  limit: number;
  /** 'none': the host answered that nothing older could join the window where it begins (the core's view ends there). */
  outcome: 'open' | 'none';
  /** Ends the background-read hold (tool-output-prefetch.ts) the page keeps while it is on its way (once). */
  release: () => void;
}

interface HistoryPaging {
  sessionId: string;
  /** The largest window a host that predates `transcriptHasOlder` has taken. */
  limit: number;
  request: PageRequest | null;
}

/** What the host states of the thread's live tail window (`transcriptHistoryOf`), and the rows the pane holds of it. */
interface WindowFacts {
  start: unknown;
  generation: unknown;
  count: number;
  /** 'unknown': the host states neither; it is asked by row counts (`nextTranscriptHistoryLimit`). */
  history: 'held' | 'older' | 'unknown';
}

/** What the core holds above the window a state shows, as the state says it: `transcriptHistory` when the host states it, the
 *  older `transcriptHasOlder` when it is a boolean, and 'unknown' only for a host that says neither. An absent
 *  `transcriptHasOlder` beside a stated history is never read. */
export function transcriptHistoryOf(state: {
  transcriptHistory?: unknown;
  transcriptHasOlder?: unknown;
}): WindowFacts['history'] {
  if (state.transcriptHistory === 'held' || state.transcriptHistory === 'older') return state.transcriptHistory;
  if (typeof state.transcriptHasOlder === 'boolean') return state.transcriptHasOlder ? 'older' : 'held';
  return 'unknown';
}

const newPaging = (sessionId: string): HistoryPaging => ({
  sessionId,
  limit: TRANSCRIPT_HISTORY_PAGE_ITEMS,
  request: null,
});

function endRequest(paging: HistoryPaging, request: PageRequest): void {
  request.release();
  if (paging.request === request) paging.request = null;
}

/** The request as it stands against the window held now, or null once it is over: the window is another one (it begins
 *  elsewhere, or a reset made a new generation of it), the thread's start is held, or newer rows already make up the rows it
 *  asked for (it would bring nothing: the next question asks anew). Until then an open request is a page on its way, whether
 *  or not the host has acknowledged it, and one answered 'none' says the window grows no further here. */
function standing(paging: HistoryPaging, facts: WindowFacts): PageRequest | null {
  const request = paging.request;
  if (!request) return null;
  const here =
    Object.is(request.at, facts.start) && Object.is(request.generation, facts.generation) && facts.history !== 'held';
  const wanted = request.outcome === 'none' || facts.history === 'unknown' || facts.count < request.limit;
  if (here && wanted) return request;
  endRequest(paging, request);
  return null;
}

/** Whether a read of older rows this pane asked of the host for `sessionId` is still unanswered, and the call that counts
 *  one out until it settles (landed, refused or failed). A read of a session the pane left counts for nothing. */
function useOlderReads(sessionId: string): [boolean, (read: Promise<unknown>) => void] {
  const [out, setOut] = useState({ sessionId, count: 0 });
  const track = useCallback(
    (read: Promise<unknown>) => {
      const add = (step: number) =>
        setOut((now) =>
          now.sessionId === sessionId
            ? { sessionId, count: now.count + step }
            : step > 0
              ? { sessionId, count: 1 }
              : now
        );
      add(1);
      const end = () => add(-1);
      void read.then(end, end);
    },
    [sessionId]
  );
  return [out.sessionId === sessionId && out.count > 0, track];
}

/**
 * The rows a pane renders and how it pages. On the live tail (following, or a
 * host that cannot read history by position) older history grows the
 * session's window as before. A reader who scrolled up pages through a
 * history window of its own (TranscriptHistoryPager): at most
 * TRANSCRIPT_WINDOW_MAX_ITEMS items within their character bound, read by
 * position from the daemon, never patched by live frames; at the bottom it
 * returns to a fresh live tail.
 */
export function useTranscriptWindow<T extends { readonly id?: unknown }>(
  sessionId: string,
  liveItems: readonly T[],
  liveHasOlder: boolean | undefined,
  following: boolean,
  /** Where the live tail's window begins (`transcriptWindowStart`). */
  liveWindowStart?: string,
  /** Its generation (`transcriptGeneration`). */
  liveGeneration?: number,
  /** The window the core holds for this connection, when the transcript is positioned (`transcriptPositioned`). */
  positioned?: PositionedFacts<T>
) {
  const legacy = useLegacyTranscriptWindow(
    positioned ? '' : sessionId,
    liveItems,
    liveHasOlder,
    following,
    liveWindowStart,
    liveGeneration
  );
  const held = usePositionedTranscriptWindow(
    positioned ? sessionId : '',
    liveItems,
    liveHasOlder,
    following,
    positioned
  );
  return positioned ? held : legacy;
}

/** What a positioned state says of its window (protocol-client `desktopSessionState`). */
export interface PositionedFacts<T> {
  /** The stretches held apart from the tail (`transcriptViews`), the one asked for last being last: each pane is shown
   *  the one its reader is in. `older`, `newer`: it continues that way. */
  views: readonly PositionedStretch<T>[];
  /** `transcriptWindowVersion`: the window changed. */
  version: number;
}

export interface PositionedStretch<T> {
  items: readonly T[];
  older: boolean;
  newer: boolean;
}

/** The stretches of a state, the same list for the same state's: a pane that reads them keeps its memo. */
const stretchesOf = new WeakMap<object, readonly PositionedStretch<unknown>[]>();
function stretches<T>(state: Record<string, unknown>): readonly PositionedStretch<T>[] {
  const listed = state.transcriptViews;
  // A state that lists none (a preview kept of a hidden session, an older host) states the one stretch it has.
  const source = Array.isArray(listed) ? listed : state.transcriptViewItems;
  if (!Array.isArray(source)) return NO_STRETCHES;
  const known = stretchesOf.get(source);
  if (known) return known as readonly PositionedStretch<T>[];
  const made: PositionedStretch<T>[] = Array.isArray(listed)
    ? (listed as { items: T[]; before?: boolean; after?: boolean }[]).map((view) => ({
        items: view.items,
        older: view.before === true,
        newer: view.after === true,
      }))
    : [
        {
          items: source as T[],
          older: state.transcriptHistoryBefore === true,
          newer: state.transcriptHistoryAfter === true,
        },
      ];
  stretchesOf.set(source, made);
  return made;
}
const NO_STRETCHES: readonly never[] = [];

/** The facts of a positioned state, or undefined for a state of another window. */
export function positionedFactsOf<T>(state: Record<string, unknown>): PositionedFacts<T> | undefined {
  if (state.transcriptPositioned !== true) return undefined;
  return {
    views: stretches<T>(state),
    version: typeof state.transcriptWindowVersion === 'number' ? state.transcriptWindowVersion : 0,
  };
}

/** The stored records each list of items shows, read once per list. */
const shownPositions = new WeakMap<object, Set<string>>();
function shows(items: readonly unknown[] | null, position: string): boolean {
  if (!items || items.length === 0) return false;
  let positions = shownPositions.get(items);
  if (!positions) {
    positions = new Set();
    for (const item of items) {
      const before = historyPositionOf(item);
      const after = historyPositionOf(item, 'after');
      if (before !== undefined) positions.add(before);
      if (after !== undefined) positions.add(after);
    }
    shownPositions.set(items, positions);
  }
  return positions.has(position);
}

const positionIn = (items: readonly unknown[], position: string): number =>
  items.findIndex((item) => historyPositionOf(item) === position || historyPositionOf(item, 'after') === position);

/** The texts of the settled replies among the items a view opened at `place` mounts: from the place's item as far as a
 *  viewport reaches at the shortest row the list paints, on both sides (the list mounts a viewport past the view, and a
 *  place may stand anywhere in it). */
function repliesAround(items: readonly unknown[], place: ReaderPlace): string[] {
  let at = positionIn(items, place.position);
  if (at < 0 && place.next !== undefined) at = positionIn(items, place.next);
  if (at < 0) return [];
  const reach = Math.ceil((typeof window === 'undefined' ? 0 : window.innerHeight) / TRANSCRIPT_MIN_ROW_PX);
  const texts: string[] = [];
  for (let index = Math.max(0, at - reach); index < items.length && index <= at + reach; index += 1) {
    const item = items[index] as { kind?: unknown; streaming?: unknown; text?: unknown } | null;
    if (item?.kind !== 'assistant' || item.streaming) continue;
    const text = String(item.text || '');
    if (text) texts.push(text);
  }
  return texts;
}

/** Whether the replies around `place` in `items` are parsed, so that the list that mounts them shows each at its own
 *  size in its first frame (MarkdownResponse.tsx parses a reply read from history within a frame's allowance, and the
 *  rest when the worker answers). The parses are asked for here, and the caller is rendered again as they end. With
 *  no `items` to open (null) or no place, there is nothing to wait for. */
function usePlaceBodies(sessionId: string, items: readonly unknown[] | null, place: ReaderPlace | null): boolean {
  const [, landed] = useReducer((count: number) => count + 1, 0);
  // The texts whose parse ended, for the place they were asked for: one too long to be kept parsed is not asked twice.
  const ended = useRef<{ sessionId: string; position: string; texts: Set<string> }>({
    sessionId,
    position: '',
    texts: new Set(),
  });
  const position = place?.position ?? '';
  if (ended.current.sessionId !== sessionId || ended.current.position !== position) {
    ended.current = { sessionId, position, texts: new Set() };
  }
  const waiting =
    items && place
      ? repliesAround(items, place).filter(
          (text) => !ended.current.texts.has(text) && readCachedStreamingMarkdownAst(text) === null
        )
      : NO_TEXTS;
  const asked = useRef(new Set<string>());
  const signature = waiting.join('\u0000');
  // biome-ignore lint/correctness/useExhaustiveDependencies: the signature is the content of `waiting`
  useEffect(() => {
    const record = ended.current;
    for (const text of waiting) {
      if (asked.current.has(text)) continue;
      asked.current.add(text);
      const end = (): void => {
        asked.current.delete(text);
        record.texts.add(text);
        landed();
      };
      void parseStreamingMarkdownAst(text).then(end, end);
    }
  }, [signature]);
  return waiting.length === 0;
}

const NO_TEXTS: readonly string[] = [];

/** The changed-files cards of the rows around `place` in `items`, as the list will draw them
 *  (transcript-rows.ts places a turn's card on the row that ends it). */
function cardsAround(
  project: ReturnType<typeof createSettledProjector>['project'],
  sessionId: string,
  items: readonly unknown[],
  place: ReaderPlace
): TurnChangesRef[] {
  const settled = items as readonly TranscriptItem[];
  const { rows } = project({
    sessionKey: sessionId,
    items: settled,
    turnKeys: transcriptTurnKeys(settled) as string[],
    failedTurns: NO_TURNS,
  });
  const at = rowOfPlace(rows, place);
  if (at < 0) return [];
  const reach = Math.ceil((typeof window === 'undefined' ? 0 : window.innerHeight) / TRANSCRIPT_MIN_ROW_PX);
  const cards: TurnChangesRef[] = [];
  for (let index = Math.max(0, at - reach); index < rows.length && index <= at + reach; index += 1) {
    const row = rows[index];
    if ((row?._tag === 'AssistantPart' || row?._tag === 'Error') && row.turnChanges) cards.push(row.turnChanges);
  }
  return cards;
}
const NO_TURNS: ReadonlySet<string> = new Set();

/** The changed-files cards of the rows around `place` in `items` are asked for as the rows arrive, so that a row
 *  mounts with the reply held where the core has answered by then (TurnChangesCard.tsx starts from it). Only the cards
 *  a view mounts hold its reveal for their reads; nothing waits for these. */
function usePlaceCards(sessionId: string, items: readonly unknown[] | null, place: ReaderPlace | null): void {
  const projector = useRef<ReturnType<typeof createSettledProjector> | null>(null);
  projector.current ??= createSettledProjector();
  const settled = projector.current;
  const position = place?.position ?? '';
  const asked = useRef<{ items: readonly unknown[] | null; position: string }>({ items: null, position: '' });
  useEffect(() => {
    if (!items || !place || (asked.current.items === items && asked.current.position === position)) return;
    asked.current = { items, position };
    for (const card of cardsAround(settled.project, sessionId, items, place))
      prefetchTurnChanges(sessionId, card.checkpointId, card.boundary);
  });
}

const subscribeLive = (listener: () => void): (() => void) => defaultSessionLaneStore.subscribeApprovals(listener);

/** A positioned transcript's rows and paging: the core holds the followed tail and one stretch apart from it, for
 *  every pane of the session. Which of them a pane shows is the pane's own: the one that holds the record its reader
 *  is on (transcript-list-reader-place.ts), or the tail's for a reader who follows the end. A state that holds neither
 *  is not this pane's view: the pane keeps the rows it shows and asks for the window around its reader's record (`at`),
 *  once when it has no rows to show (a return to a session whose window was let go, a record opened from outside) and
 *  otherwise when its reader next moves. A record the history no longer holds leaves the reader at the end.
 *
 *  The pane says where the reader is (`readerAt`: the first and last items in its view) on every scroll and whenever
 *  the window shown changes (`revision`); the window asks for the page that view is near and lets go of the rows far
 *  from it (`moveTranscriptWindow`), and the rows arrive as the session's state. */
function usePositionedTranscriptWindow<T extends { readonly id?: unknown }>(
  sessionId: string,
  liveItems: readonly T[],
  liveHasOlder: boolean | undefined,
  following: boolean,
  facts: PositionedFacts<T> | undefined
) {
  const pane = usePaneKey();
  useReaderPlaceVersion();
  const live = useSyncExternalStore(
    subscribeLive,
    () => sessionId !== '' && defaultSessionLaneStore.liveSessionIds().has(sessionId)
  );
  const [olderReading, trackOlder] = useOlderReads(sessionId);
  // A move belongs to the session it was asked for (the pane outlives the sessions it shows), and each goes out as
  // it is asked: the window knows where this reader is now, also while an earlier move of it is out. The window
  // takes one at a time, the latest asked replacing the one waiting, but for a record to open (`at`: always read).
  const move = useCallback(
    (asked: DesktopTranscriptMove, done?: (served: boolean) => void): Promise<void> | undefined => {
      const ask = window.mixdogDesktop?.moveTranscriptWindow;
      if (!sessionId || !ask) return undefined;
      // The window is one for every pane of the session: each move says whose it is.
      const to = { ...asked, reader: pane };
      const release = to.kind === 'follow' ? () => undefined : noteHistoryPageRequest();
      return Promise.resolve()
        .then(() => ask(sessionId, to))
        .catch(() => false)
        .then((served) => {
          release();
          done?.(served === true);
        });
    },
    [pane, sessionId]
  );
  // The pane reads the session's window while it shows the session: closed, hidden or showing another, it withdraws,
  // and the window lets go of what only this pane held (protocol-client `moveTranscriptWindow`: a `follow` is a
  // reader that stands nowhere apart). Back on the session, it opens its place again like any return.
  const active = useSurfaceActive();
  useEffect(() => {
    if (!active || !sessionId) return undefined;
    return () => void move({ kind: 'follow' });
  }, [active, move, sessionId]);
  const views = facts?.views ?? (NO_STRETCHES as readonly PositionedStretch<T>[]);
  const opening = sessionId ? pendingReaderPlace(pane, sessionId) : null;
  const placeOf = () => opening ?? (sessionId ? readerPlace(pane, sessionId) : null);
  const reader = following && !opening ? null : placeOf();
  // The rows this pane showed last: what it keeps when the state holds no stretch of its reader's.
  const shown = useRef<{ sessionId: string; items: readonly T[] | null }>({ sessionId, items: null });
  if (shown.current.sessionId !== sessionId) shown.current = { sessionId, items: null };
  let items: readonly T[];
  // The stretch that holds the reader's record, or the record under it when that one is gone from the history.
  const holds = (stretch: readonly T[] | null): boolean =>
    reader !== null && (shows(stretch, reader.position) || (reader.next !== undefined && shows(stretch, reader.next)));
  // Of the stretches apart, the one asked for last is looked at first.
  const apart = (has: (stretch: readonly T[]) => boolean): readonly T[] | undefined => {
    for (let at = views.length - 1; at >= 0; at -= 1) {
      const stretch = views[at]?.items;
      if (stretch && has(stretch)) return stretch;
    }
    return undefined;
  };
  const on = (stretch: readonly T[]): boolean => reader !== null && shows(stretch, reader.position);
  const inLive = (has: (stretch: readonly T[]) => boolean): readonly T[] | undefined =>
    has(liveItems) ? liveItems : undefined;
  const held: readonly T[] | null = reader
    ? (apart(on) ?? inLive(on) ?? apart(holds) ?? inLive(holds) ?? null)
    : liveItems;
  const detached = held === null;
  // Rows the pane is to open at are shown once the replies its view will mount are parsed: mounted before, a reply is
  // laid out at the size the list holds for it and takes its own a frame later, under the reader.
  const arriving = held !== null && held !== shown.current.items ? held : null;
  const bodies = usePlaceBodies(sessionId, arriving, opening);
  usePlaceCards(sessionId, arriving, opening);
  if (held === null || !bodies) items = shown.current.items ?? (EMPTY_ITEMS as readonly T[]);
  else items = held;
  if (held !== null && bodies) shown.current.items = items;
  const inView = views.find((view) => view.items === items);
  // A reader back on the tail lets go of the stretch it read apart from it; the window keeps the ones other panes
  // stand in (protocol-client `windowWant`). The tail itself is kept as it grows: following asks for nothing while
  // the tail's run is what is held.
  const loose = following && !opening && views.length > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new window version lets go of the stretch again.
  useEffect(() => {
    if (loose) move({ kind: 'follow' });
  }, [loose, move, facts?.version]);
  const historyActive = items !== liveItems;
  const hasOlder = inView ? inView.older : !historyActive && liveHasOlder;
  const lastId = items.at(-1)?.id;
  const initialBackfillId =
    active &&
    sessionId &&
    facts &&
    following &&
    !opening &&
    !historyActive &&
    hasOlder === true &&
    items.length > 0 &&
    items.length < WINDOW_LEAD_ROWS &&
    lastId !== undefined &&
    lastId !== null
      ? String(lastId)
      : '';
  // The backfill this render owes and has not asked yet counts as a read out from this render on: the pane is not
  // revealed in the frames before its effect asks.
  const backfill = initialBackfillId ? `${sessionId}\n${initialBackfillId}\n${live}\n${facts?.version}` : '';
  const backfillAsked = useRef('');
  const backfillOwed =
    backfill !== '' && backfillAsked.current !== backfill && Boolean(window.mixdogDesktop?.moveTranscriptWindow);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-trigger when the session goes live or the window advances.
  useEffect(() => {
    // A place opened in this commit's layout (a search hit's jump) is read around instead: a read of the tail sent
    // first would hold its read back.
    if (!initialBackfillId || pendingReaderPlace(pane, sessionId)) return;
    backfillAsked.current = backfill;
    const read = move({ kind: 'read', first: initialBackfillId, last: initialBackfillId, end: true });
    if (read) trackOlder(read);
  }, [initialBackfillId, live, move, sessionId, facts?.version, trackOlder]);
  // The window around a record the pane is to open at and has no rows of.
  const wanted = opening && detached && live && facts ? opening.position : '';
  const version = facts?.version;
  const asked = useRef({ sessionId, version });
  asked.current = { sessionId, version };
  // The one read around the record, as it was answered: the window it was asked of. Every answer ends the wait for the
  // record. Served, its rows are in the window the session's next state shows; a state of another window that still
  // shows none of them, or a refusal over the window asked, says the history does not hold the record here, and the
  // reader is at the end. An answer for a session no longer followed (let go, lost) ends nothing: the pane asks again
  // when it is followed again, and until then shows what any session not followed shows.
  const answered = useRef<{ sessionId: string; position: string; version: number | undefined } | null>(null);
  useEffect(() => {
    if (!wanted) {
      answered.current = null;
      return;
    }
    const before = answered.current;
    if (before && before.sessionId === sessionId && before.position === wanted) {
      if (before.version !== version && pendingReaderPlace(pane, sessionId)?.position === wanted)
        voidReaderPlace(pane, sessionId);
      return;
    }
    move({ kind: 'at', position: wanted }, (served) => {
      const now = asked.current;
      if (now.sessionId !== sessionId || !defaultSessionLaneStore.liveSessionIds().has(sessionId)) return;
      if (pendingReaderPlace(pane, sessionId)?.position !== wanted) return;
      if (!served && now.version === version) voidReaderPlace(pane, sessionId);
      else answered.current = { sessionId, position: wanted, version };
    });
  }, [move, pane, sessionId, version, wanted]);
  const lost = detached && !opening ? (reader?.position ?? '') : '';
  const placing = opening !== null;
  const readerAt = useCallback(
    (first: string, last: string) => {
      // A pane still to be put at its place is not where its reader is: it tells nothing.
      if (placing) return;
      // A reader who moves over rows the window let go has it read around the record the reader is on.
      if (lost) move({ kind: 'at', position: lost });
      else move({ kind: 'read', first, last, ...(following ? { end: true } : {}) });
    },
    [following, lost, move, placing]
  );
  const resetToLive = useCallback(() => void move({ kind: 'follow' }), [move]);
  return {
    items,
    hasOlder,
    revision: `${facts?.version ?? 0}:${items.length}:${String(hasOlder)}:${String(historyActive)}`,
    historyActive,
    /** A read of older rows is out and unanswered: its page would land above the rows shown. */
    olderReading: olderReading || backfillOwed,
    requestEarlier: noRequest,
    requestLater: noRequest,
    readerAt,
    resetToLive,
  };
}

const EMPTY_ITEMS: readonly never[] = [];

const noRequest = (): void => undefined;

function useLegacyTranscriptWindow<T extends { readonly id?: unknown }>(
  sessionId: string,
  liveItems: readonly T[],
  liveHasOlder: boolean | undefined,
  following: boolean,
  liveWindowStart?: string,
  liveGeneration?: number
) {
  const liveRef = useRef({ items: liveItems, hasOlder: liveHasOlder === true });
  liveRef.current = { items: liveItems, hasOlder: liveHasOlder === true };
  const [paged, changed] = useReducer((count: number) => count + 1, 0);
  const pagerRef = useRef<TranscriptHistoryPager<T> | null>(null);
  if (!pagerRef.current || pagerRef.current.sessionId !== sessionId) {
    pagerRef.current?.dispose();
    pagerRef.current = new TranscriptHistoryPager<T>(
      sessionId,
      () => window.mixdogDesktop?.readTranscriptHistory,
      () => liveRef.current,
      changed
    );
  }
  const pager = pagerRef.current;
  useEffect(() => () => pager.dispose(), [pager]);
  const exhaustedRef = useRef<() => void>(() => undefined);
  const [olderReading, trackOlder] = useOlderReads(sessionId);
  const growWindow = useTranscriptHistory(
    sessionId,
    liveItems.length,
    liveHasOlder,
    liveWindowStart,
    () => exhaustedRef.current(),
    liveGeneration,
    trackOlder
  );
  // A reset made another window of the live tail: rows read by position above the old one are not above this one.
  const generationRef = useRef(liveGeneration);
  if (generationRef.current !== liveGeneration) {
    generationRef.current = liveGeneration;
    pager.forget();
  }
  // A window that holds no row while older history exists (a rewind above it took all it held) has no pane to measure and
  // no row to scroll: it asks for its page as it is.
  const empty = liveItems.length === 0 && liveHasOlder === true;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the generation names the window that is empty
  useEffect(() => {
    if (empty) growWindow();
  }, [empty, growWindow, liveGeneration]);
  const followingRef = useRef(following);
  followingRef.current = following;
  useEffect(() => {
    if (following) void pager.atBottom();
  }, [following, pager]);
  const requestEarlier = useCallback(() => {
    if (!sessionId) return;
    // A host that predates `transcriptHasOlder` or cannot read by position
    // grows the session's window.
    if (liveHasOlder === undefined || pager.unsupported) {
      growWindow();
      return;
    }
    const settle = (outcome: TranscriptPagingOutcome): void => {
      if (pager.window) return;
      if (outcome === 'unsupported') growWindow();
      // The window the page was asked for, not the rows held now.
      else if (outcome === 'moved') growWindow(pager.movedFrom);
    };
    // A reader still following the tail (a short first window filling the
    // pane) grows the session's window; past the core's view, rows are read
    // by position above the live tail.
    if (followingRef.current && !pager.window) {
      if (growWindow() === 'exhausted') trackOlder(pager.earlier(true).then(settle));
      return;
    }
    trackOlder(pager.earlier().then(settle));
  }, [growWindow, liveHasOlder, pager, sessionId, trackOlder]);
  exhaustedRef.current = requestEarlier;
  const requestLater = useCallback(() => {
    void pager.later();
  }, [pager]);
  const resetToLive = useCallback(() => {
    pager.toLive();
  }, [pager]);
  const held = pager.window;
  const tail = pager.tail();
  const items = held ? held.items : tail.items;
  const tailHasOlder = tail.items === liveItems ? liveHasOlder : tail.hasOlder;
  const hasOlder = held ? held.hasOlder : tailHasOlder;
  return {
    items,
    hasOlder,
    /** Changes whenever what a paging decision reads does: the rows shown, where the live window begins, whether older rows
     *  exist, a positional page (useTranscriptHistoryFill decides again at each). */
    revision: `${paged}:${items.length}:${liveItems.length}:${liveWindowStart ?? ''}:${liveGeneration ?? ''}:${String(hasOlder)}`,
    historyActive: held !== null,
    /** A read of older rows is out and unanswered: its page would land above the rows shown. */
    olderReading,
    requestEarlier,
    requestLater,
    /** A window read by scroll offsets has no reader's position to follow. */
    readerAt: null,
    resetToLive,
  };
}

/** Grows the window by a page from the rows held now, or (a number) from that many rows. 'exhausted': the host had nothing older
 *  to add where the window begins now, and `onExhausted` is told when a page finds that. `windowStart` is where the window begins
 *  (`transcriptWindowStart`); a host that names none is measured by the rows it holds.
 *
 *  One request is out per window start (`PageRequest`). Whether it still stands is decided from the window held each time the
 *  question is asked: here, and whenever the window published changes. */
export function useTranscriptHistory(
  sessionId: string,
  itemCount: number,
  hasOlder?: boolean,
  windowStart?: string,
  onExhausted?: () => void,
  /** The window's generation (`transcriptGeneration`). */
  generation?: number,
  /** Told of each read asked of the host, which settles when the host answers or fails. */
  onRead?: (read: Promise<unknown>) => void
): (heldRows?: unknown) => 'exhausted' | undefined {
  const facts: WindowFacts = {
    start: windowStart ?? itemCount,
    generation,
    count: itemCount,
    history: transcriptHistoryOf({ transcriptHasOlder: hasOlder }),
  };
  const factsRef = useRef(facts);
  factsRef.current = facts;
  const exhaustedRef = useRef(onExhausted);
  exhaustedRef.current = onExhausted;
  const readRef = useRef(onRead);
  readRef.current = onRead;
  const pagingRef = useRef(newPaging(sessionId));
  if (pagingRef.current.sessionId !== sessionId) pagingRef.current = newPaging(sessionId);
  // The page's window may be published before or after its read is acknowledged: the request, and the background-read hold
  // with it, end on the window held, in either order.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the window's facts are the trigger; they are read through the ref
  useEffect(() => {
    standing(pagingRef.current, factsRef.current);
  }, [facts.start, facts.generation, facts.count, facts.history]);
  // Leaving the session (or unmounting) ends the request.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the trigger; the paging it owns is read at setup
  useEffect(() => {
    const paging = pagingRef.current;
    return () => {
      if (paging.request) endRequest(paging, paging.request);
    };
  }, [sessionId]);
  return useCallback(
    (heldRows?: unknown) => {
      const prefetch = window.mixdogDesktop?.prefetchSession;
      const paging = pagingRef.current;
      if (!sessionId || !prefetch) return undefined;
      const held = factsRef.current;
      const out = standing(paging, held);
      if (out) return out.outcome === 'none' ? 'exhausted' : undefined;
      const tail = held.history !== 'unknown';
      // A click handler hands its event here: only a number names the rows a window is grown from.
      const count = typeof heldRows === 'number' ? heldRows : held.count;
      const limit = tail
        ? nextTranscriptTailLimit(count, held.history === 'older')
        : nextTranscriptHistoryLimit(count, paging.limit);
      if (limit === null) return undefined;
      // Background tool-output reads hold off while the page is on its way.
      const request: PageRequest = {
        at: held.start,
        generation: held.generation,
        limit,
        outcome: 'open',
        release: noteHistoryPageRequest(),
      };
      paging.request = request;
      const read = Promise.resolve().then(() => prefetch(sessionId, limit));
      readRef.current?.(read);
      void read.then(
        (accepted) => {
          if (pagingRef.current !== paging) return;
          if (accepted === true) {
            // The page is on its way, or here already: the window held says which (`standing`).
            if (!tail) paging.limit = limit;
            return;
          }
          // The request ended with its window meanwhile: its answer is about a window no longer held.
          if (paging.request !== request) return;
          if (!tail || accepted !== false) return endRequest(paging, request);
          // `false` from a tail host: nothing older could join the window where it begins.
          request.release();
          request.outcome = 'none';
          exhaustedRef.current?.();
        },
        // Read-only failures remain retryable on the next boundary gesture.
        () => endRequest(paging, request)
      );
      return undefined;
    },
    [sessionId]
  );
}
