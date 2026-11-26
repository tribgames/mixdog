import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { registerIdleReclaim } from './idle-reclaim';
import { currentRemoteConnectionState, isRemoteDesktopOffline } from './remote-connection-state';
import { enforceRendererCacheBudget, registerBudgetedCache } from './renderer-cache-budget';
import { estimateRetainedChars } from './renderer-value-weight';
import { useSurfaceActive } from './surface-activity';
import { toolRowRevision, uiDiffDigest } from './transcript-tool-core';

interface LoadedToolOutput {
  result?: unknown;
  rawResult?: unknown;
  uiDiff?: unknown;
}
type FailedRead = { status: 'failed'; at: number; manual: boolean };
type SettledReadState = FailedRead | { status: 'done'; output: LoadedToolOutput };
type ReadState =
  /** `background`: a prefetch nobody asked to see; the row shows nothing of it. */
  { status: 'loading'; background: boolean } | SettledReadState;
const FULL_TOOL_OUTPUT_LIMIT = 64;
const FULL_TOOL_OUTPUT_MAX_CHARS = 8 * 1024 * 1024;
const FULL_TOOL_OUTPUT_MEASURE_LIMIT = 64 * 1024 * 1024;
/** Backoff for unattended prefetch failures; an observed failure takes an explicit Retry. */
export const TOOL_OUTPUT_PREFETCH_RETRY_MS = 60_000;
/** Reads by session, row and row revision (a text read for one revision of a
 *  row is never shown for another): in flight, failed, or done. */
const reads = new Map<string, ReadState>();
/** Active observed payloads: counted against the shared budget and pinned while shown. */
const observedReads = new Map<string, number>();
let observedChars = 0;
/** Only unobserved, exactly replayable payloads and lightweight failures are evictable. */
const retainedReads = new Map<string, number>();
let retainedChars = 0;
/** Receipts survive payload eviction: no second prefetch, and an opened row
 *  can reload only the exact revision the host promised to replay. */
const readKeys = new Map<string, { viewed: boolean; replayToken?: string }>();
const readKeySizes = new Map<string, number>();
let readKeysChars = 0;
/** Preserve Retry even when the read leaves the cache. Backoff affects
 *  speculative reads only; it does not erase a failure from the UI. */
const failedReads = new Map<string, FailedRead>();
const failedReadSizes = new Map<string, number>();
let failedReadsChars = 0;
/** The one request per key allowed to write its answer: a request still in
 *  flight when its session was released (or reset) settles without effect. */
const requests = new Map<string, object>();
/** Rows waiting on a read, by its key: a read wakes only its own row. */
const listeners = new Map<string, Set<() => void>>();
/** Prefetches waiting for a slot, oldest first, by the element that asked. */
const holders = new Map<string, Set<object>>();
const queued: { key: string; sessionId: string; id: string; owner: object; replayToken: string | undefined }[] = [];
const PREFETCH_SLOTS = 2;
let prefetching = 0;
let historyPagesPending = 0;

function publish(key: string): void {
  for (const listener of [...(listeners.get(key) ?? [])]) listener();
}

function setReadKey(key: string, receipt: { viewed: boolean; replayToken?: string }): void {
  deleteReadKey(key);
  const size = key.length + (receipt.replayToken?.length ?? 0) + 16;
  readKeys.set(key, receipt);
  readKeySizes.set(key, size);
  readKeysChars += size;
}

function deleteReadKey(key: string): void {
  const size = readKeySizes.get(key) ?? 0;
  readKeySizes.delete(key);
  readKeysChars -= size;
  readKeys.delete(key);
}

function setFailedRead(key: string, failed: FailedRead): void {
  deleteFailedRead(key);
  const size = key.length + 16;
  failedReads.set(key, failed);
  failedReadSizes.set(key, size);
  failedReadsChars += size;
}

function deleteFailedRead(key: string): void {
  const size = failedReadSizes.get(key) ?? 0;
  failedReadSizes.delete(key);
  failedReadsChars -= size;
  failedReads.delete(key);
}

