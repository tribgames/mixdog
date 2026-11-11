#!/usr/bin/env node
// Cases 95 and 110 of Node's channel restart tests (src/standalone/channel-restart.test.mjs, "channel call ids belong to the
// calling process, not the addressed session") from the real `createChannelTransport` (channel-transport.mjs) over its
// real loopback HTTP routes, through a byte-level TCP relay that records what is really sent and answered. Case 95 ("channel
// retries reuse results only for the same payload"): one client, the same call id resent, then reused with another payload. Case 110: two passive clients register with different lead pids, then both send the same callId, name
// and payload; the transport's handler (`handleCall`, the service boundary) is a scripted endpoint that counts calls.
// Recorded in order: every HTTP request (head lines in wire order, body) and response (head, body), every `handleCall`
// (name, args, caller context). Other cases of the file: 38 (restore and manual ON share one ordered lifetime) is not
// recorded: it proves the order by polling `transport.activeCount` for the manual request to enter the lane, and the
// transport has no event for that (a recorder may not poll); 123 (daemon boot restores the pin)
// is recorded on branch gaps-memory-channels: benchmarks/rust-core/recorders/record-channel-remote-intent.mjs (pending that branch);
// 161, 191 are WebSocket/stop concerns of the core (GONE).
//
//   node benchmarks/rust-core/recorders/record-channels-call-ids.mjs --tree <dir>
import net from 'node:net';
import { begin, capture, finish, importFrom, exact, within } from './lib/mc-record.mjs';

const ctx = begin();
const { createChannelTransport } = await importFrom(ctx.tree, 'src/standalone/channel-transport.mjs');
const SELF = process.pid; // the core's own pid appears in register answers; it is written <pid-self> (declared)
const LEAD_A = 41001; // fixed lead pids for the two passive clients: the recording must not depend on this machine's pids
const LEAD_B = 41002;
const tokens = new Map();
const norm = (value) => {
  let text = JSON.stringify(value);
  for (const [token, label] of tokens) text = text.split(token).join(label);
  return JSON.parse(text);
};

// A byte-level TCP relay between the client and the transport: what `fetch` really sends and what the server really answers,
// request head (header lines in wire order, wire case) and body, response head and body.
function relay(targetPort) {
  const connections = [];
  const server = net.createServer((client) => {
    const entry = { up: Buffer.alloc(0), down: Buffer.alloc(0), upParsed: 0, downParsed: 0, client };
    connections.push(entry);
    const upstream = net.connect(targetPort, '127.0.0.1');
    client.on('data', (chunk) => { entry.up = Buffer.concat([entry.up, chunk]); upstream.write(chunk); });
    upstream.on('data', (chunk) => { entry.down = Buffer.concat([entry.down, chunk]); client.write(chunk); });
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  const messages = (buffer, from) => {
    const out = [];
    let at = from;
    while (true) {
      const end = buffer.indexOf('\r\n\r\n', at);
      if (end < 0) break;
      const head = buffer.subarray(at, end).toString('latin1').split('\r\n');
      const length = Number((head.find((line) => /^content-length:/i.test(line)) ?? '').split(':')[1] ?? 0);
      if (head.some((line) => /^transfer-encoding:/i.test(line))) throw new Error('the relay does not decode chunked bodies');
      if (buffer.length < end + 4 + length) break;
      out.push({ head, body: buffer.subarray(end + 4, end + 4 + length).toString('utf8') });
      at = end + 4 + length;
    }
    return { out, at };
  };
  return {
    listen: () => within('the relay listening', new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))), 30_000),
    take: () => {
      const pairs = [];
      for (const entry of connections) {
        const requests = messages(entry.up, entry.upParsed);
        const responses = messages(entry.down, entry.downParsed);
        entry.upParsed = requests.at;
        entry.downParsed = responses.at;
        requests.out.forEach((request, i) => pairs.push({ request, response: responses.out[i] ?? null }));
      }
      return pairs;
    },
    close: async () => {
      for (const entry of connections) entry.client.destroy();
      await within('the relay closing', new Promise((resolve) => server.close(() => resolve())), 30_000);
    },
  };
}

