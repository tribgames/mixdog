// Folds `thread/snapshot` and thread feed notifications into `DesktopSessionState` (apps/desktop/src/shared/contract-session.ts, protocol.md §2.5, §5.1, §8.5).
import type { Json, JsonRpcNotification, ProtocolClient, ServerRequest, StreamPosition, ThreadReducer } from './api.ts';
import { streamPositionReached } from './api.ts';
import { asObj, isObj } from './obj.ts';
import type { Obj } from './obj.ts';
import { itemRows, mergeToolRows, mergeToolRowsFrom, mergeToolRowsSteps, rowOf, rowsOf } from './rows.ts';

/** The projection the UI reads: a flat record of `DesktopSessionState` fields. */
export type DesktopSessionState = Readonly<Record<string, Json>>;

/** Assistant text being streamed: the item id, the row identity the tail will take over, and the text so far, held as its
 *  completed lines (`lines`, up to and including the last newline) and the unfinished line after them (`rest`). A delta is
 *  appended to these two parts by looking only at the delta, so the reply so far is never rescanned or flattened per token. */
interface Live {
  readonly id: string;
  readonly identity: Obj;
  readonly lines: string;
  readonly rest: string;
}

/** `text` cut at its last newline. */
function splitLive(text: string): { lines: string; rest: string } {
  const cut = text.lastIndexOf('\n') + 1;
  return { lines: text.slice(0, cut), rest: text.slice(cut) };
}

/** `live` with `delta` appended. */
function appendLive(live: Live, delta: string): Live {
  const cut = delta.lastIndexOf('\n') + 1;
  if (cut === 0) return { ...live, rest: live.rest + delta };
  return { ...live, lines: live.lines + live.rest + delta.slice(0, cut), rest: delta.slice(cut) };
}

/** Whether the live row shows an unfinished line (`liveFields` sets `streamingPartial`). */
const showsPartial = (live: Live): boolean => (live.lines ? live.rest !== '' : /\S/.test(live.rest));

/** The reducer state of one thread feed. */
export interface SessionFold {
  readonly sessionId: string;
  /** Transcript rows (`DesktopTranscriptItem`), in feed order. */
  readonly items: readonly Obj[];
  /** Fields owned by section notifications and `thread/snapshot.state`; an absent field is absent here. */
  readonly fields: Readonly<Obj>;
  readonly live: Live | null;
  /** How many times the rows changed structure (`structureRevision`: an item entered, was replaced, or the log was cut back). */
  readonly structureRevision: number;
  /** A live row has shown an unfinished line (`streamingPartial`) since the fold began: from then on the field is held, `null`
   *  between lines, as Node's store holds it (turn-stream.mjs:197 sets it, :214 clears it to null; the first draft has none). */
  readonly partialShown?: boolean;
  /** The core's `thread/frame` announcements since the fold began: Node's publications of the state (frame-batched-store.mjs). */
  readonly frames?: number;
  /** `structureRevision` as Node's frames commit it: one up per frame that changed the rows' structure (frame-batched-store.mjs:37). */
  readonly framedRevision?: number;
  /** The `thread/snapshot` this fold grew from, a new object per snapshot: a reader that holds an earlier fold tells a fold
   *  that replaced it from one that advanced it. The invariant its readers rely on (`subscribeFramedSessionStates`, the desktop's
   *  session lane): every snapshot's fold gets a fresh object (`initialSteps`), and every incremental step keeps it as it is
   *  (the reducer spreads the fold). test/framed-states.test.ts fails when either stops holding. */
  readonly origin?: object;
  /** The ids of the core items this fold holds, oldest first: the snapshot's, then each item the feed brought, whether or not it
   *  has a row (a reasoning item has none, a run of tool calls is one card). A `thread/resume` window counts these, and the first
   *  is where the window begins (`transcriptWindowStart`); both are read here, never counted beside the fold. */
  readonly coreItems?: readonly string[];
  /** What the core holds above the window, as its last snapshot or history reset said: 'held', the thread's start is inside
   *  the window; 'older', older items exist. Stated either way (`transcriptHistory`): a state without it comes from a host that
   *  says nothing, which is neither. */
  readonly history?: 'held' | 'older';
  /** The history resets (`thread/historyReset`: a rewind, a clear) folded since the snapshot: the window after one is another
   *  window, even when it still begins at the same item (`transcriptGeneration`). */
  readonly generation?: number;
}

