import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { attachSession, readSessionDiscovery } from '../../../../src/standalone/session-client.mjs';
import { DesktopServiceClient } from './desktop-service-client.ts';
import { SessionTransport } from './session-transport.ts';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const desktopRoot = fileURLToPath(new URL('../../', import.meta.url));
const serviceModuleUrl = new URL('../../out/main/daemon.cjs', import.meta.url).href;

async function bounded(promise, label, timeoutMs = 15_000) {
  let timer;
  const timeout = new Error(`${label} timed out`);
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeout), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function controlledProvider(t) {
  const requests = [];
  const waiting = [];
  let sequence = 0;
  const server = createServer(async (request, response) => {
    if (request.method === 'HEAD') return void response.end();
    if (request.method === 'POST'
      && (request.url === '/v1/approval' || request.url === '/v1/approval-rewrite')) {
      request.resume();
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: 'isolated fixture approval',
          ...(request.url === '/v1/approval-rewrite' ? {
            updatedInput: {
              file_path: 'fixture-rewritten.txt',
              old_string: '',
              new_string: 'isolated approved payload\n',
            },
          } : {}),
        },
      }));
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        object: 'list',
        data: [{ id: 'deepseek-v4-pro', object: 'model', owned_by: 'fixture' }],
      }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end('Unknown fixture route');
      return;
    }
    try {
      let text = '';
      for await (const chunk of request) text += chunk;
      const body = JSON.parse(text);
      const id = `chatcmpl-fixture-${++sequence}`;
      if (body.stream !== true) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          id, object: 'chat.completion', model: body.model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Fixture title' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
        }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      const closed = Promise.withResolvers();
      response.once('close', () => closed.resolve({ ended: response.writableEnded }));
      const send = (delta, finishReason = null) => response.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', model: body.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...(finishReason ? {
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        } : {}),
      })}\n\n`);
      const stream = {
        body,
        closed: closed.promise,
        write(content) { send({ content }); },
        complete(content) {
          if (content) send({ content });
          send({}, 'stop');
          response.end('data: [DONE]\n\n');
        },
        callTool(name, args) {
          const toolId = `${id}-tool`;
          send({
            tool_calls: [{
              index: 0,
              id: toolId,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            }],
          });
          send({}, 'tool_calls');
          response.end('data: [DONE]\n\n');
          return toolId;
        },
      };
      if (waiting.length) waiting.shift().resolve(stream);
      else requests.push(stream);
    } catch (error) {
      if (!response.headersSent) response.writeHead(400);
      response.end(String(error));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    next() {
      if (requests.length) return Promise.resolve(requests.shift());
      const pending = Promise.withResolvers();
      waiting.push(pending);
      return bounded(pending.promise, 'provider request');
    },
  };
}

async function isolatedDaemon(t, root, environment) {
  const child = fork(join(repositoryRoot, 'src/standalone/daemon.mjs'), [], {
    cwd: root,
    env: environment,
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  let output = '';
  const collect = (chunk) => { output = `${output}${chunk}`.slice(-24_000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const exited = once(child, 'exit');
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (child.connected) child.send({ type: 'shutdown' });
    await bounded(exited, 'isolated daemon shutdown', 20_000);
  };
  t.after(async () => {
    try { await stop(); }
    catch (error) {
      t.diagnostic(output);
      child.kill();
      await exited;
      throw error;
    }
  });
  try {
    await bounded(new Promise((resolve, reject) => {
      child.on('message', (message) => {
        if (message?.type === 'ready') resolve();
      });
      child.once('exit', (code) => reject(new Error(`daemon exited before ready: ${code}`)));
      child.once('error', reject);
    }), 'isolated daemon ready', 30_000);
    const discovery = readSessionDiscovery(join(root, 'runtime/daemon.json'));
    assert.ok(discovery?.port && discovery?.token);
    assert.equal(discovery.pid, child.pid);
    return { discovery, stop, output: () => output };
  } catch (error) {
    t.diagnostic(output);
    throw error;
  }
}

async function desktopView(t, root, daemon) {
  const client = new DesktopServiceClient({
    connect: () => new SessionTransport(serviceModuleUrl, root, async () => ({
      // Use the real HTTP/SSE client but never discover or spawn the user's daemon.
      ensureDaemon: async () => daemon.discovery,
      attachSession,
    })),
    sessionOptions: () => ({
      userDataPath: join(root, 'profile'),
      packaged: false,
      resourcesPath: desktopRoot,
      appPath: desktopRoot,
      rendererDir: join(desktopRoot, 'out/renderer'),
      runtimeRoot: join(root, 'runtime'),
    }),
    startupTimeoutMs: 30_000,
    requestTimeoutMs: 30_000,
  });
  t.after(() => client.dispose());
  const snapshots = new Map();
  const waiters = new Set();
  client.subscribeSessionStates(({ sessionId, snapshot }) => {
    snapshots.set(sessionId, snapshot);
    for (const next of waiters) next();
  });
  await client.start();
  return {
    client,
    async snapshot(sessionId, predicate) {
      const pending = Promise.withResolvers();
      const check = () => {
        const snapshot = snapshots.get(sessionId);
        if (snapshot && predicate(snapshot)) pending.resolve(snapshot);
      };
      waiters.add(check);
      check();
      try { return await bounded(pending.promise, 'desktop session snapshot'); }
      catch (error) {
        const state = snapshots.get(sessionId);
        t.diagnostic(JSON.stringify({
          sessionId, busy: state?.busy, items: state?.items,
          streamingTail: state?.streamingTail,
        }));
        t.diagnostic(await readFile(join(root, 'data/daemon.log'), 'utf8').catch(String));
        throw error;
      }
      finally { waiters.delete(check); }
    },
  };
}

const contains = (snapshot, text) => snapshot.items?.some(
  (item) => String(item.text || '').includes(text),
);
const displays = (snapshot, text) => contains(snapshot, text)
  || String(snapshot.streamingTail?.text || '').includes(text);

// Requires the current plain-Node desktop service bundle (npm run build:fast).
// Only inference is controlled; desktop projection, RPC/SSE, provider parsing,
// turn cancellation, persistence, and daemon restart are the production paths.
async function isolatedDesktopFixture(t) {
  const cleanup = [];
  const scope = {
    after: (callback) => cleanup.push(callback),
    diagnostic: (message) => t.diagnostic(message),
  };
  t.after(async () => {
    const errors = [];
    while (cleanup.length) {
      try { await cleanup.pop()(); }
      catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Isolated fixture cleanup failed');
  });
  const root = await mkdtemp(join(tmpdir(), 'mixdog-desktop-stream-lifecycle-'));
  scope.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(['runtime', 'data', 'home', 'profile'].map(
    (directory) => mkdir(join(root, directory)),
  ));
  const provider = await controlledProvider(scope);
  const environment = Object.fromEntries(Object.entries(process.env).filter(
    ([name]) => !name.startsWith('MIXDOG_')
      && !name.startsWith('ELECTRON_')
      && !name.endsWith('_API_KEY'),
  ));
  Object.assign(environment, {
    MIXDOG_RUNTIME_ROOT: join(root, 'runtime'),
    MIXDOG_DATA_DIR: join(root, 'data'),
    MIXDOG_HOME: join(root, 'home'),
    MIXDOG_USER_DATA_BACKUP_ROOT: join(root, 'backups'),
    MIXDOG_PROJECTS_FILE: join(root, 'projects.json'),
    MIXDOG_DISABLE_PROJECT_MARKERS: '1',
    MIXDOG_DAEMON_SKIP_MEMORY: '1',
    MIXDOG_DAEMON_SPAWNED_FOR: 'session',
    MIXDOG_DAEMON_HOST: '1',
    DEEPSEEK_API_KEY: 'isolated-fixture-key',
  });
  await writeFile(join(root, 'data/mixdog-config.json'), JSON.stringify({
    agent: {
      onboarding: { completed: true, version: 1 },
      providers: { deepseek: { enabled: true, baseURL: provider.baseURL } },
      presets: [{
        id: 'fixture', name: 'Fixture', provider: 'deepseek', model: 'deepseek-v4-pro',
      }],
      default: 'fixture',
    },
  }));
  return {
    root,
    provider,
    start: () => isolatedDaemon(scope, root, environment),
    view: (daemon) => desktopView(scope, root, daemon),
  };
}

test('desktop streaming survives view replacement, cancels, and restores after daemon shutdown', {
  timeout: 120_000,
}, async (t) => {
  const fixture = await isolatedDesktopFixture(t);
  const { provider } = fixture;
  let daemon = await fixture.start();
  let view = await fixture.view(daemon);
  const first = await view.client.submitNewTask(
    'fixture:first', { id: 'fixture-first' },
    { route: { provider: 'deepseek', model: 'deepseek-v4-pro' } },
  );
  assert.equal(first.accepted, true);
  const id = first.sessionId;
  await view.client.setVisibleSessions([id]);
  const streaming = await provider.next();
  assert.ok(JSON.stringify(streaming.body.messages).includes('fixture:first'));
  // Production reveals completed lines; the unfinished suffix stays buffered.
  streaming.write('fixture partial α\n');
  await view.snapshot(id, (state) => state.busy && displays(state, 'fixture partial α'));

  // A desktop window is a view: leaving it must not cancel the owned turn.
  await view.client.dispose();
  view = await fixture.view(daemon);
  await view.client.setVisibleSessions([id]);
  await view.snapshot(id, (state) => state.busy && displays(state, 'fixture partial α'));
  streaming.write(' — after reopening\n');
  await view.snapshot(id, (state) => displays(state, 'after reopening'));
  const cancelled = await view.client.abortSession(id);
  assert.equal(cancelled.aborted, true);
  assert.equal((await bounded(streaming.closed, 'provider cancellation')).ended, false);
  await view.snapshot(id, (state) => !state.busy && contains(state, 'fixture partial α'));

  assert.equal(await view.client.submitToSession(id, 'fixture:second', { id: 'fixture-second' }), true);
  const second = await provider.next();
  second.complete('fixture completed β');
  await view.snapshot(id, (state) => !state.busy && contains(state, 'fixture completed β'));

  assert.equal(await view.client.submitToSession(id, 'fixture:shutdown', { id: 'fixture-shutdown' }), true);
  const interrupted = await provider.next();
  interrupted.write('fixture shutdown partial γ\nunfinished suffix');
  await view.snapshot(id, (state) => state.busy && displays(state, 'fixture shutdown partial γ'));
  await view.client.dispose();
  await daemon.stop();
  assert.equal((await bounded(interrupted.closed, 'shutdown cancellation')).ended, false);

  daemon = await fixture.start();
  view = await fixture.view(daemon);
  await view.client.setVisibleSessions([id]);
  const restored = await view.snapshot(id, (state) =>
    !state.busy && contains(state, 'fixture shutdown partial γ'));
  assert.ok(contains(restored, 'unfinished suffix'));
  for (const text of ['fixture:first', 'fixture partial α', 'fixture:second', 'fixture completed β']) {
    assert.ok(contains(restored, text), `restored transcript must retain ${text}`);
  }
  // Stored transcript projections assign their own row ids; submission ids
  // address live optimistic rows, not the reconstructed history.
  for (const text of ['fixture:first', 'fixture:second', 'fixture:shutdown']) {
    assert.equal(restored.items.filter((item) => item.kind === 'user' && item.text === text).length, 1);
  }
  await view.client.dispose();
  await daemon.stop();
});

test('a native read tool result reaches the real provider continuation and restored desktop transcript', {
  timeout: 120_000,
}, async (t) => {
  const fixture = await isolatedDesktopFixture(t);
  const { root, provider } = fixture;
  const payload = 'isolated native read payload';
  await writeFile(join(root, 'fixture.txt'), payload);
  let daemon = await fixture.start();
  let view = await fixture.view(daemon);
  await view.client.addProject(root);
  const submitted = await view.client.submitNewTask(
    'Read fixture.txt with the read tool, then report its contents.',
    { id: 'fixture-native-read' },
    { projectPath: root, route: { provider: 'deepseek', model: 'deepseek-v4-pro' } },
  );
  assert.equal(submitted.accepted, true);
  await view.client.setVisibleSessions([submitted.sessionId]);
  const request = await provider.next();
  assert.ok(request.body.tools.some((tool) => tool.function?.name === 'read'));
  const toolId = request.callTool('read', { file_path: 'fixture.txt', offset: 1, limit: 10 });
  const continuation = await provider.next();
  assert.ok(continuation.body.messages.some((message) =>
    message.role === 'tool' && message.tool_call_id === toolId
      && JSON.stringify(message.content).includes(payload)),
  'the provider continuation must contain the actual local read result');
  continuation.complete('fixture tool completion');
  await view.snapshot(submitted.sessionId, (state) =>
    !state.busy && contains(state, 'fixture tool completion'));
  await view.client.dispose();
  await daemon.stop();

  daemon = await fixture.start();
  view = await fixture.view(daemon);
  await view.client.setVisibleSessions([submitted.sessionId]);
  const restored = await view.snapshot(submitted.sessionId, (state) =>
    !state.busy && contains(state, 'fixture tool completion'));
  assert.ok(restored.items.some((item) => item.kind === 'tool'));
  await view.client.dispose();
  await daemon.stop();
});

for (const { decision, rewrite = false } of [
  { decision: 'approve' },
  { decision: 'deny' },
  { decision: 'abort' },
  { decision: 'approve', rewrite: true },
  { decision: 'deny', rewrite: true },
]) {
  test(`desktop tool approval ${decision}${rewrite ? ' with rewritten input' : ''} preserves the native mutation boundary`, {
    timeout: 120_000,
  }, async (t) => {
    const fixture = await isolatedDesktopFixture(t);
    const { root, provider } = fixture;
    await writeFile(join(root, 'data/hooks.json'), JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: 'edit',
          hooks: [{
            type: 'http',
            url: `${provider.baseURL}/${rewrite ? 'approval-rewrite' : 'approval'}`,
            allowPrivateHosts: true,
          }],
        }],
      },
    }));
    const daemon = await fixture.start();
    let view = await fixture.view(daemon);
    await view.client.addProject(root);
    const submitted = await view.client.submitNewTask(
      'Create fixture-output.txt after approval.',
      { id: `fixture-approval-${decision}` },
      { projectPath: root, route: { provider: 'deepseek', model: 'deepseek-v4-pro' } },
    );
    assert.equal(submitted.accepted, true);
    const id = submitted.sessionId;
    await view.client.setVisibleSessions([id]);
    const request = await provider.next();
    assert.ok(request.body.tools.some((tool) => tool.function?.name === 'edit'));
    const toolId = request.callTool('edit', {
      file_path: 'fixture-output.txt',
      old_string: '',
      new_string: 'isolated approved payload\n',
    });
    let pending = await view.snapshot(id, (state) => state.toolApproval?.toolCallId === toolId);
    const expectedFile = rewrite ? 'fixture-rewritten.txt' : 'fixture-output.txt';
    assert.equal(pending.toolApproval.args.file_path, expectedFile);
    const outputPath = join(root, expectedFile);
    await assert.rejects(readFile(outputPath), { code: 'ENOENT' });

    if (decision === 'approve') {
      await view.client.dispose();
      view = await fixture.view(daemon);
      await view.client.setVisibleSessions([id]);
      const restored = await view.snapshot(id, (state) => state.toolApproval?.id === pending.toolApproval.id);
      pending = restored;
    }
    const approvalId = pending.toolApproval.id;
    if (decision === 'abort') {
      assert.equal((await view.client.abortSession(id)).aborted, true);
      await view.snapshot(id, (state) => !state.busy && !state.toolApproval);
      assert.equal(await view.client.resolveToolApprovalForSession(id, approvalId, { approved: true }), false);
      await assert.rejects(readFile(outputPath), { code: 'ENOENT' });
    } else {
      assert.equal(await view.client.resolveToolApprovalForSession(id, approvalId, {
        approved: decision === 'approve',
        reason: 'fixture decision',
      }), true);
      const continuation = await provider.next();
      const result = continuation.body.messages.find(
        (message) => message.role === 'tool' && message.tool_call_id === toolId,
      );
      assert.ok(result, 'the provider must receive the resolved tool result');
      if (decision === 'approve') {
        assert.equal(await readFile(outputPath, 'utf8'), 'isolated approved payload\n');
      } else {
        assert.match(JSON.stringify(result.content), /denied by hook.*fixture decision/);
        await assert.rejects(readFile(outputPath), { code: 'ENOENT' });
      }
      continuation.complete(`fixture ${decision} complete`);
      await view.snapshot(id, (state) => !state.busy && !state.toolApproval
        && contains(state, `fixture ${decision} complete`));
    }
    if (rewrite) await assert.rejects(readFile(join(root, 'fixture-output.txt')), { code: 'ENOENT' });
    await view.client.dispose();
    await daemon.stop();
  });
}
