import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { currentRemoteConnectionState, isRemoteDesktopOffline } from './remote-connection-state';
import { toolRowRevision, uiDiffDigest } from './transcript-tool-core';

interface LoadedToolOutput {
  result?: unknown;
  rawResult?: unknown;
  uiDiff?: unknown;
}
type ReadState =
  /** `background`: a prefetch nobody asked to see; the row shows nothing of it. */
  | { status: 'loading'; background: boolean }
  | { status: 'failed'; at: number }
  | { status: 'done'; output: LoadedToolOutput };
const FULL_TOOL_OUTPUT_LIMIT = 64;
/** A failed read is not prefetched again for this long (the button retries it at once). */
export const TOOL_OUTPUT_PREFETCH_RETRY_MS = 60_000;
/** Reads by session, row and row revision (a text read for one revision of a
 *  row is never shown for another): in flight, failed, or done — newest last,
 *  so a row the virtual list remounts keeps its full text. The settled ones,
 *  done or failed, that no mounted row is subscribed to are kept to
 *  FULL_TOOL_OUTPUT_LIMIT; subscribed ones are always kept. */
const reads = new Map<string, ReadState>();
/** Keys whose last read succeeded, kept (key only, no output) for the life of
 *  the session or the row revision, whatever happens to the held reads: an
 *  output dropped from `reads` is not prefetched again. Cleared with the
 *  session (releaseFullToolOutputs); a new revision is a new key. */
const readKeys = new Set<string>();
/** When each key's last read failed, until its wait is over: a failure keeps
 *  its wait however many reads settle after it or leave `reads`. Oldest first. */
const failedAt = new Map<string, number>();
/** The one request per key allowed to write its answer: a request still in
 *  flight when its session was released (or reset) settles without effect. */
const requests = new Map<string, object>();
/** Rows waiting on a read, by its key: a read wakes only its own row. */
const listeners = new Map<string, Set<() => void>>();
/** Prefetches waiting for a slot, oldest first, by the element that asked. */
const queued: { key: string; sessionId: string; id: string; owner: object }[] = [];
const PREFETCH_SLOTS = 2;
let prefetching = 0;
let historyPagesPending = 0;

function publish(key: string): void {
  for (const listener of [...(listeners.get(key) ?? [])]) listener();
}

/** Keeps the newest FULL_TOOL_OUTPUT_LIMIT settled reads nobody is subscribed
 *  to; a read a mounted row shows is never dropped from under it. */
function trimSettledReads(): void {
  let settled = 0;
  for (const [entry, value] of [...reads].reverse()) {
    if (value.status === 'loading' || listeners.has(entry)) continue;
    if (++settled > FULL_TOOL_OUTPUT_LIMIT) reads.delete(entry);
  }
}

function subscribeKey(key: string, listener: () => void): () => void {
  const set = listeners.get(key) ?? new Set<() => void>();
  listeners.set(key, set);
  set.add(listener);
  return () => {
    set.delete(listener);
    if (!set.size && listeners.get(key) === set) {
      listeners.delete(key);
      // Its row left: the read counts toward the limit again.
      trimSettledReads();
    }
  };
}

export function resetFullToolOutputs(): void {
  reads.clear();
  readKeys.clear();
  failedAt.clear();
  requests.clear();
  queued.length = 0;
  prefetching = 0;
  historyPagesPending = 0;
  for (const key of [...listeners.keys()]) publish(key);
}

/** A session went away: its held reads, tombstones, failure waits and queued
 *  prefetches go with it. */
export function releaseFullToolOutputs(sessionId: string): void {
  const prefix = `${sessionId}|`;
  const gone = new Set<string>();
  for (const map of [reads, failedAt]) {
    for (const key of [...map.keys()]) {
      if (!key.startsWith(prefix)) continue;
      map.delete(key);
      gone.add(key);
    }
  }
  for (const key of [...readKeys]) {
    if (!key.startsWith(prefix)) continue;
    readKeys.delete(key);
    gone.add(key);
  }
  for (const key of [...requests.keys()]) if (key.startsWith(prefix)) requests.delete(key);
  for (let index = queued.length - 1; index >= 0; index -= 1) {
    if (queued[index]?.sessionId === sessionId) queued.splice(index, 1);
  }
  for (const key of gone) publish(key);
}