/** The core item each row was folded from (a row's id is not always its item's: a prompt's row is named by its submission). */
const rowItems = new WeakMap<Obj, string>();

/** `held` with `item`: unchanged when the fold holds it already, or when it is re-sent archived (an archived item the fold does
 *  not hold lies above its window, older than the compaction's divider). */
function holding(held: readonly string[], item: Obj): readonly string[] {
  const id = item.id;
  if (typeof id !== 'string' || held.lastIndexOf(id) >= 0) return held;
  if (asObj(asObj(item.meta).ext).archived === true) return held;
  return [...held, id];
}

/** Where in `held` the item lies that the core names `shown`: the core names an item by the id a client shows for it, which
 *  is the submission id for a prompt that carries one (mutation.rs `before_rewind`) and the item's own id otherwise, row or
 *  no row. -1 when the fold does not hold it. */
function boundaryItem(s: SessionFold, held: readonly string[], shown: string): number {
  const own = held.lastIndexOf(shown);
  if (own >= 0) return own;
  let at = s.items.length - 1;
  while (at >= 0 && s.items[at]!.id !== shown) at--;
  const item = at < 0 ? undefined : rowItems.get(s.items[at]!);
  return item === undefined ? -1 : held.lastIndexOf(item);
}

// ───────────────────────────── sections ─────────────────────────────

/** `fields`: an object section that owns several fields, replaced as a whole (a field the value omits is removed).
 * `field`: a section that owns one field; JSON `null` removes it. */
type SectionDef =
  | { readonly stateKey: string; readonly fields: readonly string[] }
  | { readonly stateKey: string; readonly field: string };

const SECTIONS: Readonly<Record<string, SectionDef>> = {
  'thread/runtime/updated': {
    stateKey: 'runtime',
    fields: [
      'busy',
      'commandBusy',
      'thinking',
      'spinner',
      'commandStatus',
      'progressHint',
      'activeTools',
      'clientHostPid',
      'toasts',
      'activeToolSummary',
      'toolMode',
      'setupChanged',
    ],
  },
  'thread/route/updated': {
    stateKey: 'route',
    fields: [
      'sessionProvider',
      'sessionModel',
      'fast',
      'fastCapable',
      'autoEffort',
      'modelParameters',
      'selectedContextWindow',
      'effort',
      'provider',
      'model',
      'turnEffort',
      'effortOptions',
      'cwd',
      'sessionForkedFrom',
      'systemShell',
      'webSearchRoute',
      'autoClear',
    ],
  },
  'thread/context/updated': {
    stateKey: 'context',
    fields: [
      'contextPercent',
      'contextTokens',
      'contextDefaultPercent',
      'contextWindow',
      'displayContextWindow',
      'autoCompactTokenLimit',
      'stats',
      'rawContextWindow',
      'effectiveContextWindowPercent',
      'compactBoundaryTokens',
    ],
  },
  'thread/agents/updated': { stateKey: 'agents', fields: ['agentWorkers', 'agentJobs', 'agentScope'] },
  'thread/workflow/updated': {
    stateKey: 'workflow',
    fields: ['workflow', 'orchestrationMode', 'pendingWorkflowSwitch', 'pendingOrchestrationModeSwitch'],
  },
  'thread/approvals/updated': { stateKey: 'approvals', fields: ['toolApprovalResult', 'handoffQuestions'] },
  'thread/todo/updated': { stateKey: 'todo', field: 'todo' },
  'thread/goal/updated': { stateKey: 'goal', field: 'goal' },
  'thread/quotaResume/updated': { stateKey: 'quotaResume', field: 'quotaResume' },
  'thread/shellJobs/updated': { stateKey: 'shellJobs', field: 'shellJobs' },
  'thread/workspace/updated': { stateKey: 'workspace', field: 'workspace' },
  'thread/promptRestore': { stateKey: 'promptRestore', field: 'promptRestore' },
  'thread/providerAccount/changed': { stateKey: 'providerAccountChange', field: 'providerAccountChange' },
  'thread/remote/updated': { stateKey: 'remoteEnabled', field: 'remoteEnabled' },
  'thread/setupUiRequest/updated': { stateKey: 'setupUiRequest', field: 'setupUiRequest' },
  // A group room log's view while the room runs (`{ busy, toolApproval?, typing?, deciding?, handoffQuestions? }`, Node's
  // `decorateRoomSnapshot`): not a field of its own, laid over the log's fields by `desktopSessionState`. The core sends it
  // with the row it landed with (`item/completed.roomView`) or alone when no row changes; the typing row is the core's, drawn
  // as supplied.
  'thread/roomView/updated': { stateKey: 'roomView', field: 'roomView' },
};

