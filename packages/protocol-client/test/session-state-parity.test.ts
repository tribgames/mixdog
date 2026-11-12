// Fold parity (protocol.md §14.12): each recorded `session-state` frame's folded renderer state (`decoded`) is replayed as thread
// feed notifications, server requests and app sections over the mock transport; the client's `sessionStateOf` must equal it.
// The notification mapping below is written from protocol.md §5.1, independent of the reducer's tables.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Json } from '../src/api.ts';
import { connect } from '../src/client.ts';
import { MockNetwork } from '../src/mock.ts';
import { sessionReducer, sessionStateOf } from '../src/session-state.ts';
import type { SessionFold } from '../src/session-state.ts';

type O = Record<string, any>;
const options = JSON.parse(readFileSync(new URL('../conformance/options.json', import.meta.url), 'utf8'));
const stream = JSON.parse(readFileSync(new URL('../../../native/core/fixtures/session-state/stream.json', import.meta.url), 'utf8'));
const FIELDS: string[] = JSON.parse(readFileSync(new URL('../../../native/core/fixtures/session-state/MANIFEST.json', import.meta.url), 'utf8')).fieldsCovered;

const OBJ_SECTIONS: Record<string, [string, string[]]> = {
  'thread/runtime/updated': ['runtime', ['busy', 'commandBusy', 'thinking', 'spinner', 'commandStatus', 'progressHint', 'activeTools']],
  'thread/route/updated': ['route', ['sessionProvider', 'sessionModel', 'fast', 'fastCapable', 'autoEffort', 'modelParameters', 'selectedContextWindow']],
  'thread/context/updated': ['context', ['contextPercent', 'contextTokens', 'contextDefaultPercent']],
  'thread/agents/updated': ['agents', ['agentWorkers', 'agentJobs']],
  'thread/workflow/updated': ['workflow', ['workflow', 'orchestrationMode', 'pendingWorkflowSwitch', 'pendingOrchestrationModeSwitch']],
  'thread/approvals/updated': ['approvals', ['toolApprovalResult', 'handoffQuestions']],
};
const VALUE_SECTIONS: Record<string, string> = {
  'thread/todo/updated': 'todo',
  'thread/goal/updated': 'goal',
  'thread/quotaResume/updated': 'quotaResume',
  'thread/shellJobs/updated': 'shellJobs',
  'thread/workspace/updated': 'workspace',
  'thread/promptRestore': 'promptRestore',
  'thread/providerAccount/changed': 'providerAccountChange',
  'thread/remote/updated': 'remoteEnabled',
};
const J = (v: unknown): string => JSON.stringify(v);
const pick = (d: O, fields: string[]): O => Object.fromEntries(fields.filter((f) => d[f] !== undefined).map((f) => [f, d[f]]));

// A recorded row is replayed as the item whose type fits it, with every attribute beyond `text` stated exactly in `meta.ext` (the
// core's exact row attributes). How items project to rows is tested against the Node product in rows.test.ts; this test checks
// that the fold carries rows and state through the notifications unchanged.
function typedItem(row: O): O {
  const { id, kind, text, ...ext } = row;
  if (kind === 'user') return { type: 'userMessage', id, content: [{ type: 'text', text }], meta: { ext } };
  if (kind === 'assistant') return { type: 'agentMessage', id, text, meta: { ext } };
  return { type: 'statusRow', id, kind, meta: { ext: text === undefined ? ext : { ...ext, text } } };
}
function snapshotOf(d: O): O {
  const state: O = { queued: d.queued ?? [] };
  if (d.desktopSessionTitle !== undefined) state.title = d.desktopSessionTitle;
  for (const [, [key, fields]] of Object.entries(OBJ_SECTIONS)) state[key] = pick(d, fields);
  for (const f of Object.values(VALUE_SECTIONS)) if (d[f] !== undefined) state[f] = d[f];
  return { thread: { id: 'lead' }, state, items: d.items.map(typedItem), hasOlder: d.transcriptHasOlder === true };
}
const liveOf = (d: O): { id: string; text: string } | null => {
  const t = d.streamingTail ?? null;
  const p = d.streamingPartial ?? null;
  return t || p ? { id: (t ?? p).id, text: (t?.text ?? '') + (p?.text ?? '') } : null;
};

