#!/usr/bin/env node
// Case 110 of Node's channel restart tests (src/standalone/channel-restart.test.mjs, "channel call ids belong to the
// calling process, not the addressed session") from the real `createChannelTransport` (channel-transport.mjs) over its
// real loopback HTTP routes: two passive clients register with different lead pids, then both send the same callId, name
// and payload; the transport's handler (`handleCall`, the service boundary) is a scripted endpoint that counts calls.
// Recorded in order: every HTTP request (method, path, body) and response (status, headers, body), every `handleCall`
// (name, args, caller context). Other cases of the file: 38 (restore and manual ON share one ordered lifetime) is not
// recorded: it proves the order by polling `transport.activeCount` for the manual request to enter the lane, and the
// transport has no event for that (a recorder may not poll); 95 is covered (ch/tests.rs
// retried_call_id_runs_once_and_conflicting_payload_is_refused); 123 is recorded by gaps-memory-channels; 161, 191 are
// WebSocket/stop concerns of the core (GONE).
//
//   node benchmarks/rust-core/recorders/record-channels-call-ids.mjs --tree <dir>
import { begin, capture, finish, importFrom, exact, within } from './lib/mc-record.mjs';

const ctx = begin();
const { createChannelTransport } = await importFrom(ctx.tree, 'src/standalone/channel-transport.mjs');
const SELF = process.pid;
const PARENT = process.ppid;
const tokens = new Map();
const norm = (value) => {
  let text = JSON.stringify(value);
  for (const [token, label] of tokens) text = text.split(token).join(label);
  text = text.replaceAll(`"leadPid":${SELF}`, '"leadPid":"<pid-self>"').replaceAll(`"leadPid":${PARENT}`, '"leadPid":"<pid-parent>"');
  return JSON.parse(text);
};

async function session(label, makeScript) {
  tokens.clear();
  const calls = [];
  let n = 0;
  const transport = createChannelTransport({
    handleCall: async (name, args, caller) => { n += 1; calls.push({ name, args: exact(args), caller: exact(caller ?? null) }); return { call: n }; },
  });
  const wire = [];
  try {
    const endpoint = await within('the channel transport starting on loopback', transport.start(), 30_000);
    const post = async (path, body, step) => {
      const response = await within(`POST ${path} (${step})`, fetch(`http://127.0.0.1:${endpoint.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mixdog-daemon-token': endpoint.token }, body: JSON.stringify(body) }), 30_000);
      const raw = await response.text();
      // The core's pid is part of the answer (`pid`): written as a label, and content-length recorded as if the pid had 5 digits.
      const pidHits = raw.split(`\"pid\":${SELF}`).length - 1;
      const text = raw.replaceAll(`\"pid\":${SELF}`, '\"pid\":\"<pid-self>\"');
      const headers = Object.fromEntries([...response.headers].map(([k, v]) => [k, k === 'date' ? '<date>' : k === 'content-length' ? String(Number(v) + pidHits * (5 - String(SELF).length)) : v]));
      let json = null;
      try { json = JSON.parse(text); } catch { json = null; }
      if (json?.token && !tokens.has(json.token)) tokens.set(json.token, `<client-token-${tokens.size + 1}>`);
      wire.push({ step, request: { method: 'POST', path: path, headers: { 'content-type': 'application/json', 'x-mixdog-daemon-token': '<daemon-token>' }, body }, response: { status: response.status, headers, body: text } });
      return json;
    };
    const run = await makeScript({ post, calls, transport });
    return { label, ...run, wire: norm(wire), handleCalls: norm(calls) };
  } finally {
    await transport.stop();
  }
}

const bySession = await session('same callId, two processes, one session', async ({ post }) => {
  const first = await post('/client/register', { leadPid: SELF, passive: true }, 'register client 1 (lead pid = recorder)');
  const second = await post('/client/register', { leadPid: PARENT, passive: true }, 'register client 2 (lead pid = recorder parent)');
  const payload = { callId: 'shared-id', name: 'send_reply', args: { sessionId: 'same_session', text: 'hello' } };
  await post('/call', { ...payload, token: first.token }, 'call shared-id from client 1');
  await post('/call', { ...payload, token: second.token }, 'call shared-id from client 2');
  await post('/call', { ...payload, token: first.token }, 'retry shared-id from client 1 (same payload)');
  await post('/call', { ...payload, args: { sessionId: 'same_session', text: 'other' }, token: first.token }, 'client 1 reuses shared-id with another payload');
  return {};
});
const sameProcess = await session('same callId, two clients of the same process', async ({ post }) => {
  const first = await post('/client/register', { leadPid: SELF, passive: true }, 'register client 1');
  const second = await post('/client/register', { leadPid: SELF, passive: true }, 'register client 2 (same lead pid)');
  const payload = { callId: 'shared-id', name: 'send_reply', args: { sessionId: 'same_session', text: 'hello' } };
  await post('/call', { ...payload, token: first.token }, 'call shared-id from client 1');
  await post('/call', { ...payload, token: second.token }, 'call shared-id from client 2');
  return {};
});
const noCallId = await session('no callId: every call runs', async ({ post }) => {
  const first = await post('/client/register', { leadPid: SELF, passive: true }, 'register client');
  const payload = { name: 'send_reply', args: { text: 'x' } };
  await post('/call', { ...payload, token: first.token }, 'call without callId');
  await post('/call', { ...payload, token: first.token }, 'same call without callId again');
  return {};
});

finish(ctx, {
  url: import.meta.url,
  set: 'channels-call-ids',
  golden: {
    domain: 'channels-call-ids',
    source: 'src/standalone/channel-restart.test.mjs',
    cases: [
      { name: 'channel call ids belong to the calling process, not the addressed session (test line 110)', session: bySession },
      { name: 'further shapes (beyond the test file)', sessions: [sameProcess, noCallId] },
    ],
  },
  extra: {
    entry: { runs: 'createChannelTransport (channel-transport.mjs): its HTTP server, client registry, call dispatch (call-dispatch.mjs: callId idempotency cache keyed by caller owner and callId, rpc-call-identity.mjs) over real loopback fetch', notRun: 'the daemon behind handleCall (scripted: it returns {call: n}); the remote intent files (no remoteIntentPath is given)' },
    replay: 'mixdog-services channels: ch/call.rs run_call / call_owner (pid + token, not session) and the op-id cache, with the caller identity a core connection carries; the HTTP/SSE wire is replaced by WebSocket (protocol.md:854-865), so a replay compares per step the results and the handleCall list (name, args, caller), mapping `leadPid` to the connection\'s owner pid. The wire entries are what Node sent and answered over HTTP, for the replay author',
    exclusions: 'test case 38 (restore vs manual ON order) is not recorded: it needs a poll of transport.activeCount; 95 is covered; 123 belongs to gaps-memory-channels; 161 and 191 are WebSocket / core stop concerns',
    normalised: { 'client tokens': 'random tokens written as <client-token-N> by order of registration', 'lead pids': 'the recorder pid and its parent pid written as <pid-self> / <pid-parent> (the registration body keeps the recorded values replaced the same way)', port: 'not recorded (loopback ephemeral)', date: 'response Date header written as <date>' },
  },
});
process.exit(0);