/** The shell-job status with no job (shell-jobs-poller.ts's empty status). */
const emptyShellJobs = (): Json => ({ count: 0, elapsedLabel: '', jobs: [], finished: [] });

/** Up-arrow recall holds at most this many prompts (`PROMPT_HISTORY_LIMIT`). */
const PROMPT_HISTORY_LIMIT = 50;
const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** `thread/promptHistory/updated`: `added` puts the prompt first, replacing an entry of the same whitespace-collapsed text, and
 * keeps the newest 50; `replaced` is the whole list. The list is the core's, over the whole transcript, never derived from the
 * resumed rows (a window shorter than the transcript). */
function promptHistoryOf(held: unknown, change: Obj): Json[] {
  if (change.kind === 'replaced') return Array.isArray(change.prompts) ? change.prompts : [];
  if (change.kind !== 'added' || typeof change.prompt !== 'string') return Array.isArray(held) ? (held as Json[]) : [];
  const key = collapse(change.prompt);
  const rest = (Array.isArray(held) ? (held as Json[]) : []).filter(
    (p) => typeof p !== 'string' || collapse(p) !== key
  );
  return [change.prompt, ...rest].slice(0, PROMPT_HISTORY_LIMIT);
}

/** Applies one section value to the field record (a new record; `fields` is never mutated). */
function withSection(fields: Readonly<Obj>, def: SectionDef, value: Json | undefined): Obj {
  const next: Obj = { ...fields };
  if ('field' in def) {
    if (value === undefined || value === null) delete next[def.field];
    else next[def.field] = value;
    return next;
  }
  const v = asObj(value);
  for (const f of def.fields) {
    if (v[f] === undefined) delete next[f];
    else next[f] = v[f] as Json;
  }
  return next;
}

// ───────────────────────────── items → rows ─────────────────────────────

/** `fold.items` holds one row per item; the transcript the UI reads merges runs of tool rows into aggregate cards. The merge is
 * memoized on the identity of the (never mutated) row array, so a render that changed nothing costs nothing. */
const transcriptCache = new WeakMap<readonly Obj[], Obj[]>();
/** A row array not merged yet, by the array: the merged transcript of an earlier one it holds the same rows as before
 *  `from`. However many notifications changed rows since that transcript was read, the next read merges once, from there. */
const transcriptOwed = new WeakMap<readonly Obj[], { held: Obj[]; from: number }>();
function transcriptOf(items: readonly Obj[]): Obj[] {
  let rows = transcriptCache.get(items);
  if (!rows) {
    const owed = transcriptOwed.get(items);
    rows = owed ? mergeToolRowsFrom(owed.held, items, owed.from) : mergeToolRows(items);
    transcriptOwed.delete(items);
    transcriptCache.set(items, rows);
  }
  return rows;
}
/** `next` holds the rows of `prior` before `from`: its transcript is owed from the one `prior` has, or is owed from. */
function oweTranscript(prior: readonly Obj[], next: readonly Obj[], from: number): void {
  const merged = transcriptCache.get(prior);
  const owed = merged ? undefined : transcriptOwed.get(prior);
  if (merged) transcriptOwed.set(next, { held: merged, from });
  else if (owed) transcriptOwed.set(next, { held: owed.held, from: Math.min(owed.from, from) });
}

/** The most rows a subscribed thread's fold holds while rows keep arriving: the desktop's largest transcript read (main/ipc-validation.ts
 * TRANSCRIPT_WINDOW_MAX_ITEMS), so a thread followed for long keeps a bounded window. A row past it drops the oldest, and the fold
 * says older rows exist (`transcriptHasOlder`), which paging reads back as it reads rows above any window. */
