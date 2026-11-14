/**
 * The page's CDP events, forwarded to the core as `host/browser/events`.
 *
 * The router hands over the allowlisted events of a page in arrival order;
 * they queue per page and leave in batches, each under 200 KiB serialized and
 * numbered with the page's next `seq` (the same counter the page facts use,
 * so the core sees a gap whenever a notification was lost). Every string of
 * an event has the secrets known to the page masked first: request bodies and
 * headers included, not only console text. `flush(pageId)` sends what is
 * queued at once; the registry calls it before a response so the core reads
 * the events first, and the facts publisher calls it before each facts
 * notification so the two stay in order on the one writer.
 *
 * `Mixdog.internalConsole` and `Mixdog.requestRefused` are not CDP: the host
 * logged or refused something itself and says so in the same stream.
 */
import type { WebContents } from 'electron';

import type {
  BrowserEngineEvent,
  HostBrowserEventsParams,
  PageFacts,
} from '../../../../../../packages/protocol/src/index.ts';
import type { EngineEventSink } from '../../browser/cdp-event-router';
import type { HostConnection } from '../connection';
import type { EngineContext } from './context';

export const HOST_BROWSER_EVENTS = 'host/browser/events';

/** The events the engine lane carries (BROWSER_ENGINE_EVENT_METHODS of the app protocol). */
export const ENGINE_EVENT_METHODS: ReadonlySet<string> = new Set([
  'Network.requestWillBeSent',
  'Network.responseReceived',
  'Network.loadingFinished',
  'Network.loadingFailed',
  'Network.requestServedFromCache',
  'Network.dataReceived',
  'Network.webSocketCreated',
  'Network.webSocketClosed',
  'Network.webSocketFrameError',
  'Network.requestWillBeSentExtraInfo',
  'Network.responseReceivedExtraInfo',
  'Runtime.consoleAPICalled',
  'Runtime.exceptionThrown',
  'Runtime.executionContextCreated',
  'Runtime.executionContextDestroyed',
  'Runtime.executionContextsCleared',
  'Log.entryAdded',
  'Page.javascriptDialogOpening',
  'Page.javascriptDialogClosed',
  'Page.fileChooserOpened',
  'Mixdog.internalConsole',
  'Mixdog.requestRefused',
]);

/** A batch's events stay under this many serialized bytes (the limit is 200 KiB with the envelope). */
export const MAX_BATCH_BYTES = 180 * 1024;
/** A single string of an event is cut here before the event is measured. */
const MAX_STRING_CHARS = 32 * 1024;
/** Queued bytes of a page past which the queue is sent without waiting for the schedule. */
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;

export interface EngineEventsOptions {
  /** The next notification number of the page (shared with its facts). */
  nextSeq(pageId: string): number;
  /** Masks the secrets known to the page in `text`. */
  redact(pageId: string, text: string): string;
  /** The page's facts now. */
  facts(pageId: string): PageFacts;
  /** Runs `run` soon; the returned function cancels it. Defaults to a zero timer. */
  schedule?(run: () => void): () => void;
  now?(): number;
}

export type EngineEvents = EngineContext['events'] & {
  /** Queues one event of the page. */
  push(pageId: string, event: { sessionId?: string; method: string; params: unknown }): void;
  /** The page is gone: its queue is dropped. */
  drop(pageId: string): void;
};

interface Queue {
  events: Array<{ event: BrowserEngineEvent; bytes: number }>;
  bytes: number;
  cancel?: () => void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `value` with `fn` applied to every string in it (keys stay). */
function mapStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, fn)]));
  }
  return value;
}

const sizeOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? 'null');

function defaultSchedule(run: () => void): () => void {
  const timer = setTimeout(run, 0);
  return () => clearTimeout(timer);
}

export function createEngineEvents(connection: HostConnection, options: EngineEventsOptions): EngineEvents {
  const queues = new Map<string, Queue>();
  const schedule = options.schedule ?? defaultSchedule;
  const now = options.now ?? Date.now;

  function send(pageId: string, events: BrowserEngineEvent[]): void {
    const params: HostBrowserEventsParams = { pageId, seq: options.nextSeq(pageId), events };
    try {
      connection.notify(HOST_BROWSER_EVENTS, params);
    } catch {
      // The connection is closing; the next claim starts from a clean slate.
    }
  }

  function flush(pageId: string): void {
    const queue = queues.get(pageId);
    if (!queue) return;
    queue.cancel?.();
    queues.delete(pageId);
    let batch: BrowserEngineEvent[] = [];
    let batchBytes = 0;
    for (const { event, bytes } of queue.events) {
      if (batch.length && batchBytes + bytes > MAX_BATCH_BYTES) {
        send(pageId, batch);
        batch = [];
        batchBytes = 0;
      }
      batch.push(event);
      batchBytes += bytes;
    }
    if (batch.length) send(pageId, batch);
  }

  function push(pageId: string, raw: { sessionId?: string; method: string; params: unknown }): void {
    const clip = (text: string) =>
      options.redact(pageId, text.length > MAX_STRING_CHARS ? text.slice(0, MAX_STRING_CHARS) : text);
    let event: BrowserEngineEvent = {
      ...(raw.sessionId ? { sessionId: raw.sessionId } : {}),
      method: raw.method,
      params: mapStrings(raw.params ?? {}, clip) as BrowserEngineEvent['params'],
      t: now(),
    };
    let bytes = sizeOf(event);
    if (bytes > MAX_BATCH_BYTES) {
      // Many large strings in one event: the event is still delivered, without its payload.
      event = { ...event, params: { truncated: true } };
      bytes = sizeOf(event);
    }
    let queue = queues.get(pageId);
    if (!queue) {
      queue = { events: [], bytes: 0 };
      queues.set(pageId, queue);
    }
    queue.events.push({ event, bytes });
    queue.bytes += bytes;
    if (queue.bytes >= MAX_QUEUED_BYTES) {
      flush(pageId);
      return;
    }
    queue.cancel ??= schedule(() => {
      const held = queues.get(pageId);
      if (held) held.cancel = undefined;
      flush(pageId);
    });
  }

  return {
    push,
    flush,
    facts: (pageId) => options.facts(pageId),
    drop(pageId) {
      queues.get(pageId)?.cancel?.();
      queues.delete(pageId);
    },
  };
}

/** The router's sink onto the events queue: `pageId` names a guest's page; the lane is on while `isEngineMode()`. */
export function createEngineEventSink(
  events: Pick<EngineEvents, 'push'>,
  pageId: (guest: WebContents) => string,
  isEngineMode: () => boolean
): EngineEventSink {
  return {
    active: isEngineMode,
    carries: (method) => ENGINE_EVENT_METHODS.has(method),
    forward(guest, method, params, sessionId) {
      if (!ENGINE_EVENT_METHODS.has(method)) return;
      events.push(pageId(guest), { ...(sessionId ? { sessionId } : {}), method, params });
    },
  };
}

/** The synthetic events for the host's own console entries and refusals. */
export function pushInternalConsole(events: Pick<EngineEvents, 'push'>, pageId: string, text: string): void {
  events.push(pageId, { method: 'Mixdog.internalConsole', params: { level: 'error', text } });
}

export function pushRequestRefused(
  events: Pick<EngineEvents, 'push'>,
  pageId: string,
  url: string,
  reason: string
): void {
  events.push(pageId, { method: 'Mixdog.requestRefused', params: { url, reason } });
}
