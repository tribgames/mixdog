// The TUI session view over `@mixdog/protocol-client`, driven by a scripted core on the client's mock transport.
// Display assertions are made on the text frames Ink paints from the view's state (the same `Item` rows the TUI
// draws); wire assertions are made on the frames the core receives.
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { build } from 'esbuild';
import React from 'react';
import { connect, sessionReducer, sessionStateOf, uuidv7 } from '../../../packages/protocol-client/src/index.ts';
import { SESSION_ACTIONS, resolveAction } from '../../../packages/protocol-client/src/actions/action-route.mjs';
import { createProtocolSessionFactory } from './session.mjs';
import { Reply, ScriptedCore } from './scripted-core.fixture.mjs';

const CLIENT_INFO = { name: 'mixdog-tui', title: 'Mixdog TUI', version: '1.4.6', kind: 'tui' };

let directory;
let Item;
let useSession;
let ink;

before(async () => {
  ink = await import('ink');
  directory = mkdtempSync(resolve('.tmp-protocol-session-test-'));
  const output = join(directory, 'view.mjs');
  await build({
    stdin: {
      contents: `
        export { Item } from './TranscriptItem.jsx';
        export { useSession } from '../hooks/useSession.mjs';
      `,
      resolveDir: resolve('src/tui/components'),
      loader: 'jsx',
    },
    outfile: output,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
  });
  ({ Item, useSession } = await import(pathToFileURL(output).href));
});

after(() => rmSync(directory, { recursive: true, force: true }));

