// The Stops against a RUNNING mixdogd, each time: the core built at MIXDOGD_EXE is driven through the cases of
// remote-protocol-chat-abort-cases.mjs (remote-protocol-chat-abort-live.mjs) and what the phone reads of it is compared, whole, with what Node's
// daemon + SessionHost gave the phone for the same cases (remote-protocol-chat-abort.recorded.json, the exact b6f10295a export):
//   the Stop's reply        through the adapter's abortSession
//   the stored transcript   Node's `readSessionTranscript` rows against the core's thread items folded as the client folds them
//   the thread's list row   Node's `listSessions` row against the core's `thread/list` row through the phone's projection
// Without MIXDOGD_EXE / REAL_TURN_HARNESS naming real files this file fails: there is no replay fallback.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mergeToolRows, rowOf } from '../../../../packages/protocol-client/src/rows.ts';
import { summariesOfThreadRows } from '../main/protocol/thread-rows.ts';
import { createChatApi } from './remote-protocol-chat.ts';
import { createCapabilityLane } from '../main/protocol/capability-route.ts';
import { routeService } from '../main/protocol/service-route.ts';
import { coreErrorForWindow } from '../main/protocol/core-error.ts';
import { runAbortLive } from './remote-protocol-chat-abort-live.mjs';

const node = JSON.parse(readFileSync(new URL('./remote-protocol-chat-abort.recorded.json', import.meta.url), 'utf8'));
const live = await runAbortLive();

const plain = (value) => JSON.parse(JSON.stringify(value));
/** Values that are a run's own: ids the daemon minted, wall-clock times, the machine/client name. Their kind must match; nothing else is skipped. */
const RUN_FIELDS = new Set(['at', 'elapsedMs', 'thinkingElapsedMs', 'messageId', 'attemptId', 'device', 'createdAt', 'updatedAt', 'activityAt']);
const folders = (value) => (typeof value === 'string' ? value.replace(/^.*[\\/]env-ph2-chat-abort-(node|live)[\\/]/, '<env>/') : value);
const shape = (value, key = '') => {
  if (Array.isArray(value)) return value.map((v) => shape(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v, k)]));
  if (RUN_FIELDS.has(key)) return `<${typeof value}>`;
  if (key === 'id' && typeof value === 'string' && !value.startsWith('sub-')) return '<id>';
  if (key === 'checkpointId') return typeof value === 'string' && value.startsWith('sub-') ? value : '<id>';
  return folders(value);
};
const foldRows = (items) => mergeToolRows(items.map((item) => rowOf(item)).filter(Boolean));

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
  assert.deepEqual(live.cases.map((c) => c.name), node.cases.map((c) => c.name));
});

for (const nodeCase of node.cases) {
  const core = live.cases.find((c) => c.name === nodeCase.name);
  test(`${nodeCase.name}: the Stop's reply, the stored transcript and the list row are Node's`, async () => {
    const replies = [core.core.reply, core.core.again?.reply].filter((r) => r !== undefined);
    const { api, sent } = adapterFor(replies);
    assert.deepEqual(await api.abortSession(core.stop.threadId, nodeCase.stop), nodeCase.node.reply);
    if (nodeCase.node.second) assert.deepEqual(await api.abortSession(core.stop.threadId, nodeCase.again), nodeCase.node.second);
    assert.deepEqual(sent[0].params, core.stop);
    assert.deepEqual(shape(plain(foldRows(core.core.items))), shape(nodeCase.node.items), 'stored transcript');
    assert.deepEqual(shape(plain(summariesOfThreadRows([core.core.row])[0])), shape(nodeCase.node.row), 'list row');
  });
}
