import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DESKTOP_IPC } from '../shared/contract-ipc.ts';
import { allowedProvidersForHost } from './ssh/ssh-host-store.ts';
import { registerSshHostIpc } from './ipc-ssh-hosts.ts';
import { RemoteBootstrapError } from './ssh/remote-bootstrap.ts';
import { SshError } from './ssh/ssh-command.ts';
import { currentSshContext } from './ssh/ssh-context.ts';

const CHANNELS = [
  'sshListHosts',
  'sshRenameHost',
  'sshForgetHost',
  'sshOpenHost',
  'sshConfigHosts',
  'sshInspectHostKey',
  'sshConnect',
  'sshCancel',
  'sshAskpassReply',
  'sshCleanupHost',
  'sshUpdateHostSettings',
  'sshServerLogins',
  'sshServerLoginBegin',
  'sshServerLoginStatus',
  'sshServerLoginComplete',
  'sshServerLoginCancel',
  'sshServerLoginSaveKey',
  'sshServerLoginLogout',
  'sshServerLoginRemoveCustom',
];
/** Answered in a server window too (about its own server only). */
const DIAGNOSTICS_CHANNELS = ['sshDiagnosticsLog', 'sshDiagnosticsCopy', 'sshServerLog'];
const UNKNOWN_KEY = {
  check: { status: 'unknown', fingerprint: 'SHA256:x', keyType: 'ED25519' },
  pin: { line: '10.0.0.1 ssh-ed25519 AAAA', file: '/home/u/.ssh/known_hosts' },
};
const TRUSTED = { check: { status: 'trusted' } };

/** A window as ipcMain sees it: a webContents with a main frame and an id. */
function fakeWindow(id) {
  const mainFrame = { name: `main-${id}` };
  const sent = [];
  const listeners = new Map();
  let destroyed = false;
  const sender = {
    id,
    mainFrame,
    isDestroyed: () => destroyed,
    send: (channel, payload) => sent.push([channel, payload]),
    once: (name, listener) => listeners.set(name, listener),
  };
  return {
    id,
    sender,
    sent,
    event: { sender, senderFrame: mainFrame },
    destroy() {
      destroyed = true;
      listeners.get('destroyed')?.();
    },
  };
}

async function setup({
  open,
  inspect,
  platform = 'linux',
  startAskpass,
  cleanup,
  detectAgent,
  replaceKey,
  configureSsh,
  extra = {},
} = {}) {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const opened = new Set();
  const calls = [];
  const inspected = [];
  const connections = {
    open: async (spec, onProgress, options) => {
      calls.push(['open', spec.id, spec.name, spec.target]);
      const context = currentSshContext();
      contexts.push(context ? { ...context, openOptions: options } : null);
      await (open ?? (async () => onProgress?.({ phase: 'ready' })))(spec, onProgress);
      opened.add(spec.id);
    },
    isOpen: (id) => opened.has(id),
    close: async (id) => {
      calls.push(['close', id]);
      opened.delete(id);
    },
    applyModelLogin: async (id, modelLogin) => {
      calls.push(['applyModelLogin', id, modelLogin]);
      contexts.push({ applyModelLogin: currentSshContext()?.settings ?? null });
    },
  };
  const pins = [];
  const contexts = [];
  const routes = new Map([
    [1, 'local'],
    [2, 'local'],
    [3, 'ssh-1'],
  ]);
  const userDataPath = await mkdtemp(join(tmpdir(), 'mixdog-ssh-ipc-'));
  const dispose = registerSshHostIpc({
    ipcMain,
    routes: { connectionIdFor: (id) => routes.get(id) },
    userDataPath,
    connections,
    platform,
    inspect:
      inspect ??
      (async (target) => {
        inspected.push(target.display);
        return TRUSTED;
      }),
    pin: async (pin) => {
      calls.push(['pin', pin.line]);
      pins.push(pin);
    },
    readConfigHosts: async () => [{ alias: 'gpu-box', detail: 'jae@10.0.0.21' }],
    startAskpass,
    configureSsh: configureSsh ?? (async () => undefined),
    cleanupRemoteServer: cleanup,
    detectAgent,
    replaceKey: replaceKey ?? (async (replace) => calls.push(['replace', replace.spec])),
    now: () => 1_000,
    ...extra,
  });
  const win = fakeWindow(1);
  const other = fakeWindow(2);
  const invokeFrom = (window, channel, ...args) => handlers.get(DESKTOP_IPC[channel])(window.event, ...args);
  const invoke = (channel, ...args) => invokeFrom(win, channel, ...args);
  /** Inspects `target` and, unless told otherwise, connects the attempt. */
  const connectTo = async (target, { window = win, trustHostKey, settings } = {}) => {
    const { attemptId } = await invokeFrom(window, 'sshInspectHostKey', target);
    const result = await invokeFrom(window, 'sshConnect', {
      attemptId,
      ...(settings ? { settings } : {}),
      ...(trustHostKey === undefined ? {} : { trustHostKey }),
    });
    return { attemptId, result };
  };
  return {
    invoke,
    invokeFrom,
    connectTo,
    win,
    other,
    routes,
    handlers,
    dispose,
    calls,
    inspected,
    pins,
    contexts,
    userDataPath,
    opened,
  };
}

const opens = (t) => t.calls.filter((call) => call[0] === 'open');
const untilOpening = async (t) => {
  while (!t.calls.some((call) => call[0] === 'open')) await new Promise((resolve) => setImmediate(resolve));
};

test('connecting saves the server under its alias or host and reports progress to the asking window only', async () => {
  const s = await setup();
  const { attemptId, result } = await s.connectTo('root@vps.example.com:2202');
  assert.equal(result.ok, true);
  assert.equal(result.host.name, 'vps.example.com');
  assert.equal(result.host.target, 'root@vps.example.com:2202');
  assert.equal(result.host.lastConnectedAt, 1_000);
  assert.equal(result.host.open, true);
  assert.deepEqual(s.win.sent, [[DESKTOP_IPC.sshProgress, { attemptId, phase: 'ready' }]]);
  assert.deepEqual(s.other.sent, []);
  const stored = JSON.parse(await readFile(join(s.userDataPath, 'ssh-hosts.json'), 'utf8'));
  assert.equal(stored.hosts.length, 1);
  assert.deepEqual(await s.invoke('sshListHosts'), [result.host]);
  // The same target connects as the same server.
  const again = await s.connectTo('root@vps.example.com:2202');
  assert.equal(again.result.host.id, result.host.id);
});

