// The phone's own transcript window over `mixdogd` (Node: remote-transcript-window.ts, one window per phone delta encoder).
// The phone folds a thread's feed into rows (packages/protocol-client); what it shows of them is cut here, per thread, by Node's
// rules (phoneTranscriptView):
//  - a first page is the newest rows whose phone copies fit REMOTE_TRANSCRIPT_TAIL_ITEMS rows and REMOTE_TRANSCRIPT_TAIL_BYTES
//    bytes, always its newest row: a tool row's outputs are capped, an oversized one cut to fit (remote-transcript.ts);
//  - a page request (`prefetchSession`'s limit) adds at most 512 rows above, within DESKTOP_TRANSCRIPT_PAGE_BYTES, as history
//    (outputs cut to their head);
//  - "Show full output" reads the whole row (`remoteToolOutput`).
// The rows sit in the phone's fold only as far as its `thread/resume` window reaches; older ones a page asks for are read from the
// core (`thread/items/list`, the `older` read) and kept, whole, above the fold's.
import { phoneTranscriptView, phoneTranscriptWanted, requestPhoneTranscriptPage } from './remote-transcript-window';
import { remoteToolOutput } from './remote-transcript';

export interface PhoneTranscriptReads {
  /** At most `limit` rows directly older than the row `beforeId`, as the phone folds them, and whether rows older still remain. */
  older(threadId: string, beforeId: string, limit: number): Promise<{ rows: unknown[]; hasOlder: boolean }>;
  /** A page changed what the thread's window holds: the phone is shown its state again (Node re-sent the session's frame). */
  changed(threadId: string): void;
}

interface ThreadWindow {
  /** The window's key (remote-transcript-window.ts keeps one window per key). */
  readonly key: object;
  /** Rows read from the core above the fold's first row, oldest first, whole. */
  earlier: unknown[];
  /** Whether rows older than `earlier` remain. */
  earlierHasOlder: boolean;
  /** The fold row `earlier` was read above: when the fold starts elsewhere (a reset, a new resume) they no longer join it. */
  above: unknown;
  /** The rows the phone was last shown. */
  shown: unknown[] | undefined;
}

const idOf = (item: unknown): unknown => (item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined);
const itemsOf = (state: unknown): unknown[] => {
  const items = (state as { items?: unknown } | null | undefined)?.items;
  return Array.isArray(items) ? items : [];
};

export interface PhoneTranscript {
  /** `state` (the thread's folded state) as the phone shows it. */
  view<T>(threadId: string, state: T): T;
  /** The phone asked to hold `limit` rows of the thread (a history page); rows the fold lacks are read first. */
  page(threadId: string, state: unknown, limit: number): Promise<void>;
  /** The whole output of a tool row the phone holds (`remoteToolOutput`), or null. */
  output(threadId: string, state: unknown, itemId: string): ReturnType<typeof remoteToolOutput>;
  /** The thread is no longer shown: its window goes. */
  forget(threadId: string): void;
}

export function createPhoneTranscript(reads: PhoneTranscriptReads): PhoneTranscript {
  const threads = new Map<string, ThreadWindow>();
  const windowOf = (threadId: string): ThreadWindow => {
    let window = threads.get(threadId);
    if (!window) {
      window = { key: {}, earlier: [], earlierHasOlder: false, above: undefined, shown: undefined };
      threads.set(threadId, window);
    }
    return window;
  };
  /** Every row the phone can be shown: those read above the fold, then the fold's. */
  const whole = (window: ThreadWindow, state: unknown): Record<string, unknown> => {
    const record = (state && typeof state === 'object' ? state : {}) as Record<string, unknown>;
    const items = itemsOf(state);
    if (window.earlier.length && window.above !== idOf(items[0])) window.earlier = [];
    if (!window.earlier.length) return record;
    return { ...record, items: [...window.earlier, ...items], transcriptHasOlder: window.earlierHasOlder };
  };
  return {
    view(threadId, state) {
      const window = windowOf(threadId);
      const shown = phoneTranscriptView(window.key, whole(window, state), window.shown);
      window.shown = itemsOf(shown);
      return shown as typeof state;
    },
    async page(threadId, state, limit) {
      const window = windowOf(threadId);
      requestPhoneTranscriptPage(window.key, limit);
      const record = whole(window, state);
      const rows = itemsOf(record);
      const start = rows.findIndex((row) => idOf(row) === idOf(window.shown?.[0]));
      const missing = phoneTranscriptWanted(window.key, rows, window.shown) - start;
      if (start >= 0 && missing > 0 && record.transcriptHasOlder === true) {
        const read = await reads.older(threadId, String(idOf(rows[0])), missing);
        window.above = window.earlier.length ? window.above : idOf(itemsOf(state)[0]);
        window.earlier = [...read.rows, ...window.earlier];
        window.earlierHasOlder = read.hasOlder;
      }
      reads.changed(threadId);
    },
    output(threadId, state, itemId) {
      return remoteToolOutput(whole(windowOf(threadId), state), itemId);
    },
    forget(threadId) {
      threads.delete(threadId);
    },
  };
}