/** Paints `store.getState()` the way the transcript does: one `Item` per row, then the live streaming tail. */
function mountTranscript(context, store, columns = 60) {
  const stdout = new PassThrough();
  stdout.columns = columns;
  stdout.rows = 30;
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  let frame = '';
  const write = stdout.write.bind(stdout);
  stdout.write = (chunk, ...args) => {
    frame = String(chunk);
    return write(chunk, ...args);
  };
  function Transcript() {
    const state = useSession(store);
    const rows = (state.items ?? []).map((item, index) =>
      React.createElement(Item, { key: item.id, item, prevKind: state.items[index - 1]?.kind, columns })
    );
    if (state.streamingTail) {
      rows.push(
        React.createElement(Item, { key: 'tail', item: state.streamingTail, prevKind: state.items.at(-1)?.kind, columns })
      );
    }
    if (state.busy) rows.push(React.createElement(ink.Text, { key: 'busy' }, '[working]'));
    return React.createElement(ink.Box, { flexDirection: 'column' }, ...rows);
  }
  const view = ink.render(React.createElement(Transcript), {
    stdout,
    stdin,
    stderr: stdout,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  context.after(() => {
    view.unmount();
    stdin.end();
    stdout.end();
  });
  return async () => {
    await new Promise((done) => setTimeout(done, 80));
    return stripVTControlCharacters(frame).trimEnd();
  };
}

async function open(context, { handlers, options = {}, factory = {}, seed } = {}) {
  const core = new ScriptedCore({ handlers });
  seed?.(core);
  const createSession = createProtocolSessionFactory({
    connect,
    connector: core.net,
    ensureCore: async () => ({}),
    threadReducer: sessionReducer,
    stateOf: sessionStateOf,
    clientInfo: CLIENT_INFO,
    clock: { sleep: () => Promise.resolve() },
    random: () => 0.5,
    newOpId: () => uuidv7(Date.now()),
    ...factory,
  });
  const store = await createSession({ cwd: '/work', ...options });
  context.after(() => store.dispose());
  return { core, store };
}

const settle = () => new Promise((done) => setTimeout(done, 20));
const userItem = (id, text) => ({ type: 'userMessage', id, content: [{ type: 'text', text }] });
const busy = (on) => ({ value: { busy: on } });

test('opens a project thread at the working directory and follows its feed with the live window', async (context) => {
  const { core, store } = await open(context, { options: { provider: 'openai', model: 'gpt-5', toolMode: 'readonly' } });
  assert.deepEqual(core.methods(), ['initialize', 'thread/start', 'thread/setToolMode', 'thread/resume']);
  const [start] = core.request('thread/start');
  assert.equal(start.params.kind, 'project');
  assert.equal(start.params.projectPath, '/work');
  assert.deepEqual(start.params.draft, { route: { provider: 'openai', model: 'gpt-5' } });
  assert.match(start.params.opId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(core.request('thread/setToolMode')[0].params, {
    threadId: 't1',
    mode: 'readonly',
    opId: core.request('thread/setToolMode')[0].params.opId,
  });
  assert.deepEqual(core.request('thread/resume')[0].params, { threadId: 't1', window: { lastItems: 512 } });
  assert.equal(store.isRemoteSession, true);
  assert.equal(store.getState().sessionId, 't1');
  assert.equal(store.getState().cwd, '/work');
});

test('a transcript the core already holds is painted from the resume snapshot', async (context) => {
  const { store } = await open(context, {
    seed: (core) =>
      core.thread('t1').items.push(
        userItem('u0', 'what is in this repo'),
        { type: 'agentMessage', id: 'a0', text: 'A Rust workspace.' }
      ),
  });
  const text = await mountTranscript(context, store)();
  assert.match(text, /what is in this repo/);
  assert.match(text, /A Rust workspace\./);
  assert.ok(text.indexOf('what is in this repo') < text.indexOf('A Rust workspace.'));
});

test('submit sends turn/start with the submission identity and the transcript repaints as the turn streams', async (context) => {
  const { core, store } = await open(context);
  const frame = mountTranscript(context, store);
  assert.equal(await frame(), '');

  assert.equal(store.submit('hello there', { id: 'sub-1', displayText: 'hello there', priority: 'next' }), true);
  await settle();
  const [turn] = core.request('turn/start');
  assert.equal(turn.params.threadId, 't1');
  assert.deepEqual(turn.params.input, {
    prompt: 'hello there',
    options: { displayText: 'hello there', priority: 'next', clientSubmissionId: 'sub-1' },
  });

  core.emit('t1', 'thread/runtime/updated', busy(true));
  core.emit('t1', 'item/completed', { item: userItem('u1', 'hello there') });
  core.emit('t1', 'item/started', { item: { type: 'agentMessage', id: 'a1', text: '' } });
  core.emit('t1', 'item/agentMessage/delta', { itemId: 'a1', delta: 'Hi, I can help.\nand then I' });
  const streaming = await frame();
  assert.match(streaming, /hello there[\s\S]*Hi, I can help\./);
  assert.match(streaming, /\[working\]/);
  // The terminal paints completed lines only; the unfinished line is the desktop's.
  assert.doesNotMatch(streaming, /and then I/);

  core.emit('t1', 'item/completed', { item: { type: 'agentMessage', id: 'a1', text: 'Hi, I can help.\nand then I am done.' } });
  core.emit('t1', 'thread/runtime/updated', busy(false));
  const done = await frame();
  assert.match(done, /hello there/);
  assert.match(done, /and then I am done\./);
  assert.equal(done.split('Hi, I can help.').length - 1, 1);
  assert.doesNotMatch(done, /\[working\]/);
});

test('the terminal view never holds the desktop-only streaming field, and its state is stable between changes', async (context) => {
  const { core, store } = await open(context);
  const changes = [];
  const stop = store.subscribe(() => changes.push(store.getState()));
  core.emit('t1', 'item/started', { item: { type: 'agentMessage', id: 'a1', text: '' } });
  core.emit('t1', 'item/agentMessage/delta', { itemId: 'a1', delta: 'line one\nunfinished' });
  await settle();
  const state = store.getState();
  assert.equal(state.streamingTail.text, 'line one\n');
  assert.equal(Object.hasOwn(state, 'streamingPartial'), false);
  assert.equal(store.getState(), state);
  assert.equal(changes.length, 2);
  stop();
});

test('abort sends turn/interrupt and reports whether the core took the cancel', async (context) => {
  const { core, store } = await open(context);
  const result = await store.abortAsync({ restorePrompt: false });
  assert.deepEqual(result, { aborted: true, turnId: 'u1' });
  assert.deepEqual(core.request('turn/interrupt')[0].params, { threadId: 't1', restorePrompt: false });
});

test('a tool approval is answered with the JSON-RPC response of the pending server request', async (context) => {
  const { core, store } = await open(context);
  core.conn.serverSend({
    id: 'ap-1',
    method: 'item/tool/requestApproval',
    params: { kind: 'shell', tool: 'shell', request: {}, threadId: 't1', requestedAt: 1, order: 1 },
  });
  await settle();
  assert.equal(store.getState().toolApproval.id, 'ap-1');
  assert.equal(store.getState().toolApprovalsWaiting, 0);
  assert.equal(store.resolveToolApproval('ap-1', { approved: false, reason: 'denied by user' }), true);
  await settle();
  const answer = core.received.find((frame) => frame.id === 'ap-1');
  assert.deepEqual(answer, { id: 'ap-1', result: { approved: false, reason: 'denied by user' } });
});

test('session actions become protocol requests with named params on the bound thread', async (context) => {
  const { core, store } = await open(context);
  await store.setEffort('high');
  await store.renameSessionTitle('t7', 'Renamed');
  await store.setFast(true);
  await store.rewindToItem('item-3');
  await store.getSessionUsage();
  const sent = (method) => core.request(method)[0].params;
  const { opId: _op1, ...effort } = sent('thread/setEffort');
  assert.deepEqual(effort, { threadId: 't1', value: 'high' });
  const { opId: _op2, ...rename } = sent('thread/name/set');
  assert.deepEqual(rename, { threadId: 't7', title: 'Renamed' });
  const { opId: _op3, ...fast } = sent('fast/set');
  assert.deepEqual(fast, { threadId: 't1', on: true });
  const { opId: _op4, ...rewind } = sent('thread/rewind');
  assert.deepEqual(rewind, { threadId: 't1', itemId: 'item-3', restoreFiles: true });
  assert.deepEqual(sent('thread/getSessionUsage'), { threadId: 't1' });
  assert.equal(core.request('thread/getSessionUsage')[0].params.opId, undefined);
});

test('an action result is the core result; an action the protocol does not declare is rejected before sending', async (context) => {
  const { core, store } = await open(context, {
    handlers: { 'thread/getSessionUsage': () => ({ total: 42 }) },
  });
  assert.deepEqual(await store.getSessionUsage(), { total: 42 });
  await assert.rejects(store.isSessionTerminal(), (error) => error.code === 'unknownMethod');
  assert.equal(core.request('thread/isSessionTerminal').length, 0);
  await assert.rejects(store.setEffort('a', 'b', 'c'), TypeError);
});

test('a core refusal reaches the caller as an Error with the core message and typed reason', async (context) => {
  const { store } = await open(context, {
    handlers: {
      'thread/setEffort': () =>
        new Reply({ error: { code: -32600, message: 'session is busy', data: { reason: 'preconditionFailed' } } }),
    },
  });
  await assert.rejects(store.setEffort('high'), (error) => {
    assert.equal(error.message, 'session is busy');
    assert.equal(error.code, 'preconditionFailed');
    return true;
  });
});

test('newSession starts and follows a new thread, leaving the old feed; resume follows another and keeps the current', async (context) => {
  const { core, store } = await open(context);
  const frame = mountTranscript(context, store);
  core.emit('t1', 'item/completed', { item: userItem('u1', 'first thread text') });
  assert.match(await frame(), /first thread text/);

  assert.equal(await store.newSession(), true);
  assert.equal(store.getState().sessionId, 't2');
  assert.doesNotMatch(await frame(), /first thread text/);
  assert.deepEqual(core.request('thread/unsubscribe').map((f) => f.params.threadId), ['t1']);

  core.thread('t9').items.push({ type: 'agentMessage', id: 'a9', text: 'older conversation' });
  assert.equal(await store.resume('t9'), true);
  assert.match(await frame(), /older conversation/);
  assert.equal(await store.resume('t9'), true);
  assert.equal(core.request('thread/resume').filter((f) => f.params.threadId === 't9').length, 1);
  assert.deepEqual(core.request('thread/unsubscribe').map((f) => f.params.threadId), ['t1', 't2']);
});

test('listSessions pages through thread/list and projects use the project routes', async (context) => {
  const pages = [
    { data: [{ id: 'a' }, { id: 'b' }], nextCursor: 'c1' },
    { data: [{ id: 'c' }] },
  ];
  const { core, store } = await open(context, {
    handlers: {
      'thread/list': () => pages.shift(),
      'project/list': () => ({ projects: [{ path: '/work', name: 'work' }] }),
      'project/touch': () => ({ project: { path: '/work' } }),
      'project/delete': () => ({ removed: true }),
    },
  });
  assert.deepEqual((await store.listSessions({ refreshFromStorage: true })).map((row) => row.id), ['a', 'b', 'c']);
  assert.deepEqual(core.request('thread/list').map((f) => f.params), [{}, { cursor: 'c1' }]);
  assert.deepEqual(await store.listProjects(), [{ path: '/work', name: 'work' }]);
  assert.deepEqual(await store.touchProjectSelected('/work'), { path: '/work' });
  assert.equal(await store.removeProject('/work'), true);
});

test('a dropped socket reconnects, resumes from the folded position and the frame keeps both turns', async (context) => {
  const { core, store } = await open(context);
  const frame = mountTranscript(context, store);
  core.emit('t1', 'item/completed', { item: userItem('u1', 'before the drop') });
  assert.match(await frame(), /before the drop/);

  core.conn.serverClose(1006);
  await settle();
  await settle();
  const resumes = core.request('thread/resume');
  assert.equal(resumes.length, 2);
  assert.deepEqual(resumes[1].params.resumeFrom, { epoch: 'e1', seq: 11, window: { lastItems: 512 } });

  core.emit('t1', 'item/completed', { item: { type: 'agentMessage', id: 'a1', text: 'after the drop' } });
  const text = await frame();
  assert.match(text, /before the drop/);
  assert.match(text, /after the drop/);
});

test('dispose leaves the thread and closes the connection without stopping the core', async (context) => {
  const { core, store } = await open(context);
  await store.dispose();
  assert.deepEqual(core.request('thread/unsubscribe').map((f) => f.params), [{ threadId: 't1' }]);
  assert.equal(core.conn.clientClose.code, 1000);
  assert.equal(store.disposedView, true);
  await assert.rejects(store.getSessionUsage(), /disposed/);
  assert.equal(store.submit('late'), false);
});

test('views of one process share a connection, which closes with the last view', async (context) => {
  const core = new ScriptedCore();
  const createSession = createProtocolSessionFactory({
    connect,
    connector: core.net,
    ensureCore: async () => ({}),
    threadReducer: sessionReducer,
    stateOf: sessionStateOf,
    clientInfo: CLIENT_INFO,
    clock: { sleep: () => Promise.resolve() },
    random: () => 0.5,
  });
  const first = await createSession({ cwd: '/work' });
  const second = await createSession({ cwd: '/work' });
  assert.equal(core.conns.length, 1);
  await first.dispose();
  assert.equal(core.conn.clientClose, undefined);
  await second.dispose();
  assert.equal(core.conn.clientClose.code, 1000);
});

test('a version refusal fails the session with the update message', async () => {
  const core = new ScriptedCore({
    handlers: {
      initialize: (_params, scripted) => {
        queueMicrotask(() => scripted.conn.serverClose(4002, 'version'));
        return new Reply({
          error: { code: -32600, message: 'v', data: { reason: 'clientOutdated', serverVersion: '2.0.0', clientVersion: '1.4.6' } },
        });
      },
    },
  });
  const createSession = createProtocolSessionFactory({
    connect,
    connector: core.net,
    ensureCore: async () => ({}),
    threadReducer: sessionReducer,
    stateOf: sessionStateOf,
    clientInfo: CLIENT_INFO,
    clock: { sleep: () => Promise.resolve() },
    random: () => 0.5,
  });
  await assert.rejects(createSession({ cwd: '/work' }), /update Mixdog/);
});

test('a routed action either resolves to a declared method or fails as unknownMethod', () => {
  for (const action of SESSION_ACTIONS) {
    try {
      const { method, params } = resolveAction(action, [], { threadId: 't1' });
      assert.match(method, /^[a-zA-Z]+(\/[a-zA-Z]+)+$/, action);
      assert.equal(typeof params, 'object', action);
    } catch (error) {
      assert.equal(error.code, 'unknownMethod', `${action}: ${error.message}`);
    }
  }
});
