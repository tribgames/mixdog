import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

import { registerComputerPermissions } from './computer-permissions.ts';
import { bindComputerEnvironment } from './computer-environment.ts';
import { COMPUTER_USER_CONTROL, coreDrivesComputer } from './computer-user-control.ts';
import { createComputerSwitch, registerComputerScopes } from './computer-scope.ts';

// computer-command.ts reaches Electron's screen and windows at import; outside Electron a stand-in answers.
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url: 'data:text/javascript,export default "";export const screen = {};export const BrowserWindow = { getAllWindows: () => [] };',
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});
const { registerComputerCommand } = await import('./computer-command.ts');

function fakeConnection() {
  const handlers = new Map();
  const requests = [];
  const notifications = [];
  return {
    requests,
    notifications,
    handlers,
    notify: (method, params) => notifications.push([method, params]),
    handleRequest: (method, handler) => handlers.set(method, handler),
    request: async (method, params) => {
      requests.push([method, params]);
      return {};
    },
    serve: (method, params) => handlers.get(method)(params, new AbortController().signal),
  };
}

test('permissions: reads the grants, prompts only when asked, rejects a non-boolean request', async () => {
  const connection = fakeConnection();
  let prompts = 0;
  registerComputerPermissions(connection, {
    read: async () => ({ screen_capture: 'granted', accessibility: 'denied', input: 'accessibility_dependent' }),
    request: () => {
      prompts += 1;
    },
  });
  const grants = { screenCapture: 'granted', accessibility: 'denied', input: 'accessibility_dependent' };
  assert.deepEqual(await connection.serve('host/computer/permissions', {}), grants);
  assert.deepEqual(await connection.serve('host/computer/permissions', { request: false }), grants);
  assert.equal(prompts, 0);
  await connection.serve('host/computer/permissions', { request: true });
  assert.equal(prompts, 1);
  await assert.rejects(connection.serve('host/computer/permissions', { request: 'yes' }), /boolean/);
  await assert.rejects(connection.serve('host/computer/permissions', []), /object/);
});

test('permissions: Linux readiness travels as `linux`', async () => {
  const connection = fakeConnection();
  const linux = { capabilities: {} };
  registerComputerPermissions(connection, {
    read: () => ({ screen_capture: 'ready', accessibility: 'ready', input: 'ready', linux }),
    request: () => undefined,
  });
  assert.equal((await connection.serve('host/computer/permissions', {})).linux, linux);
});

test('environment: lock, suspend and display changes send a takeover; unrelated metrics send nothing', async () => {
  const power = new EventEmitter();
  const screen = new EventEmitter();
  const sent = [];
  const stop = bindComputerEnvironment(power, screen, async (method, params) => {
    sent.push([method, params]);
  }, () => true);
  power.emit('lock-screen');
  power.emit('suspend');
  screen.emit('display-added');
  screen.emit('display-removed');
  screen.emit('display-metrics-changed', {}, {}, ['workArea']);
  screen.emit('display-metrics-changed', {}, {}, ['colorSpace']);
  const unavailable = { action: 'takeover', reason: 'desktop_unavailable' };
  const changed = { action: 'takeover', reason: 'display_changed' };
  assert.deepEqual(sent, [unavailable, unavailable, changed, changed, changed].map((p) => [COMPUTER_USER_CONTROL, p]));
  stop();
  power.emit('lock-screen');
  assert.equal(sent.length, 5);
});

test('environment: a failed send is reported, not thrown', async () => {
  const power = new EventEmitter();
  const errors = [];
  bindComputerEnvironment(power, new EventEmitter(), async () => {
    throw new Error('core down');
  }, () => true, (error) => errors.push(error.message));
  power.emit('suspend');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, ['core down']);
});