export const FOLD_MAX_ITEMS = 8_192;

/** `items` with `row` in the place of the row of its id, or after them all; `at` is where it went. */
function upsert(items: readonly Obj[], row: Obj): { items: Obj[]; at: number } {
  let at = items.length - 1;
  while (at >= 0 && items[at]?.id !== row.id) at--;
  if (at < 0) return { items: [...items, row], at: items.length };
  const next = items.slice();
  next[at] = row;
  return { items: next, at };
}

// ───────────────────────────── the reducer ─────────────────────────────

/** The queue as clients hold it, Node's projection of a queue entry (`session-state-projection.mjs:33-49`): `id`, `submittedAt`,
 * `text` and `displayText` (the same shown text), `mode`, `priority`, the sender's source fields and the images. A queued entry is
 * named by the submission it answers (Node's `makeQueueEntry` id), which the core carries as `clientSubmissionId` beside its own
 * queue id; its `submittedAt` is the core's `enqueuedAt`. */
function queueOf(queued: Json | undefined): Json[] {
  if (!Array.isArray(queued)) return [];
  return queued.map((row) => {
    // Only the core's queue rows (they carry `enqueuedAt`) are projected; a row already in the projected shape stays as it is.
    if (!isObj(row) || !('enqueuedAt' in row)) return row;
    const { clientSubmissionId, enqueuedAt, id, text, mode, priority, images, ...source } = row;
    const shown = typeof text === 'string' ? text : '';
    return {
      id: typeof clientSubmissionId === 'string' && clientSubmissionId ? clientSubmissionId : id,
      submittedAt: enqueuedAt,
      text: shown,
      displayText: shown,
      mode: mode || 'prompt',
      priority: priority || 'next',
      ...source,
      ...(Array.isArray(images) && images.length ? { images } : {}),
    };
  });
}

function fieldsOfState(state: Obj): Obj {
  let fields: Obj = {};
  for (const def of Object.values(SECTIONS)) fields = withSection(fields, def, state[def.stateKey]);
  if (typeof state.title === 'string') fields.desktopSessionTitle = state.title;
  if (Array.isArray(state.promptHistoryList)) fields.promptHistoryList = state.promptHistoryList;
  fields.queued = queueOf(state.queued);
  return fields;
}

/** The live text of an `agentMessage` item: the row it settles as, without its text. */
function liveOf(item: Obj, row: Obj): Live {
  const { text, ...identity } = row;
  return {
    id: String(item.id),
    identity: { ...identity, kind: 'assistant', streaming: true },
    ...splitLive(typeof text === 'string' ? text : ''),
  };
}

const withLive = (s: SessionFold, live: Live | null): SessionFold => ({
  ...s,
  live,
  ...(!s.partialShown && live && showsPartial(live) ? { partialShown: true } : {}),
});
const withField = (s: SessionFold, key: string, value: Json | undefined): SessionFold => {
  const fields: Obj = { ...s.fields };
  if (value === undefined) delete fields[key];
  else fields[key] = value;
  return { ...s, fields };
};

/** Rows of the snapshot's items, yielding every `ITEMS_PER_STEP` so a long transcript folds in budgeted turns. The merged transcript
 * is built in steps too and cached before the state is returned, so the first read does not pay for it. */