async function session(label, makeScript) {
  tokens.clear();
  const calls = [];
  let n = 0;
  const transport = createChannelTransport({
    handleCall: async (name, args, caller) => { n += 1; calls.push({ name, args: exact(args), caller: exact(caller) }); return { call: n }; },
  });
  const wire = [];
  let proxy = null;
  try {
    const endpoint = await within('the channel transport starting on loopback', transport.start(), 30_000);
    proxy = relay(endpoint.port);
    const proxyPort = await proxy.listen();
    const wireText = (value) => value.replaceAll(`:${proxyPort}`, ':<port>').replaceAll(endpoint.token, '<daemon-token>');
    const post = async (path, body, step) => {
      const response = await within(`POST ${path} (${step})`, fetch(`http://127.0.0.1:${proxyPort}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mixdog-daemon-token': endpoint.token }, body: JSON.stringify(body) }), 30_000);
      const raw = await within(`the response body of POST ${path} (${step})`, response.text(), 30_000);
      let json = null;
      try { json = JSON.parse(raw); } catch { json = null; }
      if (json?.token && !tokens.has(json.token)) tokens.set(json.token, `<client-token-${tokens.size + 1}>`);
      const exchanged = proxy.take();
      if (exchanged.length !== 1 || !exchanged[0].response) throw new Error(`the relay saw ${exchanged.length} exchanges for ${step}`);
      const { request, response: answer } = exchanged[0];
      // The register answer carries this process's pid; it is a label, and the content-length is the length the recorded text has.
      const pidText = `"pid":${SELF}`;
      const pidHits = answer.body.split(pidText).length - 1;
      // The body as sent is longer than the recorded text wherever a random token was written as its label: every message lists
      // the labels written in its body with the token's original length and count, so recorded body + rewrites = the real Content-Length.
      const rewrites = (body) => Object.fromEntries([...tokens, [endpoint.token, wireText(endpoint.token)]].map(([token, label]) => [label, { originalLength: token.length, count: body.split(token).length - 1 }]).filter(([, hit]) => hit.count > 0));
      wire.push({
        step,
        request: { head: request.head.map((line) => wireText(line)), body: wireText(request.body), rewrites: rewrites(request.body) },
        response: { head: answer.head.map((line) => (/^date:/i.test(line) ? 'Date: <date>' : /^content-length:/i.test(line) ? `Content-Length: ${Number(line.split(':')[1]) + pidHits * ('"<pid-self>"'.length - String(SELF).length)}` : line)), rewrites: rewrites(answer.body), body: answer.body.replaceAll(pidText, '"pid":"<pid-self>"') },
      });
      return json;
    };
    const run = await makeScript({ post, calls, transport });
    return { label, ...run, wire: norm(wire), handleCalls: norm(calls) };
  } finally {
    await proxy?.close();
    await within('the channel transport stopping', transport.stop(), 30_000);
  }
}

const bySession = await session('same callId, two processes, one session', async ({ post }) => {
  const first = await post('/client/register', { leadPid: LEAD_A, passive: true }, 'register client 1 (lead pid 41001)');
  const second = await post('/client/register', { leadPid: LEAD_B, passive: true }, 'register client 2 (lead pid 41002)');
  const payload = { callId: 'shared-id', name: 'send_reply', args: { sessionId: 'same_session', text: 'hello' } };
  await post('/call', { ...payload, token: first.token }, 'call shared-id from client 1');
  await post('/call', { ...payload, token: second.token }, 'call shared-id from client 2');
  await post('/call', { ...payload, token: first.token }, 'retry shared-id from client 1 (same payload)');
  await post('/call', { ...payload, args: { sessionId: 'same_session', text: 'other' }, token: first.token }, 'client 1 reuses shared-id with another payload');
  return {};
});
const sameProcess = await session('same callId, two clients of the same process', async ({ post }) => {
  const first = await post('/client/register', { leadPid: LEAD_A, passive: true }, 'register client 1');
  const second = await post('/client/register', { leadPid: LEAD_A, passive: true }, 'register client 2 (same lead pid)');
  const payload = { callId: 'shared-id', name: 'send_reply', args: { sessionId: 'same_session', text: 'hello' } };
  await post('/call', { ...payload, token: first.token }, 'call shared-id from client 1');
  await post('/call', { ...payload, token: second.token }, 'call shared-id from client 2');
  return {};
});
const retries = await session('same callId resent by one client, then reused with another payload (case 95)', async ({ post }) => {
  const client = await post('/client/register', { leadPid: LEAD_A, passive: true }, 'register the client');
  const original = { token: client.token, callId: 'same-call', name: 'send_reply', args: { text: 'first' } };
  await post('/call', original, 'call same-call');
  await post('/call', original, 'resend the same payload');
  await post('/call', { ...original, args: { text: 'second' } }, 'reuse same-call with another payload');
  return {};
});
const noCallId = await session('no callId: every call runs', async ({ post }) => {
  const first = await post('/client/register', { leadPid: LEAD_A, passive: true }, 'register client');
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
      { name: 'channel retries reuse results only for the same payload (test line 95)', session: retries },
      { name: 'channel call ids belong to the calling process, not the addressed session (test line 110)', session: bySession },
      { name: 'further shapes (beyond the test file)', sessions: [sameProcess, noCallId] },
    ],
  },
  extra: {
    entry: { runs: 'createChannelTransport (channel-transport.mjs): its HTTP server, client registry, call dispatch (call-dispatch.mjs: callId idempotency cache keyed by caller owner and callId, rpc-call-identity.mjs) over real loopback fetch', notRun: 'the daemon behind handleCall (scripted: it returns {call: n}); the remote intent files (no remoteIntentPath is given)' },
    replay: "The `channel/call` request a client makes: DomainService::call (mixdog-services channels/service.rs:138) -> call_tool (:94; `req.op` is the callId) -> CallDispatch::dispatch (channels/call.rs:190, pub; cache keyed by owner + call id, CallIdConflict on a different payload). Replay: two connections with different owners send the same op, name and payload, then a retry, then a changed payload (and the case-95 shape with one client); compares per step the answer (result, or the ECALLIDCONFLICT error text) and the list of calls the bridge handler received (name, args, caller owner). The HTTP wire is not the Rust surface (WebSocket, protocol.md:854-865): the `wire` entries are what Node really sent and answered, captured at a TCP relay, for the replay author; `leadPid` maps to the connection's owner",
    exclusions: 'test case 38 (restore vs manual ON order) is not recorded: the Node test polls transport.activeCount and no event exists; 123 is pending branch gaps-memory-channels (benchmarks/rust-core/recorders/record-channel-remote-intent.mjs there); 161 and 191 are WebSocket / core stop concerns',
    normalised: { 'Content-Length': 'every Content-Length is the one Node sent for the real body; where a random token was written as its label the message carries `rewrites` {label: {originalLength, count}} (request and response body), so length(recorded body) + sum(count * (originalLength - label length)) = Content-Length. Request head lines are as sent except the x-mixdog-daemon-token value and Host port (label / <port>)',  'client tokens': 'random tokens written as <client-token-N> by order of registration', 'pids': 'the two clients use fixed lead pids 41001 and 41002 (not this machine\'s); the pid in the register answer is the recorder process\'s own, written "<pid-self>", and the one header that is not the one Node sent is the Content-Length of a register answer, which is the length of the recorded text (the digit count of the pid is machine-dependent)', port: 'not recorded (loopback ephemeral)', date: 'response Date header written as <date>' },
  },
});
process.exit(0);
