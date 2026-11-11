#!/usr/bin/env node
// Replay of native/core/fixtures/session-lane-backlog-cases (record-session-lane-backlog-cases.mjs, b6f10295a) on a built `mixdogd`
// through the desktop's protocol client (packages/protocol-client: `connect`, `sessionReducer`, `sessionStateOf`, the state the
// desktop main publishes), over the core's real WebSocket listener.
//
// What the user sees: a session whose stream is backed up (the client has not taken a 300 000-character row yet) still gets the
// next row once it takes its frames, in order, and the desktop shows both; another client of the same session is not held up by it.
// Node's recording: an SSE response whose attach write back-pressured; the opened snapshot (row `a`, 300 000 characters, title
// `open`) and a live one (`a`, `b` "live") were published while it was backed up; after the drain the decoder applied both.
//
// Here: client A watches the thread and stops reading its socket (`ws` pause: the core's frames stay unread). The thread gets its
// title, then a 300 000-character row, then the live row, each the answer of a turn (the core writes a row only for a turn; the
// scripted provider answers them). Client B watches the same thread and reads: its turns complete while A is backed up. Then A
// reads again and its state must show what Node's decoder showed after each publication: `decoded[i].snapshot` against A's
// desktop state when it holds that publication's rows. Compared: `ok`, the title, the rows' text in order (the recorded snapshot's
// `items`), `streamingTail`. Declared in the manifest (`replay.normalised`): the turns' prompt rows, the item ids, `writes*`
// (Node's SSE writes), `maxPendingBytes` (compared with the core's ordered-lane room instead).
//   node replay-session-lane-backlog.mjs --mixdogd <exe>
// The exit code is 1 on any difference.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPO_ROOT, startCore, waitStore, within } from '../../../scripts/rust-core/lib/core-session.mjs';
import { fromExact as decodeExact } from './lib/exact.mjs';

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const bin = arg('--mixdogd');
if (!bin) throw new Error('--mixdogd <exe> is required');
const NAME = 'a backed-up session stream still delivers a lane the desktop decoder can apply';
const golden = JSON.parse(readFileSync(join(REPO_ROOT, 'native/core/fixtures/session-lane-backlog-cases/golden.json'), 'utf8'));
const recorded = decodeExact(golden.cases.find((entry) => entry.case === NAME).observed);
const MODEL = 'lane-backlog-model';
const PROVIDER = 'custom-22222222-2222-4222-8222-222222222222';
const LIMIT = Number(process.env.LB_LIMIT) || 60_000;

/** The scripted OpenAI-chat provider: a model request whose last user message is a key of `replies` is answered with its value
 * (the core may ask the model for other things, a title among them, in between). */
function provider(replies) {
  let n = 0;
  const chunk = (delta, finish = null) => ({ id: 's', object: 'chat.completion.chunk', created: 0, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] });
  const server = createServer((req, res) => {
    const parts = [];
    req.on('data', (part) => parts.push(part));
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }));
      }
      n++;
      const users = (JSON.parse(Buffer.concat(parts).toString('utf8')).messages ?? []).filter((m) => m.role === 'user');
      const last = users.at(-1)?.content;
      const prompt = typeof last === 'string' ? last : Array.isArray(last) ? last.map((part) => part.text ?? '').join('') : '';
      const text = Object.entries(replies).find(([key]) => prompt.trim() === key)?.[1] ?? 'unscripted request';      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const c of [chunk({ role: 'assistant', content: text }), chunk({}, 'stop'), '[DONE]']) res.write(`data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`);
      res.end();
    });
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ count: () => n, baseURL: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((c) => { server.closeAllConnections(); server.close(c); }) })));
}