const ITEMS_PER_STEP = 16;
function* initialSteps(snapshot: Json): Generator<void, SessionFold, void> {
  const p = asObj(snapshot);
  const source = Array.isArray(p.items) ? p.items : [];
  const items: Obj[] = [];
  const coreItems: string[] = [];
  let live: Live | null = null;
  for (let i = 0; i < source.length; i++) {
    const item = asObj(source[i]);
    const id = typeof item.id === 'string' ? item.id : undefined;
    if (id !== undefined) coreItems.push(id);
    // The reply the turn is streaming (the core's in-progress item, its text so far) is the live row `item/started` and its deltas
    // made, not a settled row: a snapshot taken mid-stream folds to the state the live feed had, and the next delta extends it.
    const row = item.type === 'agentMessage' && asObj(item.meta).status === 'inProgress' ? rowOf(item) : null;
    if (row) live = liveOf(item, row);
    else
      for (const folded of rowsOf(item)) {
        if (id !== undefined) rowItems.set(folded, id);
        items.push(folded);
      }
    if (i % ITEMS_PER_STEP === ITEMS_PER_STEP - 1) yield;
  }
  transcriptCache.set(items, yield* mergeToolRowsSteps(items));
  // Node's store begins at 0 (initial-state.mjs:18) and a snapshot's rows enter it as one structure change (transcript-store.mjs:74,
  // a restore's `replaceItems`; a new task's first row is a push, frame-batched-store.mjs:37): a snapshot with rows is revision 1.
  // `origin` is a fresh object for each snapshot and is never replaced by a later step (`SessionFold.origin`).
  const fold: SessionFold = {
    sessionId: String(asObj(p.thread).id ?? ''),
    items,
    fields: fieldsOfState(asObj(p.state)),
    live: null,
    structureRevision: items.length ? 1 : 0,
    frames: 0,
    framedRevision: items.length ? 1 : 0,
    origin: {},
    coreItems,
    history: p.hasOlder === true ? 'older' : 'held',
    generation: 0,
  };
  return live ? withLive(fold, live) : fold;
}