function untrackObservedRead(key: string): void {
  observedChars -= observedReads.get(key) ?? 0;
  observedReads.delete(key);
}

function trackObservedRead(key: string, chars: number): void {
  untrackObservedRead(key);
  observedReads.set(key, chars);
  observedChars += chars;
}

function untrackRead(key: string): void {
  retainedChars -= retainedReads.get(key) ?? 0;
  retainedReads.delete(key);
}

function dropRead(key: string): void {
  untrackRead(key);
  untrackObservedRead(key);
  reads.delete(key);
}

function totalToolOutputChars(): number {
  return observedChars + retainedChars + readKeysChars + failedReadsChars;
}

function readKeyPinned(key: string): boolean {
  return listeners.has(key) || holders.has(key) || readKeys.get(key)?.viewed === true;
}

function pinnedToolOutputChars(): number {
  let pinned = observedChars;
  for (const [key, size] of readKeySizes) {
    if (readKeyPinned(key)) pinned += size;
  }
  for (const [key, size] of failedReadSizes) {
    if (listeners.has(key)) pinned += size;
  }
  return pinned;
}

/** A loaded read leaves with nothing left behind that blocks reading it again
 *  (a row the person already opened keeps its receipt: it loads on expansion). */
function evictRead(key: string): void {
  const done = reads.get(key)?.status === 'done';
  dropRead(key);
  if (done && !readKeys.get(key)?.viewed) deleteReadKey(key);
}

function trimSettledReads(target: number): void {
  while (retainedReads.size > FULL_TOOL_OUTPUT_LIMIT || (retainedReads.size > 0 && totalToolOutputChars() > target)) {
    const oldest = retainedReads.keys().next();
    if (oldest.done) break;
    evictRead(oldest.value);
  }
  if (totalToolOutputChars() > target) {
    for (const key of [...failedReads.keys()]) {
      if (totalToolOutputChars() <= target) break;
      if (listeners.has(key)) continue;
      deleteFailedRead(key);
    }
  }
  if (totalToolOutputChars() > target) {
    for (const key of [...readKeys.keys()]) {
      if (totalToolOutputChars() <= target) break;
      if (readKeyPinned(key)) continue;
      deleteReadKey(key);
    }
  }
}

registerBudgetedCache({
  name: 'full-tool-output',
  chars: totalToolOutputChars,
  pinned: pinnedToolOutputChars,
  trim: trimSettledReads,
});
registerIdleReclaim(() => {
  for (const key of [...retainedReads.keys()]) evictRead(key);
  for (const key of [...failedReads.keys()]) {
    if (!listeners.has(key)) deleteFailedRead(key);
  }
  for (const key of [...readKeys.keys()]) {
    if (!readKeyPinned(key)) deleteReadKey(key);
  }
});

function retainUnobservedRead(key: string, state: SettledReadState): void {
  // A loaded output nobody observes is released unless the group that prefetched
  // it is still mounted (then it counts against the budget).
  if (state.status === 'done' && !holders.has(key)) {
    evictRead(key);
    return;
  }
  const chars = state.status === 'done' ? estimateRetainedChars(state.output, FULL_TOOL_OUTPUT_MAX_CHARS) : 0;
  if (chars > FULL_TOOL_OUTPUT_MAX_CHARS) {
    // Its receipt stays: an output known to be over the limit is not prefetched again.
    dropRead(key);
    return;
  }
  retainedReads.set(key, chars);
  retainedChars += chars;
  while (retainedReads.size > FULL_TOOL_OUTPUT_LIMIT || retainedChars > FULL_TOOL_OUTPUT_MAX_CHARS) {
    const oldest = retainedReads.keys().next();
    if (oldest.done) break;
    evictRead(oldest.value);
  }
  enforceRendererCacheBudget();
}

