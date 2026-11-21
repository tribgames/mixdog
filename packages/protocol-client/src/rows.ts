import type { Json } from './api.ts';
import { asObj, isObj } from './obj.ts';
import type { Obj } from './obj.ts';
import * as node from './rows/index.mjs';
import type { AggregateCall, AggregateHeader } from './rows/index.mjs';

const FINISHED = new Set(['completed', 'failed', 'declined', 'interrupted']);

/** The tool rows a live turn built (`ToolRun.live`): `mergeToolRows` reads this, and no row carries it. */
const liveRows = new WeakSet<Obj>();
/** The live tool rows whose card the turn's Stop ended (`meta.status` `interrupted`): their aggregate is finalized as cancelled
 * (`finalizeOpenCards(…, { cancelled })`, tool-card-results.mjs:88-97). No row carries it. */
const stoppedRows = new WeakSet<Obj>();

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const present = <K extends string>(key: K, v: unknown): { [P in K]?: Json } =>
  typeof v === 'string' && v ? ({ [key]: v } as { [P in K]?: Json }) : {};

/** `transcriptRouteMetadataFields`: the route a user or assistant row was produced on. */
function routeFields(m: Obj): Obj {
  return {
    ...present('modelId', m.modelId),
    ...present('model', m.model),
    ...present('provider', m.provider),
    ...present('agent', m.agent),
  };
}
const atField = (m: Obj): Obj => (finite(m.at) ? { at: m.at } : {});

/** Stored history positions are not display ids or serialized row attributes. An aggregate has a different edge in each direction. */
const positions = new WeakMap<object, { before: string | undefined; after: string | undefined }>();
export function historyPositionOf(row: unknown, direction: 'before' | 'after' = 'before'): string | undefined {
  return row && typeof row === 'object' ? positions.get(row)?.[direction] : undefined;
}
export function setHistoryPositions<T extends object>(
  row: T,
  before: string | undefined,
  after: string | undefined
): T {
  if (before !== undefined || after !== undefined) positions.set(row, { before, after });
  return row;
}

/** One `ThreadItem` as its transcript row; `null` for an item that has none (reasoning: today's thinking is the `thinking` state
 * field, never a row; control tools and task waits). */
export function rowOf(item: Obj): Obj | null {
  const m = asObj(item.meta);
  const row = item.type === 'roomRow' ? roomRowItem(item, m) : rowBody(item, m);
  if (row === null) return null;
  if (item.type !== 'roomRow') {
    const { [DIVIDERS_AFTER]: _dividers, historyPosition: _position, ...ext } = extOf(item, m);
    if (item.type === 'toolCall') delete ext.toolMeta; // toolRow validates both typed and legacy metadata
    Object.assign(row, ext);
  }
  const position = text(asObj(m.ext).historyPosition) || undefined;
  return setHistoryPositions(row, position, position);
}

/** The `ext` member a history page's row carries the compaction dividers shown after it under (the core's `DIVIDERS_AFTER`,
 * reads.rs): the items of each divider, which a page cannot list as rows of its own (a page cursor names a stored row). */
const DIVIDERS_AFTER = 'dividersAfter';

/** A history page's item as its rows: its own row, then the rows of the compaction dividers that follow it. */
export function rowsOf(item: Obj): Obj[] {
  const after = asObj(asObj(item.meta).ext)[DIVIDERS_AFTER];
  const dividers = Array.isArray(after)
    ? after.map((divider) => rowOf(asObj(divider))).filter((row): row is Obj => row !== null)
    : [];
  return [...itemRows(item), ...dividers];
}

/** One completion of a woken batch: where its text lies in the row's joined text, and what the batch recorded of its job. */
interface BatchEntry {
  start: number;
  end: number;
  execution: Obj;
}

const escapeField = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** The completions of a turn input row, located in its text. A row the core wrote for a batch carries them as data
 * (`details.completions`, UTF-16 offsets into the text): nothing is cut by its content. A row stored before that data existed has
 * only `details.consumedExecutionIds`, one id per queued entry in order, and an entry's text is its `<task-notification>` envelope
 * whose first field is its own `<task-id>`: entry k starts at the first line after entry k-1's start that opens an envelope naming
 * id k, and the last entry ends with the text. The envelope writers do not escape a result, so a result may quote envelopes; the
 * only cut that can then be wrong is a result quoting the envelope of the very next completion (same task id) before that
 * completion's own envelope. A row whose ids cannot all be found (an entry that named none, or an execution id other than its
 * envelope's task id, as `restart:` ids are) is not split: it stays the one card it always was. */