export const sessionReducer: ThreadReducer<SessionFold> = {
  initial(snapshot: Json): SessionFold {
    const steps = initialSteps(snapshot);
    for (;;) {
      const r = steps.next();
      if (r.done) return r.value;
    }
  },
  initialSteps,

  apply(s: SessionFold, n: JsonRpcNotification): SessionFold {
    const p = asObj(n.params);
    const section = SECTIONS[n.method];
    if (section) return { ...s, fields: withSection(s.fields, section, p.value) };
    switch (n.method) {
      case 'thread/promptHistory/updated':
        return withField(s, 'promptHistoryList', promptHistoryOf(s.fields.promptHistoryList, asObj(p.value)));
      case 'thread/queue/changed':
        return withField(s, 'queued', queueOf(p.queued));
      case 'thread/name/updated':
        return withField(s, 'desktopSessionTitle', typeof p.title === 'string' ? p.title : undefined);
      case 'thread/goal/cleared':
        return withField(s, 'goal', undefined);
      case 'thread/frame':
        return {
          ...s,
          frames: (s.frames ?? 0) + 1,
          framedRevision: (s.framedRevision ?? 0) + (p.structureChanged === true ? 1 : 0),
        };
      case 'turn/started':
      case 'turn/completed':
        return withLive(s, null);
      case 'item/started':
      case 'item/completed': {
        const item = asObj(p.item);
        const rows = itemRows(item);
        const [row, ...batched] = rows;
        // After a compaction the core sends each row of its window again, archived (`show_archived`). A row this store does not
        // hold lies above its tail window, older than the divider; appended, it showed below the divider, inside the current turn.
        // Node dims only the rows its store holds (`archiveItemsForCompaction`); paging reads the older ones, already archived.
        if (row?.archived === true && !s.items.some((held) => held.id === row.id)) return s;
        // The item is held from here on, whatever it folds to below: every later return starts from `held`.
        const coreItems = holding(s.coreItems ?? [], item);
        const held = coreItems === s.coreItems ? s : { ...s, coreItems };
        if (row === undefined) return held;
        if (item.type === 'agentMessage' && n.method === 'item/started') return withLive(held, liveOf(item, row));
        for (const folded of rows) rowItems.set(folded, String(item.id));
        const live = s.live?.id === item.id && n.method === 'item/completed' ? null : s.live;
        // A room log's row and the view that landed with it are one revision: the view rides on the row's notification
        // (`roomView`), so both are folded here, before any subscriber is told.
        const viewed =
          p.roomView === undefined ? s.fields : withSection(s.fields, SECTIONS['thread/roomView/updated']!, p.roomView);
        let upserted: readonly Obj[] = s.items;
        let from = s.items.length;
        for (const folded of [row, ...batched]) {
          const placed = upsert(upserted, folded);
          upserted = placed.items;
          from = Math.min(from, placed.at);
        }
        const drop = upserted.length - FOLD_MAX_ITEMS;
        const revision = s.structureRevision + 1;
        if (drop <= 0) {
          // The transcript is merged on from the one held, when it is next read (a frame's publication): the cards before
          // the first row that changed are not made again, and a run of notifications between two reads is one merge.
          oweTranscript(s.items, upserted, from);
          return { ...held, items: upserted, live, fields: viewed, structureRevision: revision };
        }
        // The dropped rows' items go with them: the window begins at the item of the first row kept.
        const items = upserted.slice(drop);
        const first = coreItems.indexOf(rowItems.get(items[0]!) ?? '');
        return {
          ...held,
          items,
          live,
          fields: viewed,
          structureRevision: revision,
          coreItems: first > 0 ? coreItems.slice(first) : coreItems,
          history: 'older',
        };
      }
      case 'item/agentMessage/delta': {
        const id = String(p.itemId);
        const delta = typeof p.delta === 'string' ? p.delta : '';
        const live =
          s.live?.id === id
            ? appendLive(s.live, delta)
            : { id, identity: { id, kind: 'assistant', streaming: true }, ...splitLive(delta) };
        return withLive(s, live);
      }
      case 'thread/historyReset': {
        // `hasOlder` speaks of the core's own window (mutation.rs `history_reset`), which may reach further back than this
        // one. A clear leaves nothing anywhere, so it is this window's answer too. A rewind keeps the items up to its boundary:
        // with the boundary inside this window the window begins where it did, and what lies above it is what the fold
        // already said, or what the core says is older still; with the boundary above this window everything held goes and
        // what the rewind kept is above it.
        const held = s.coreItems;
        const boundary = p.fromItemId === undefined ? undefined : String(p.fromItemId);
        const kept = boundary === undefined || !held ? 0 : boundaryItem(s, held, boundary) + 1;
        const above = boundary !== undefined && (kept === 0 ? held !== undefined : s.history === 'older');
        const reset: SessionFold = {
          ...s,
          live: null,
          history: p.hasOlder === true || above ? 'older' : 'held',
          generation: (s.generation ?? 0) + 1,
        };
        // A fold that names no core items (one built outside this reducer) is cut where its rows name the boundary.
        if (!held) {
          const at = p.fromItemId === undefined ? -1 : s.items.findIndex((r) => r.id === p.fromItemId);
          if (p.fromItemId !== undefined && at < 0) return reset;
          return { ...reset, items: s.items.slice(0, at + 1), structureRevision: s.structureRevision + 1 };
        }
        // The items past the boundary are no longer the thread's. One cut, at a core item, takes them and their rows; a
        // boundary the fold does not hold lies above its window, and nothing it holds stays.
        const order = new Map(held.map((id, at) => [id, at]));
        let rows = s.items.length;
        while (rows > 0 && (order.get(rowItems.get(s.items[rows - 1]!) ?? '') ?? -1) >= kept) rows--;
        return {
          ...reset,
          items: s.items.slice(0, rows),
          structureRevision: s.structureRevision + 1,
          coreItems: held.slice(0, kept),
        };
      }
      default:
        return s;
    }
  },
};

// ───────────────────────────── projection ─────────────────────────────

/** The live row as `streamingTail` (what the terminal shows, gated to completed lines) and `streamingPartial` (the unfinished
 * line beyond it), as the engine publishes them today (turn-stream.mjs `partialNow`). */
function liveFields(live: Live): Obj {
  const { lines, rest } = live;
  const out: Obj = {};
  if (lines) {
    out.streamingTail = { ...live.identity, text: lines };
    if (rest) out.streamingPartial = { id: live.id, from: lines.length, text: rest };
  } else if (showsPartial(live)) {
    out.streamingPartial = { id: live.id, from: 0, text: rest, tail: live.identity };
  }
  return out;
}