function commandHost(answer, { deny } = {}) {
  const seen = [];
  return {
    seen,
    assertPublic(command) {
      if (deny?.(command)) throw new Error('computer_policy_denied: internal');
    },
    answerBridgeCommand: async (command) => {
      seen.push(command);
      return answer;
    },
  };
}

test('command: the text answer and an uploaded image come back as result and blob', async () => {
  const connection = fakeConnection();
  const bytes = Buffer.from('frame-bytes');
  const host = commandHost({ ok: true, value: { text: 'done', isError: true, image: { mimeType: 'image/png', data: bytes.toString('base64') } } });
  registerComputerCommand(connection, () => host, { admit: () => ({ signal: new AbortController().signal, commit() {}, track() {}, trackUnfenced() {} }) });
  const result = await connection.serve('host/computer/command', { sessionThreadId: 't', command: { action: 'capture' } });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'done');
  assert.equal(result.isError, true);
  assert.equal(result.imageBlob.byteLength, bytes.length);
  assert.equal(result.imageBlob.mimeType, 'image/png');
  assert.match(result.imageBlob.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(connection.requests.length, 1);
  assert.equal(connection.requests[0][0], 'blob/put');
  assert.equal(connection.requests[0][1].digest, result.imageBlob.digest);
});

test('command: a failed answer is the result error; policy and a missing host refuse', async () => {
  const connection = fakeConnection();
  let host = commandHost({ ok: false, error: 'boom' }, { deny: (c) => c.session_id === 'internal' });
  registerComputerCommand(connection, () => host, { admit: () => ({ signal: new AbortController().signal, commit() {}, track() {}, trackUnfenced() {} }) });
  assert.deepEqual(await connection.serve('host/computer/command', { command: { action: 'capture' } }), { ok: false, error: 'boom' });
  await assert.rejects(connection.serve('host/computer/command', { command: { session_id: 'internal' } }), /invalid request/);
  assert.equal(host.seen.length, 1);
  await assert.rejects(connection.serve('host/computer/command', 'x'), /object/);
  host = null;
  await assert.rejects(connection.serve('host/computer/command', { command: {} }), /unavailable/);
});

test("environment: nothing is reported while the core does not drive the computer (the desktop host's own guard takes over)", () => {
  const power = new EventEmitter();
  const screen = new EventEmitter();
  const sent = [];
  let drives = false;
  bindComputerEnvironment(power, screen, async (method, params) => void sent.push([method, params]), () => drives);
  power.emit('lock-screen');
  screen.emit('display-added');
  assert.deepEqual(sent, []);
  drives = true;
  power.emit('suspend');
  assert.deepEqual(sent, [[COMPUTER_USER_CONTROL, { action: 'takeover', reason: 'desktop_unavailable' }]]);
});

test("coreDrivesComputer: the core's helper with a session, a hold or a pending cleanup; never the desktop's own host", () => {
  const snap = (over = {}) => ({ presentSessionIds: [], userControlActive: false, cleanupState: 'ready', ...over });
  const pill = (backend, snapshot) => ({ backend: () => backend, snapshot: () => snapshot });
  assert.equal(coreDrivesComputer(pill('helper', snap())), false);
  assert.equal(coreDrivesComputer(pill('helper', snap({ presentSessionIds: ['s1'] }))), true);
  assert.equal(coreDrivesComputer(pill('helper', snap({ userControlActive: true }))), true);
  assert.equal(coreDrivesComputer(pill('helper', snap({ cleanupState: 'pending' }))), true);
  assert.equal(coreDrivesComputer(pill('desktopHost', snap({ presentSessionIds: ['s1'] }))), false);
});

/** A promise and its opener: the barrier a fake host's reply waits on. */
function opening() {
  let open;
  const opened = new Promise((resolve) => (open = resolve));
  return { open, opened };
}