export function batchEntries(content: string, details: Obj): BatchEntry[] {
  if (Array.isArray(details.completions) && details.completions.length > 0) {
    return details.completions.map((entry) => {
      const one = asObj(entry);
      const execution: Obj = {
        ...present('id', one.executionId),
        ...present('surface', one.surface),
        ...present('status', one.status),
      };
      return { start: Number(one.start), end: Number(one.end), execution };
    });
  }
  const ids = Array.isArray(details.consumedExecutionIds) ? details.consumedExecutionIds : [];
  if (ids.length < 2 || ids.some((id) => typeof id !== 'string' || !id)) return [];
  const starts: number[] = [];
  let from = 0;
  for (const [at, id] of (ids as string[]).entries()) {
    const opening = `<task-notification>\n<task-id>${escapeField(id)}</task-id>\n`;
    const found = at === 0 ? (content.startsWith(opening) ? 0 : -1) : content.indexOf(`\n${opening}`, from) + 1 || -1;
    if (found < 0) return [];
    starts.push(found);
    from = found + 1;
  }
  return starts.map((start, at) => ({
    start,
    end: at === starts.length - 1 ? content.length : (starts[at + 1] as number) - 1,
    execution:
      envelopeExecution(
        content.slice(start, at === starts.length - 1 ? content.length : (starts[at + 1] as number) - 1)
      ) ?? {},
  }));
}

/** `parseTaskNotification`'s outer fields (task id, status, surface) of one envelope; null when it has none of a task's. */
function envelopeExecution(envelope: string): Obj | null {
  const head = envelope.split('\n<result>\n')[0] ?? '';
  const field = (name: string) =>
    new RegExp(`^<${name}>([^<]*)</${name}>$`, 'm')
      .exec(head)?.[1]
      ?.replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&amp;', '&') ?? '';
  const id = field('task-id');
  const status = field('status');
  const summary = field('summary');
  if (!id || !summary || !/^(completed|failed|cancelled)$/.test(status)) return null;
  const surface = summary.startsWith('Agent "')
    ? 'agent'
    : summary.startsWith('Shell task ')
      ? 'shell'
      : /^(\S+) task /.exec(summary)?.[1] || 'tool';
  return { id, status, surface };
}

type ImportedTool = { name: string; count: number };

/** The canonical marker written by the importers. The Rust importer clips names by UTF-16, the older importer by code point. */
function importedToolLine(tools: ImportedTool[], codePoints: boolean): string {
  const suffix = (remaining: number) => (remaining > 0 ? `, +${remaining} more` : '');
  let body = '';
  let shown = 0;
  for (const { name, count } of tools) {
    const chars = codePoints ? Array.from(name) : name;
    const clipped = chars.slice(0, 39);
    // A UTF-16 cut between surrogates is serialized by the Rust importer as U+FFFD.
    const display =
      chars.length > 40
        ? `${typeof clipped === 'string' ? clipped.replace(/[\uD800-\uDBFF]$/, '�') : clipped.join('')}…`
        : name;
    const next = `${shown ? `${body}, ` : ''}${display} ×${count}`;
    if (shown && `[ran tools: ${next}${suffix(tools.length - shown - 1)}]`.length > 400) break;
    body = next;
    shown++;
  }
  return `[ran tools: ${body}${suffix(tools.length - shown)}]`;
}

function importedRun(
  run: Obj,
  content: string,
  cursor: number
): { start: number; end: number; calls: ImportedTool[] } | undefined {
  const { start, end, tools } = run;
  if (
    !finite(start) ||
    !finite(end) ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < cursor ||
    end <= start ||
    end > content.length
  )
    return undefined;
  if (
    !Array.isArray(tools) ||
    !tools.length ||
    !tools.every((tool) => {
      const { name, count } = asObj(tool);
      return typeof name === 'string' && finite(count) && Number.isInteger(count) && count > 0;
    })
  )
    return undefined;
  const calls = tools as ImportedTool[];
  const line = content.slice(start, end);
  if (line !== importedToolLine(calls, true) && line !== importedToolLine(calls, false)) return undefined;
  return { start, end, calls };
}