test("a key file and folder entered with the address reach the first attempt's ssh context and are saved with the server", async () => {
  const s = await setup();
  const { result } = await s.connectTo('root@new.example.com', {
    settings: { identityFile: ' ~/.ssh/id_work ', remoteCwd: '~/work' },
  });
  assert.equal(result.ok, true);
  // defaultSshSpawn turns context.settings.identityFile into `-i <key> -o IdentitiesOnly=yes` (ssh-auth.ts).
  assert.equal(s.contexts[0].settings.identityFile, '~/.ssh/id_work');
  assert.equal(s.contexts[0].settings.remoteCwd, '~/work');
  assert.deepEqual(result.host.settings, { identityFile: '~/.ssh/id_work', remoteCwd: '~/work' });
  const stored = JSON.parse(await readFile(join(s.userDataPath, 'ssh-hosts.json'), 'utf8'));
  assert.deepEqual(stored.hosts[0].settings, { identityFile: '~/.ssh/id_work', remoteCwd: '~/work' });
});

test('entered settings that change an already-open server are refused, so a wrong key never replaces the saved one', async () => {
  const s = await setup();
  const first = await s.connectTo('root@open.example.com', { settings: { identityFile: '~/.ssh/good' } });
  assert.equal(first.result.ok, true);
  const opensBefore = opens(s).length;
  // A guidance kind with no retry, not an error thrown across IPC.
  const refused = await s.connectTo('root@open.example.com', { settings: { identityFile: '~/.ssh/wrong' } });
  assert.deepEqual(refused.result, { ok: false, failure: { kind: 'already-connected' } });
  assert.equal(opens(s).length, opensBefore);
  assert.equal((await s.invoke('sshListHosts'))[0].settings.identityFile, '~/.ssh/good');
  // The same values (or none) simply reuse the live connection.
  const same = await s.connectTo('root@open.example.com', { settings: { identityFile: '~/.ssh/good' } });
  assert.equal(same.result.ok, true);
});

test('concurrent first connects of one server are serialized: the second never saves a key the first connection did not log in with', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const s = await setup({ open: () => gate });
  const first = s.connectTo('root@race.example.com', { settings: { identityFile: '~/.ssh/good' } });
  await untilOpening(s);
  const second = s.connectTo('root@race.example.com', { settings: { identityFile: '~/.ssh/untested' } });
  // The second waits for the first instead of opening (the manager would reuse the first connection).
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opens(s).length, 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.result.ok, true);
  assert.deepEqual(b.result, { ok: false, failure: { kind: 'already-connected' } });
  assert.equal(opens(s).length, 1);
  assert.equal((await s.invoke('sshListHosts'))[0].settings.identityFile, '~/.ssh/good');
});

test('a queued connect runs normally when the first one failed', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let calls = 0;
  const s = await setup({
    open: async () => {
      if (calls++ === 0) {
        await gate;
        throw new SshError('ssh root@retry.example.com failed:\nboom', 'terminal', 'boom', 255);
      }
    },
  });
  const first = s.connectTo('root@retry.example.com', { settings: { identityFile: '~/.ssh/bad' } });
  await untilOpening(s);
  const second = s.connectTo('root@retry.example.com', { settings: { identityFile: '~/.ssh/fixed' } });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.result.ok, false);
  assert.equal(b.result.ok, true);
  assert.equal((await s.invoke('sshListHosts'))[0].settings.identityFile, '~/.ssh/fixed');
});

test('a key file starting with "-" in the connect request is refused before anything connects', async () => {
  const s = await setup();
  const { attemptId } = await s.invoke('sshInspectHostKey', 'root@bad.example.com');
  await assert.rejects(
    s.invoke('sshConnect', { attemptId, settings: { identityFile: '-oProxyCommand=x' } }),
    /must not start with "-"/
  );
  assert.deepEqual(opens(s), []);
  assert.deepEqual(await s.invoke('sshListHosts'), []);
});

test('nothing is saved when the connection fails; the failure comes back as a guidance kind', async () => {
  const s = await setup({
    open: async () => {
      throw new SshError('denied', 'terminal', 'root@x: Permission denied (publickey).', 255);
    },
    platform: 'win32',
  });
  const { result } = await s.connectTo('root@10.0.0.1');
  assert.equal(result.ok, false);
  assert.equal(result.failure.kind, 'auth');
  assert.match(result.failure.register, /^Get-Content/);
  assert.deepEqual(await s.invoke('sshListHosts'), []);
});

test('host key: an unknown key is saved only after the user confirmed it, and before ssh connects', async () => {
  const s = await setup({ inspect: async () => UNKNOWN_KEY });
  const inspection = await s.invoke('sshInspectHostKey', 'root@10.0.0.1');
  assert.deepEqual(inspection.check, UNKNOWN_KEY.check);
  await assert.rejects(s.invoke('sshConnect', { attemptId: inspection.attemptId }), /Confirm the server’s fingerprint/);
  await assert.rejects(
    s.invoke('sshConnect', { attemptId: inspection.attemptId, trustHostKey: 'yes' }),
    /Confirm the server’s fingerprint/
  );
  assert.deepEqual(s.calls, [], 'an unconfirmed key neither pins nor connects');
  const result = await s.invoke('sshConnect', { attemptId: inspection.attemptId, trustHostKey: true });
  assert.equal(result.ok, true);
  assert.deepEqual(
    s.calls.map((call) => call[0]),
    ['pin', 'open'],
    'pinned first'
  );
  assert.deepEqual(s.pins, [UNKNOWN_KEY.pin]);
});

test('host key: a trusted key connects without pinning anything', async () => {
  const s = await setup();
  const { result } = await s.connectTo('root@10.0.0.1', { trustHostKey: true });
  assert.equal(result.ok, true);
  assert.deepEqual(s.pins, []);
});

test('host key: a changed key is refused whatever the renderer says, and the attempt is spent', async () => {
  const changed = {
    check: { status: 'changed', previous: 'SHA256:old', current: 'SHA256:new', keyType: 'ED25519' },
    pin: UNKNOWN_KEY.pin,
  };
  const s = await setup({ inspect: async () => changed });
  const { attemptId, result } = await s.connectTo('root@10.0.0.1', { trustHostKey: true });
  assert.deepEqual(result, {
    ok: false,
    failure: { kind: 'host-key-changed', previous: 'SHA256:old', current: 'SHA256:new', code: 'host-key-changed' },
  });
  assert.deepEqual(s.calls, [], 'no pin and no connection');
  await assert.rejects(s.invoke('sshConnect', { attemptId, trustHostKey: true }), /no longer active/);
});

test('host key: an unreadable key is refused with the reason', async () => {
  const s = await setup({
    inspect: async () => ({ check: { status: 'unreachable', message: 'Connection timed out' } }),
  });
  const { result } = await s.connectTo('root@10.0.0.1', { trustHostKey: true });
  assert.deepEqual(result, {
    ok: false,
    failure: { kind: 'failed', message: 'Connection timed out', code: 'host-key-unreachable' },
  });
  assert.deepEqual(s.calls, []);
});

