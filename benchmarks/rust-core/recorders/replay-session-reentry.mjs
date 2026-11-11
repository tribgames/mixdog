#!/usr/bin/env node
// Replay of native/core/fixtures/session-reentry-cases (record-session-reentry-cases.mjs, b6f10295a) on a built `mixdogd` through the
// desktop's protocol client (packages/protocol-client `connect`, `sessionReducer`, `sessionStateOf`: the transcript the desktop shows),
// over the core's real WebSocket listener. Six cases; the seventh (a replayed submission id) is the Rust test named in the manifest.
//
// What the user sees, per case:
// - an evicted session (reopen first true/false): the transcript after each step; leaving a session and coming back shows every row
//   written meanwhile, in order, from the first state shown (never an empty or shorter transcript first); a prompt sent to a session the
//   desktop had let go is answered; a later quiet moment makes the desktop read nothing more.
// - a delayed stored reply: a read the desktop started before a new turn, answered after it, leaves the new turn on screen.
// - cold refresh ticks: while a session's opening read is in flight the desktop sends no second read of it.
// - read tracing (result): a read held and released shows the stored answer.
// - read tracing (rejection): a read the core refuses reaches the caller as the core's own error, unchanged.
//
// Inputs: the core writes rows only through turns, so each recorded row the Node recorder wrote straight into the store or the old
// runtime ("old progress N", "persisted after leaving", "cold refresh", "stored answer", "private saved answer") is the answer of a turn
// whose prompt is a carrier listed in CARRIERS; a second client (`writer`, the old runtime) runs the turns the desktop did not.
// Compared after each step: `texts` (the desktop's user and assistant rows, carrier prompts left out: manifest `replay.normalised`).
// Declared in the manifest: Node's host bookkeeping (`serviceSize`, `storedReads`, `updateCount`, `lastUpdate.snapshot.projectionStamp`,
// `lastUpdate.frameSource`, `readTraceId`, the read-tracing sink's `records`, `performanceNow*`), the recorder's settings.
//   node replay-session-reentry.mjs --mixdogd <exe>
// The exit code is 1 on any difference.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, startCore, waitStore, within } from '../../../scripts/rust-core/lib/core-session.mjs';
import { fromExact as decodeExact } from './lib/exact.mjs';

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const bin = arg('--mixdogd');
if (!bin) throw new Error('--mixdogd <exe> is required');
const golden = JSON.parse(readFileSync(join(REPO_ROOT, 'native/core/fixtures/session-reentry-cases/golden.json'), 'utf8'));
const observed = (name) => decodeExact(golden.cases.find((entry) => entry.case === name).observed);
const MODEL = 'reentry-model';
const PROVIDER = 'custom-44444444-4444-4444-8444-444444444444';
const LIMIT = 60_000;
const READS = new Set(['thread/resume', 'thread/read', 'thread/items/list', 'thread/items/read', 'thread/turns/list']);

/** The carrier prompt of each row the recorder wrote without a turn, and its answer. */
const CARRIERS = {
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`progress ${i}`, `old progress ${i}`])),
  leave: 'persisted after leaving',
  cold: 'cold refresh',
  stored: 'stored answer',
  saved: 'private saved answer',
};
const ANSWERS = { ...CARRIERS, first: 'reply: first', next: 'reply: next', 'new turn': 'reply: new turn' };

/** The scripted OpenAI-chat provider: a request is answered by its last user message. */
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
      const text = ANSWERS[prompt] ?? `unscripted request: ${prompt.slice(0, 80)}`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const c of [chunk({ role: 'assistant', content: text }), chunk({}, 'stop'), '[DONE]']) res.write(`data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`);
      res.end();
    });
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ baseURL: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((c) => { server.closeAllConnections(); server.close(c); }) })));
}

