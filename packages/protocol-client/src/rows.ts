// The transcript rows of a thread: `ThreadItem` → the exact row objects of today's Node product, field for field, so the renderer, the
// TUI and the phone read them unchanged. Ported from src/runtime/.../transcript-restore/restore.mjs (tool cards, `__aggregate__`
// cards, attachments), src/tui/session/transcript-intake.mjs and agent-room.mjs `roomRowItem`; the helpers they call live in ./rows.
//
// Two steps, because the fold keeps one row per item and an aggregate card is a view over a run of them:
//  - `rowOf` is one item's row (restore.mjs `restoredToolCallItems` + `attachRestoredToolResult` for a tool call);
//  - `mergeToolRows` collapses a run of finished tool rows into one `__aggregate__` row (restore.mjs `mergeRestoredToolItems`).
// Whatever the item cannot state in its own members (`callId`, `rawResult`, `uiDiff`, `toolMeta`, the room payload, ...) arrives in
// `meta.ext`, the core's exact row attributes; `ext` is applied last, so the core always has the final word on a row.
import type { Json } from './api.ts';
import { asObj, isObj } from './obj.ts';
import type { Obj } from './obj.ts';
import * as node from './rows/index.mjs';
import type { AggregateCall, AggregateHeader } from './rows/index.mjs';

const FINISHED = new Set(['completed', 'failed', 'declined', 'interrupted']);

/** The tool rows a live turn built (`ToolRun.live`): `mergeToolRows` reads this, and no row carries it. */
const liveRows = new WeakSet<Obj>();

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const present = <K extends string>(key: K, v: unknown): { [P in K]?: Json } => (typeof v === 'string' && v ? ({ [key]: v } as { [P in K]?: Json }) : {});

/** `transcriptRouteMetadataFields`: the route a user or assistant row was produced on. */
function routeFields(m: Obj): Obj {
  return { ...present('modelId', m.modelId), ...present('model', m.model), ...present('provider', m.provider), ...present('agent', m.agent) };
}
const atField = (m: Obj): Obj => (finite(m.at) ? { at: m.at } : {});

/** One `ThreadItem` as its transcript row; `null` for an item that has none (reasoning: today's thinking is the `thinking` state
 * field, never a row; control tools and task waits). */
export function rowOf(item: Obj): Obj | null {
  const m = asObj(item.meta);
  if (item.type === 'roomRow') return roomRowItem(item, m);
  const row = rowBody(item, m);
  return row === null ? null : Object.assign(row, extOf(item, m));
}

function rowBody(item: Obj, m: Obj): Obj | null {
  const id = item.id as Json;
  const failed = m.status === 'failed';
  switch (item.type) {
    case 'userMessage':
      return userMessageRow(item, m);
    case 'agentMessage':
      return { kind: 'assistant', id, text: text(item.text), ...present('messageId', m.messageId), ...atField(m), ...routeFields(m) };
    case 'reasoning':
      return null;
    case 'turnEnd':
      return turnEndRow(item, m);
    case 'mcpToolCall':
      return toolRow(item, m, `mcp__${text(item.server)}__${text(item.tool)}`, item.arguments as Json, outputText(item.result ?? item.error), failed || item.error !== undefined);
    case 'webSearch':
      return toolRow(item, m, 'web_search', { query: item.query as Json }, undefined, failed);
    case 'toolCall':
      return toolRow(item, m, text(item.name), item.input as Json, outputText(item.output), failed);
    case 'subAgentActivity':
      return toolRow(item, m, 'agent', { agent: item.agent as Json, ...(item.threadId === undefined ? {} : { threadId: item.threadId as Json }) }, undefined, failed);
    case 'agentJob':
      return toolRow(item, m, 'agent', { ...(item.tag === undefined ? {} : { tag: item.tag as Json }), ...(item.taskId === undefined ? {} : { task_id: item.taskId as Json }) }, undefined, failed);
    case 'contextCompaction':
      // The product's compaction divider (compaction-archive-capture.mjs): status `compacted`, label `Conversation compacted`.
      return { kind: 'statusdone', id, status: 'compacted', label: text(m.label) || 'Conversation compacted', ...present('detail', m.detail), ...atField(m) };
    case 'statusRow':
      return {
        kind: item.kind as Json,
        id,
        ...present('label', m.label),
        ...present('detail', m.detail),
        ...routeFields(m),
        ...atField(m),
      };
    default:
      return null;
  }
}