test('host key: connect needs an attempt main opened; the address in the request is ignored', async () => {
  const s = await setup();
  await assert.rejects(
    s.invoke('sshConnect', { attemptId: 'never-inspected', target: 'root@10.0.0.1' }),
    /no longer active/
  );
  await assert.rejects(s.invoke('sshConnect', { target: 'root@10.0.0.1', trustHostKey: true }), /attemptId/);
  assert.deepEqual(s.calls, []);
  const { attemptId } = await s.invoke('sshInspectHostKey', 'root@good.example.com');
  const result = await s.invoke('sshConnect', { attemptId, target: 'root@evil.example.com', trustHostKey: true });
  assert.equal(result.host.target, 'root@good.example.com');
  assert.deepEqual(
    opens(s).map((call) => call[3]),
    ['root@good.example.com']
  );
});

test('host key: the key main inspected is the key it pins, even if the inspection result is changed afterwards', async () => {
  const seen = { check: { ...UNKNOWN_KEY.check }, pin: { ...UNKNOWN_KEY.pin } };
  const s = await setup({ inspect: async () => seen });
  const inspection = await s.invoke('sshInspectHostKey', 'root@10.0.0.1');
  seen.pin.line = '10.0.0.1 ssh-ed25519 EVIL';
  seen.check.fingerprint = 'SHA256:evil';
  assert.equal(inspection.check.fingerprint, 'SHA256:x');
  assert.throws(() => {
    inspection.check.status = 'trusted';
  }, TypeError);
  await s.invoke('sshConnect', { attemptId: inspection.attemptId, trustHostKey: true });
  assert.deepEqual(s.pins, [UNKNOWN_KEY.pin]);
});

test('an attempt connects once; the next try inspects again', async () => {
  const s = await setup();
  const { attemptId } = await s.connectTo('root@10.0.0.1');
  await assert.rejects(s.invoke('sshConnect', { attemptId }), /no longer active/);
  assert.equal(opens(s).length, 1);
});

test('host key: opening a saved server never starts a connection, it only focuses an open one', async () => {
  const s = await setup();
  const { result } = await s.connectTo('gpu-box');
  s.opened.clear();
  await assert.rejects(s.invoke('sshOpenHost', result.host.id), /not connected/);
  assert.equal(opens(s).length, 1, 'no second open');
  assert.deepEqual(s.inspected, ['gpu-box']);
  await s.connectTo('gpu-box');
  const focused = await s.invoke('sshOpenHost', result.host.id);
  assert.equal(focused.ok, true);
  assert.equal(opens(s).length, 3);
});

test('a daemon the server already runs is replaced only on a second, confirmed connect of the same attempt', async () => {
  let busy = true;
  const s = await setup({
    open: async () => {
      if (busy)
        throw new RemoteBootstrapError(
          'daemon-not-proxy',
          'A Mixdog daemon (pid 1667) is already running on the server.'
        );
    },
  });
  const { attemptId, result } = await s.connectTo('root@10.0.0.1');
  assert.deepEqual(result.failure, { kind: 'daemon-running', pid: 1667, code: 'daemon-not-proxy' });
  assert.equal(s.contexts[0].forceRestart, undefined, 'the first try never restarts anything');
  await assert.rejects(s.invokeFrom(s.other, 'sshConnect', { attemptId, forceRestart: true }), /no longer active/);
  await assert.rejects(
    s.invoke('sshConnect', { attemptId }),
    /already ran/,
    'a plain retry of a found daemon is not a confirmation'
  );
  busy = false;
  const restarted = await s.invoke('sshConnect', { attemptId, forceRestart: true });
  assert.equal(restarted.ok, true);
  assert.equal(s.contexts.at(-1).forceRestart, true);
  assert.deepEqual(
    s.contexts.at(-1).openOptions,
    { forceRestart: true },
    'the connection manager is told through its open option'
  );
  assert.equal(s.contexts[0].openOptions, undefined);
  await assert.rejects(
    s.invoke('sshConnect', { attemptId, forceRestart: true }),
    /no longer active/,
    'one restart per found daemon'
  );
  // forceRestart on an attempt that found nothing is ignored: it is not a way around the first try.
  const fresh = await s.invoke('sshInspectHostKey', 'root@10.0.0.2');
  await s.invoke('sshConnect', { attemptId: fresh.attemptId, forceRestart: true });
  assert.equal(s.contexts.at(-1).forceRestart, undefined);
});

test('another version’s busy daemon is restartable the same way', async () => {
  const s = await setup({
    open: async () => {
      throw new RemoteBootstrapError('daemon-busy-other-version', 'A session is running on mixdog 1.0.0.');
    },
  });
  const { attemptId, result } = await s.connectTo('root@10.0.0.1');
  assert.equal(result.failure.kind, 'daemon-busy');
  assert.match(result.failure.message, /1\.0\.0/);
  await assert.rejects(s.invoke('sshConnect', { attemptId }), /already ran/);
  await s.invoke('sshConnect', { attemptId, forceRestart: true });
  assert.equal(s.contexts.at(-1).forceRestart, true);
});
test('a cancelled attempt neither saves the server nor leaves its window open', async () => {
  const release = Promise.withResolvers();
  const s = await setup({ open: () => release.promise });
  const { attemptId } = await s.invoke('sshInspectHostKey', 'root@10.0.0.1');
  const pending = s.invoke('sshConnect', { attemptId });
  await untilOpening(s);
  await s.invoke('sshCancel', attemptId);
  release.resolve();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.deepEqual(await s.invoke('sshListHosts'), []);
  assert.ok(s.calls.some((call) => call[0] === 'close'));
  assert.equal(s.opened.size, 0);
});

test('an attempt cancelled while queued behind another on the same server pins and replaces no host key', async () => {
  const release = Promise.withResolvers();
  let inspections = 0;
  const s = await setup({
    open: () => release.promise,
    inspect: async () => (inspections++ === 0 ? TRUSTED : UNKNOWN_KEY),
  });
  const first = await s.invokeFrom(s.win, 'sshInspectHostKey', 'root@queue.example.com');
  const second = await s.invokeFrom(s.other, 'sshInspectHostKey', 'root@queue.example.com');
  const running = s.invokeFrom(s.win, 'sshConnect', { attemptId: first.attemptId });
  await untilOpening(s);
  const queued = s.invokeFrom(s.other, 'sshConnect', { attemptId: second.attemptId, trustHostKey: true });
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  await s.invokeFrom(s.other, 'sshCancel', second.attemptId);
  release.resolve();
  const [done, cancelled] = await Promise.all([running, queued]);
  assert.equal(done.ok, true);
  assert.equal(cancelled.ok, false);
  assert.equal(s.pins.length, 0);
  assert.equal(
    s.calls.some((call) => call[0] === 'pin' || call[0] === 'replace'),
    false
  );
  assert.equal(opens(s).length, 1);
});

test('cancelling before connect ends the attempt, so a later connect is refused', async () => {
  const s = await setup({ inspect: async () => UNKNOWN_KEY });
  const { attemptId } = await s.invoke('sshInspectHostKey', 'root@10.0.0.1');
  await s.invoke('sshCancel', attemptId);
  await assert.rejects(s.invoke('sshConnect', { attemptId, trustHostKey: true }), /no longer active/);
  assert.deepEqual(s.calls, []);
});

