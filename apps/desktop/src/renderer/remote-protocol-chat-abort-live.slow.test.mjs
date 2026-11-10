// The Stops against a RUNNING mixdogd, each time: the core built at MIXDOGD_EXE is driven through the cases of
// remote-protocol-chat-abort-cases.mjs (remote-protocol-chat-abort-live.mjs) and what the phone reads of it is compared, whole, with what Node's
// daemon + SessionHost gave the phone for the same cases (remote-protocol-chat-abort.recorded.json, the exact b6f10295a export):
//   the Stop's reply        through the adapter's abortSession
//   the stored transcript   Node's `readSessionTranscript` rows against the core's thread items folded as the client folds them
//   the thread's list row   Node's `listSessions` row against the core's `thread/list` row through the phone's projection
// Without MIXDOGD_EXE / REAL_TURN_HARNESS naming real files this file fails: there is no replay fallback.
// Run directly with `--only <case name>` (node --test-force-exit … remote-protocol-chat-abort-live.slow.test.mjs --only running-pasted-text,
// the flag scripts/test.mjs gives every file), it drives and
// compares that one case; the default (and the test lane) runs every case.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { desktopSessionState, sessionReducer } from '../../../../packages/protocol-client/src/session-state.ts';
import { summariesOfThreadRows } from '../main/protocol/thread-rows.ts';
import { createChatApi } from './remote-protocol-chat.ts';
import { createCapabilityLane } from '../main/protocol/capability-route.ts';
import { routeService } from '../main/protocol/service-route.ts';
import { coreErrorForWindow } from '../main/protocol/core-error.ts';
import { RUN_OTHERS, RUN_TIMES } from './remote-protocol-chat-abort-run-fields.mjs';
import { runAbortLive } from './remote-protocol-chat-abort-live.mjs';

const node = JSON.parse(readFileSync(new URL('./remote-protocol-chat-abort.recorded.json', import.meta.url), 'utf8'));
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt === -1 ? undefined : process.argv[onlyAt + 1];
const live = await runAbortLive({ only });
const nodeCases = node.cases.filter((c) => only === undefined || c.name === only);

const plain = (value) => JSON.parse(JSON.stringify(value));
/**
 * Values that are a run's own (remote-protocol-chat-abort-run-fields.mjs; remote-protocol-chat-abort-run-fields.test.mjs shows by two recordings of
 * Node that these, and only these, differ between runs). They compare as: the same kind of value; `messageId` in the same character shape; the ids
 * as ids (a submission id is fixed by the case and compared as it is; a turn end names a row of its own transcript); the times in the same order
 * as Node's (`timeFacts`: which fields occur, in which order, none before the one before it, a tool's completion not before its start).
 * `device` is no longer exempt: both sides name the paired device the case names.
 */
const RUN_FIELDS = new Set([...RUN_TIMES, ...RUN_OTHERS]);
const TIME_FIELDS = new Set(RUN_TIMES);/** The time fields in the order they occur, and for each whether it is not before the one occurring before it (rows: `at` of a later row is not earlier); a tool's completion is not before its start. */
const timeFacts = (value) => {
  const seen = [];
  const walk = (v, key = '') => {
    if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, k);
      if (typeof v.startedAt === 'number' && typeof v.completedAt === 'number') seen.push([`${key}.completedAt>=startedAt`, v.completedAt >= v.startedAt]);
    } else if (TIME_FIELDS.has(key)) seen.push([key, v]);
  };
  walk(value);
  const stamps = seen.filter(([, v]) => typeof v === 'number');
  return {
    names: seen.map(([name]) => name),
    notBackwards: stamps.map(([, v], i) => (i === 0 ? true : v >= stamps[i - 1][1])),
    completionNotBeforeStart: seen.filter(([, v]) => typeof v === 'boolean').map(([, v]) => v),
  };
};
const folders = (value) => (typeof value === 'string' ? value.replace(/^.*[\\/]env-ph2-chat-abort-(node|live)[\\/]/, '<env>/') : value);
const shape = (value, key = '') => {
  if (Array.isArray(value)) return value.map((v) => shape(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v, k)]));
  if (key === 'messageId' && typeof value === 'string') return value.replace(/[0-9a-f]/g, 'x');
  if (RUN_FIELDS.has(key)) return `<${typeof value}>`;
  if (key === 'finalAssistantId' && typeof value === 'string') return '<id>';
  if (key === 'id' && typeof value === 'string' && !value.startsWith('sub-')) return '<id>';
  if (key === 'checkpointId') return typeof value === 'string' && value.startsWith('sub-') ? value : '<id>';
  return folders(value);
};
/** The transcript rows the production fold gives for a thread snapshot's items (session-state.ts `sessionReducer.initial` + `desktopSessionState`): nothing is dropped here. */
const foldRows = (items) => desktopSessionState(sessionReducer.initial({ thread: { id: 'abort-live' }, items, state: {} }), []).items;

