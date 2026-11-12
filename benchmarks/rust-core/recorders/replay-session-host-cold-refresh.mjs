#!/usr/bin/env node
// Replay of native/core/fixtures/session-host-cold-refresh-cases (record-session-host-cold-refresh-cases.mjs, b6f10295a) on a built
// `mixdogd` through the desktop's protocol client (packages/protocol-client `connect`, `sessionReducer`, `sessionStateOf`), over the
// core's real WebSocket listener.
//
// What the user sees: six sessions open in the desktop, each showing its stored row; while nothing is written none of them changes;
// when one is written, that one shows the new row and no other session changes. Node's desktop learns of the write by re-reading the
// store on a refresh tick; the core pushes the write to the watching desktop, so the desktop reads each session once (when it opens
// it) and never again (compared: `openReads`, and no read after it).
//
// Inputs: the core writes rows only through turns, so each recorded stored row (`sess_cold_<i>:1`, then `sess_cold_2:2`) is the answer
// of a turn of a second client (the writer) whose carrier prompt is the row's name with `write ` in front (manifest `replay.normalised`).
//   node replay-session-host-cold-refresh.mjs --mixdogd <exe>
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, startCore, waitStore, within } from '../../../scripts/rust-core/lib/core-session.mjs';

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const bin = arg('--mixdogd');
if (!bin) throw new Error('--mixdogd <exe> is required');
const NAME = 'the cold-view refresh skips unchanged sessions and refreshes a written one';
const golden = JSON.parse(readFileSync(join(REPO_ROOT, 'native/core/fixtures/session-host-cold-refresh-cases/golden.json'), 'utf8'));
const recorded = golden.cases.find((entry) => entry.case === NAME).observed;
const MODEL = 'cold-refresh-model';
const PROVIDER = 'custom-55555555-5555-4555-8555-555555555555';
const LIMIT = 60_000;
const READS = new Set(['thread/resume', 'thread/read', 'thread/items/list', 'thread/items/read', 'thread/turns/list']);

/** The scripted OpenAI-chat provider: `write <row>` is answered with `<row>`. */
function provider() {
  const chunk = (delta, finish = null) => ({ id: 's', object: 'chat.completion.chunk', created: 0, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] });
  const server = createServer((req, res) => {
    const parts = [];
    req.on('data', (part) => parts.push(part));
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }));
      }
      const users = (JSON.parse(Buffer.concat(parts).toString('utf8')).messages ?? []).filter((m) => m.role === 'user');
      const last = users.at(-1)?.content;
      const prompt = (typeof last === 'string' ? last : Array.isArray(last) ? last.map((part) => part.text ?? '').join('') : '').trim();
      // The core may append a system reminder to the user's message: the prompt is its first line.
      const line = prompt.split('\n')[0];
      const text = line.startsWith('write ') ? line.slice('write '.length) : `unscripted request: ${prompt.slice(0, 80)}`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const c of [chunk({ role: 'assistant', content: text }), chunk({}, 'stop'), '[DONE]']) res.write(`data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`);
      res.end();
    });
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ baseURL: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((c) => { server.closeAllConnections(); server.close(c); }) })));
}