test('attempts belong to the window that opened them: another window can neither connect, cancel nor stop them', async () => {
  const release = Promise.withResolvers();
  const s = await setup({ inspect: async () => UNKNOWN_KEY, open: () => release.promise });
  const { attemptId } = await s.invoke('sshInspectHostKey', 'root@10.0.0.1');
  await assert.rejects(s.invokeFrom(s.other, 'sshConnect', { attemptId, trustHostKey: true }), /no longer active/);
  await s.invokeFrom(s.other, 'sshCancel', attemptId);
  assert.deepEqual(s.calls, [], 'the other window changed nothing');
  // The owner's attempt is untouched by all of that, and so is the key it was shown.
  const pending = s.invoke('sshConnect', { attemptId, trustHostKey: true });
  await untilOpening(s);
  await s.invokeFrom(s.other, 'sshCancel', attemptId);
  assert.deepEqual(
    s.calls.filter((call) => call[0] === 'close'),
    [],
    'a foreign cancel does not close the window'
  );
  release.resolve();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.deepEqual(s.pins, [UNKNOWN_KEY.pin]);
  assert.deepEqual(s.other.sent, []);
});

test('two windows inspecting the same address get separate attempts', async () => {
  const s = await setup({ inspect: async () => UNKNOWN_KEY });
  const mine = await s.invokeFrom(s.win, 'sshInspectHostKey', 'root@10.0.0.1');
  const theirs = await s.invokeFrom(s.other, 'sshInspectHostKey', 'root@10.0.0.1');
  assert.notEqual(mine.attemptId, theirs.attemptId);
  await s.invokeFrom(s.other, 'sshCancel', theirs.attemptId);
  // Cancelling the other window's attempt leaves this window's confirmable.
  const result = await s.invokeFrom(s.win, 'sshConnect', { attemptId: mine.attemptId, trustHostKey: true });
  assert.equal(result.ok, true);
  assert.deepEqual(s.pins, [UNKNOWN_KEY.pin]);
});

test('concurrent first connections to one target share a single saved-host id', async () => {
  const release = Promise.withResolvers();
  const s = await setup({ open: () => release.promise });
  const first = await s.invokeFrom(s.win, 'sshInspectHostKey', 'root@10.0.0.1');
  const second = await s.invokeFrom(s.other, 'sshInspectHostKey', 'root@10.0.0.1');
  const a = s.invokeFrom(s.win, 'sshConnect', { attemptId: first.attemptId });
  const b = s.invokeFrom(s.other, 'sshConnect', { attemptId: second.attemptId });
  // Attempts on one target run one at a time: the second opens once the first is done.
  while (opens(s).length < 1) await new Promise((resolve) => setImmediate(resolve));
  release.resolve();
  const [resultA, resultB] = await Promise.all([a, b]);
  assert.equal(resultA.host.id, resultB.host.id);
  assert.deepEqual(new Set(opens(s).map((call) => call[1])).size, 1, 'both opened the same id');
  assert.equal((await s.invoke('sshListHosts')).length, 1);
  // A reservation does not outlive its attempts: a failed first try leaves no id behind.
  const failing = await setup({
    open: async () => {
      throw new Error('boom');
    },
  });
  await failing.connectTo('root@10.0.0.2');
  await failing.connectTo('root@10.0.0.2');
  const ids = failing.calls.filter((call) => call[0] === 'open').map((call) => call[1]);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  assert.deepEqual(await failing.invoke('sshListHosts'), []);
});

test('a window that goes away takes its attempts with it', async () => {
  const release = Promise.withResolvers();
  const s = await setup({ open: () => release.promise });
  const idle = await s.invokeFrom(s.other, 'sshInspectHostKey', 'root@10.0.0.9');
  const running = await s.invokeFrom(s.other, 'sshInspectHostKey', 'root@10.0.0.1');
  const pending = s.invokeFrom(s.other, 'sshConnect', { attemptId: running.attemptId });
  await untilOpening(s);
  s.other.destroy();
  await assert.rejects(s.invokeFrom(s.other, 'sshConnect', { attemptId: idle.attemptId }), /main window/);
  release.resolve();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.ok(
    s.calls.some((call) => call[0] === 'close'),
    'the window it opened is closed again'
  );
  assert.deepEqual(await s.invoke('sshListHosts'), []);
  // Its idle attempt is gone for anyone: it cannot be picked up by a window with the same id.
  const reborn = fakeWindow(2);
  await assert.rejects(s.invokeFrom(reborn, 'sshConnect', { attemptId: idle.attemptId }), /no longer active/);
});

test('a window holds a handful of attempts; the oldest idle one is dropped for a new one', async () => {
  const s = await setup();
  const first = await s.invoke('sshInspectHostKey', 'root@10.0.0.1');
  for (let i = 0; i < 8; i += 1) await s.invoke('sshInspectHostKey', `root@10.0.1.${i}`);
  await assert.rejects(s.invoke('sshConnect', { attemptId: first.attemptId }), /no longer active/);
  const latest = await s.invoke('sshInspectHostKey', 'root@10.0.2.1');
  assert.equal((await s.invoke('sshConnect', { attemptId: latest.attemptId })).ok, true);
});

test('only this PC’s own main window may manage SSH servers; everything else is refused before anything runs', async () => {
  const s = await setup();
  assert.deepEqual(
    [...s.handlers.keys()].sort(),
    [...CHANNELS, ...DIAGNOSTICS_CHANNELS].map((name) => DESKTOP_IPC[name]).sort(),
    'every SSH handler is registered, and each goes through the sender check'
  );
  const bad = (event, why) => ({ event, why });
  const mainFrame = { name: 'main-1' };
  const refused = [
    bad(
      { sender: { ...s.win.sender, id: 99 }, senderFrame: s.win.sender.mainFrame },
      'a webContents that is not an app window'
    ),
    bad({ sender: { ...s.win.sender, id: 3, mainFrame }, senderFrame: mainFrame }, 'a window of an ssh server'),
    bad({ sender: s.win.sender, senderFrame: { name: 'iframe' } }, 'a sub-frame of an app window'),
    bad({ sender: s.win.sender, senderFrame: null }, 'no frame'),
    bad(
      { sender: { ...s.win.sender, isDestroyed: () => true }, senderFrame: s.win.sender.mainFrame },
      'a destroyed window'
    ),
  ];
  for (const { event, why } of refused) {
    for (const name of CHANNELS) {
      await assert.rejects(
        s.handlers.get(DESKTOP_IPC[name])(event, { attemptId: 'x', target: 'root@10.0.0.1' }, 'x'),
        /main window/,
        `${name} from ${why}`
      );
    }
  }
  assert.deepEqual(s.calls, []);
  assert.deepEqual(s.inspected, []);
  await assert.rejects(readFile(join(s.userDataPath, 'ssh-hosts.json')), /ENOENT/, 'the saved list was never touched');
  // A window routed to the local connection is accepted.
  assert.deepEqual(await s.invoke('sshConfigHosts'), [{ alias: 'gpu-box', detail: 'jae@10.0.0.21' }]);
  // Routing is read live: a window whose route is gone is refused.
  s.routes.delete(1);
  await assert.rejects(s.invoke('sshListHosts'), /main window/);
});