function subscribeKey(key: string, listener: () => void): () => void {
  const wasObserved = listeners.has(key);
  const set = listeners.get(key) ?? new Set<() => void>();
  listeners.set(key, set);
  set.add(listener);
  if (!wasObserved) {
    const keptChars = retainedReads.get(key);
    untrackRead(key);
    const state = reads.get(key);
    if (state?.status === 'done') {
      trackObservedRead(key, keptChars ?? estimateRetainedChars(state.output, FULL_TOOL_OUTPUT_MEASURE_LIMIT));
    }
  }
  return () => {
    set.delete(listener);
    if (!set.size && listeners.get(key) === set) {
      listeners.delete(key);
      untrackObservedRead(key);
      const state = reads.get(key);
      if (state && state.status !== 'loading') retainUnobservedRead(key, state);
    }
  };
}

export function resetFullToolOutputs(): void {
  reads.clear();
  observedReads.clear();
  observedChars = 0;
  retainedReads.clear();
  retainedChars = 0;
  readKeys.clear();
  readKeySizes.clear();
  readKeysChars = 0;
  failedReads.clear();
  failedReadSizes.clear();
  failedReadsChars = 0;
  requests.clear();
  holders.clear();
  queued.length = 0;
  prefetching = 0;
  historyPagesPending = 0;
  for (const key of [...listeners.keys()]) publish(key);
}

/** A session went away: its held reads, tombstones, failure waits and queued
 *  prefetches go with it. */
export function releaseFullToolOutputs(sessionId: string): void {
  const prefix = fullToolOutputSessionPrefix(sessionId);
  const gone = new Set<string>();
  for (const key of reads.keys()) {
    if (!key.startsWith(prefix)) continue;
    dropRead(key);
    gone.add(key);
  }
  for (const key of [...readKeys.keys()]) {
    if (!key.startsWith(prefix)) continue;
    deleteReadKey(key);
    gone.add(key);
  }
  for (const key of [...failedReads.keys()]) {
    if (!key.startsWith(prefix)) continue;
    deleteFailedRead(key);
    gone.add(key);
  }
  for (const key of requests.keys()) if (key.startsWith(prefix)) requests.delete(key);
  for (const key of holders.keys()) if (key.startsWith(prefix)) holders.delete(key);
  for (let index = queued.length - 1; index >= 0; index -= 1) {
    if (queued[index]?.sessionId === sessionId) queued.splice(index, 1);
  }
  for (const key of gone) publish(key);
}

function fullToolOutputSessionPrefix(sessionId: string): string {
  return `${JSON.stringify(sessionId)}|`;
}

/** The key a row's read is held under. */
function fullToolOutputKey(sessionId: string, item: TranscriptItem): string {
  const itemId = fullReadId(item);
  return `${fullToolOutputSessionPrefix(sessionId)}${JSON.stringify(itemId)}|${toolRowRevision(item)}|${projectedReplayToken(item) ?? ''}`;
}

/** The id a row's full read is asked under. A grouped card's diff digest belongs to one member (`uiDiffMemberId`), whose id is the
 *  card's only for the member the card's own id names. */
function fullReadId(item: TranscriptItem): string {
  if (uiDiffDigest(item) !== null && typeof item.uiDiffMemberId === 'string') return item.uiDiffMemberId;
  return item.id == null ? '' : String(item.id);
}

function projectedReplayToken(item: TranscriptItem): string | undefined {
  return typeof item.remoteOutputReplayToken === 'string' ? item.remoteOutputReplayToken : undefined;
}

/** The phone's copy of this row holds a cut output (main/remote-transcript.ts). */
export function toolOutputCut(item: TranscriptItem): boolean {
  return typeof item.remoteOutputTruncated === 'number' && item.remoteOutputTruncated > 0;
}