function importedAssistantRows(item: Obj, m: Obj): Obj[] | undefined {
  if (typeof item.text !== 'string' || !Array.isArray(item.importedToolRuns) || !item.importedToolRuns.length)
    return undefined;
  const content = item.text;
  const assistant = rowOf(item)!;
  const rows: Obj[] = [];
  // The core uses `:<n>` for other items attached to this same stored message.
  const nextId = () => (rows.length === 0 ? assistant.id! : `${String(assistant.id)}:import:${rows.length}`);
  const pushText = (raw: string) => {
    const prose = raw.trim();
    if (prose) rows.push({ ...assistant, id: nextId(), text: prose });
  };
  let cursor = 0;
  for (const entry of item.importedToolRuns) {
    const run = importedRun(asObj(entry), content, cursor);
    if (!run) continue;
    const { start, end, calls } = run;
    pushText(content.slice(cursor, start));
    for (const { name, count } of calls) {
      if (node.isTranscriptHiddenControlToolName(name)) continue;
      rows.push({
        kind: 'tool',
        id: nextId(),
        name,
        count,
        completedCount: count,
        imported: true,
        expanded: false,
        ...(finite(m.at) ? { at: m.at, startedAt: m.at, completedAt: m.at } : {}),
        ...(assistant.archived === true ? { archived: true } : {}),
      });
    }
    cursor = end;
  }
  pushText(content.slice(cursor));
  return rows;
}

/** A reply may expand into imported prose and tools, and a queued batch into one card per completion.
 * In either case the first visible row keeps the item id and subsequent ids are local to that item. */