/** The key a row's read is held under. */
export function fullToolOutputKey(sessionId: string, item: TranscriptItem): string {
  return `${sessionId}|${item.id == null ? '' : String(item.id)}|${toolRowRevision(item)}`;
}

/** The phone's copy of this row holds a cut output (main/remote-transcript.ts). */
export function toolOutputCut(item: TranscriptItem): boolean {
  return typeof item.remoteOutputTruncated === 'number' && item.remoteOutputTruncated > 0;
}

/** Reads one row's uncut output from the host and holds the answer. */
function startRead(key: string, sessionId: string, id: string, prefetch: boolean): void {
  const read = typeof window === 'undefined' ? undefined : window.mixdogDesktop?.readTranscriptItem;
  if (!read) return;
  const request = {};
  requests.set(key, request);
  reads.set(key, { status: 'loading', background: prefetch });
  // A background read starts unseen: no row is woken until it settles.
  if (prefetch) prefetching += 1;
  else publish(key);
  const settle = (state: ReadState) => {
    if (prefetch) prefetching -= 1;
    if (requests.get(key) !== request) {
      // Superseded or released: it writes nothing, but its slot is free.
      pumpPrefetches();
      return;
    }
    requests.delete(key);
    reads.delete(key);
    reads.set(key, state);
    readKeys.delete(key);
    failedAt.delete(key);
    if (state.status === 'failed') failedAt.set(key, state.at);
    else readKeys.add(key);
    // A failure whose wait is over is as good as never read.
    for (const [entry, at] of failedAt) {
      if (Date.now() - at < TOOL_OUTPUT_PREFETCH_RETRY_MS) break;
      failedAt.delete(entry);
    }
    trimSettledReads();
    publish(key);
    pumpPrefetches();
  };
  void Promise.resolve(read(sessionId, id))
    .then((output) => {
      if (!output || output.withheld) return settle({ status: 'failed', at: Date.now() });
      settle({
        status: 'done',
        output: {
          ...('result' in output ? { result: output.result } : {}),
          ...('rawResult' in output ? { rawResult: output.rawResult } : {}),
          ...('uiDiff' in output ? { uiDiff: output.uiDiff } : {}),
        },
      });
    })
    .catch(() => settle({ status: 'failed', at: Date.now() }));
}

/** Whether a background read of `key` is due: never read, or failed long
 *  enough ago (also once its held read was dropped). */
function prefetchDue(key: string): boolean {
  const state = reads.get(key);
  if (state) return state.status === 'failed' && Date.now() - state.at >= TOOL_OUTPUT_PREFETCH_RETRY_MS;
  if (readKeys.has(key)) return false;
  const failed = failedAt.get(key);
  return failed === undefined || Date.now() - failed >= TOOL_OUTPUT_PREFETCH_RETRY_MS;
}

/** The phone's link to the host is up (a desktop window has no remote state). */
function linkUp(): boolean {
  const state = currentRemoteConnectionState();
  return (state === null || state === 'connected') && !isRemoteDesktopOffline();
}

function pumpPrefetches(): void {
  if (!linkUp()) return;
  while (prefetching < PREFETCH_SLOTS && historyPagesPending === 0 && queued.length) {
    const next = queued.shift();
    if (next && prefetchDue(next.key)) startRead(next.key, next.sessionId, next.id, true);
  }
}

/** Queues the uncut output of `items` (rows of `owner` whose output is cut)
 *  for a background read: two at a time, none while a history page is on its
 *  way, each row once. */
export function prefetchToolOutputs(sessionId: string, items: readonly TranscriptItem[], owner: object): void {
  for (const item of items) {
    if (!toolOutputCut(item) || item.id == null || !sessionId) continue;
    const key = fullToolOutputKey(sessionId, item);
    if (!prefetchDue(key) || queued.some((entry) => entry.key === key)) continue;
    queued.push({ key, sessionId, id: String(item.id), owner });
  }
  pumpPrefetches();
}

/** Drops the queued (not yet started) reads `owner` asked for, or every queued
 *  read without one: its rows left, or the reader scrolled on. */
export function cancelToolOutputPrefetch(owner?: object): void {
  for (let index = queued.length - 1; index >= 0; index -= 1) {
    if (owner === undefined || queued[index]?.owner === owner) queued.splice(index, 1);
  }
}

/** A history page request started (+1) or settled (-1); prefetches wait for none. */
export function noteHistoryPagePending(delta: 1 | -1): void {
  historyPagesPending = Math.max(0, historyPagesPending + delta);
  pumpPrefetches();
}