/** Reads one row's uncut output from the host and holds the answer. */
function startRead(key: string, sessionId: string, id: string, prefetch: boolean, projectedToken?: string): void {
  const read = typeof window === 'undefined' ? undefined : window.mixdogDesktop?.readTranscriptItem;
  if (!read) return;
  const receipt = readKeys.get(key);
  const replayToken = receipt?.replayToken ?? projectedToken;
  const request = {};
  requests.set(key, request);
  dropRead(key);
  reads.set(key, { status: 'loading', background: prefetch });
  // A background read starts unseen: no row is woken until it settles.
  if (prefetch) prefetching += 1;
  else publish(key);
  const settle = (state: SettledReadState, token?: string) => {
    if (prefetch) prefetching -= 1;
    if (requests.get(key) !== request) {
      // Superseded or released: it writes nothing, but its slot is free.
      pumpPrefetches();
      return;
    }
    requests.delete(key);
    const current = reads.get(key);
    reads.set(key, state);
    if (state.status === 'failed') {
      setFailedRead(key, state);
    } else {
      deleteFailedRead(key);
      setReadKey(key, {
        viewed: receipt?.viewed === true || (current?.status === 'loading' && !current.background),
        ...(token ? { replayToken: token } : {}),
      });
    }
    if (!listeners.has(key)) {
      untrackObservedRead(key);
      retainUnobservedRead(key, state);
    } else if (state.status === 'done') {
      trackObservedRead(key, estimateRetainedChars(state.output, FULL_TOOL_OUTPUT_MEASURE_LIMIT));
      enforceRendererCacheBudget();
    } else {
      untrackObservedRead(key);
    }
    publish(key);
    pumpPrefetches();
  };
  const fail = () => {
    const current = reads.get(key);
    settle({ status: 'failed', at: Date.now(), manual: current?.status === 'loading' && !current.background });
  };
  void Promise.resolve(replayToken ? read(sessionId, id, replayToken) : read(sessionId, id))
    .then((output) => {
      if (!output || output.withheld || output.id !== id || (replayToken && output.replayToken !== replayToken)) {
        return fail();
      }
      settle(
        {
          status: 'done',
          output: {
            ...('result' in output ? { result: output.result } : {}),
            ...('rawResult' in output ? { rawResult: output.rawResult } : {}),
            ...('uiDiff' in output ? { uiDiff: output.uiDiff } : {}),
          },
        },
        output.replayToken
      );
    })
    .catch(fail);
}

/** Whether a background read of `key` is due: never read, or failed long
 *  enough ago (also once its held read was dropped). */
function prefetchDue(key: string): boolean {
  if (readKeys.has(key)) return false;
  const state = reads.get(key);
  if (state && state.status !== 'failed') return false;
  const failed = failedReads.get(key);
  if (!failed) return true;
  if (!failed.manual && Date.now() - failed.at >= TOOL_OUTPUT_PREFETCH_RETRY_MS) {
    deleteFailedRead(key);
    return true;
  }
  return false;
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
    if (next && prefetchDue(next.key)) startRead(next.key, next.sessionId, next.id, true, next.replayToken);
  }
}

/** Queues the uncut output of `items` (rows of `owner` whose output is cut)
 *  for a background read: two at a time, none while a history page is on its
 *  way, each row once. */
export function prefetchToolOutputs(sessionId: string, items: readonly TranscriptItem[], owner: object): void {
  for (const item of items) {
    // A row the core sent cut is read when the person asks, not ahead of that: each read is a request over the link.
    if (!toolOutputCut(item) || item.remoteOutputOnRequest === true || item.id == null || !sessionId) continue;
    const key = fullToolOutputKey(sessionId, item);
    const asked = holders.get(key) ?? new Set<object>();
    asked.add(owner);
    holders.set(key, asked);
    if (!prefetchDue(key) || queued.some((entry) => entry.key === key)) continue;
    queued.push({ key, sessionId, id: fullReadId(item), owner, replayToken: projectedReplayToken(item) });
  }
  pumpPrefetches();
}

/** The group that prefetched leaves: the reads it held go unless a row shows them. */
export function releaseToolOutputPrefetch(owner: object): void {
  for (const [key, asked] of [...holders]) {
    if (!asked.delete(owner) || asked.size) continue;
    holders.delete(key);
    if (!listeners.has(key) && reads.get(key)?.status === 'done') evictRead(key);
  }
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
  /** The row still holds the cut copy: nothing it shows may stand in for the whole text (Copy waits for load). */
  copyPending: boolean;
  loading: boolean;
  failed: boolean;
  /** Reads the full text from the host; null when nothing is cut or loadable. */
  load: (() => void) | null;
}