const prov = await provider();
const root = mkdtempSync(join(tmpdir(), 'cold-refresh-'));
const config = { agent: { compaction: { auto: false }, providers: { [PROVIDER]: { enabled: true, type: 'custom', name: 'cr', protocol: 'openai-chat', baseURL: prov.baseURL, auth: 'none', models: [{ id: MODEL, contextWindow: 1_000_000 }] } } } };
const core = await startCore({ bin: resolve(bin), root, config, clientName: 'cold-refresh-writer' });
let a = null;
try {
  const { default: WebSocket } = await import('ws');
  const lib = await import(pathToFileURL(join(REPO_ROOT, 'packages/protocol-client/src/index.ts')).href);
  const writer = core.client;
  const rows = (client, threadId) => (lib.sessionStateOf(client, threadId)?.items ?? []).filter((item) => item.kind === 'assistant').map((item) => item.text);
  const idle = (client, threadId) => lib.sessionStateOf(client, threadId)?.busy === false;
  /** The writer's turn that stores `row` in `threadId`, awaited to its stored answer through the writer's own view. */
  async function write(threadId, row) {
    await within(writer.resumeThread(threadId, { lastItems: 10 }), LIMIT, 'the writer watching');
    await within(writer.call('turn/start', { threadId, input: { prompt: `write ${row}`, options: {} } }), LIMIT, `writing ${row}`);
    await within(waitStore(writer, () => (idle(writer, threadId) && rows(writer, threadId).at(-1) === row ? true : undefined)), LIMIT, `the stored ${row}`)
      .catch((error) => { throw new Error(`${error.message}; the writer shows ${JSON.stringify(lib.sessionStateOf(writer, threadId)?.items?.map((item) => [item.kind, item.text]))} busy=${lib.sessionStateOf(writer, threadId)?.busy}`); });
    await within(writer.unsubscribeThread(threadId), LIMIT, 'the writer leaving');
  }

  // The six sessions, each with its stored row, written before the desktop opens them.
  const ids = new Map();
  for (const session of recorded.sessions) {
    const started = await within(writer.call('thread/start', { kind: 'task', session: { toolMode: 'full', approvalMode: 'implicit', autoWakeCompletions: false, webSearch: false, memory: false }, projectPath: core.paths.workspace, draft: { projectPath: core.paths.workspace, route: { provider: PROVIDER, model: MODEL }, orchestrationMode: 'none' } }), LIMIT, 'thread/start');
    ids.set(session, started.thread.id);
    await write(started.thread.id, `${session}:1`);
  }
  const sessionOf = new Map([...ids].map(([session, id]) => [id, session]));

  // The desktop's clock is the replay's: its only sleeper is the reconnect backoff (packages/protocol-client client.ts, `clock.sleep`), and
  // time moves only by `advance`. Node's refresh tick was 1 000 ms (`COLD_VIEW_REFRESH_MS`, session-host-catalog.ts:8); a client that arms any
  // timer on this clock, a refresh tick or a backoff after a lost connection, is seen in `sleeps`.
  const sleeps = [];
  let virtualNow = 0;
  const clock = { sleep: (ms) => new Promise((wake) => sleeps.push({ at: virtualNow + ms, ms, wake })) };
  // The client's only other scheduler is `turn.yieldTurn` (client.ts: a `setImmediate` / `setTimeout(0)` that gives the thread back to
  // a long fold, nowhere else does the package arm a timer): it is the replay's, so every timer the client can arm is seen, in `sleeps`
  // or in `yields`.
  const yields = [];
  const turn = { yieldTurn: () => new Promise((wake) => { yields.push(virtualNow); setImmediate(wake); }) };
  const advance = (ms) => {
    virtualNow += ms;
    for (const sleeper of sleeps) if (sleeper.at <= virtualNow) sleeper.wake();
  };
  // The desktop, its outgoing reads named by the session they read.
  const reads = [];
  a = await within(lib.connect({
    target: { id: 'local' },
    connector: { async open(_target, sink) {
      const socket = new WebSocket(`ws://127.0.0.1:${core.discovery.core.rpc.port}/rpc`, { headers: { Authorization: `Bearer ${core.discovery.endpoints.session.token}` }, perMessageDeflate: false });
      return new Promise((done, fail) => {
        const send = (text) => {
          const message = JSON.parse(text);
          if (READS.has(message.method)) reads.push(sessionOf.get(message.params?.threadId) ?? message.params?.threadId);
          socket.send(text);
        };
        socket.on('open', () => done({ send, close: (code, reason) => socket.close(code, reason) }));
        socket.on('message', (data) => sink.frame(data.toString('utf8')));
        socket.on('close', (code, reason) => sink.closed(code, reason.toString('utf8')));
        socket.on('error', fail);
      });
    } },
    clientInfo: { name: 'cold-refresh-desktop', title: 'cold-refresh-desktop', version: String(JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version), kind: 'desktop' },
    capabilities: {},
    threadReducer: lib.sessionReducer,
    clock,
    turn,
    random: Math.random,
  }), LIMIT, 'the desktop connecting');
  for (const [session, id] of ids) {
    await within(a.resumeThread(id, { lastItems: 10 }), LIMIT, `opening ${session}`);
    // Opened: the stored turn shown whole, its end divider included.
    await within(waitStore(a, () => (rows(a, id).length === 1 && lib.sessionStateOf(a, id)?.items?.at(-1)?.kind === 'turndone' ? true : undefined)), LIMIT, `${session} showing its stored row`);
  }
  const shownStamps = recorded.sessions.map((session) => rows(a, ids.get(session)).join(''));
  const openReads = reads.splice(0);

  // Every change of what a session shows from here on, by session: the fields Node's published snapshot carries (its rows, by kind
  // and text, and its queue). The core's own state fields (token stats, the user's prompt history, which the writer's carrier
  // prompts feed) are declared in the manifest.
  const shown = (id) => {
    const state = lib.sessionStateOf(a, id);
    return JSON.stringify({ rows: (state?.items ?? []).map((item) => [item.kind, item.text ?? null]), queued: state?.queued ?? [] });
  };
  const states = new Map([...ids].map(([session, id]) => [session, shown(id)]));
  const published = [];
  const unseen = a.store.subscribe(() => {
    for (const [session, id] of ids) {
      const now = shown(id);
      if (now !== states.get(session)) {
        states.set(session, now);
        published.push(session);
      }
    }
  });
  // The three ticks Node's refresh ran while nothing was written: the clock is advanced explicitly by one tick each, and after each the
  // desktop has armed no timer, sent no read and shows no change.
  yields.length = 0;
  for (let tick = 1; tick <= 3; tick += 1) {
    advance(1_000);
    assert.deepStrictEqual({ armedTimers: sleeps.length + yields.length, reads: reads.slice(), published: published.slice() }, { armedTimers: 0, reads: [], published: [] }, `after tick ${tick} of an unchanged desktop`);
  }
  const unchanged = { readsAfterThreeTicks: reads.slice(), published: published.slice() };
  const written = recorded.writtenSession;
  await write(ids.get(written), `${written}:2`);
  await within(waitStore(a, () => (rows(a, ids.get(written)).at(-1) === `${written}:2` && idle(a, ids.get(written)) ? true : undefined)), LIMIT, `the desktop showing ${written}'s new row`);
  unseen();
  const rust = {
    sessions: [...ids.keys()],
    initialStamps: shownStamps,
    openReads,
    unchanged,
    writtenSession: written,
    written: { publishedSessions: [...new Set(published)], lastRow: rows(a, ids.get(written)).at(-1) },
    readsAfterOpen: reads,
  };
  const node = {
    sessions: recorded.sessions,
    initialStamps: recorded.initialStamps,
    openReads: recorded.openReads,
    unchanged: recorded.unchanged,
    writtenSession: written,
    written: { publishedSessions: recorded.written.published.map((entry) => entry.sessionId), lastRow: recorded.written.published.at(-1).snapshot.items.at(-1).text },
    // Node re-reads the written session on its refresh ticks (`written.reads`, `readsAfterNextTick`); the core pushes the write, so the desktop reads nothing more.
    readsAfterOpen: [],
  };
  assert.deepStrictEqual(rust, node, NAME);
  console.log(`${NAME}: replayed`);
} finally {
  await a?.close().catch(() => {});
  await core.stop();
  await prov.close();
}