export function itemRows(item: Obj): Obj[] {
  const m = asObj(item.meta);
  if (item.type === 'agentMessage') {
    const imported = importedAssistantRows(item, m);
    if (imported !== undefined) {
      const position = text(asObj(m.ext).historyPosition) || undefined;
      for (const row of imported) setHistoryPositions(row, position, position);
      return imported;
    }
  }
  const details = asObj(item.details);
  if (item.type === 'userMessage' && (m.source ?? details.source) === 'task-notification') {
    const content = text(userRow(item, m).text);
    const entries = batchEntries(content, details);
    if (entries.length > 1) {
      const ext = asObj(m.ext);
      return entries
        .map((entry, at) =>
          rowOf({
            ...item,
            id: at === 0 ? (item.id as Json) : `${String(item.id)}:${at}`,
            content: [{ type: 'text', text: content.slice(entry.start, entry.end) }],
            meta: { ...m, ext: { ...ext, execution: entry.execution } },
          })
        )
        .filter((row): row is Obj => row !== null);
    }
  }
  const row = rowOf(item);
  return row === null ? [] : [row];
}
function rowBody(item: Obj, m: Obj): Obj | null {
  const id = item.id as Json;
  const failed = m.status === 'failed';
  switch (item.type) {
    case 'userMessage':
      return userMessageRow(item, m);
    case 'agentMessage':
      return {
        kind: 'assistant',
        id,
        text: text(item.text),
        ...present('messageId', m.messageId),
        ...atField(m),
        ...routeFields(m),
      };
    case 'reasoning':
      return null;
    case 'turnEnd':
      return turnEndRow(item, m);
    case 'mcpToolCall':
      return toolRow(
        item,
        m,
        `mcp__${text(item.server)}__${text(item.tool)}`,
        item.arguments as Json,
        outputText(item.result ?? item.error),
        failed || item.error !== undefined
      );
    case 'webSearch':
      return toolRow(item, m, 'web_search', { query: item.query as Json }, undefined, failed);
    case 'toolCall':
      // A stored card states its result once, on its run; a live one may carry `output`.
      return toolRow(
        item,
        m,
        text(item.name),
        item.input as Json,
        outputText(item.output ?? asObj(item.run).result),
        failed
      );
    case 'subAgentActivity':
      return toolRow(
        item,
        m,
        'agent',
        { agent: item.agent as Json, ...(item.threadId === undefined ? {} : { threadId: item.threadId as Json }) },
        undefined,
        failed
      );
    case 'agentJob':
      return toolRow(
        item,
        m,
        'agent',
        {
          ...(item.tag === undefined ? {} : { tag: item.tag as Json }),
          ...(item.taskId === undefined ? {} : { task_id: item.taskId as Json }),
        },
        undefined,
        failed
      );
    case 'contextCompaction':
      // The product's compaction divider (compaction-archive-capture.mjs): status `compacted`, label `Conversation compacted`.
      return {
        kind: 'statusdone',
        id,
        status: 'compacted',
        label: text(m.label) || 'Conversation compacted',
        ...present('detail', m.detail),
        ...atField(m),
      };
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

function toolMetaField(value: unknown): Obj {
  const meta = asObj(value);
  const code = text(meta.code);
  if (!code) return {};
  const missing = Array.isArray(meta.missing) ? meta.missing.filter((name) => typeof name === 'string' && name) : [];
  const ownerSessionId = text(meta.ownerSessionId);
  return {
    toolMeta: { code, missing, ...(/^[A-Za-z0-9_.:-]{1,128}$/.test(ownerSessionId) ? { ownerSessionId } : {}) },
  };
}

/** One tool call's row: restore.mjs `restoredToolCallItems` for the call, `attachRestoredToolResult` once it has finished. */
function toolRow(
  item: Obj,
  m: Obj,
  name: string,
  args: Json | undefined,
  output: string | undefined,
  failed: boolean
): Obj | null {
  if (node.isTranscriptHiddenControlToolName(name) || node.isTaskWaitToolCall(name, args)) return null;
  const ext = asObj(m.ext);
  const finished = typeof m.status === 'string' && FINISHED.has(m.status);
  // A live turn's card starts when its call shows and completes when its result lands (turn-tool-cards.mjs `startedAt: Date.now()`,
  // aggregate-result.mjs `completedAt: Date.now()`), the times its run carries; a restored one reads its message's time for both.
  const run = asObj(item.run);
  const live = run.live === true;
  const completedAt = live && finite(run.completedAt) ? run.completedAt : m.at;
  // A card the core extended with later responses (`agent_response`) states how many it covers on its run.
  const count = Number.isInteger(run.count) && (run.count as number) >= 1 ? (run.count as number) : 1;
  const row: Obj = {
    kind: 'tool',
    id: item.id as Json,
    name,
    ...(args !== undefined && args !== '' ? { args } : {}),
    expanded: false,
    count,
    completedCount: finished ? count : 0,
    ...(finite(m.at)
      ? {
          at: m.at,
          startedAt: live && finite(run.startedAt) ? run.startedAt : m.at,
          ...(finished ? { completedAt } : {}),
        }
      : {}),
    ...present('callId', run.callId ?? ext.callId),
    ...present('messageId', m.messageId),
  };
  // The core ends a live card as `interrupted` only with the abort's error result: a failed call whose card the Stop ended.
  const stopped = live && m.status === 'interrupted';
  if (live) liveRows.add(row);
  if (stopped) stoppedRows.add(row);
  if (!finished) return row;
  const result = output ?? '';
  row.result = result;
  // `attachRestoredToolResult` -> `assignUiDiffFromMessage`: the result message's diff is the card's.
  Object.assign(row, node.stringUiDiffPatch(run.uiDiff), toolMetaField(run.toolMeta ?? ext.toolMeta));
  if (typeof run.rawResult === 'string') row.rawResult = run.rawResult;
  // A cancel/crash body is not a red failure (restore.mjs): it shows the Cancelled tone.
  const cancelled = node.toolResultTerminalStatus(result) === 'cancelled';
  const { isCallError, isExitError } = cancelled
    ? { isCallError: false, isExitError: false }
    : node.toolCallOutcome(
        { isError: failed || stopped || ext.isError === true || run.isError === true, toolName: name },
        result
      );
  row.isError = isCallError;
  row.errorCount = isCallError ? 1 : 0;
  row.callErrorCount = isCallError ? 1 : 0;
  row.exitErrorCount = isExitError ? 1 : 0;
  return row;
}

// ───────────────────────────── aggregate cards ─────────────────────────────

/** A tool row that can join an aggregate: a finished per-call card (restore.mjs `mergeRestoredToolItems` merges restored cards,
 * which have all finished; a call still running stays its own card until its result arrives). */
const mergeable = (row: Obj): boolean =>
  row.kind === 'tool' && row.aggregate !== true && row.imported !== true && 'result' in row;
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

/** The card of a run, by its first row: the run's rows and liveness it was made from. */
const runCards = new WeakMap<Obj, { live: boolean; rows: readonly Obj[]; card: Obj }>();
/** A live standalone card, by its row. */
const standaloneCards = new WeakMap<Obj, Obj>();
/** A live card with its sealed header, by the card: [open, sealed]. */
const sealedCards = new WeakMap<Obj, [Obj | undefined, Obj | undefined]>();
const heldRunCard = (members: readonly { item: Obj }[], live: boolean): Obj | undefined => {
  const held = runCards.get(members[0]!.item);
  if (!held || held.live !== live || held.rows.length !== members.length) return undefined;
  return held.rows.every((row, i) => row === members[i]!.item) ? held.card : undefined;
};
const sealed = (card: Obj, headerFinalized: boolean): Obj => {
  const held = sealedCards.get(card) ?? [undefined, undefined];
  const at = headerFinalized ? 1 : 0;
  let out = held[at];
  if (!out) {
    out = setHistoryPositions({ ...card, headerFinalized }, historyPositionOf(card), historyPositionOf(card, 'after'));
    held[at] = out;
    sealedCards.set(card, held);
  }
  return out;
};
export function* mergeToolRowsSteps(rows: readonly Obj[]): Generator<void, Obj[], void> {
  const merged: Obj[] = [];
  let run: { bucket: string; live: boolean; members: { item: Obj; category: string }[] } | null = null;
  // A run of any length aggregates in steps too: one step per `ROWS_PER_STEP` of its members.
  function* flush(): Generator<void, void, void> {
    if (!run) return;
    const { members, live } = run;
    run = null;
    if (live) liveCards.push({ at: merged.length, stopped: members.some((member) => stoppedRows.has(member.item)) });
    // A restore merges two or more finished cards (`mergeRestoredToolItems`); a live turn's tool cards put every call of a bucket on an aggregate, even one.
    if (members.length >= 2 || live) {
      const held = heldRunCard(members, live);
      if (held) {
        merged.push(held);
        return;
      }
      const card = yield* aggregateRowSteps(members, live);
      // Node archives the card itself (compaction-view.mjs `archivedItem`): a card of calls a compaction took dims as they do.
      const shown = members.every((member) => member.item.archived === true) ? { ...card, archived: true } : card;
      setHistoryPositions(shown, historyPositionOf(members[0]!.item), historyPositionOf(members.at(-1)!.item, 'after'));
      runCards.set(members[0]!.item, { live, rows: members.map((member) => member.item), card: shown });
      merged.push(shown);
    } else for (const member of members) merged.push(member.item);
  }
  // A live card's header is sealed (`finalizeToolHeaders`, header-sync.mjs:13-31) once the block it is in ends: the turn's next
  // non-tool row (`clearAggregateContinuation` at assistant text, a steer or a compact, turn.mjs:256,322; the turn's end,
  // `finalizeToolCards`, turn-tool-cards.mjs:291, which a Stop runs too). Until then it shows the active header form, finished or not.
  const liveCards: { at: number; stopped: boolean }[] = [];
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
      let card = live ? standaloneCards.get(item) : item;
      if (!card) {
        card = setHistoryPositions(
          { ...item, headerFinalized: true, deferredDisplayReady: true },
          historyPositionOf(item),
          historyPositionOf(item, 'after')
        );
        standaloneCards.set(item, card);
      }
      merged.push(card);
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
  let lastOther = merged.length - 1;
  while (lastOther >= 0 && merged[lastOther]!.kind === 'tool') lastOther--;
  for (const { at, stopped } of liveCards) merged[at] = sealed(merged[at]!, stopped || at < lastOther);
  return merged;
}

function aggregateCall(item: Obj, category: string, live: boolean): AggregateCall {
  const callId = live ? item.callId : item.id;
  if (!('result' in item)) {
    return {
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
    } as unknown as AggregateCall;
  }
  const resultText = String(item.result ?? '');
  const rawResultText = String(item.rawResult ?? item.result ?? '');
  if (live) {
    const outcome = node.toolResultDisplay({ isError: item.isError === true }, rawResultText, item.name as string);
    return {
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
      summary: !outcome.isError
        ? node.summarizeToolResult(item.name as string, item.args, rawResultText, outcome.isError)
        : null,
    };
  }
  const { exitCode, isExitError, isCallError } = node.toolCallOutcome(
    { isError: item.isError === true, toolName: item.name as string },
    resultText
  );
  return {
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
    summary:
      !isCallError && resultText.trim()
        ? node.summarizeToolResult(item.name as string, item.args, resultText, false)
        : null,
  };
}

function* aggregateRowSteps(
  members: readonly { item: Obj; category: string }[],
  live: boolean
): Generator<void, Obj, void> {
  const header: AggregateHeader = { categories: new Map(), categoryOrder: [] };
  const calls: AggregateCall[] = [];
  for (const { item, category } of members) {
    if (calls.length % ROWS_PER_STEP === ROWS_PER_STEP - 1) yield;
    node.mergeAggregateCategoryEntries(
      header,
      node.aggregateToolCategoryEntries(item.name as string, item.args, category)
    );
    calls.push(aggregateCall(item, category, live));
  }
  const loadingTargets = yield* node.aggregateLoadingTargetsSteps(calls);
  const first = members[0]!.item;
  // Ownership belongs to the individual call, not to an aggregate that can contain different owners.
  function* restoreMemberMetadata(toolMembers: Obj[]): Generator<void, Obj[], void> {
    for (const [i, member] of toolMembers.entries()) {
      if (i % ROWS_PER_STEP === ROWS_PER_STEP - 1) yield;
      const meta = members[i]?.item.toolMeta;
      if (meta !== undefined) member.toolMeta = meta;
    }
    return toolMembers;
  }
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
      toolMembers: yield* restoreMemberMetadata((yield* node.aggregateToolMembersSteps(calls)) as Obj[]),
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
  if (Array.isArray(outcomePatch.toolMembers)) yield* restoreMemberMetadata(outcomePatch.toolMembers as Obj[]);
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
  // `finalizeAggregateCard(…, { cancelled })` (aggregate-result.mjs:80-91): a card the Stop ended keeps the cancelled marker.
  if (live && members.some((member) => stoppedRows.has(member.item))) {
    const detail = node.withCancelledResultMarker((outcomePatch as Obj).result, outcomePatch as Obj);
    Object.assign(outcomePatch as Obj, { result: detail, text: detail });
  }
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
      ...(ATTACHMENT_ID.test(text(original.attachmentRef))
        ? {
            original: {
              attachmentRef: original.attachmentRef as Json,
              mimeType: text(original.mimeType).slice(0, 100),
            },
          }
        : {}),
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
    if (
      !/^[A-Za-z0-9._-]{1,80}$/.test(agentId) ||
      !emoji ||
      emoji.length > 16 ||
      out.some((r) => r.agentId === agentId)
    )
      continue;
    out.push({ agentId, emoji, ...(finite(raw.at) ? { at: raw.at } : {}) });
  }
  return out.length ? { reactions: out } : {};
}

function routineTriggerField(value: unknown): Obj {
  const trigger = asObj(value);
  const name = text(trigger.name).trim().slice(0, 200);
  if (!name || (trigger.kind !== 'schedule' && trigger.kind !== 'webhook')) return {};
  return {
    routineTrigger: { kind: trigger.kind, name, ...present('event', text(trigger.event).trim().slice(0, 200)) },
  };
}

/** The typed source of a user-role item that the product shows as something other than the user's prompt. */
const NOTICE_SOURCES = new Set(['schedule-result', 'held-request', 'task-notification']);
/** The ext keys the source branches consume to build the row themselves (the stored payloads, not row attributes). */
const SOURCE_PAYLOAD_KEYS = [
  'routine',
  'heldRequest',
  'execution',
  'attachments',
  'messageId',
  'posted',
  'name',
  'args',
  'isError',
];

/** `meta.ext` as row attributes: for a notice or card source the stored payloads it was built from are not row attributes. */
function extOf(item: Obj, m: Obj): Obj {
  const ext = asObj(m.ext);
  if (item.type === 'turnEnd' && text(ext.clientSubmissionId)) {
    // Node's turn end names the prompt by the row id it shows, the submission id (`checkpointId`, turn.mjs `turnDoneItem`);
    // the core's own `checkpointId` is the user item's id, the submission riding in `ext`. A client names a prompt by what it
    // shows (rewind resolves the submission id), so the row shows Node's value.
    const { clientSubmissionId, ...rest } = ext;
    return { ...rest, checkpointId: text(clientSubmissionId) };
  }
  if (item.type !== 'userMessage' || !NOTICE_SOURCES.has(text(m.source ?? asObj(item.details).source))) return ext;
  const rest = { ...ext };
  for (const k of SOURCE_PAYLOAD_KEYS) delete rest[k];
  return rest;
}

/** Posted into the thread outside any turn (restore.mjs `isPostedMessage`): stamped so, or a message id minted by the routine
 * delivery (`routine_<runId>`). */
const postedField = (posted: unknown, messageId: unknown): Obj =>
  posted === true || text(messageId).startsWith('routine_') ? { posted: true } : {};

function handoffFiles(value: unknown): Obj[] {
  return (Array.isArray(value) ? value.map(asObj) : [])
    .filter((f) => typeof f.path === 'string' && f.path !== '')
    .slice(0, 8)
    .map((f) => ({
      name: String(f.name || 'file').slice(0, 200),
      path: text(f.path).slice(0, 1024),
      kind: ['image', 'file', 'text'].includes(text(f.kind)) ? text(f.kind) : 'file',
      mimeType: String(f.mimeType || 'application/octet-stream').slice(0, 100),
      // biome-ignore lint/complexity/useMathMinMax: a NaN size must become 0, which Math.max would keep as NaN.
      size: Number(f.size) >= 0 ? Number(f.size) : 0,
      ...(/^[a-f0-9]{64}$/.test(text(f.id)) ? { id: f.id as Json } : {}),
    }));
}

function taskRoutineNotice(routine: Obj, attachmentSources: unknown[]): Obj {
  const session = routine.target === 'session';
  const status = text(routine.status);
  const what =
    ({ started: 'started', blocked: 'waiting for confirmation' } as Record<string, string>)[status] || status;
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
    ...attachmentsField(attachmentSources.flatMap((source) => (Array.isArray(source) ? source : []))),
  };
}