test('rename and forget touch only the saved entry; forgetting never closes the window', async () => {
  const s = await setup();
  const { result } = await s.connectTo('gpu-box');
  const { host } = result;
  const renamed = await s.invoke('sshRenameHost', host.id, '  GPU  ');
  assert.equal(renamed[0].name, 'GPU');
  const callsBefore = s.calls.length;
  assert.deepEqual(await s.invoke('sshForgetHost', host.id), []);
  assert.equal(s.calls.length, callsBefore, 'no close call');
  assert.equal(s.opened.has(host.id), true);
});

test('forgetting a server drops the login cancels still waiting for it', async () => {
  const invoked = [];
  const ends = [];
  const attaches = [];
  const link = { attached: true, reachable: true };
  const server = {
    modelLogin: 'server',
    busySessions: async () => 0,
    onEnd: (listener) => {
      ends.push(listener);
      return () => undefined;
    },
    invoke: async (capability) => {
      if (!link.reachable) throw new Error('ssh link is down');
      invoked.push(capability);
      return { flowId: 'f1', provider: 'openai-oauth', state: 'pending', url: null };
    },
  };
  const s = await setup({
    extra: {
      serverLogins: {
        connection: () => (link.attached ? server : null),
        onAttach: (listener) => {
          attaches.push(listener);
          return () => undefined;
        },
        openExternal: async () => undefined,
        forwardCallback: async () => {
          throw new Error('no forward');
        },
        cancelTimeoutMs: 20,
      },
    },
  });
  const { host } = (await s.connectTo('gpu-box')).result;
  await s.invoke('sshServerLoginBegin', host.id, 'openai-oauth');
  link.reachable = false;
  await Promise.all(ends.map((end) => end()));
  await s.invoke('sshForgetHost', host.id);
  link.reachable = true;
  for (const attached of attaches) attached(host.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(invoked, ['beginOAuthProviderLogin'], 'the cancel of a forgotten server is never sent');
});

test('aliases are listed, an address that could be read as an option is refused, and dispose removes the handlers', async () => {
  const s = await setup();
  assert.deepEqual(await s.invoke('sshConfigHosts'), [{ alias: 'gpu-box', detail: 'jae@10.0.0.21' }]);
  await assert.rejects(s.invoke('sshInspectHostKey', '-oProxyCommand=x'), /must not start with "-"/);
  s.dispose();
  assert.equal(s.handlers.size, 0);
});

const REFUSED = () => new SshError('denied', 'terminal', 'root@10.0.0.1: Permission denied (publickey,password).', 255);

/** An askpass session whose questions the test answers through the window like the real dialog does. */
function fakeAskpass() {
  const sessions = [];
  const startAskpass = async (options) => {
    const session = {
      options,
      env: {},
      controlDir: null,
      closed: false,
      cancelled: false,
      async close() {
        session.closed = true;
      },
    };
    sessions.push(session);
    return session;
  };
  return { startAskpass, sessions };
}

test('a refused login is retried once through the askpass helper, asking in the window that connects', async () => {
  const { startAskpass, sessions } = fakeAskpass();
  const s = await setup({
    startAskpass,
    open: async () => {
      if (!currentSshContext()?.askpass) throw REFUSED();
    },
  });
  const { attemptId, result } = await s.connectTo('root@10.0.0.1');
  assert.equal(result.ok, true);
  assert.deepEqual(
    s.contexts.map((context) => Boolean(context?.askpass)),
    [false, true],
    'BatchMode first, askpass second'
  );
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].closed, true, 'secrets live only as long as the attempt');
  // The question reaches only the asking window, and only that window can answer it.
  const asked = sessions[0].options.ask(
    { kind: 'passphrase', prompt: "Enter passphrase for key '/home/u/.ssh/id_ed25519': ", retry: false },
    new AbortController().signal
  );
  const [, question] = s.win.sent.at(-1);
  assert.deepEqual(
    { ...question, requestId: typeof question.requestId },
    {
      attemptId,
      requestId: 'string',
      kind: 'passphrase',
      host: '10.0.0.1',
      prompt: "Enter passphrase for key '/home/u/.ssh/id_ed25519': ",
      retry: false,
      timeoutMs: 120000,
    }
  );
  assert.deepEqual(s.other.sent, []);
  await s.invokeFrom(s.other, 'sshAskpassReply', attemptId, question.requestId, 'stolen');
  await s.invoke('sshAskpassReply', attemptId, question.requestId, 'hunter2');
  assert.equal(await asked, 'hunter2');
  await s.invoke('sshAskpassReply', attemptId, question.requestId, 'again');
});

test('cancelling the question, or letting it time out, ends the attempt as cancelled; the timeout closes the dialog', async () => {
  const { startAskpass, sessions } = fakeAskpass();
  const s = await setup({
    startAskpass,
    open: async () => {
      if (currentSshContext()?.askpass) sessions[0].cancelled = true;
      throw REFUSED();
    },
  });
  const { result } = await s.connectTo('root@10.0.0.1');
  assert.deepEqual(result, { ok: false, failure: { kind: 'cancelled' } });
  const timeout = new AbortController();
  const asked = sessions[0].options.ask({ kind: 'otp', prompt: 'Verification code: ', retry: false }, timeout.signal);
  const [, question] = s.win.sent.at(-1);
  timeout.abort();
  assert.equal(await asked, null);
  assert.deepEqual(s.win.sent.at(-1)[1], { ...question, kind: 'close' });
  await s.invoke('sshAskpassReply', 'x', question.requestId, 'late');
  assert.equal(
    await sessions[0].options.ask(
      { kind: 'otp', prompt: 'again', retry: false },
      (() => {
        const a = new AbortController();
        a.abort();
        return a.signal;
      })()
    ),
    null
  );
});

test('a login that is still refused after the questions shows the agent state', async () => {
  const { startAskpass } = fakeAskpass();
  const s = await setup({
    startAskpass,
    open: async () => {
      throw REFUSED();
    },
    detectAgent: async () => ({ state: 'stopped', command: 'Start-Service ssh-agent; ssh-add' }),
    platform: 'win32',
  });
  const { result } = await s.connectTo('root@10.0.0.1');
  assert.equal(result.failure.kind, 'auth');
  assert.deepEqual(result.failure.agent, { state: 'stopped', command: 'Start-Service ssh-agent; ssh-add' });
  assert.equal(s.contexts.length, 2, 'one batch try and one interactive retry, no loop');
});