export function historyPagePending(): boolean {
  return historyPagesPending > 0;
}

/** Reads held, in flight or settled (diagnostics and tests). */
export function heldToolOutputReads(): number {
  return reads.size;
}

/** Reads in flight for prefetches (diagnostics and tests). */
export function toolOutputPrefetchesInFlight(): number {
  return prefetching;
}

export interface FullToolOutput {
  /** The row with the host's uncut output and diff in place of the phone's copy. */
  item: TranscriptItem;
  /** The output was cut: the "Show full output" button is offered. */
  outputCut: boolean;
  loading: boolean;
  failed: boolean;
  /** Reads the full text from the host; null when nothing is cut or loadable. */
  load: (() => void) | null;
}

/** The host cuts a long tool output from a phone's copy of the transcript
 *  (`remoteOutputTruncated`; an older row's output to its first lines) and
 *  sends an edit's diff as a digest (`uiDiffSummary`). `readTranscriptItem`
 *  returns the uncut text. A digest-only diff loads on its own once the row is
 *  open (`wanted`); a cut output waits for the button, unless the idle
 *  prefetch (tool-output-prefetch.ts) already read it. */
export function useFullToolOutput(sessionId: string, item: TranscriptItem, wanted: boolean): FullToolOutput {
  const outputCut = toolOutputCut(item);
  const diffCut = uiDiffDigest(item) !== null;
  const id = item.id == null ? '' : String(item.id);
  const key = fullToolOutputKey(sessionId, item);
  const subscribe = useCallback((listener: () => void) => subscribeKey(key, listener), [key]);
  const state = useSyncExternalStore(
    subscribe,
    () => reads.get(key),
    () => undefined
  );
  const status =
    (state?.status === 'loading' && !state.background) || state?.status === 'failed' ? state.status : 'idle';
  const loaded = (outputCut || diffCut) && state?.status === 'done' ? state.output : undefined;
  const read = typeof window === 'undefined' ? undefined : window.mixdogDesktop?.readTranscriptItem;
  const merged = useMemo(() => {
    if (!loaded) return item;
    const {
      remoteOutputTruncated: _cut,
      uiDiffSummary: _digest,
      remoteOutputFacts: _facts,
      ...rest
    } = item as TranscriptItem & { remoteOutputFacts?: unknown };
    return {
      ...rest,
      ...('result' in loaded ? { result: loaded.result } : {}),
      ...('rawResult' in loaded ? { rawResult: loaded.rawResult } : {}),
      ...('uiDiff' in loaded ? { uiDiff: loaded.uiDiff } : {}),
    } as TranscriptItem;
  }, [item, loaded]);
  const load =
    (outputCut || diffCut) && !loaded && read && sessionId && id
      ? () => {
          // A reader's own press goes ahead of the prefetch queue (and its slots);
          // pressed while a background read of the row runs, it shows that one.
          const current = reads.get(key);
          if (current?.status === 'loading') {
            if (current.background) {
              reads.set(key, { status: 'loading', background: false });
              publish(key);
            }
            return;
          }
          reads.delete(key);
          startRead(key, sessionId, id, false);
        }
      : null;
  const loadRef = useRef(load);
  loadRef.current = load;
  const autoLoad = wanted && diffCut && load !== null && status === 'idle';
  // \key\ re-arms the load when the row changes while it stays open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: \key\ is the trigger, not a value the effect reads
  useEffect(() => {
    if (autoLoad) loadRef.current?.();
  }, [autoLoad, key]);
  return { item: merged, outputCut, loading: status === 'loading', failed: status === 'failed', load };
}

/** "Show full output" under a cut row; "Loading…" while it reads; "Retry"
 *  when it failed. Nothing for a row that is whole (a diff that loads by
 *  itself shows only while it loads or after it failed). */
export function FullToolOutputButton({ output }: { output: FullToolOutput }) {
  if (!output.load || !(output.outputCut || output.loading || output.failed)) return null;
  return (
    <button
      type="button"
      className="tool-activity-preview-more"
      disabled={output.loading}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={output.load}
    >
      {fullOutputButtonLabel(output)}
    </button>
  );
}

function fullOutputButtonLabel(output: FullToolOutput): string {
  if (output.loading) return t('Loading…');
  if (output.failed) return t('Retry');
  return t('Show full output');
}