/** `routineResultNotice` (routine-result.mjs): the line, tone and `routine` payload of a stored routine result. */
function routineNotice(ext: Obj, attachments: unknown): Obj {
  const routine = asObj(ext.routine);
  if (Number(routine.omitted) > 0)
    return {
      text: `⏱ Routine results omitted: ${routine.omitted}`,
      tone: 'info',
      routine: { omitted: routine.omitted! },
    };
  if (Number(routine.relayFailed) > 0) {
    return {
      text: `⚠ Task results not relayed: ${routine.relayFailed} — they are shown above`,
      tone: 'warn',
      routine: { relayFailed: routine.relayFailed! },
    };
  }
  if (routine.kind === 'task') return taskRoutineNotice(routine, [attachments, ext.attachments]);
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
  const label = (
    { pending: 'Approval needed', approved: 'Approved', denied: 'Denied', expired: 'Expired (denied)' } as Record<
      string,
      string
    >
  )[text(held.status)];
  return {
    text: `⏸ ${label || 'Approval needed'} · ${what}`,
    tone: held.status === 'pending' ? 'warn' : 'info',
    heldRequest: held,
  };
}

function taskNotificationCard(id: Json, exec: Obj, result: string, messageId: unknown, m: Obj): Obj {
  const surface = (text(exec.surface) || 'task').toLowerCase();
  const status = text(exec.status).toLowerCase();
  return {
    kind: 'tool',
    id,
    ...present('messageId', messageId),
    name: ['agent', 'shell', 'web_search'].includes(surface) ? surface : 'task',
    args: {
      type: 'result',
      ...(status ? { status } : {}),
      ...(exec.id === undefined ? {} : { task_id: exec.id }),
      surface,
    },
    result,
    rawResult: result,
    isError: /^(failed|error|timeout|cancelled|canceled|killed)$/i.test(status) || /^error:/i.test(result),
    expanded: false,
    count: 1,
    completedCount: 1,
    ...(finite(m.at) ? { at: m.at, startedAt: m.at, completedAt: m.at } : {}),
  };
}