test('askpass questions end with their window', async () => {
  const { startAskpass, sessions } = fakeAskpass();
  const s = await setup({
    startAskpass,
    open: async () => {
      if (!currentSshContext()?.askpass) throw REFUSED();
    },
  });
  await s.connectTo('root@10.0.0.1', { window: s.other });
  const asked = sessions[0].options.ask(
    { kind: 'password', prompt: 'root@10.0.0.1’s password: ', retry: false },
    new AbortController().signal
  );
  s.other.destroy();
  assert.equal(await asked, null);
});

test('a saved server’s settings travel with every ssh its connection starts; they are validated and kept per server', async () => {
  const s = await setup();
  const { result } = await s.connectTo('root@10.0.0.1');
  const id = result.host.id;
  assert.deepEqual(
    s.contexts[0].settings,
    { graceMinutes: 30 },
    'the grace period is always set, 30 minutes by default'
  );
  const updated = await s.invoke('sshUpdateHostSettings', id, {
    remoteCwd: ' ~/work ',
    identityFile: 'C:\\Users\\김 철수\\.ssh\\id_work',
    autoReconnect: false,
    junk: 1,
  });
  assert.deepEqual(updated[0].settings, {
    remoteCwd: '~/work',
    identityFile: 'C:\\Users\\김 철수\\.ssh\\id_work',
    autoReconnect: false,
  });
  await s.connectTo('root@10.0.0.1');
  assert.deepEqual(s.contexts.at(-1).settings, { ...updated[0].settings, graceMinutes: 30 });
  await assert.rejects(s.invoke('sshUpdateHostSettings', id, { remoteCwd: 'relative/dir' }), /absolute server path/);
  await assert.rejects(
    s.invoke('sshUpdateHostSettings', id, { identityFile: '-oProxyCommand=x' }),
    /must not start with "-"/
  );
  assert.deepEqual((await s.invoke('sshUpdateHostSettings', id, {}))[0].settings, undefined);
  // The grace period: a whole number of minutes from 1 to 10080, passed to the install and connection code through the context.
  for (const bad of [0, 10_081, 1.5, 'soon', -3])
    await assert.rejects(
      s.invoke('sshUpdateHostSettings', id, { graceMinutes: bad }),
      /whole number of minutes from 1 to 10080/,
      String(bad)
    );
  assert.equal((await s.invoke('sshUpdateHostSettings', id, { graceMinutes: '90' }))[0].settings.graceMinutes, 90);
  await s.connectTo('root@10.0.0.1');
  assert.equal(s.contexts.at(-1).settings.graceMinutes, 90);
  assert.equal(
    (await s.invoke('sshUpdateHostSettings', id, { graceMinutes: 10_080 }))[0].settings.graceMinutes,
    10_080
  );
});

test('the same server spelled with another letter case is one saved server, also while connecting', async () => {
  const release = Promise.withResolvers();
  const s = await setup({ open: () => release.promise });
  const a = await s.invokeFrom(s.win, 'sshInspectHostKey', 'root@Vps.Example.com');
  const b = await s.invokeFrom(s.other, 'sshInspectHostKey', 'root@vps.example.com');
  const first = s.invokeFrom(s.win, 'sshConnect', { attemptId: a.attemptId });
  const second = s.invokeFrom(s.other, 'sshConnect', { attemptId: b.attemptId });
  while (opens(s).length < 1) await new Promise((resolve) => setImmediate(resolve));
  release.resolve();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.host.id, two.host.id);
  assert.equal((await s.invoke('sshListHosts')).length, 1);
});

test('a revoked key is refused whatever the renderer says', async () => {
  const s = await setup({
    inspect: async () => ({ check: { status: 'revoked', fingerprint: 'SHA256:r', host: '10.0.0.1' } }),
  });
  const { result } = await s.connectTo('root@10.0.0.1', { trustHostKey: true });
  assert.deepEqual(result, { ok: false, failure: { kind: 'host-key-revoked', code: 'host-key-revoked' } });
  assert.deepEqual(s.calls, []);
});

test('a changed key is replaced only with the host name typed, by main, from the key it inspected', async () => {
  const changed = {
    check: {
      status: 'changed',
      previous: 'SHA256:old',
      current: 'SHA256:new',
      keyType: 'ED25519',
      host: 'Vps.Example.com',
      removeCommand: 'ssh-keygen -R "vps.example.com"',
    },
    replace: {
      spec: 'vps.example.com',
      file: '/home/u/.ssh/known_hosts',
      line: 'vps.example.com ssh-ed25519 NEW',
      host: 'Vps.Example.com',
    },
  };
  const s = await setup({ inspect: async () => changed });
  const wrong = await s.invoke('sshInspectHostKey', 'root@vps.example.com');
  for (const typed of [undefined, '', 'vps', true]) {
    const result = await s.invoke('sshConnect', { attemptId: wrong.attemptId, replaceHostKey: typed });
    assert.equal(result.failure.kind, 'host-key-changed');
    break;
  }
  assert.deepEqual(s.calls, []);
  await assert.rejects(
    s.invoke('sshConnect', { attemptId: wrong.attemptId, replaceHostKey: 'Vps.Example.com' }),
    /no longer active/,
    'a refused attempt is spent'
  );
  const again = await s.invoke('sshInspectHostKey', 'root@vps.example.com');
  const result = await s.invoke('sshConnect', { attemptId: again.attemptId, replaceHostKey: ' vps.example.com ' });
  assert.equal(result.ok, true);
  assert.deepEqual(
    s.calls.map((call) => call[0]),
    ['replace', 'open']
  );
  assert.deepEqual(s.calls[0], ['replace', 'vps.example.com']);
});

test('cleanup removes Mixdog from the saved server, closes its window first, asks for a login when needed and can forget the entry', async () => {
  const { startAskpass, sessions } = fakeAskpass();
  const cleaned = [];
  const s = await setup({
    startAskpass,
    cleanup: async (target, options) => {
      if (!currentSshContext()?.askpass) throw REFUSED();
      cleaned.push([target, { removeUserData: options.removeUserData }, s.opened.has(host.id)]);
      options.onProgress({ phase: 'remove', detail: 'x' });
      return 'Removed 12 files';
    },
  });
  const { result } = await s.connectTo('root@10.0.0.1');
  const host = result.host;
  const done = await s.invoke('sshCleanupHost', host.id, { operationId: 'op-1', removeUserData: true, forget: false });
  assert.equal(done.ok, true);
  assert.equal(done.detail, 'Removed 12 files');
  assert.deepEqual(
    cleaned,
    [['root@10.0.0.1', { removeUserData: true }, false]],
    'the window was closed before the cleanup ran'
  );
  assert.equal(done.hosts.length, 1);
  assert.deepEqual(
    s.win.sent.filter(([channel]) => channel === DESKTOP_IPC.sshCleanupProgress).map(([, progress]) => progress),
    [{ operationId: 'op-1', phase: 'remove', detail: 'x' }],
    'progress reaches the asking window under its operation id'
  );
  assert.equal(sessions.length, 1);
  sessions[0].options.ask({ kind: 'password', prompt: 'p', retry: false }, new AbortController().signal);
  assert.equal(s.win.sent.at(-1)[1].attemptId, 'op-1', 'its questions arrive under the operation id');
  const forgotten = await s.invoke('sshCleanupHost', host.id, {
    operationId: 'op-2',
    removeUserData: false,
    forget: true,
  });
  assert.equal(forgotten.ok, true);
  assert.deepEqual(forgotten.hosts, []);
  assert.deepEqual(cleaned.at(-1)[1], { removeUserData: false });
  await assert.rejects(s.invoke('sshCleanupHost', host.id, { operationId: 'op-3' }), /no longer saved/);
});