/** The card of a server request, shaped like today's `toolApproval`: the request's own content plus its id. */
function approvalCard(r: ServerRequest): Obj {
  // The core's copy of Node's card (`normalizeToolApprovalRequest` of the hook request), with the row-shaped id the card shows
  // (room_approval.rs `card_id`; `approvalRequestOf` finds the request back from it).
  const card = asObj(r.params).card;
  if (card && typeof card === 'object' && !Array.isArray(card)) return { ...(card as Obj) };
  const {
    threadId: _t,
    turnId: _u,
    itemId: _i,
    surfaceThreadId: _s,
    chain: _c,
    requestedAt: _r,
    expiresAt: _e,
    order: _o,
    request,
    kind: _k,
    ...rest
  } = asObj(r.params);
  // An `ask_user` question carries no kind on the wire (its method says it); Node's card said `kind: 'question'` (the push notifier
  // and the card's Allow rules tell a question from an approval by it).
  return {
    ...rest,
    ...asObj(request),
    ...(r.method === 'item/tool/requestUserInput' ? { kind: 'question' } : {}),
    id: String(r.id),
  };
}

const surfaceOf = (r: ServerRequest): string => {
  const p = r.params as unknown as { surfaceThreadId?: string; threadId: string };
  return p.surfaceThreadId ?? p.threadId;
};
/** The thread whose approval card a server request belongs to. */
export const approvalSurface = surfaceOf;

/**
 * The `DesktopSessionState` of one thread. Pure: a caller that renders often memoizes on the identity of `fold`, `requests` and
 * `hostShellJobs`.
 *  - `toolApproval` is the pending request with the lowest `order` on this surface, `toolApprovalsWaiting` the others (§8.5).
 *    Both start from the engine's initial state (`null`, 0: initial-state.mjs); the counter is the queue length
 *    (tool-approval.mjs `presentNextToolApproval`) whether or not a `toolApprovalResult` is shown.
 */
export function desktopSessionState(
  fold: SessionFold,
  requests: readonly ServerRequest[],
  hostShellJobs?: Json
): DesktopSessionState {
  // Idle values of the TUI store's state (`createInitialSessionState`, context-state.mjs `baseRouteState`): the core keeps the whole log,
  // so the transcript window never spills or pages (decisions.md, the `transcriptArchive` row).
  const out: Obj = {
    sessionProvider: null,
    sessionModel: null,
    promptRestore: null,
    workspace: null,
    goal: null,
    quotaResume: null,
    todo: null,
    agentScope: null,
    ...fold.fields,
    sessionId: fold.sessionId,
    items: transcriptOf(fold.items),
    structureRevision: fold.structureRevision,
    streamingTail: null,
    ...(fold.partialShown ? { streamingPartial: null } : {}),
    promptHistoryList: [],
    transcriptViewItems: null,
    transcriptViewRevision: 0,
    transcriptHistoryBefore: false,
    transcriptHistoryAfter: false,
    transcriptArchive: null,
    lastTurn: null,
    themeEpoch: 0,
    // Host fields Node's session state always carries (session-host-publication.ts:281-288, session-host.ts:485-495).
    remoteEnabled: false,
    remoteSessionId: null,
    shellJobs: emptyShellJobs(),
    hostShellJobs: emptyShellJobs(),
    ...fold.fields,
    toolApproval: null,
    toolApprovalsWaiting: 0,
  };
  // The window, stated: what the core holds above it, the core item it begins at, and its generation. `transcriptHasOlder`
  // is the same fact for readers that predate `transcriptHistory`, present only when true as it always was.
  if (fold.history !== undefined) out.transcriptHistory = fold.history;
  if (fold.history === 'older') out.transcriptHasOlder = true;
  if (fold.generation !== undefined) out.transcriptGeneration = fold.generation;
  const windowStart = fold.coreItems?.[0];
  if (windowStart !== undefined) out.transcriptWindowStart = windowStart;
  if (fold.items.length) out.transcriptSpilled = { epoch: 0, rows: 0 };
  if (hostShellJobs !== undefined) out.hostShellJobs = hostShellJobs;
  if (fold.live) Object.assign(out, liveFields(fold.live));
  const approval = nextApproval(requests, fold.sessionId);
  if (approval) {
    out.toolApproval = approval.card;
    out.toolApprovalsWaiting = approval.waiting;
  }
  return withRoomView(out);
}

function nextApproval(requests: readonly ServerRequest[], sessionId: string): { card: Obj; waiting: number } | null {
  const pending = requests
    .filter((r) => surfaceOf(r) === sessionId)
    .map((r, arrival) => ({ r, arrival, order: (r.params as { order: number }).order }))
    .sort((a, b) => a.order - b.order || a.arrival - b.arrival);
  const first = pending[0];
  return first ? { card: approvalCard(first.r), waiting: pending.length - 1 } : null;
}