/** The `turndone` row of a turn end (turn.mjs `turnDoneItem`, restore.mjs `restoredTranscriptItems` for a stored completion): the
 * typed members are the row's own attributes, and what only the live end states (`outputTokens`, `thinkingElapsedMs`, `toolCount`,
 * `attemptId`, `completionVerb`) is `meta.ext`, applied last by `rowOf`. */
function turnEndRow(item: Obj, m: Obj): Obj {
  return {
    kind: 'turndone',
    id: item.id as Json,
    ...present('checkpointId', item.checkpointId),
    elapsedMs: item.elapsedMs as Json,
    status: item.status as Json,
    ...present('finalAssistantId', item.finalAssistantId),
    ...present('verb', item.verb),
    ...atField(m),
    ...present('detail', item.detail),
    ...present('errorDetails', item.errorDetails),
    ...routeFields(m),
    ...present('messageId', m.messageId),
    ...(isObj(item.quota) ? { quota: item.quota as Json } : {}),
    ...(isObj(item.errorKind) ? { errorKind: item.errorKind as Json } : {}),
  };
}

// ───────────────────────────── tool rows ─────────────────────────────

/** A tool result or argument value as the text the product stores: a string as is, anything else as JSON. */
function outputText(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** One tool call's row: restore.mjs `restoredToolCallItems` for the call, `attachRestoredToolResult` once it has finished. */
function toolRow(item: Obj, m: Obj, name: string, args: Json | undefined, output: string | undefined, failed: boolean): Obj | null {
  if (node.isTranscriptHiddenControlToolName(name) || node.isTaskWaitToolCall(name, args)) return null;
  const ext = asObj(m.ext);
  const finished = typeof m.status === 'string' && FINISHED.has(m.status);
  // A live turn's card starts when its call shows and completes when its result lands (turn-tool-cards.mjs `startedAt: Date.now()`,
  // aggregate-result.mjs `completedAt: Date.now()`), the times its run carries; a restored one reads its message's time for both.
  const run = asObj(item.run);
  const live = run.live === true;
  const completedAt = live && finite(run.completedAt) ? run.completedAt : m.at;
  const row: Obj = {
    kind: 'tool',
    id: item.id as Json,
    name,
    ...(args !== undefined && args !== '' ? { args } : {}),
    expanded: false,
    count: 1,
    completedCount: finished ? 1 : 0,
    ...(finite(m.at) ? { at: m.at, startedAt: live && finite(run.startedAt) ? run.startedAt : m.at, ...(finished ? { completedAt } : {}) } : {}),
    ...present('callId', asObj(item.run).callId ?? ext.callId),
  };
  if (asObj(item.run).live === true) liveRows.add(row);
  if (!finished) return row;
  const result = output ?? '';
  row.result = result;
  // `attachRestoredToolResult` -> `assignUiDiffFromMessage`: the result message's diff is the card's.
  Object.assign(row, node.stringUiDiffPatch(asObj(item.run).uiDiff));
  // A cancel/crash body is not a red failure (restore.mjs): it shows the Cancelled tone.
  const cancelled = node.toolResultTerminalStatus(result) === 'cancelled';
  const { isCallError, isExitError } = cancelled
    ? { isCallError: false, isExitError: false }
    : node.toolCallOutcome({ isError: failed || ext.isError === true, toolName: name }, result);
  row.isError = isCallError;
  row.errorCount = isCallError ? 1 : 0;
  row.callErrorCount = isCallError ? 1 : 0;
  row.exitErrorCount = isExitError ? 1 : 0;
  return row;
}

// ───────────────────────────── aggregate cards ─────────────────────────────

/** A tool row that can join an aggregate: a finished per-call card (restore.mjs `mergeRestoredToolItems` merges restored cards,
 * which have all finished; a call still running stays its own card until its result arrives). */
const mergeable = (row: Obj): boolean => row.kind === 'tool' && row.aggregate !== true && row.imported !== true && 'result' in row;
/** A live tool row joins its bucket's aggregate whether or not its result has arrived (`syncAggregateHeader` counts the call at once). */
const liveMergeable = (row: Obj): boolean => row.kind === 'tool' && row.aggregate !== true && row.imported !== true;

/** Collapses every run of two or more consecutive finished tool rows of one bucket into one `__aggregate__` card, shaped exactly
 * like the live turn's (restore.mjs `buildRestoredAggregateItem`), and drops the tool rows the transcript hides. A non-tool row ends
 * a run. */
export function mergeToolRows(rows: readonly Obj[]): Obj[] {
  const steps = mergeToolRowsSteps(rows);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/** `mergeToolRows` in steps: yields every `ROWS_PER_STEP` rows so a long transcript merges in budgeted turns. */
export const ROWS_PER_STEP = 16;
export function* mergeToolRowsSteps(rows: readonly Obj[]): Generator<void, Obj[], void> {
  const merged: Obj[] = [];
  let run: { bucket: string; live: boolean; members: { item: Obj; category: string }[] } | null = null;
  // A run of any length aggregates in steps too: one step per `ROWS_PER_STEP` of its members.
  function* flush(): Generator<void, void, void> {
    if (!run) return;
    const { members, live } = run;
    run = null;
    // A restore merges two or more finished cards (`mergeRestoredToolItems`); a live turn's tool cards put every call of a bucket on an aggregate, even one.
    if (members.length >= 2 || live) merged.push(yield* aggregateRowSteps(members, live));
    else for (const member of members) merged.push(member.item);
  }
  let seen = 0;
  for (const item of rows) {
    if (++seen % ROWS_PER_STEP === 0) yield;
    if (item.kind === 'tool' && node.isTranscriptHiddenToolItem(item)) continue;
    const live = liveRows.has(item);
    if (!(live ? liveMergeable(item) : mergeable(item))) {
      yield* flush();
      merged.push(item);
      continue;
    }
    const category = node.classifyToolCategory(item.name as string, item.args);
    // Agent cards never merge on restore: the live rule scopes their grouping to one provider batch.
    const bucket = category === 'Agent' ? '' : node.aggregateBucketForCategory(category);
    if (!bucket) {
      yield* flush();
      // A live standalone card (`standaloneCardSpec`) is sealed (`finalizeToolHeaders`) and shown (`materialize`) when its turn ends.
      merged.push(live ? { ...item, headerFinalized: true, deferredDisplayReady: true } : item);
      continue;
    }
    if (run && run.bucket === bucket && run.live === live) {
      run.members.push({ item, category });
      continue;
    }
    yield* flush();
    run = { bucket, live, members: [{ item, category }] };
  }
  yield* flush();
  return merged;
}

/** The card of one run, every pass over its members stepped: the per-member work (outcome, summary, category entries) and then the
 * finalization (result patch and its members and detail line, last diff, loading targets, call ids, done categories, raw result).
 * `live`: the card of a live turn (turn-aggregate-cards.mjs): its calls are keyed by their provider call id, it carries no `at` or
 * `callIds`, and it is `deferredDisplayReady`; while a call has no result yet it holds only the header `syncAggregateHeader` keeps. */
function* aggregateRowSteps(members: readonly { item: Obj; category: string }[], live: boolean): Generator<void, Obj, void> {
  const header: AggregateHeader = { categories: new Map(), categoryOrder: [] };
  const calls: AggregateCall[] = [];
  for (const { item, category } of members) {
    if (calls.length % ROWS_PER_STEP === ROWS_PER_STEP - 1) yield;
    node.mergeAggregateCategoryEntries(header, node.aggregateToolCategoryEntries(item.name as string, item.args, category));
    // A live card keys its calls by the provider's call id (`aggregateCallEntry`), a restored one by the restored item's id.
    const callId = live ? item.callId : item.id;
    if (!('result' in item)) {
      // `aggregateCallEntry`: a call whose result has not arrived.
      calls.push({
        callId,
        name: item.name as string,
        args: item.args,
        category,
        isError: false,
        isCallError: false,
        isExitError: false,
        exitCode: null,
        resultText: null,
        rawResultText: null,
        resolved: false,
        startedAt: item.startedAt,
        completedAt: null,
        summary: null,
      } as unknown as AggregateCall);
      continue;
    }
    const resultText = String(item.result ?? '');
    const rawResultText = String(item.rawResult ?? item.result ?? '');
    if (live) {
      // The live card's result (`applyAggregateCallFields` of `toolResultDisplay`): the text a card shows (a command's body without its
      // exit header, a failure as its presented error) beside the raw body.
      const outcome = node.toolResultDisplay({ isError: item.isError === true }, rawResultText, item.name as string);
      calls.push({
        callId,
        name: item.name as string,
        args: item.args,
        category,
        isError: outcome.isError,
        isCallError: outcome.isCallError,
        isExitError: outcome.isExitError,
        exitCode: outcome.exitCode,
        resultText: outcome.text,
        rawResultText,
        ...node.stringUiDiffPatch(item.uiDiff),
        resolved: true,
        startedAt: item.startedAt,
        completedAt: item.completedAt,
        summary: !outcome.isError ? node.summarizeToolResult(item.name as string, item.args, rawResultText, outcome.isError) : null,
      });
      continue;
    }
    const { exitCode, isExitError, isCallError } = node.toolCallOutcome({ isError: item.isError === true, toolName: item.name as string }, resultText);
    calls.push({
      callId,
      name: item.name as string,
      args: item.args,
      category,
      isError: isCallError,
      isCallError,
      isExitError,
      exitCode,
      resultText,
      rawResultText,
      ...node.stringUiDiffPatch(item.uiDiff),
      resolved: true,
      startedAt: item.startedAt,
      completedAt: item.completedAt,
      summary: !isCallError && resultText.trim() ? node.summarizeToolResult(item.name as string, item.args, resultText, false) : null,
    });
  }
  const loadingTargets = yield* node.aggregateLoadingTargetsSteps(calls);
  const first = members[0]!.item;
  const resolvedCount = calls.filter((call) => call.resolved).length;
  if (resolvedCount < calls.length) {
    return {
      kind: 'tool',
      id: first.id as Json,
      name: '__aggregate__',
      args: { categoryOrder: header.categoryOrder, ...(loadingTargets.length > 0 ? { loadingTargets } : {}) },
      count: calls.length,
      completedCount: resolvedCount,
      categories: Object.fromEntries(header.categories) as unknown as Json,
      toolMembers: (yield* node.aggregateToolMembersSteps(calls)) as unknown as Json,
      aggregate: true,
      result: null,
      rawResult: null,
      isError: false,
      expanded: false,
      headerFinalized: false,
      ...(first.startedAt != null ? { startedAt: first.startedAt } : {}),
      deferredDisplayReady: true,
    };
  }
  // Every pass over the members below steps with the same quantum: the Node helpers' stepped forks, and the two small ones here.
  const outcomePatch = yield* node.aggregateResultPatchSteps({ calls }, calls, calls.length);
  let latestUiDiff: Obj | undefined;
  for (let i = members.length - 1; i >= 0; i--) {
    if ((members.length - i) % ROWS_PER_STEP === 0) yield;
    if (Object.hasOwn(members[i]!.item, 'uiDiff')) {
      latestUiDiff = members[i]!.item;
      break;
    }
  }
  const last = members[members.length - 1]!.item;
  const callIds: Json[] = [];
  for (let i = 0; i < members.length; i++) {
    if (i % ROWS_PER_STEP === ROWS_PER_STEP - 1) yield;
    const callId = members[i]!.item.callId;
    if (callId) callIds.push(callId as Json);
  }
  const doneCategories = yield* node.aggregateDoneCategoriesSteps(calls);
  const rawResult = yield* node.aggregateRawResultSteps(calls);
  return {
    kind: 'tool',
    id: first.id as Json,
    name: '__aggregate__',
    args: { categoryOrder: header.categoryOrder, ...(loadingTargets.length > 0 ? { loadingTargets } : {}) },
    aggregate: true,
    ...(!live && callIds.length > 0 ? { callIds } : {}),
    categories: Object.fromEntries(header.categories) as unknown as Json,
    doneCategories: doneCategories as unknown as Json,
    completedCount: calls.length,
    ...(outcomePatch as Obj),
    rawResult: rawResult || null,
    ...(latestUiDiff ? { uiDiff: latestUiDiff.uiDiff } : {}),
    expanded: false,
    headerFinalized: true,
    ...(live ? { deferredDisplayReady: true } : first.at != null ? { at: first.at } : {}),
    ...(first.startedAt != null ? { startedAt: first.startedAt } : {}),
    ...(last.completedAt != null ? { completedAt: last.completedAt } : {}),
  };
}
// ───────────────────────────── user rows and attachments ─────────────────────────────

const ATTACHMENT_ID = /^[a-f0-9]{64}$/;
const ATTACHMENT_KINDS = new Set(['image', 'file', 'text']);
const bare = (digest: unknown): string => text(digest).replace(/^sha256:/, '');

/** `normalizeMessageAttachments` (transcript-metadata.mjs): well-formed, de-duplicated records, at most 64, each keyed by the
 * bare content hash and repeating it as `attachmentRef`. */
function attachmentRecords(value: unknown): Obj[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: Obj[] = [];
  for (const entry of value) {
    const raw = asObj(entry);
    const id = text(raw.id);
    if (!ATTACHMENT_ID.test(id) || seen.has(id) || out.length >= 64) continue;
    seen.add(id);
    const original = asObj(raw.original);
    out.push({
      id,
      attachmentRef: id,
      kind: ATTACHMENT_KINDS.has(text(raw.kind)) ? text(raw.kind) : 'file',
      name: String(raw.name || 'attachment').slice(0, 200),
      mimeType: String(raw.mimeType || 'application/octet-stream').slice(0, 100),
      size: finite(Number(raw.size)) && Number(raw.size) >= 0 ? Number(raw.size) : 0,
      ...(ATTACHMENT_ID.test(text(original.attachmentRef)) ? { original: { attachmentRef: original.attachmentRef as Json, mimeType: text(original.mimeType).slice(0, 100) } } : {}),
    });
  }
  return out;
}
const attachmentsField = (value: unknown): Obj => {
  const attachments = attachmentRecords(value);
  return attachments.length ? { attachments } : {};
};

/** `normalizeMessageReactions` (transcript-metadata.mjs). */
function reactionsField(value: unknown): Obj {
  if (!Array.isArray(value)) return {};
  const out: Obj[] = [];
  for (const entry of value) {
    const raw = asObj(entry);
    const agentId = text(raw.agentId);
    const emoji = text(raw.emoji);
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(agentId) || !emoji || emoji.length > 16 || out.some((r) => r.agentId === agentId)) continue;
    out.push({ agentId, emoji, ...(finite(raw.at) ? { at: raw.at } : {}) });
  }
  return out.length ? { reactions: out } : {};
}

/** The typed source of a user-role item that the product shows as something other than the user's prompt. */
const NOTICE_SOURCES = new Set(['schedule-result', 'held-request', 'task-notification']);
/** The ext keys the source branches consume to build the row themselves (the stored payloads, not row attributes). */
const SOURCE_PAYLOAD_KEYS = ['routine', 'heldRequest', 'execution', 'attachments', 'messageId', 'posted', 'name', 'args', 'isError'];

/** `meta.ext` as row attributes: for a notice or card source the stored payloads it was built from are not row attributes. */
function extOf(item: Obj, m: Obj): Obj {
  const ext = asObj(m.ext);
  if (item.type === 'turnEnd' && text(ext.clientSubmissionId)) {
    // Node's turn end names the prompt by the row id it shows, the submission id (`checkpointId`, turn.mjs `turnDoneItem`);
    // the core's own `checkpointId` is the user item's id, the submission riding in `ext`. A client names a prompt by what it
    // shows (rewind resolves the submission id), so the row shows Node's value.
    const { clientSubmissionId, ...rest } = ext;
    return { ...rest, checkpointId: clientSubmissionId };
  }
  if (item.type !== 'userMessage' || !NOTICE_SOURCES.has(text(m.source))) return ext;
  const rest = { ...ext };
  for (const k of SOURCE_PAYLOAD_KEYS) delete rest[k];
  return rest;
}

/** Posted into the thread outside any turn (restore.mjs `isPostedMessage`): stamped so, or a message id minted by the routine
 * delivery (`routine_<runId>`). */
const postedField = (ext: Obj): Obj => (ext.posted === true || text(ext.messageId).startsWith('routine_') ? { posted: true } : {});

/** `normalizeHandoffFiles` (handoff-artifacts.mjs). */
function handoffFiles(value: unknown): Obj[] {
  return (Array.isArray(value) ? value.map(asObj) : [])
    .filter((f) => typeof f.path === 'string' && f.path !== '')
    .slice(0, 8)
    .map((f) => ({
      name: String(f.name || 'file').slice(0, 200),
      path: text(f.path).slice(0, 1024),
      kind: ['image', 'file', 'text'].includes(text(f.kind)) ? text(f.kind) : 'file',
      mimeType: String(f.mimeType || 'application/octet-stream').slice(0, 100),
      size: Number(f.size) >= 0 ? Number(f.size) : 0,
      ...(/^[a-f0-9]{64}$/.test(text(f.id)) ? { id: f.id as Json } : {}),
    }));
}

/** `routineResultNotice` (routine-result.mjs): the line, tone and `routine` payload of a stored routine result. */
function routineNotice(ext: Obj): Obj {
  const routine = asObj(ext.routine);
  if (Number(routine.omitted) > 0) return { text: `⏱ Routine results omitted: ${routine.omitted}`, tone: 'info', routine: { omitted: routine.omitted! } };
  if (Number(routine.relayFailed) > 0) {
    return { text: `⚠ Task results not relayed: ${routine.relayFailed} — they are shown above`, tone: 'warn', routine: { relayFailed: routine.relayFailed! } };
  }
  if (routine.kind === 'task') {
    const session = routine.target === 'session';
    const status = text(routine.status);
    const what = ({ started: 'started', blocked: 'waiting for confirmation' } as Record<string, string>)[status] || status;
    const files = handoffFiles(routine.files);
    const summary = routine.summary;
    return {
      text: `🛠 ${session ? 'Session' : 'Agent task'} ${what} · ${text(routine.name)}${summary ? ` — ${text(summary)}` : ''}`,
      tone: status === 'failed' ? 'warn' : 'info',
      routine: {
        kind: 'task',
        ...(routine.name === undefined ? {} : { name: routine.name }),
        ...(routine.status === undefined ? {} : { status: routine.status }),
        ...(summary === undefined ? {} : { summary }),
        ...(routine.sessionId === undefined ? {} : { sessionId: routine.sessionId }),
        ...(session ? { target: 'session' } : {}),
        ...present('agentId', routine.agentId),
        ...present('sendId', routine.sendId),
        ...(Array.isArray(routine.sendIds) && routine.sendIds.length > 1 ? { sendIds: routine.sendIds } : {}),
        ...(files.length ? { files } : {}),
        ...present('line', routine.line),
      },
      ...attachmentsField(ext.attachments),
    };
  }
  const webhook = routine.kind === 'webhook';
  const failed = routine.status === 'failed';
  const summary = String(routine.summary || '');
  const detail = failed ? (summary ? `Failed: ${summary}` : 'Failed') : summary;
  return {
    text: `${webhook ? '🔗 Webhook' : '⏱ Schedule'} · ${String(routine.name || '')}${detail ? ` — ${detail}` : ''}`,
    tone: failed ? 'warn' : 'info',
    routine: {
      ...(webhook ? { kind: 'webhook' } : {}),
      name: String(routine.name || ''),
      status: failed ? 'failed' : 'completed',
      summary,
      ...present('runId', routine.runId),
      ...present('runSessionId', routine.runSessionId),
      ...(failed ? { ...present('reason', routine.reason), ...(routine.paused ? { paused: true } : {}) } : {}),
    },
  };
}

/** `heldRequestNotice` (held-message.mjs). */
function heldNotice(held: Obj): Obj {
  const what = `${text(held.tool) || 'tool'}${held.target ? ` → ${text(held.target)}` : ''}`;
  const label = ({ pending: 'Approval needed', approved: 'Approved', denied: 'Denied', expired: 'Expired (denied)' } as Record<string, string>)[text(held.status)];
  return { text: `⏸ ${label || 'Approval needed'} · ${what}`, tone: held.status === 'pending' ? 'warn' : 'info', heldRequest: held };
}

/** A user-role item by its typed message source (`meta.source`; the core drops `skill` and `hook` rows and sends internal wrappers
 * and interrupted ends as typed records, so nothing here reads text). The stored payloads (`routine`, `heldRequest`, `execution`,
 * the stored attachments, `messageId`) are `meta.ext`. */
function userMessageRow(item: Obj, m: Obj): Obj | null {
  const id = item.id as Json;
  const body = userRow(item, m);
  const ext = asObj(m.ext);
  const stamp: Obj = { ...present('messageId', ext.messageId), ...(finite(m.at) && m.at ? { at: m.at } : {}) };
  switch (m.source) {
    case 'schedule-result':
      return { kind: 'notice', id, ...routineNotice(ext), ...stamp, ...postedField(ext) };
    case 'held-request':
      // A held request without its id cannot be answered, so it has no row.
      return isObj(ext.heldRequest) && ext.heldRequest.id ? { kind: 'notice', id, ...heldNotice(ext.heldRequest), ...stamp } : null;
    case 'steering':
      return { ...body, steered: true };
    case 'task-notification': {
      // `completionCardFromExecution` (agent-envelope.mjs), from the typed execution record.
      const exec = asObj(ext.execution);
      const surface = (text(exec.surface) || 'task').toLowerCase();
      const status = text(exec.status).toLowerCase();
      const result = text(body.text);
      return {
        kind: 'tool',
        id,
        ...present('messageId', ext.messageId),
        name: ['agent', 'shell', 'web_search'].includes(surface) ? surface : 'task',
        args: { type: 'result', ...(status ? { status } : {}), ...(exec.id === undefined ? {} : { task_id: exec.id }), surface },
        result,
        rawResult: result,
        isError: /^(failed|error|timeout|cancelled|canceled|killed)$/i.test(status) || /^error:/i.test(result),
        expanded: false,
        count: 1,
        completedCount: 1,
        ...(finite(m.at) ? { at: m.at, startedAt: m.at, completedAt: m.at } : {}),
      };
    }
    default: // `import` renders verbatim, as a plain prompt
      return body;
  }
}

/** A user message: its text parts form the prompt `text` (a pasted text is part of the prompt); an attachment part is a record of
 * `attachments` keyed by the blob's content hash. */
function userRow(item: Obj, m: Obj): Obj {
  const parts = Array.isArray(item.content) ? item.content.map(asObj) : [];
  const attachments = parts
    .filter((p) => p.type === 'attachment')
    .map((p) => {
      const blob = asObj(p.blob);
      const mimeType = text(blob.mediaType) || 'application/octet-stream';
      const original = asObj(p.original);
      return {
        id: bare(blob.digest),
        kind: (p.kind ?? null) as Json, // the stored value; the normalizer defaults an absent one to `file`
        name: text(p.filename) || (mimeType.startsWith('image/') ? 'image' : 'file'),
        mimeType,
        size: blob.bytes as Json,
        ...(original.digest === undefined ? {} : { original: { attachmentRef: bare(original.digest), mimeType: text(original.mediaType) } }),
      };
    });
  return {
    kind: 'user',
    // Node's row id is the submission id (`pushUserOrSyntheticItem(text, id)`), which a client matches its pending bubble by
    // (conversation-prompt-items.ts `pendingPromptTranscriptItems`); the core carries it as `clientSubmissionId`.
    id: (text(item.clientSubmissionId) || item.id) as Json,
    text: parts.filter((p) => p.type === 'text' || p.type === 'pastedText').map((p) => text(p.text)).join(''),
    ...present('messageId', m.messageId),
    ...atField(m),
    ...routeFields(m),
    ...present('device', item.device),
    ...present('checkpointId', item.checkpointId),
    ...attachmentsField(attachments),
    ...(Array.isArray(item.appliedSkills) && item.appliedSkills.length ? { appliedSkills: item.appliedSkills.filter((s) => typeof s === 'string' && s) } : {}),
  };
}

// ───────────────────────────── room rows ─────────────────────────────

/** `roomRowTargets` (agent-room.mjs): a row's addressees as `{ id, name }`, from lists or the single strings older rows carry. */
function roomTargets(row: Obj): { id: string; name: string }[] {
  const ids = (Array.isArray(row.to) ? row.to : [row.to]).filter((id): id is string => typeof id === 'string' && id !== '');
  const names = Array.isArray(row.toName) ? row.toName : [row.toName];
  return ids.map((id, i) => ({ id, name: (typeof names[i] === 'string' && names[i]) || id }));
}

/** `roomRowText` (agent-room.mjs): the plain-text line of a row. */
function roomRowText(room: Obj, body: string): string {
  const names = Array.isArray(room.names) ? room.names.join(', ') : '';
  const who = names || text(room.name) || text(room.speaker) || 'agent';
  if (room.kind === 'user' || room.kind === 'speech') return body;
  if (room.kind === 'pass') return room.failed ? `${who} · no reply` : `${who} · pass`;
  if (room.kind === 'cap' && room.usage) return 'Paused: the usage limit was reached.';
  if (room.kind === 'cap') return 'Stopped at the room limit. Continue to run another batch.';
  if (room.kind === 'stopped') return 'Stopped.';
  return 'Interrupted.';
}

/** `roomRowItem` (agent-room.mjs): the user's bubble, or a notice row whose `room` payload the app renders as speech, pass or limit
 * line. The payload (`kind`, `name`, `to`, `usage`, ...) is `meta.ext.room`, the message id `meta.ext.messageId`, and a user row's
 * files and reactions `meta.ext.attachments` / `meta.ext.reactions`: the stored fields the product reads them from. Without a
 * payload the item is member speech by `speaker`. */
function roomRowItem(item: Obj, m: Obj): Obj {
  const ext = asObj(m.ext);
  const { images, ...stored } = isObj(ext.room) ? ext.room : { kind: 'speech', speaker: item.speaker as Json };
  const targets = roomTargets(stored);
  const room: Obj = targets.length ? { ...stored, to: targets.map((t) => t.id), toName: targets.map((t) => t.name) } : stored;
  const messageId = text(ext.messageId);
  const user = room.kind === 'user';
  const sender: Obj = user && room.fromSession ? (room.fromAgent ? { fromAgent: room.fromAgent } : { sender: 'lead' }) : {};
  return {
    kind: user ? 'user' : 'notice',
    id: user && messageId ? messageId : (item.id as Json),
    text: roomRowText(room, text(item.text)),
    ...(user ? {} : { tone: 'info' }),
    room: { ...room, ...(messageId ? { id: messageId } : {}), ...atField(m) },
    ...(messageId ? { messageId } : {}),
    ...atField(m),
    ...(user || room.kind === 'speech' ? attachmentsField(ext.attachments) : {}),
    ...(user && Array.isArray(images) && images.length ? { images } : {}),
    ...(user ? reactionsField(ext.reactions) : {}),
    ...sender,
  };
}