const prov = await provider();
const root = mkdtempSync(join(tmpdir(), 'session-reentry-'));
const config = { agent: { compaction: { auto: false }, providers: { [PROVIDER]: { enabled: true, type: 'custom', name: 're', protocol: 'openai-chat', baseURL: prov.baseURL, auth: 'none', models: [{ id: MODEL, contextWindow: 1_000_000 }] } } } };
const core = await startCore({ bin: resolve(bin), root, config, clientName: 'session-reentry-writer' });
const opened = [];
try {
  const { default: WebSocket } = await import('ws');
  const lib = await import(pathToFileURL(join(REPO_ROOT, 'packages/protocol-client/src/index.ts')).href);
  const writer = core.client;

  /** The desktop: the protocol client over a socket whose outgoing reads this replay counts and can hold (a read in flight). */
  async function desktop(name) {
    const wire = { reads: [], hold: null, held: [], replies: [] };
    let socket = null;
    const client = await within(lib.connect({
      target: { id: 'local' },
      connector: { async open(_target, sink) {
        socket = new WebSocket(`ws://127.0.0.1:${core.discovery.core.rpc.port}/rpc`, { headers: { Authorization: `Bearer ${core.discovery.endpoints.session.token}` }, perMessageDeflate: false });
        return new Promise((done, fail) => {
          const send = (text) => {
            const message = JSON.parse(text);
            if (READS.has(message.method)) wire.reads.push(message.method);
            if (wire.hold && wire.hold === message.method) {
              wire.held.push(text);
              return void wire.onHeld?.();
            }
            socket.send(text);
          };
          socket.on('open', () => done({ send, close: (code, reason) => socket.close(code, reason) }));
          socket.on('message', (data) => {
            const text = data.toString('utf8');
            if (text.includes('"error"')) wire.replies.push(JSON.parse(text));
            sink.frame(text);
          });
          socket.on('close', (code, reason) => sink.closed(code, reason.toString('utf8')));
          socket.on('error', fail);
        });
      } },
      clientInfo: { name, title: name, version: String(JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version), kind: 'desktop' },
      capabilities: {},
      threadReducer: lib.sessionReducer,
      clock: { sleep: (ms) => Promise.reject(new Error(`${name} asked to sleep ${ms} ms (a reconnect backoff): its connection was lost`)) },
      random: Math.random,
    }), LIMIT, `${name} connecting`);
    opened.push(client);
    const release = () => {
      wire.hold = null;
      for (const text of wire.held.splice(0)) socket.send(text);
    };
    /** Holds the next request of `method` on its way out; resolves once it is held. */
    const holdNext = (method) => {
      wire.hold = method;
      return within(new Promise((done) => { wire.onHeld = done; }), LIMIT, `the ${method} request being sent`);
    };
    return { client, wire, release, holdNext };
  }

  const carrierPrompts = new Set(Object.keys(CARRIERS));
  /** The rows the desktop shows for `threadId`: its user and assistant rows, carrier prompts left out (manifest `replay.normalised`). */
  const texts = (client, threadId) => (lib.sessionStateOf(client, threadId)?.items ?? [])
    .filter((item) => (item.kind === 'user' && !carrierPrompts.has(item.text)) || item.kind === 'assistant')
    .map((item) => item.text);
  const idle = (client, threadId) => lib.sessionStateOf(client, threadId)?.busy === false;
  const shows = (client, threadId, want, what) => within(waitStore(client, () => (idle(client, threadId) && JSON.stringify(texts(client, threadId)) === JSON.stringify(want) ? true : undefined)), LIMIT, what)
    .catch((error) => { throw new Error(`${error.message}; shows ${JSON.stringify(texts(client, threadId))}, wanted ${JSON.stringify(want)}`); });
  const newThread = async (by) => (await within(by.call('thread/start', { kind: 'task', session: { toolMode: 'full', approvalMode: 'implicit', autoWakeCompletions: false, webSearch: false, memory: false }, projectPath: core.paths.workspace, draft: { projectPath: core.paths.workspace, route: { provider: PROVIDER, model: MODEL }, orchestrationMode: 'none' } }), LIMIT, 'thread/start')).thread.id;
  const turn = (by, threadId, prompt) => within(by.call('turn/start', { threadId, input: { prompt, options: {} } }), LIMIT, `the turn "${prompt}"`);
  /** A turn of the writer (the old runtime), awaited to its stored answer through the writer's own view. */
  async function written(threadId, prompt) {
    await within(writer.resumeThread(threadId, { lastItems: 50 }), LIMIT, 'the writer watching');
    const before = texts(writer, threadId).length;
    await turn(writer, threadId, prompt);
    await within(waitStore(writer, () => (idle(writer, threadId) && texts(writer, threadId).length > before && texts(writer, threadId).at(-1) === CARRIERS[prompt] ? true : undefined)), LIMIT, `the writer's turn "${prompt}"`);
    await within(writer.unsubscribeThread(threadId), LIMIT, 'the writer leaving');
  }
  const step = (record, name) => record.steps.find((entry) => entry.step === name);

  for (const reopenFirst of [true, false]) {
    const name = `an evicted session delivers new prompts and replies (reopen first: ${reopenFirst})`;
    const rec = observed(name);
    const { client: a, wire } = await desktop(`reentry-${reopenFirst}`);
    const threadId = await newThread(a);
    await within(a.resumeThread(threadId, { lastItems: 50 }), LIMIT, 'showing the session');
    await turn(a, threadId, 'first');
    await shows(a, threadId, step(rec, 'first submitted').texts, 'first submitted');
    for (let i = 0; i < 12; i++) {
      await turn(a, threadId, `progress ${i}`);
      await shows(a, threadId, step(rec, 'first submitted').texts.concat(Array.from({ length: i + 1 }, (_, n) => `old progress ${n}`)), `progress ${i}`);
    }
    assert.deepStrictEqual(texts(a, threadId), step(rec, 'old runtime advanced 12 rows (tick 20 ms each)').texts, `${name}: the old runtime's rows`);
    const left = texts(a, threadId);
    await within(a.unsubscribeThread(threadId), LIMIT, 'hiding the session');
    assert.deepStrictEqual(left, step(rec, 'hidden, 10 s tick, evict sweep drained').texts, `${name}: what the hidden session last showed`);
    await written(threadId, 'leave');
    if (reopenFirst) {
      const shown = [];
      const unseen = a.store.subscribe(() => {
        const now = texts(a, threadId);
        if (lib.sessionStateOf(a, threadId) && JSON.stringify(now) !== JSON.stringify(shown.at(-1))) shown.push(now);
      });
      await within(a.resumeThread(threadId, { lastItems: 50 }), LIMIT, 'reopening the session');
      // The snapshot folds in budgeted steps after the reply: every state until it shows the stored view is kept.
      await shows(a, threadId, step(rec, 'reopened (stored view)').texts, 'the reopened session');
      unseen();
      assert.deepStrictEqual(shown, [step(rec, 'reopened (stored view)').texts], `${name}: every transcript shown on re-entry`);
      await written(threadId, 'cold');
      await shows(a, threadId, step(rec, 'cold refresh tick').texts, 'the row written while shown');
    } else {
      await turn(a, threadId, 'next');
      await within(a.resumeThread(threadId, { lastItems: 50 }), LIMIT, 'showing the session after the prompt');
    }
    if (reopenFirst) await turn(a, threadId, 'next');
    const next = step(rec, 'next submitted');
    await shows(a, threadId, next.texts, 'next submitted');
    assert.deepStrictEqual(texts(a, threadId).slice(-2), next.lastTwo, `${name}: the last two rows`);
    const reads = wire.reads.length;
    const quiet = step(rec, '1 s tick after live publication');
    assert.deepStrictEqual({ texts: texts(a, threadId), readsUnchanged: wire.reads.length === reads }, { texts: quiet.texts, readsUnchanged: quiet.readsUnchanged }, `${name}: after the live publication`);
    console.log(`${name}: replayed`);
  }

  {
    const name = 'a delayed stored reply cannot overwrite a newly materialized turn';
    const rec = observed(name);
    const threadId = await newThread(writer);
    await written(threadId, 'stored');
    const { client: a, release, holdNext } = await desktop('reentry-delayed');
    await within(a.resumeThread(threadId, { lastItems: 50 }), LIMIT, 'opening the stored session');
    await shows(a, threadId, step(rec, 'opened with a stored answer').texts, 'opened with a stored answer');
    const holding = holdNext('thread/items/list');
    const read = a.call('thread/items/list', { threadId, limit: 50 });
    await holding;
    assert.deepStrictEqual(texts(a, threadId), step(rec, 'prefetch read held').texts, `${name}: while the read is held`);
    await turn(a, threadId, 'new turn');
    await shows(a, threadId, step(rec, 'new turn submitted while the read is held').texts, 'the new turn while the read is held');
    release();
    await within(read, LIMIT, 'the held read');
    const done = step(rec, 'read released');
    assert.deepStrictEqual({ texts: texts(a, threadId), lastTwo: texts(a, threadId).slice(-2) }, { texts: done.texts, lastTwo: done.lastTwo }, `${name}: after the read is released`);
    console.log(`${name}: replayed`);
  }

  {
    const name = 'cold refresh ticks do not stack reads while that session is still loading';
    const rec = observed(name);
    const threadId = await newThread(writer);
    await written(threadId, 'stored');
    const { client: a, wire, release, holdNext } = await desktop('reentry-cold');
    const holding = holdNext('thread/resume');
    const opening = a.resumeThread(threadId, { lastItems: 50 });
    await holding;
    const held = step(rec, '1 s tick, read held, 5 s more ticks');
    assert.deepStrictEqual(wire.reads.length, held.readsSinceOpen, `${name}: reads while the opening read is held`);
    release();
    await within(opening, LIMIT, 'the opening read');
    const settled = step(rec, 'read settled, 1 s tick');
    await shows(a, threadId, settled.texts, 'the stored answer after the opening read');
    assert.deepStrictEqual({ texts: texts(a, threadId), readsSinceOpen: wire.reads.length }, { texts: settled.texts, readsSinceOpen: settled.readsSinceOpen }, `${name}: after the read settles`);
    console.log(`${name}: replayed`);
  }

  {
    const name = 'read tracing measures a held host read and propagates its correlation without changing the result';
    const rec = observed(name);
    const threadId = await newThread(writer);
    await written(threadId, 'saved');
    const { client: a, release, holdNext } = await desktop('reentry-traced');
    const holding = holdNext('thread/resume');
    const opening = a.resumeThread(threadId, { lastItems: 50 });
    await holding;
    release();
    await within(opening, LIMIT, 'the held read');
    await shows(a, threadId, rec.texts, 'the stored answer after the held read');
    assert.deepStrictEqual({ result: true, texts: texts(a, threadId) }, { result: rec.result, texts: rec.texts }, name);
    console.log(`${name}: replayed`);
  }

  {
    const name = 'a traced host read preserves its original rejection';
    const rec = observed(name);
    const { client: a, wire } = await desktop('reentry-refused');
    const refused = await a.resumeThread('thr_missing_session', { lastItems: 50 }).then(() => null, (error) => error);
    assert.ok(refused, `${name}: the read of a session the store does not hold must fail`);
    const sent = wire.replies.at(-1)?.error;
    assert.deepStrictEqual({ rejected: refused instanceof Error, sameErrorObject: refused.message === sent?.message || String(refused.message).includes(sent?.message) },
      { rejected: rec.outcome.rejected instanceof Error, sameErrorObject: rec.outcome.sameErrorObject }, `${name}: the caller gets the core's own error (${refused.message} / ${sent?.message})`);
    console.log(`${name}: replayed`);
  }
} finally {
  for (const client of opened) await client.close().catch(() => {});
  await core.stop();
  await prov.close();
}