/** The notifications that take `prev` to `next`, or `null` when only a fresh snapshot can express the change. */
function diff(prev: O, next: O, prevLive: { id: string; text: string } | null): { method: string; params: O }[] | null {
  const ids = (d: O) => d.items.map(J);
  if (prev.items.length > next.items.length || ids(prev).some((r: string, i: number) => r !== ids(next)[i])) return null;
  if (prev.desktopSessionTitle !== next.desktopSessionTitle || prev.transcriptHasOlder !== next.transcriptHasOlder) return null;
  const out: { method: string; params: O }[] = [];
  const t = { threadId: 'lead' };
  for (const [method, [, fields]] of Object.entries(OBJ_SECTIONS)) {
    if (J(pick(prev, fields)) !== J(pick(next, fields))) out.push({ method, params: { ...t, value: pick(next, fields) } });
  }
  for (const [method, f] of Object.entries(VALUE_SECTIONS)) {
    if (J(prev[f]) !== J(next[f])) out.push({ method, params: { ...t, value: next[f] ?? null } });
  }
  if (J(prev.queued) !== J(next.queued)) out.push({ method: 'thread/queue/changed', params: { ...t, queued: next.queued } });
  for (const row of next.items.slice(prev.items.length)) out.push({ method: 'item/completed', params: { ...t, turnId: 'turn', item: typedItem(row) } });
  const live = liveOf(next);
  if (live) {
    const same = prevLive?.id === live.id && live.text.startsWith(prevLive.text);
    if (!same) out.push({ method: 'item/started', params: { ...t, turnId: 'turn', item: { type: 'agentMessage', id: live.id, text: '', meta: {} } } });
    const delta = same ? live.text.slice(prevLive!.text.length) : live.text;
    if (delta) out.push({ method: 'item/agentMessage/delta', params: { ...t, turnId: 'turn', itemId: live.id, delta } });
  } else if (prevLive) out.push({ method: 'turn/completed', params: { ...t, turn: { id: 'turn', status: 'completed' } } });
  return out;
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};

test('prompt history and history reset fold from the core', () => {
  const snap = (state: unknown, hasOlder = true) => sessionReducer.initial({ thread: { id: 't' }, items: [], state, hasOlder } as unknown as Json);
  const at = (s: SessionFold, method: string, params: unknown) => sessionReducer.apply(s, { method, params } as never);
  let s = snap({ promptHistoryList: ['b  c', 'a'] });
  assert.deepEqual(s.fields.promptHistoryList, ['b  c', 'a']);
  s = at(s, 'thread/promptHistory/updated', { threadId: 't', value: { kind: 'added', prompt: 'a' } });
  s = at(s, 'thread/promptHistory/updated', { threadId: 't', value: { kind: 'added', prompt: 'b\n c' } });
  assert.deepEqual(s.fields.promptHistoryList, ['b\n c', 'a']);
  const full = Array.from({ length: 50 }, (_, i) => `p${i}`);
  s = at(s, 'thread/promptHistory/updated', { threadId: 't', value: { kind: 'replaced', prompts: full } });
  s = at(s, 'thread/promptHistory/updated', { threadId: 't', value: { kind: 'added', prompt: 'new' } });
  assert.deepEqual(s.fields.promptHistoryList, ['new', ...full.slice(0, 49)]);
  assert.equal(s.fields.transcriptHasOlder, true);
  s = at(s, 'thread/historyReset', { threadId: 't', reason: 'clear', hasOlder: false });
  assert.equal('transcriptHasOlder' in s.fields, false);
  s = at(s, 'thread/historyReset', { threadId: 't', reason: 'rewind', fromItemId: 'gone', hasOlder: true });
  assert.equal(s.fields.transcriptHasOlder, true);
});