test('a failed cleanup comes back as a failure and keeps the entry', async () => {
  const s = await setup({
    cleanup: async () => {
      throw new RemoteBootstrapError('install-locked', 'Another install is running.');
    },
  });
  const { result } = await s.connectTo('root@10.0.0.1');
  const failed = await s.invoke('sshCleanupHost', result.host.id, {
    operationId: 'op',
    removeUserData: false,
    forget: true,
  });
  assert.deepEqual(failed, { ok: false, failure: { kind: 'install-locked', code: 'install-locked' } });
  assert.equal((await s.invoke('sshListHosts')).length, 1);
});

test('forwards of the user’s config that Mixdog could not set aside apply only after the user accepted them', async () => {
  const forwards = ['local [127.0.0.1]:8080 [127.0.0.1]:80'];
  const s = await setup({
    inspect: async () => ({
      ...UNKNOWN_KEY,
      summary: { hostName: '10.0.0.1', user: null, port: 22, proxyJump: null, proxyCommand: false, forwards },
    }),
  });
  const { attemptId } = await s.invoke('sshInspectHostKey', 'root@10.0.0.1');
  await assert.rejects(s.invoke('sshConnect', { attemptId, trustHostKey: true }), /Confirm the port forwards/);
  assert.deepEqual(s.calls, [], 'nothing is pinned or opened without the acceptance');
  const again = await s.invoke('sshInspectHostKey', 'root@10.0.0.1');
  const result = await s.invoke('sshConnect', { attemptId: again.attemptId, trustHostKey: true, acceptForwards: true });
  assert.equal(result.ok, true);
  assert.equal(s.calls[0][0], 'pin');
});
test('a jump chain is confirmed one server at a time: the shown key is saved, then the next server is checked again', async () => {
  const hops = [
    { name: 'bastion', role: 'jump', status: 'unknown', fingerprint: 'SHA256:b', keyType: 'ED25519' },
    { name: 'inner', role: 'target', status: 'pending' },
  ];
  const s = await setup({
    inspect: async () => ({
      check: { status: 'unknown', fingerprint: 'SHA256:b', keyType: 'ED25519', hops },
      pin: { line: 'bastion ssh-ed25519 AAAA', file: '/data/known_hosts' },
    }),
  });
  const { attemptId } = await s.invoke('sshInspectHostKey', 'inner');
  await assert.rejects(s.invoke('sshConnect', { attemptId }), /Confirm the server/);
  const result = await s.invoke('sshConnect', { attemptId, trustHostKey: true });
  assert.deepEqual(result, { ok: false, failure: { kind: 'host-key-next' } });
  assert.deepEqual(s.calls, [['pin', 'bastion ssh-ed25519 AAAA']], 'the confirmed key is saved; nothing is opened');
  await assert.rejects(s.invoke('sshConnect', { attemptId, trustHostKey: true }), /no longer active/);
});

test('Mixdog’s own ssh config and known_hosts are prepared before the first check', async () => {
  const order = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const s = await setup({
    configureSsh: async () => {
      await gate;
      order.push('configured');
    },
    inspect: async () => {
      order.push('inspected');
      return TRUSTED;
    },
  });
  const pending = s.invoke('sshInspectHostKey', 'root@10.0.0.1');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, [], 'the check waits for the configuration');
  release();
  await pending;
  assert.deepEqual(order, ['configured', 'inspected']);
});

test('an unrecognized server prompt is passed on as its own kind, with the host it comes from', async () => {
  const { startAskpass, sessions } = fakeAskpass();
  const s = await setup({
    startAskpass,
    open: async () => {
      if (!currentSshContext()?.askpass) throw REFUSED();
    },
  });
  await s.connectTo('ops@gate.example.com');
  const asked = sessions[0].options.ask(
    { kind: 'other', prompt: 'Approve on your phone: ', retry: false },
    new AbortController().signal
  );
  const [, question] = s.win.sent.at(-1);
  assert.equal(question.kind, 'other');
  assert.equal(question.host, 'gate.example.com');
  await s.invoke('sshAskpassReply', question.attemptId, question.requestId, 'ok');
  assert.equal(await asked, 'ok');
});

test('the providers a server may use are saved per server and looked up by id', async () => {
  const s = await setup();
  const { result } = await s.connectTo('root@10.0.0.1');
  const id = result.host.id;
  assert.equal(allowedProvidersForHost(id), null, 'every provider enabled on this PC until restricted');
  const listed = await s.invoke('sshUpdateHostSettings', id, {
    allowedProviders: ['anthropic', ' openai ', 'anthropic'],
  });
  assert.deepEqual(listed[0].settings.allowedProviders, ['anthropic', 'openai']);
  assert.deepEqual(allowedProvidersForHost(id), ['anthropic', 'openai']);
  assert.deepEqual(
    (await s.invoke('sshUpdateHostSettings', id, { allowedProviders: [] }))[0].settings.allowedProviders,
    [],
    'an empty list allows none'
  );
  assert.deepEqual(allowedProvidersForHost(id), []);
  await assert.rejects(s.invoke('sshUpdateHostSettings', id, { allowedProviders: [''] }), /provider id/);
  await s.invoke('sshUpdateHostSettings', id, { remoteCwd: '~' });
  assert.equal(allowedProvidersForHost(id), null, 'saving without the field lifts the restriction');
  assert.deepEqual(allowedProvidersForHost('unknown-id'), [], 'a server that is not saved gets none');
});

test('a changed model login is saved and restarts the attached server in it; the same choice restarts nothing', async () => {
  const s = await setup();
  const { result } = await s.connectTo('root@10.0.0.1');
  const id = result.host.id;
  const restarts = () => s.calls.filter((call) => call[0] === 'applyModelLogin');
  const update = async (settings) => {
    const listed = await s.invoke('sshUpdateHostSettings', id, settings);
    await new Promise((resolve) => setImmediate(resolve));
    return listed;
  };
  const listed = await update({ remoteCwd: '~', identityFile: '~/.ssh/id_box', modelLogin: 'server' });
  assert.deepEqual(listed[0].settings, { remoteCwd: '~', identityFile: '~/.ssh/id_box', modelLogin: 'server' });
  assert.deepEqual(restarts(), [['applyModelLogin', id, 'server']]);
  // The restart dials under the server's saved settings (its key file).
  assert.equal(s.contexts.at(-1).applyModelLogin.identityFile, '~/.ssh/id_box');
  await update({ remoteCwd: '~/app', modelLogin: 'server' });
  assert.equal(restarts().length, 1, 'other settings alone restart nothing');
  await update({ remoteCwd: '~/app' });
  assert.deepEqual(restarts().at(-1), ['applyModelLogin', id, 'pc'], "leaving it out is this PC's logins again");
  await assert.rejects(update({ modelLogin: 'cloud' }), /model login is not valid/);
  assert.equal(restarts().length, 2);
  // No attached server answers for its logins here.
  assert.deepEqual(await s.invoke('sshServerLogins', id), {
    connected: false,
    modelLogin: null,
    busySessions: null,
    providers: null,
  });
});

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