/** A room log's `roomView` laid over its state as Node's `decorateRoomSnapshot` decorates the room's session state
 *  (`agent-room-views.ts`): busy while the room has an exchange state, the speaking member's `toolApproval`, the handed-off
 *  questions, and the typing row after the transcript. `roomView` itself is not a `DesktopSessionState` field. */
function withRoomView(out: Obj): Obj {
  const view = out.roomView;
  delete out.roomView;
  if (!view || typeof view !== 'object' || Array.isArray(view)) return out;
  const room = view as Obj;
  if (Array.isArray(room.handoffQuestions) && room.handoffQuestions.length)
    out.handoffQuestions = room.handoffQuestions;
  if (room.busy !== true) return out;
  out.busy = true;
  if (room.toolApproval && typeof room.toolApproval === 'object') out.toolApproval = room.toolApproval;
  const items = Array.isArray(out.items) ? (out.items as Json[]) : [];
  if (room.typing && typeof room.typing === 'object') out.items = [...items, room.typing];
  return out;
}

/** `desktopSessionState` of a folded thread of `client`; `undefined` when the thread is not subscribed. */
export function sessionStateOf(client: ProtocolClient<SessionFold>, threadId: string): DesktopSessionState | undefined {
  const fold = client.store.thread(threadId);
  if (!fold) return undefined;
  return desktopSessionState(fold.state, client.pendingServerRequests(), client.store.section('hostShellJobs')?.value);
}

/** The thread's states as Node's frame publisher published them (frame-batched-store.mjs): `listener` hears the first fold of the
 *  thread and then one state per `thread/frame`, its `structureRevision` the frames' (one up per frame that changed the rows'
 *  structure). A fold that replaces the thread's (a resume's new snapshot: another window, a redial) is a first fold again, its
 *  frames counted from none.
 *
 *  What is heard is kept per fold, by the fold's `origin` (`initialSteps`: one new object per snapshot, carried unchanged by every
 *  incremental step of the reducer), so it goes with the fold: a thread that is unsubscribed or lost leaves nothing behind. A
 *  fold without an `origin` is heard at every change. The phone shows these; a reader of every change uses `sessionStateOf`.
 *
 *  Each state is heard with the feed position it was folded up to. A note that schedules no frame and leaves the fold as it was
 *  (stage, model-request and tool-batch telemetry) makes the state last heard current at its later position: `current` hears
 *  that position, with the state last heard, so a reader comparing with a received position (`feedPosition`) always reaches it. */
export function subscribeFramedSessionStates(
  client: ProtocolClient<SessionFold>,
  threadId: () => string | undefined,
  listener: (threadId: string, state: DesktopSessionState, position: StreamPosition) => void,
  current?: (threadId: string, state: DesktopSessionState, position: StreamPosition) => void
): () => void {
  const heard = new WeakMap<
    object,
    { frames: number; fold: SessionFold; state: DesktopSessionState; position: StreamPosition }
  >();
  return client.store.subscribe((change) => {
    if (change.type !== 'thread') return;
    const id = threadId() ?? change.threadId;
    if (change.threadId !== id) return;
    const entry = client.store.thread(id);
    const fold = entry?.state;
    if (!entry || !fold) return;
    const frames = fold.frames ?? 0;
    const position: StreamPosition = { epoch: entry.feed.epoch, seq: entry.feed.seq, order: entry.order };
    const last = fold.origin ? heard.get(fold.origin) : undefined;
    if (last && last.frames === frames) {
      if (current && last.fold === fold && !streamPositionReached(last.position, position)) {
        heard.set(fold.origin as object, { ...last, position });
        current(id, last.state, position);
      }
      return;
    }
    const state = {
      ...desktopSessionState(fold, client.pendingServerRequests(), client.store.section('hostShellJobs')?.value),
      structureRevision: fold.framedRevision ?? fold.structureRevision,
    };
    if (fold.origin) heard.set(fold.origin, { frames, fold, state, position });
    listener(id, state, position);
  });
}