test('fold parity: recorded session-state frames reproduce DesktopSessionState field for field', async () => {
  const net = new MockNetwork();
  const connecting = connect<SessionFold>({
    target: { id: 'local' },
    connector: net,
    clientInfo: options.clientInfo,
    capabilities: options.capabilities,
    threadReducer: sessionReducer,
    clock: { sleep: () => Promise.resolve() },
    random: () => 0,
  });
  const conn = await net.accept();
  const init = JSON.parse(await conn.nextSent());
  conn.serverSend({ id: init.id, result: { ...options.initializeResult, serverInstanceId: 's1' } });
  await conn.nextSent(); // initialized
  const client = await connecting;

  const answer = async (result: Json): Promise<void> => conn.serverSend({ id: JSON.parse(await conn.nextSent()).id, result });
  let seq = 0;
  const feed = (method: string, params: unknown, id = 'lead', epoch = 'e1') => conn.serverSend({ method, params, feed: { id, epoch, seq: seq++ } });
  const thread = { id: 'lead', preview: '', title: '', updatedAt: 1, messageCount: 0, cwd: '/w', classification: {}, projectPath: null };

  const resumed = client.resumeThread('lead', { lastItems: 50 });
  await answer({ thread, subscription: { id: 'sub', mode: 'snapshot', epoch: 'e1', startSeq: 1 } } as unknown as Json);
  await resumed;
  const app = client.subscribeApp();
  await answer({ subscription: { id: 'as', mode: 'snapshot', epoch: 'ae', startSeq: 1 } } as unknown as Json);
  await app;
  const hostShell = stream.frames[0].decoded.hostShellJobs;
  conn.serverSend({ method: 'app/snapshot', params: { sections: [{ section: 'hostShellJobs', key: null, revision: 1, value: hostShell }] }, feed: { id: 'app', epoch: 'ae', seq: 0 } });

  let prev: O | null = null;
  let live: { id: string; text: string } | null = null;
  const pending: string[] = [];
  let requestSeq = 0;
  void requestSeq;
  for (const frame of stream.frames as { step: string; decoded: O }[]) {
    const d = frame.decoded;
    const notes = prev ? diff(prev, d, live) : null;
    if (notes === null) {
      feed('thread/snapshot', snapshotOf(d));
      live = null;
      if (liveOf(d)) {
        const l = liveOf(d)!;
        feed('item/started', { threadId: 'lead', turnId: 'turn', item: { type: 'agentMessage', id: l.id, text: '', meta: {} } });
        feed('item/agentMessage/delta', { threadId: 'lead', turnId: 'turn', itemId: l.id, delta: l.text });
      }
    } else for (const n of notes) feed(n.method, n.params);
    live = liveOf(d);

    const want: string[] = d.toolApproval ? [d.toolApproval.id, ...Array.from({ length: d.toolApprovalsWaiting }, (_, i) => `${d.toolApproval.id}-w${i}`)] : [];
    for (const id of pending.splice(0).filter((p) => !want.includes(p))) {
      conn.serverSend({ method: 'serverRequest/resolved', params: { threadId: 'lead', requestId: id, resolution: { kind: 'cancelled', at: 1 } } });
    }
    want.forEach((id, i) => {
      if (pending.includes(id)) return;
      const { id: _id, tool, ...request } = d.toolApproval;
      conn.serverSend({ id, method: 'item/tool/requestApproval', params: { threadId: 'lead', requestedAt: 1, order: i + 1, kind: 'shell', tool, request } });
    });
    pending.push(...want);
    await settle();

    const got = sessionStateOf(client, 'lead') as O;
    // Fields the engine starts with (initial-state.mjs, context-state.mjs `baseRouteState`, the route's `runtime.sessionProvider ?? null`) that
    // the scripted daemon's snapshot omits while they hold their initial value; `transcriptSpilled` comes with the first row
    // (transcript-store.mjs). `streamingPartial` is not among them: the first draft has none (initial-state.mjs); a frame holds it once a
    // partial line was shown. The host's always-present fields read null (or empty) while they hold nothing
    // (session-host-publication.ts:281-288, session-host.ts:485-495).
    const expected: O = {
      streamingTail: null,
      sessionProvider: null,
      sessionModel: null,
      promptRestore: null,
      workspace: null,
      goal: null,
      quotaResume: null,
      todo: null,
      agentScope: null,
      remoteEnabled: false,
      shellJobs: { count: 0, elapsedLabel: '', jobs: [], finished: [] },
      hostShellJobs: { count: 0, elapsedLabel: '', jobs: [], finished: [] },
      toolApproval: null,
      toolApprovalsWaiting: 0,
      promptHistoryList: [],
      // The transcript window and the TUI counters the core does not page or spill (the fold's idle values, initial-state.mjs).
      transcriptViewItems: null,
      transcriptViewRevision: 0,
      transcriptHistoryBefore: false,
      transcriptHistoryAfter: false,
      transcriptArchive: null,
      ...(d.items.length ? { transcriptSpilled: { epoch: 0, rows: 0 } } : {}),
      lastTurn: null,
      themeEpoch: 0,
      ...d,
    };
    // The host's remote session id is the host's (session-host-publication.ts:286), not a thread feed field: the fold holds none.
    expected.remoteSessionId = null;
    // `structureRevision` counts the fold's own row changes; a recorded frame states none.
    assert.equal(Number.isInteger(got.structureRevision), true, `step ${frame.step}: structureRevision`);
    delete got.structureRevision;
    assert.deepEqual(got, expected, `step ${frame.step}`);
    for (const f of FIELDS) assert.deepEqual(got[f], expected[f], `${frame.step}: ${f}`);
    prev = d;
  }
  await client.close();
});