test('a relayed command awaiting its reply when its scope is revoked: its signal aborts, the next command is refused, and the report is not complete', async () => {
  const wire = { ...fakeConnection(), onClose() {} };
  const scopes = registerComputerScopes(wire, createComputerSwitch(true));
  const reply = opening();
  const entered = opening();
  const seen = [];
  const host = {
    assertPublic() {},
    async answerBridgeCommand(command, signal) {
      seen.push({ command, signal });
      entered.open();
      await reply.opened;
      return { ok: true, value: { text: 'done' } };
    },
  };
  registerComputerCommand(wire, () => host, scopes);
  const ask = { command: { action: 'click' }, automationScope: 5 };
  const running = wire.serve('host/computer/command', ask);
  await entered.opened;
  const [report] = (await wire.serve('host/computer/revokeScopes', { scopes: [5] })).reports;
  assert.ok(seen[0].signal.aborted, 'the command runs under the scope signal');
  assert.deepEqual(report, {
    scope: 5,
    revision: 1,
    admission: 'unconfirmed',
    unfinished_at_closure: 1,
    unfinished: 1,
    cleanup: 'pending',
    unknown_executors: ['bridge_command'],
  });
  await assert.rejects(wire.serve('host/computer/command', ask), /computer use is unavailable/);
  assert.equal(seen.length, 1, 'the next command never reached the host');
  reply.open();
  await assert.rejects(running, /computer use is unavailable/, 'its reply is not handed on');
  const [again] = (await wire.serve('host/computer/revokeScopes', { scopes: [5] })).reports;
  assert.equal(again.admission, 'unconfirmed', 'its end after the abort is not observed: stays unconfirmed');
  assert.equal(again.cleanup, 'complete');
  assert.equal(again.unfinished_at_closure, 1);
});

test('a command relayed under its scope endpoint: the scope fences each request, its next one after Off is refused, and the report settles complete with admission closed', async () => {
  const wire = { ...fakeConnection(), onClose() {} };
  const scopes = registerComputerScopes(wire, createComputerSwitch(true));
  const reply = opening();
  const entered = opening();
  const sent = [];
  const host = {
    assertPublic() {},
    answerBridgeCommand: async () => assert.fail('a host with the scoped entry is not run unfenced'),
    // A two-request command as the worker pool runs it under the endpoint: each request admitted and counted there.
    async answerScopedCommand(command, endpoint) {
      const request = (name, settled) => {
        endpoint.commit();
        sent.push(name);
        endpoint.track(settled);
        return settled;
      };
      await request('first', (entered.open(), reply.opened));
      request('second', Promise.resolve());
      return { ok: true, value: { text: 'done' } };
    },
  };
  registerComputerCommand(wire, () => host, scopes);
  const ask = { command: { action: 'click' }, automationScope: 6 };
  const running = wire.serve('host/computer/command', ask);
  await entered.opened;
  const [report] = (await wire.serve('host/computer/revokeScopes', { scopes: [6] })).reports;
  assert.deepEqual(report, { scope: 6, revision: 1, admission: 'closed', unfinished_at_closure: 2, unfinished: 2, cleanup: 'pending' });
  assert.deepEqual(wire.notifications, [['host/computer/scopeReport', { report }]], 'pushed before the answer');
  reply.open();
  await assert.rejects(running, /computer use is unavailable/);
  assert.deepEqual(sent, ['first'], 'the continuation was refused');
  await new Promise((resolve) => setImmediate(resolve));
  const pushed = wire.notifications.map(([, params]) => params.report);
  assert.deepEqual(pushed.at(-1), { scope: 6, revision: pushed.at(-1).revision, admission: 'closed', unfinished_at_closure: 2, unfinished: 0, cleanup: 'complete' });
  assert.ok(pushed.every((each, at) => at === 0 || each.revision > pushed[at - 1].revision), 'revisions increase');
  const [again] = (await wire.serve('host/computer/revokeScopes', { scopes: [6] })).reports;
  assert.deepEqual(again, pushed.at(-1), 'the snapshot of a settled scope repeats its last report');
});
