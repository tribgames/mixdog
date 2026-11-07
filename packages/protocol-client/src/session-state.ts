// The thread fold: `thread/snapshot` plus the thread feed notifications folded into the view model that reproduces today's
// `DesktopSessionState` (apps/desktop/src/shared/contract-session.ts), protocol.md §2.5 and §5.1.
//
// Two layers, so that each input has exactly one owner:
//  - `sessionReducer` is the pure `ThreadReducer`: it keeps the transcript rows, the section-owned fields and the live
//    assistant text of one thread feed.
//  - `desktopSessionState` projects that fold, the pending server requests and the `hostShellJobs` section into the
//    `DesktopSessionState` the UI reads. `toolApproval`/`toolApprovalsWaiting` come from server requests (protocol.md §8.5) and
//    `hostShellJobs` from the app feed, which are not part of the thread feed, so they are joined here and nowhere else.
import type { Json, JsonRpcNotification, ProtocolClient, ServerRequest, ThreadReducer } from './api.ts';
import { asObj } from './obj.ts';
import type { Obj } from './obj.ts';
import { mergeToolRows, mergeToolRowsSteps, rowOf } from './rows.ts';


/** The projection the UI reads: a flat record of `DesktopSessionState` fields. */
export type DesktopSessionState = Readonly<Record<string, Json>>;

/** Assistant text being streamed: the item id, the row identity the tail will take over, and the text so far. */
interface Live {
  readonly id: string;
  readonly identity: Obj;
  readonly text: string;
}

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
}

// ───────────────────────────── sections ─────────────────────────────

/** `fields`: an object section that owns several fields, replaced as a whole (a field the value omits is removed).
 * `field`: a section that owns one field; JSON `null` removes it. */
type SectionDef = { readonly stateKey: string; readonly fields: readonly string[] } | { readonly stateKey: string; readonly field: string };

const SECTIONS: Readonly<Record<string, SectionDef>> = {
  'thread/runtime/updated': { stateKey: 'runtime', fields: ['busy', 'commandBusy', 'thinking', 'spinner', 'commandStatus', 'progressHint', 'activeTools', 'clientHostPid', 'toasts', 'activeToolSummary', 'toolMode', 'setupChanged'] },
  'thread/route/updated': {
    stateKey: 'route',
    fields: ['sessionProvider', 'sessionModel', 'fast', 'fastCapable', 'autoEffort', 'modelParameters', 'selectedContextWindow', 'effort', 'provider', 'model', 'turnEffort', 'effortOptions', 'cwd', 'sessionForkedFrom', 'systemShell', 'webSearchRoute', 'autoClear'],
  },
  'thread/context/updated': { stateKey: 'context', fields: ['contextPercent', 'contextTokens', 'contextDefaultPercent', 'contextWindow', 'displayContextWindow', 'autoCompactTokenLimit', 'stats', 'rawContextWindow', 'effectiveContextWindowPercent', 'compactBoundaryTokens'] },
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
  // The setup tool's desktop request (`{ id, at }`, Node's session store `setupUiRequest`), held by the thread until a window
  // claims it or its claim window ends; a snapshot carries it as a replay does.
  'thread/setupUiRequest/updated': { stateKey: 'setupUiRequest', field: 'setupUiRequest' },
  // A group room log's view while the room runs (`{ busy, toolApproval?, typing?, handoffQuestions? }`, Node's
  // `decorateRoomSnapshot`): not a field of its own, laid over the log's fields by `desktopSessionState`.
  'thread/roomView/updated': { stateKey: 'roomView', field: 'roomView' },
};

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
  const rest = (Array.isArray(held) ? (held as Json[]) : []).filter((p) => typeof p !== 'string' || collapse(p) !== key);
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
function transcriptOf(items: readonly Obj[]): Obj[] {
  let rows = transcriptCache.get(items);
  if (!rows) {
    rows = mergeToolRows(items);
    transcriptCache.set(items, rows);
  }
  return rows;
}

function upsert(items: readonly Obj[], row: Obj): Obj[] {
  let at = items.length - 1;
  while (at >= 0 && items[at]?.id !== row.id) at--;
  if (at < 0) return [...items, row];
  const next = items.slice();
  next[at] = row;
  return next;
}

// ───────────────────────────── the reducer ─────────────────────────────

function fieldsOfState(state: Obj, hasOlder: boolean): Obj {
  let fields: Obj = {};
  for (const def of Object.values(SECTIONS)) fields = withSection(fields, def, state[def.stateKey]);
  if (typeof state.title === 'string') fields.desktopSessionTitle = state.title;
  if (hasOlder) fields.transcriptHasOlder = true;
  if (Array.isArray(state.promptHistoryList)) fields.promptHistoryList = state.promptHistoryList;
  fields.queued = Array.isArray(state.queued) ? state.queued : [];
  return fields;
}