/** A user-role item by its typed message source (`meta.source`; the core drops `skill` and `hook` rows and sends internal wrappers
 * and interrupted ends as typed records, so nothing here reads text). Some older items keep their payloads and stamps in `meta.ext`. */
function userMessageRow(item: Obj, m: Obj): Obj | null {
  const id = item.id as Json;
  const body = userRow(item, m);
  const ext = asObj(m.ext);
  // The row's facts the item states in `details` (UserRowDetails): its source and held request.
  const details = asObj(item.details);
  const held = isObj(ext.heldRequest) ? ext.heldRequest : details.heldRequest;
  const messageId = m.messageId ?? ext.messageId;
  const stamp: Obj = {
    ...present('messageId', messageId),
    ...(finite(m.at) && m.at ? { at: m.at } : {}),
    ...postedField(m.posted ?? ext.posted, messageId),
  };
  switch (m.source ?? details.source) {
    case 'schedule-result':
      return { kind: 'notice', id, ...routineNotice(ext, body.attachments), ...stamp };
    case 'held-request':
      // A held request without its id cannot be answered, so it has no row.
      return isObj(held) && held.id ? { kind: 'notice', id, ...heldNotice(held), ...stamp } : null;
    case 'steering':
      return { ...body, steered: true };
    case 'task-notification':
      return taskNotificationCard(id, asObj(ext.execution), text(body.text), messageId, m);
    default: // `import` renders verbatim, as a plain prompt
      return body;
  }
}