function adapterFor(replies) {
  const sent = [];
  const protocol = {
    call: async (method, params) => {
      sent.push({ method, params });
      if (method !== 'turn/interrupt') throw new Error(`unscripted request ${method}`);
      const reply = replies.shift();
      if (reply?.error) throw Object.assign(new Error(reply.error.message), { detail: { kind: 'rpc', code: reply.error.code, reason: reply.error.data?.reason, message: reply.error.message, data: reply.error.data } });
      return reply;
    },
    snapshot: () => ({ entries: [] }),
    noteUserInput() {},
    respond() {},
    pendingServerRequests: () => [],
  };
  const client = { call: protocol.call, resumeThread: async () => ({}), unsubscribeThread: async () => ({}), server: { connection: {} } };
  const api = createChatApi(client, { routeService, lane: createCapabilityLane({ protocol }), coreErrorForWindow, normalizedProviderModels: (rows) => rows, sessionStateOf: () => undefined, remoteToolOutput: () => null }, {});
  return { api, sent };
}

test('the run is of the built core and holds Node\'s cases', () => {
  assert.match(live.manifest.binarySha256, /^[0-9a-f]{64}$/);
  assert.equal(node.manifest.exact, true);
  assert.deepEqual(live.cases.map((c) => c.name), nodeCases.map((c) => c.name));
});

for (const nodeCase of nodeCases) {
  const core = live.cases.find((c) => c.name === nodeCase.name);
  test(`${nodeCase.name}: the Stop's reply, the stored transcript and the list row are Node's`, async () => {
    // A second Stop has a reply on both sides or on neither: an absent reply where Node had one (or the reverse) fails here.
    assert.equal(core.core.again?.reply !== undefined, nodeCase.node.second !== undefined, 'a reply to the second Stop on both sides or neither');
    assert.notEqual(core.core.reply, undefined, 'the core answered the Stop');
    const replies = nodeCase.node.second !== undefined ? [core.core.reply, core.core.again.reply] : [core.core.reply];
    const { api, sent } = adapterFor(replies);
    const handedBack = await api.abortSession(core.stop.threadId, nodeCase.stop);
    assert.deepEqual(handedBack, nodeCase.node.reply);
    // A handed-back pasted text is readable by the phone: its text is the one sent, and its reference names exactly those bytes (the store is content-addressed).
    for (const [key, entry] of Object.entries(handedBack.pastedTexts ?? {})) {
      assert.equal(entry.text, core.start.input.options.pastedTexts[key].text);
      assert.equal(entry.attachmentRef, createHash('sha256').update(entry.text, 'utf8').digest('hex'));
    }
    if (nodeCase.node.second) assert.deepEqual(await api.abortSession(core.stop.threadId, nodeCase.again), nodeCase.node.second);
    assert.deepEqual(sent[0].params, core.stop);
    // A turn end names its answer by an id each side mints (`it_…` in Node, `itm_…` in the core): it must be the id of a row of the same transcript.
    for (const [side, rows] of [['core', plain(foldRows(core.core.items))], ['node', nodeCase.node.items]]) {
      for (const end of rows) {
        if (end.finalAssistantId === undefined) continue;
        assert.ok(rows.some((r) => r.kind === 'assistant' && r.id === end.finalAssistantId), `${side}: the turn end names a row of its transcript`);
      }
    }
    const coreRows = plain(foldRows(core.core.items));
    const coreRow = plain(summariesOfThreadRows([core.core.row])[0]);
    assert.deepEqual(shape(coreRows), shape(nodeCase.node.items), 'stored transcript');
    assert.deepEqual(shape(coreRow), shape(nodeCase.node.row), 'list row');
    assert.deepEqual(timeFacts(coreRows), timeFacts(nodeCase.node.items), 'stored transcript: the times are in Node\'s order');
    assert.deepEqual(timeFacts(coreRow), timeFacts(nodeCase.node.row), 'list row: the times are in Node\'s order');
    // The composer of the device that sent the prompt: Node's session state `promptRestore` is the core's last `thread/promptRestore` (null when none came).
    const restore = core.core.promptRestores.at(-1)?.value ?? null;
    assert.deepEqual(shape(plain(restore)), shape(nodeCase.node.promptRestore), 'the prompt handed to the sending device');
    assert.equal(core.core.promptRestores.length, nodeCase.node.promptRestore ? 1 : 0, 'one hand-over, or none');
  });
}