const withLive = (s: SessionFold, live: Live | null): SessionFold => ({ ...s, live });
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
  for (let i = 0; i < source.length; i++) {
    const row = rowOf(asObj(source[i]));
    if (row) items.push(row);
    if (i % ITEMS_PER_STEP === ITEMS_PER_STEP - 1) yield;
  }
  transcriptCache.set(items, yield* mergeToolRowsSteps(items));
  return { sessionId: String(asObj(p.thread).id ?? ''), items, fields: fieldsOfState(asObj(p.state), p.hasOlder === true), live: null, structureRevision: 0 };
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
        return withField(s, 'queued', Array.isArray(p.queued) ? p.queued : []);
      case 'thread/name/updated':
        return withField(s, 'desktopSessionTitle', typeof p.title === 'string' ? p.title : undefined);
      case 'thread/goal/cleared':
        return withField(s, 'goal', undefined);
      case 'turn/started':
      case 'turn/completed':
        return withLive(s, null);
      case 'item/started':
      case 'item/completed': {
        const item = asObj(p.item);
        const row = rowOf(item);
        if (row === null) return s;
        if (item.type === 'agentMessage' && n.method === 'item/started') {
          const { text, ...identity } = row;
          return withLive(s, { id: String(item.id), identity: { ...identity, kind: 'assistant', streaming: true }, text: typeof text === 'string' ? text : '' });
        }
        const live = s.live?.id === item.id && n.method === 'item/completed' ? null : s.live;
        return { ...s, items: upsert(s.items, row), live, structureRevision: s.structureRevision + 1 };
      }
      case 'item/agentMessage/delta': {
        const id = String(p.itemId);
        const delta = typeof p.delta === 'string' ? p.delta : '';
        const live = s.live?.id === id ? { ...s.live, text: s.live.text + delta } : { id, identity: { id, kind: 'assistant', streaming: true }, text: delta };
        return withLive(s, live);
      }
      case 'thread/historyReset': {
        const from = p.fromItemId;
        const at = from === undefined ? -1 : s.items.findIndex((r) => r.id === from);
        // `hasOlder` is the transcript's flag after the reset; an absent flag reads false, as in a snapshot.
        const flagged = withField(s, 'transcriptHasOlder', p.hasOlder === true ? true : undefined);
        if (from !== undefined && at < 0) return withLive(flagged, null);
        return { ...flagged, items: s.items.slice(0, at + 1), live: null, structureRevision: s.structureRevision + 1 };
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
  const cut = live.text.lastIndexOf('\n') + 1;
  const rest = live.text.slice(cut);
  const out: Obj = {};
  if (cut > 0) {
    out.streamingTail = { ...live.identity, text: live.text.slice(0, cut) };
    if (rest) out.streamingPartial = { id: live.id, from: cut, text: rest };
  } else if (live.text.trim()) {
    out.streamingPartial = { id: live.id, from: 0, text: live.text, tail: live.identity };
  }
  return out;
}

/** The card of a server request, shaped like today's `toolApproval`: the request's own content plus its id. */
function approvalCard(r: ServerRequest): Obj {
  const { threadId: _t, turnId: _u, itemId: _i, surfaceThreadId: _s, chain: _c, requestedAt: _r, expiresAt: _e, order: _o, request, kind: _k, ...rest } = asObj(r.params);
  return { ...rest, ...asObj(request), id: String(r.id) };
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
export function desktopSessionState(fold: SessionFold, requests: readonly ServerRequest[], hostShellJobs?: Json): DesktopSessionState {
  // The transcript window is the TUI store's (`createInitialSessionState`): the core keeps the whole log (no spill, no paged view, no
  // archive range: decisions.md, the `transcriptArchive` row), so these hold the store's idle values; `lastTurn` is only ever cleared and
  // `themeEpoch` is the TUI process's theme counter.
  const out: Obj = {
    ...fold.fields,
    sessionId: fold.sessionId,
    items: transcriptOf(fold.items),
    structureRevision: fold.structureRevision,
    streamingTail: null,
    streamingPartial: null,
    promptHistoryList: [],
    transcriptViewItems: null,
    transcriptViewRevision: 0,
    transcriptHistoryBefore: false,
    transcriptHistoryAfter: false,
    transcriptArchive: null,
    transcriptSpilled: { epoch: 0, rows: 0 },
    lastTurn: null,
    themeEpoch: 0,
    ...fold.fields,
    toolApproval: null,
    toolApprovalsWaiting: 0,
  };
  if (hostShellJobs !== undefined) out.hostShellJobs = hostShellJobs;
  if (fold.live) Object.assign(out, liveFields(fold.live));
  const pending = requests
    .filter((r) => surfaceOf(r) === fold.sessionId)
    .map((r, arrival) => ({ r, arrival, order: (r.params as { order: number }).order }))
    .sort((a, b) => a.order - b.order || a.arrival - b.arrival);
  const first = pending[0];
  if (first) {
    out.toolApproval = approvalCard(first.r);
    out.toolApprovalsWaiting = pending.length - 1;
  }
  return withRoomView(out);
}

/** A room log's `roomView` laid over its state as Node's `decorateRoomSnapshot` decorates the room's session state
 *  (`agent-room-views.ts`): busy while the room has an exchange state, the speaking member's `toolApproval`, the handed-off
 *  questions, and the typing row after the transcript. `roomView` itself is not a `DesktopSessionState` field. */
function withRoomView(out: Obj): Obj {
  const view = out.roomView;
  delete out.roomView;
  if (!view || typeof view !== 'object' || Array.isArray(view)) return out;
  const room = view as Obj;
  if (Array.isArray(room.handoffQuestions) && room.handoffQuestions.length) out.handoffQuestions = room.handoffQuestions;
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