function attachmentPart(p: Obj): Obj {
  const blob = asObj(p.blob);
  const mimeType = text(blob.mediaType) || 'application/octet-stream';
  const original = asObj(p.original);
  return {
    id: bare(blob.digest),
    kind: (p.kind ?? null) as Json,
    name: text(p.filename) || (mimeType.startsWith('image/') ? 'image' : 'file'),
    mimeType,
    size: blob.bytes as Json,
    ...(original.digest === undefined
      ? {}
      : { original: { attachmentRef: bare(original.digest), mimeType: text(original.mediaType) } }),
  };
}

/** A user message: its text parts form the prompt `text` (a pasted text is part of the prompt); an attachment part is a record of
 * `attachments` keyed by the blob's content hash. */
function userRow(item: Obj, m: Obj): Obj {
  const parts = Array.isArray(item.content) ? item.content.map(asObj) : [];
  const attachments = parts.filter((p) => p.type === 'attachment').map(attachmentPart);
  const details = asObj(item.details);
  const imageRefs = details.imageRefs;
  // restore.mjs `restoredTranscriptMetadata`: the stored attachments (`meta.transcript.attachments`, the core's
  // `details.attachments`) the pasted-text and file chips read and open from the store.
  const stored = Array.isArray(details.attachments) ? details.attachments : [];
  return {
    kind: 'user',
    // Node's row id is the submission id (`pushUserOrSyntheticItem(text, id)`), which a client matches its pending bubble by
    // (conversation-prompt-items.ts `pendingPromptTranscriptItems`); the core carries it as `clientSubmissionId`.
    id: (text(item.clientSubmissionId) || item.id) as Json,
    text: parts
      .filter((p) => p.type === 'text' || p.type === 'pastedText')
      .map((p) => text(p.text))
      .join(''),
    ...present('messageId', m.messageId),
    ...atField(m),
    ...routeFields(m),
    ...present('device', item.device),
    ...present('checkpointId', item.checkpointId),
    // `persistedUserTranscriptMetadata`: who sent a bot's message.
    ...present('sender', details.sender),
    ...present('fromAgent', details.fromAgent),
    ...routineTriggerField(details.routineTrigger),
    ...reactionsField(details.reactions),
    ...attachmentsField([...attachments, ...stored]),
    // restore.mjs: each `[Image: …]` line's stored original, which the transcript chip draws its picture from.
    ...(Array.isArray(imageRefs) && imageRefs.length ? { imageRefs: imageRefs as Json } : {}),
    ...(Array.isArray(item.appliedSkills) && item.appliedSkills.length
      ? { appliedSkills: item.appliedSkills.filter((s) => typeof s === 'string' && s) }
      : {}),
  };
}