const opened = recorded.decoded[0].snapshot;
const live = recorded.decoded[1].snapshot;
const prov = await provider({ open: opened.items[0].text, live: live.items[1].text });
const root = mkdtempSync(join(tmpdir(), 'lane-backlog-'));
// Compaction is off: the 300 000-character row would otherwise make the core summarise before the live turn, which Node's
// recording (two publications, no turn) has no part in.
const config = { agent: { compaction: { auto: false }, providers: { [PROVIDER]: { enabled: true, type: 'custom', name: 'lb', protocol: 'openai-chat', baseURL: prov.baseURL, auth: 'none', models: [{ id: MODEL, contextWindow: 1_000_000 }] } } } };
const core = await startCore({ bin: resolve(bin), root, config, clientName: 'lane-backlog-b' });
let a = null;
try {
  const { default: WebSocket } = await import('ws');
  const lib = await import(pathToFileURL(join(REPO_ROOT, 'packages/protocol-client/src/index.ts')).href);
  // Client A: the desktop's client over a socket this replay can stop reading (`pause`), as the backed-up SSE response did.
  let socket = null;
  a = await within(lib.connect({
    target: { id: 'local' },
    connector: { async open(_target, sink) {
      socket = new WebSocket(`ws://127.0.0.1:${core.discovery.core.rpc.port}/rpc`, { headers: { Authorization: `Bearer ${core.discovery.endpoints.session.token}` }, perMessageDeflate: false });
      return new Promise((done, fail) => {
        socket.on('open', () => done({ send: (text) => socket.send(text), close: (code, reason) => socket.close(code, reason) }));
        socket.on('message', (data) => sink.frame(data.toString('utf8')));
        socket.on('close', (code, reason) => { console.error(`client A closed ${code} ${reason} at ${Date.now()}`); sink.closed(code, reason.toString('utf8')); });
        socket.on('error', fail);
      });
    } },
    clientInfo: { name: 'lane-backlog-a', title: 'lane-backlog-a', version: String(JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version), kind: 'desktop' },
    capabilities: {},
    threadReducer: lib.sessionReducer,
    clock: { sleep: (ms) => Promise.reject(new Error(`client A asked to sleep ${ms} ms (a reconnect backoff): its connection was lost`)) },
    random: Math.random,
  }), LIMIT, 'client A connecting');
  const b = core.client;
  const started = await within(b.call('thread/start', { kind: 'task', session: { toolMode: 'full', approvalMode: 'implicit', autoWakeCompletions: false, webSearch: false, memory: false }, projectPath: core.paths.workspace, draft: { projectPath: core.paths.workspace, route: { provider: PROVIDER, model: MODEL }, orchestrationMode: 'none' } }), LIMIT, 'thread/start');
  const threadId = started.thread.id;
  await within(a.resumeThread(threadId, { lastItems: 10 }), LIMIT, 'client A watching the thread');
  await within(b.resumeThread(threadId, { lastItems: 10 }), LIMIT, 'client B watching the thread');
  if (!process.env.LB_NOPAUSE) socket.pause();
  const assistantTexts = (client) => (lib.sessionStateOf(client, threadId)?.items ?? []).filter((item) => item.kind === 'assistant').map((item) => item.text);
  const turnDone = (count) => waitStore(b, () => (assistantTexts(b).length >= count && lib.sessionStateOf(b, threadId)?.busy === false ? true : undefined));
  await within(b.call('thread/name/set', { threadId, title: opened.title }), LIMIT, 'thread/name/set');
  const t0 = Date.now();
  await within(b.call('turn/start', { threadId, input: { prompt: 'open', options: {} } }), LIMIT, 'the opening turn');
  await within(turnDone(1), LIMIT, 'client B seeing the 300 000-character row while client A is backed up').catch(async (error) => {
    const s = lib.sessionStateOf(b, threadId);
    const stored = await b.call('thread/items/list', { threadId, limit: 20 }).catch((e) => ({ error: e.message }));
    console.error(JSON.stringify(stored, (k, v) => (typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}…(${v.length})` : v)).slice(0, 4000));
    throw new Error(`${error.message}; client B shows busy=${s?.busy} rows=${JSON.stringify((s?.items ?? []).map((item) => [item.kind, String(item.text ?? '').slice(0, 80)]))}; provider requests ${prov.count()}; fields ${JSON.stringify(Object.keys(s ?? {}))} lastError=${JSON.stringify(s?.lastError ?? s?.error ?? null)}\n${core.tail()}`);
  });
  await within(b.call('turn/start', { threadId, input: { prompt: 'live', options: {} } }), LIMIT, 'the live turn');
  console.error(`turn 1 done at ${Date.now() - t0} ms (${Date.now()})`);
  await within(turnDone(2), LIMIT, 'client B seeing the live row while client A is backed up').catch(async (error) => {
    const s = lib.sessionStateOf(b, threadId);
    const stored = await b.call('thread/items/list', { threadId, limit: 20 }).catch((e) => ({ error: e.message }));
    console.error(JSON.stringify(stored, (k, v) => (typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}…(${v.length})` : v)).slice(0, 3000));
    throw new Error(`${error.message}; busy=${s?.busy} rows=${JSON.stringify((s?.items ?? []).map((item) => [item.kind, String(item.text ?? '').slice(0, 40)]))}; provider requests ${prov.count()}; tail=${JSON.stringify(s?.streamingTail)?.slice(0, 300)} hint=${JSON.stringify(s?.progressHint)} status=${JSON.stringify(s?.commandStatus)}\n${core.tail()}`);
  });
  const shown = (client) => {
    const state = lib.sessionStateOf(client, threadId);
    return { ok: true, title: state?.desktopSessionTitle, texts: assistantTexts(client), streamingTail: state?.streamingTail };
  };
  // A has taken nothing since the pause: its state still holds no row.
  const backedUp = shown(a);
  assert.deepStrictEqual(backedUp.texts, [], 'client A took no frame while paused');
  const seen = [];
  const unseen = a.store.subscribe(() => {
    const now = shown(a);
    if (now.texts.length > (seen.at(-1)?.texts.length ?? 0)) seen.push(now);
  });
  socket.resume();
  await within(waitStore(a, () => (assistantTexts(a).length >= 2 ? true : undefined)), LIMIT, 'client A taking its backed-up frames');
  unseen();
  const expected = recorded.decoded.map((entry) => ({ ok: entry.ok, title: entry.snapshot.title, texts: entry.snapshot.items.map((item) => item.text), streamingTail: entry.snapshot.streamingTail ?? null }));
  const brief = (list) => JSON.stringify(list.map((entry) => ({ ...entry, texts: entry.texts.map((text) => `${text.slice(0, 12)}…(${text.length})`) })));
  assert.deepStrictEqual(seen.map((entry) => ({ ...entry, streamingTail: entry.streamingTail ?? null })), expected, `what client A shows after each publication: ${brief(seen)} against ${brief(expected)}`);
  assert.deepStrictEqual(shown(b).texts, expected.at(-1).texts, 'client B shows the same rows');
  console.log(`${NAME}: replayed (${seen.length} publications)`);
} finally {
  await a?.close().catch(() => {});
  await core.stop();
  await prov.close();
}