/** A reader's own press goes ahead of the prefetch queue (and its slots);
 *  pressed while a background read of the row runs, it shows that one. */
function pressFullRead(key: string, sessionId: string, id: string, replayToken: string | undefined): void {
  const current = reads.get(key);
  if (current?.status === 'done') return;
  if (current?.status === 'loading') {
    if (current.background) {
      reads.set(key, { status: 'loading', background: false });
      publish(key);
    }
    return;
  }
  startRead(key, sessionId, id, false, replayToken);
}

function mergeFullOutput(item: TranscriptItem, loaded: LoadedToolOutput, memberRead: boolean): TranscriptItem {
  const {
    remoteOutputTruncated: _cut,
    uiDiffSummary: _digest,
    remoteOutputFacts: _facts,
    ...rest
  } = item as TranscriptItem & { remoteOutputFacts?: unknown };
  return {
    ...rest,
    ...(!memberRead && 'result' in loaded ? { result: loaded.result } : {}),
    ...(!memberRead && 'rawResult' in loaded ? { rawResult: loaded.rawResult } : {}),
    ...('uiDiff' in loaded ? { uiDiff: loaded.uiDiff } : {}),
  } as TranscriptItem;
}

/** The host cuts a long tool output from a phone's copy of the transcript
 *  (`remoteOutputTruncated`; an older row's output to its first lines) and
 *  sends an edit's diff as a digest (`uiDiffSummary`). `readTranscriptItem`
 *  returns the uncut text. Digest-only diffs and previously requested full
 *  output reload on expansion (`wanted`); an unread cut output waits for the
 *  button unless the idle prefetch already filled it. */
export function useFullToolOutput(sessionId: string, item: TranscriptItem, wanted: boolean): FullToolOutput {
  const surfaceActive = useSurfaceActive();
  const outputCut = toolOutputCut(item);
  const diffCut = uiDiffDigest(item) !== null;
  const id = fullReadId(item);
  // Read by a member's id, the answer is that member's: only its diff belongs to this card.
  const memberRead = item.id != null && id !== String(item.id);
  const key = fullToolOutputKey(sessionId, item);
  const subscribe = useCallback(
    (listener: () => void) => (surfaceActive ? subscribeKey(key, listener) : () => {}),
    [key, surfaceActive]
  );
  const state = useSyncExternalStore(
    subscribe,
    () => (surfaceActive ? (reads.get(key) ?? failedReads.get(key)) : undefined),
    () => undefined
  );
  const status =
    (state?.status === 'loading' && !state.background) || state?.status === 'failed' ? state.status : 'idle';
  const loaded = (outputCut || diffCut) && state?.status === 'done' ? state.output : undefined;
  const read = typeof window === 'undefined' ? undefined : window.mixdogDesktop?.readTranscriptItem;
  const merged = useMemo(() => (loaded ? mergeFullOutput(item, loaded, memberRead) : item), [item, loaded, memberRead]);
  const load =
    (outputCut || diffCut) && !loaded && read && sessionId && id
      ? () => pressFullRead(key, sessionId, id, projectedReplayToken(item))
      : null;
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!wanted || !surfaceActive) return;
    if (loaded) {
      const receipt = readKeys.get(key);
      if (receipt) receipt.viewed = true;
    }
    if (status === 'failed') {
      const failure = failedReads.get(key);
      if (failure) failure.manual = true;
    }
  }, [key, loaded, status, wanted, surfaceActive]);
  const autoLoad =
    surfaceActive && wanted && (diffCut || readKeys.get(key)?.viewed === true) && load !== null && status === 'idle';
  // \key\ re-arms the load when the row changes while it stays open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: \key\ is the trigger, not a value the effect reads
  useEffect(() => {
    if (autoLoad) loadRef.current?.();
  }, [autoLoad, key]);
  return {
    item: merged,
    outputCut,
    copyPending: outputCut && !loaded,
    loading: status === 'loading',
    failed: status === 'failed',
    load,
  };
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