// ───────────────────────────── room rows ─────────────────────────────

/** `roomRowTargets` (agent-room.mjs): a row's addressees as `{ id, name }`, from lists or the single strings older rows carry. */
function roomTargets(row: Obj): { id: string; name: string }[] {
  const ids = (Array.isArray(row.to) ? row.to : [row.to]).filter(
    (id): id is string => typeof id === 'string' && id !== ''
  );
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

function roomRowItem(item: Obj, m: Obj): Obj {
  const { at: _at, ...stored } = asObj(item.room);
  const images = item.images;
  const targets = roomTargets(stored);
  const room: Obj = targets.length
    ? { ...stored, to: targets.map((t) => t.id), toName: targets.map((t) => t.name) }
    : stored;
  const messageId = text(m.messageId);
  const user = room.kind === 'user';
  const sender: Obj =
    user && room.fromSession ? (room.fromAgent ? { fromAgent: room.fromAgent } : { sender: 'lead' }) : {};
  return {
    kind: user ? 'user' : 'notice',
    id: user && messageId ? messageId : (item.id as Json),
    text: roomRowText(room, text(item.text)),
    ...(user ? {} : { tone: 'info' }),
    room: { ...room, ...(messageId ? { id: messageId } : {}), ...atField(m) },
    ...(messageId ? { messageId } : {}),
    ...atField(m),
    ...(user || room.kind === 'speech' ? attachmentsField(item.attachments) : {}),
    ...(user && Array.isArray(images) && images.length ? { images } : {}),
    ...(user ? reactionsField(item.reactions) : {}),
    ...sender,
  };
}