/** A server window's event: its webContents routed to the connection `route`. */
const serverWindowEvent = (s, route, id = 7) => {
  const mainFrame = { name: `server-${id}` };
  s.routes.set(id, route);
  return { sender: { id, mainFrame, isDestroyed: () => false }, senderFrame: mainFrame };
};

test('the connection log shows the phases of a connect; copied text replaces the server by <server>', async () => {
  const s = await setup({
    open: async (_spec, onProgress) => {
      onProgress({ phase: 'connect' });
      onProgress({ phase: 'check', detail: '22.1.0' });
      onProgress({ phase: 'ready' });
    },
  });
  const { result } = await s.connectTo('deploy@vps.example.com');
  const view = await s.invoke('sshDiagnosticsLog', result.host.id);
  assert.deepEqual(
    view.lines.map((line) => line.replace(/^\S+ /, '')),
    ['log    host key check: trusted', 'phase  connect', 'phase  check: 22.1.0', 'phase  ready']
  );
  const withHost = await s.invoke('sshDiagnosticsLog', 'deploy@vps.example.com');
  assert.deepEqual(withHost.lines, view.lines, 'an address names the same server as its saved id');
  await s.invoke('sshServerLog', 'deploy@vps.example.com');
  assert.equal((await s.invoke('sshDiagnosticsLog', result.host.id)).copyText.includes('vps.example.com'), false);
});

test('copied diagnostics hold the app, OS, ssh version, the redacted ssh -G summary and the last lines', async () => {
  const runs = [];
  const s = await setup({
    extra: {
      appVersion: '9.9.9',
      diagnosticsRun: async (command, args) => {
        runs.push([command, ...args]);
        return args[0] === '-V'
          ? { code: 0, stdout: '', stderr: 'OpenSSH_for_Windows_9.5p1, LibreSSL 3.8\n' }
          : {
              code: 0,
              stdout: 'user deploy\nhostname 203.0.113.7\nport 2202\nproxyjump jump@bastion.example.com:22\n',
              stderr: '',
            };
      },
    },
  });
  const { result } = await s.connectTo('deploy@vps.example.com:2202');
  const report = await s.invoke('sshDiagnosticsCopy', result.host.id);
  assert.match(report, /App: 9\.9\.9/);
  assert.match(report, /ssh: OpenSSH_for_Windows_9\.5p1/);
  assert.match(report, /HostName <server>\n {2}User <server>\n {2}Port 2202\n {2}ProxyJump <server>/);
  assert.match(report, /host key check: trusted/);
  for (const secret of ['vps.example.com', '203.0.113.7', 'bastion.example.com', 'deploy'])
    assert.equal(report.includes(secret), false, secret);
  assert.deepEqual(runs[0], ['ssh', '-V']);
});

test('a server window reads only its own server’s log, whatever it asks for; other windows and frames are refused', async () => {
  const s = await setup();
  const { result: first } = await s.connectTo('ops@first.example.com');
  const { result: second } = await s.connectTo('ops@second.example.com');
  const event = serverWindowEvent(s, first.host.id);
  const mine = await s.handlers.get(DESKTOP_IPC.sshDiagnosticsLog)(event, second.host.id);
  assert.ok(mine.lines.length > 0);
  assert.deepEqual(mine, await s.invoke('sshDiagnosticsLog', first.host.id), 'the requested id is ignored');
  // A server window whose route is not a saved server, a sub-frame, a destroyed window and an unrouted one get nothing.
  await assert.rejects(
    s.handlers.get(DESKTOP_IPC.sshDiagnosticsLog)(serverWindowEvent(s, 'not-saved', 8), first.host.id),
    /no SSH server log/
  );
  await assert.rejects(
    s.handlers.get(DESKTOP_IPC.sshServerLog)({ sender: event.sender, senderFrame: { name: 'iframe' } }, ''),
    /main window/
  );
  await assert.rejects(
    s.handlers.get(DESKTOP_IPC.sshDiagnosticsCopy)(
      { sender: { ...event.sender, isDestroyed: () => true }, senderFrame: event.sender.mainFrame },
      ''
    ),
    /main window/
  );
  await assert.rejects(
    s.handlers.get(DESKTOP_IPC.sshDiagnosticsLog)(
      {
        sender: { id: 99, mainFrame: event.sender.mainFrame, isDestroyed: () => false },
        senderFrame: event.sender.mainFrame,
      },
      first.host.id
    ),
    /main window/
  );
});

test('the server log is the daemon.log tail read over ssh, with secrets removed and the server redacted in the copy', async () => {
  const seen = [];
  const s = await setup({
    extra: {
      readServerLog: async (target) => {
        seen.push([
          target.display,
          currentSshContext()?.settings?.graceMinutes,
          typeof currentSshContext()?.diagnosticsKey,
        ]);
        return `started on vps.example.com\nMIXDOG_REMOTE_TOKEN=${TOKEN}\nlistening\n`;
      },
    },
  });
  const { result } = await s.connectTo('root@vps.example.com');
  const log = await s.invoke('sshServerLog', result.host.id);
  assert.equal(log.ok, true);
  assert.equal(log.text.includes(TOKEN), false);
  assert.match(log.text, /started on vps\.example\.com/);
  assert.match(log.copyText, /started on <server>/);
  assert.deepEqual(seen, [['root@vps.example.com', 30, 'string']], 'it runs under the saved server’s context');
  // A server window can fetch it too (its own server).
  assert.equal((await s.handlers.get(DESKTOP_IPC.sshServerLog)(serverWindowEvent(s, result.host.id), '')).ok, true);
});

test('a server log that cannot be read comes back as a failure and is noted in the log', async () => {
  const s = await setup({
    extra: {
      readServerLog: async () => {
        throw new Error('Permission denied (publickey).');
      },
    },
  });
  const { result } = await s.connectTo('root@vps.example.com');
  assert.deepEqual(await s.invoke('sshServerLog', result.host.id), {
    ok: false,
    message: 'Permission denied (publickey).',
  });
  assert.match(
    (await s.invoke('sshDiagnosticsLog', result.host.id)).lines.at(-1),
    /server log failed: Permission denied/
  );
});
