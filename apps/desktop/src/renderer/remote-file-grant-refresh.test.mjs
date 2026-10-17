import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storedGrantSources, withApiFileGrantRefresh, withFileGrantRefresh } from './remote-file-grant-refresh.ts';
import { clearStoredRemotePairing, remotePairingKeys } from './remote-pairing-recovery.ts';

/** A Storage stand-in that outlives the pages built on it. */
function memoryStorage() {
  const items = new Map();
  return {
    items,
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: (key) => items.delete(key),
  };
}
const KEYS = remotePairingKeys('https://relay.test', 'abcdef12');

const REFUSED = 'The selected-file permission is unavailable.';
/** The host's refusal as a client receives it: message for display, code for logic. */
const refusal = (message = REFUSED) => Object.assign(new Error(message), { code: 'SELECTED_FILE_GRANT_UNAVAILABLE' });
const ANY = { anyConversation: true };
const FILE = 'C:/outside/report.txt';

/** Calls that carry the token as their third argument and are not reads. */
const TOKEN_METHODS = { openFilePath: 1, revealFile: 1, serverDownloadBegin: 1 };

/** A host that grants linked files like remote-methods: one live token per
 *  file, which `expire()` ends (the grant timed out or was evicted). */
function fakeHost({ refuseAlways = false, message = REFUSED } = {}) {
  const live = new Set();
  const calls = [];
  let minted = 0;
  const call = async (method, params = []) => {
    calls.push([method, ...params]);
    if (method === 'resolveLocalPaths') {
      minted += 1;
      const token = `t${minted}`;
      live.add(token);
      return [{ absolutePath: params[0][0], projectPath: 'C:/outside', relPath: 'report.txt', accessToken: token }];
    }
    if (method === 'readProjectFile') {
      if (refuseAlways || !live.has(params[2])) throw refusal(message);
      return { content: 'linked report' };
    }
    if (method in TOKEN_METHODS) {
      if (!live.has(params[2])) throw refusal(message);
      return true;
    }
    throw new Error(`unexpected ${method}`);
  };
  return { call, calls, expire: () => live.clear() };
}

const count = (calls, method) => calls.filter((entry) => entry[0] === method).length;

test('a refused held token is granted again through resolveLocalPaths and the open succeeds', async () => {
  const host = fakeHost();
  const call = withFileGrantRefresh(host.call);
  const [entry] = await call('resolveLocalPaths', [[FILE], 's1']);
  host.expire();
  const read = await call('readProjectFile', ['C:/outside', 'report.txt', entry.accessToken]);
  assert.equal(read.content, 'linked report');
  // The refresh repeats the original request, conversation included.
  assert.deepEqual(host.calls[2], ['resolveLocalPaths', [FILE], 's1', ANY]);
  assert.deepEqual(host.calls[3], ['readProjectFile', 'C:/outside', 'report.txt', 't2']);
});

test('a refused token is refreshed and retried only once', async () => {
  const host = fakeHost({ refuseAlways: true });
  const call = withFileGrantRefresh(host.call);
  const [entry] = await call('resolveLocalPaths', [[FILE]]);
  await assert.rejects(call('readProjectFile', ['C:/outside', 'report.txt', entry.accessToken]), { message: REFUSED });
  assert.equal(count(host.calls, 'resolveLocalPaths'), 2);
  assert.equal(count(host.calls, 'readProjectFile'), 2);
});

test('a token with no kept record is granted again from the file the call names', async () => {
  const host = fakeHost();
  // Storage cleared, or a layout restored from another PC: nothing recorded.
  const call = withFileGrantRefresh(host.call);
  const read = await call('readProjectFile', ['C:\\outside', 'report.txt', 'held-elsewhere']);
  assert.equal(read.content, 'linked report');
  // Asked for without a conversation: the host checks every one this device can open.
  assert.deepEqual(host.calls[1], ['resolveLocalPaths', [FILE], null, ANY]);
  // Other failures and calls without a token are never retried.
  const failing = withFileGrantRefresh(async (method) => {
    host.calls.push([method]);
    throw new Error('ENOENT: no such file');
  });
  await assert.rejects(failing('readProjectFile', ['C:/outside', 'report.txt', 'x']), /ENOENT/);
  await assert.rejects(failing('readProjectFile', ['C:/outside', 'report.txt', null]), /ENOENT/);
  assert.equal(count(host.calls, 'resolveLocalPaths'), 1);
});

test('the remote DesktopApi opens a linked file again after its grant ended', async () => {
  const { createRemoteApi } = await import('./remote-shim-api.ts');
  const host = fakeHost();
  const api = createRemoteApi({ call: host.call });
  const [entry] = await api.resolveLocalPaths([FILE], 's1');
  host.expire();
  // Before the fix: "The selected-file permission is unavailable."
  const read = await api.readProjectFile(entry.projectPath, entry.relPath, entry.accessToken);
  assert.equal(read.content, 'linked report');
});

test('after a client reload a held token is refreshed once and opens', async () => {
  const host = fakeHost();
  const storage = memoryStorage();
  const before = withFileGrantRefresh(host.call, storedGrantSources(storage, KEYS.fileGrants));
  const [entry] = await before('resolveLocalPaths', [[FILE], 's1']);
  // Only the path and conversation are kept, never contents.
  assert.deepEqual(JSON.parse(storage.getItem(KEYS.fileGrants)), [['t1', FILE, 's1']]);
  // The reload: a new page over the same storage, still holding the old token
  // (a restored tab or cached link) while the host's grant has ended.
  host.expire();
  const after = withFileGrantRefresh(host.call, storedGrantSources(storage, KEYS.fileGrants));
  for (let open = 0; open < 5; open += 1) {
    const read = await after('readProjectFile', ['C:/outside', 'report.txt', entry.accessToken]);
    assert.equal(read.content, 'linked report');
  }
  assert.equal(count(host.calls, 'resolveLocalPaths'), 2);
  assert.deepEqual(host.calls[2], ['resolveLocalPaths', [FILE], 's1', ANY]);
});

test('a refused token whose folder became a project opens through the project route', async () => {
  const host = fakeHost();
  const call = withFileGrantRefresh(async (method, params = []) => {
    // The folder is a registered project now: no grant, a project address.
    if (method === 'resolveLocalPaths' && host.calls.length > 0) {
      host.calls.push([method, ...params]);
      return [{ absolutePath: FILE, projectPath: 'C:/outside', relPath: 'report.txt' }];
    }
    if (method === 'readProjectFile' && params[2] === null) {
      host.calls.push([method, ...params]);
      return { content: 'project report' };
    }
    return host.call(method, params);
  });
  const [entry] = await call('resolveLocalPaths', [[FILE], 's1']);
  host.expire();
  for (let open = 0; open < 5; open += 1) {
    // Before the fix: "The selected-file permission is unavailable."
    const read = await call('readProjectFile', ['C:/outside', 'report.txt', entry.accessToken]);
    assert.equal(read.content, 'project report');
  }
  assert.equal(count(host.calls, 'resolveLocalPaths'), 2);
  assert.deepEqual(host.calls.at(-1), ['readProjectFile', 'C:/outside', 'report.txt', null]);
  // Write calls keep their own arguments and lose only the token.
  const writes = [];
  const writer = withFileGrantRefresh(async (method, params = []) => {
    if (method === 'resolveLocalPaths')
      return [{ absolutePath: FILE, projectPath: 'C:/proj', relPath: 'sub/report.txt' }];
    writes.push(params);
    if (params[4]) throw refusal();
    return true;
  });
  await writer('writeProjectFile', ['C:/outside', 'report.txt', 'new', 'old', 'stale', 'utf8']);
  assert.deepEqual(writes.at(-1), ['C:/proj', 'sub/report.txt', 'new', 'old', null, 'utf8']);
});

test('opens recover after the PC wiped its grants (restart), on every surface holding the token', async () => {
  const host = fakeHost();
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  const { createRemoteApi } = await import('./remote-shim-api.ts');
  const api = createRemoteApi({ call: host.call, pairingKeys: KEYS });
  const [entry] = await api.resolveLocalPaths([FILE], 's1');
  for (let wipe = 0; wipe < 3; wipe += 1) {
    host.expire();
    // A reload after each restart, as well, for the later rounds.
    const page = wipe === 0 ? api : createRemoteApi({ call: host.call, pairingKeys: KEYS });
    for (let open = 0; open < 5; open += 1) {
      const read = await page.readProjectFile(entry.projectPath, entry.relPath, entry.accessToken);
      assert.equal(read.content, 'linked report');
    }
  }
  assert.equal(count(host.calls, 'resolveLocalPaths'), 4);
});

test('the kept records are bounded and end with the pairing', async () => {
  const host = fakeHost();
  const storage = memoryStorage();
  const sources = storedGrantSources(storage, KEYS.fileGrants);
  for (let file = 0; file < 300; file += 1) sources.set(`k${file}`, { path: `C:/outside/${file}.txt` });
  const kept = JSON.parse(storage.getItem(KEYS.fileGrants));
  assert.equal(kept.length, 256);
  assert.deepEqual(kept.at(-1), ['k299', 'C:/outside/299.txt']);
  assert.equal(sources.get('k0'), undefined);
  // Unpair or revoke resets the pairing storage, the kept paths with it, and
  // the page reads the reset at once.
  const call = withFileGrantRefresh(host.call, sources);
  const [entry] = await call('resolveLocalPaths', [[FILE], 's1']);
  assert.deepEqual(sources.get(entry.accessToken), { path: FILE, sessionId: 's1' });
  clearStoredRemotePairing(storage, KEYS);
  assert.equal(storage.getItem(KEYS.fileGrants), null);
  assert.equal(sources.get(entry.accessToken), undefined);
});

test('after a refresh the held token keeps opening across repeated opens', async () => {
  const host = fakeHost();
  const call = withFileGrantRefresh(host.call);
  const [entry] = await call('resolveLocalPaths', [[FILE], 's1']);
  host.expire();
  for (let open = 0; open < 5; open += 1) {
    const read = await call('readProjectFile', ['C:/outside', 'report.txt', entry.accessToken]);
    assert.equal(read.content, 'linked report');
  }
  // One refresh served all five: later opens use the renewed token directly.
  assert.equal(count(host.calls, 'resolveLocalPaths'), 2);
  assert.equal(count(host.calls, 'readProjectFile'), 6);
  // A grant that ends again is renewed again from the original held token.
  host.expire();
  const read = await call('readProjectFile', ['C:/outside', 'report.txt', entry.accessToken]);
  assert.equal(read.content, 'linked report');
  assert.equal(count(host.calls, 'resolveLocalPaths'), 3);
});

test('open, reveal and server-download calls are granted again with their other arguments intact', async () => {
  const cases = [
    ['openFilePath', ['C:/outside/report.txt']],
    ['revealFile', []],
    ['serverDownloadBegin', []],
  ];
  for (const [method, rest] of cases) {
    const host = fakeHost();
    const call = withFileGrantRefresh(host.call);
    const [entry] = await call('resolveLocalPaths', [[FILE], 's1']);
    host.expire();
    assert.equal(await call(method, ['C:/outside', 'report.txt', entry.accessToken, ...rest]), true, method);
    assert.deepEqual(
      host.calls.slice(-3),
      [
        [method, 'C:/outside', 'report.txt', 't1', ...rest],
        ['resolveLocalPaths', [FILE], 's1', ANY],
        [method, 'C:/outside', 'report.txt', 't2', ...rest],
      ],
      method
    );
  }
  // The same through the window API the preload exposes.
  const host = fakeHost();
  const api = withApiFileGrantRefresh({
    resolveLocalPaths: (...args) => host.call('resolveLocalPaths', args),
    openFilePath: (...args) => host.call('openFilePath', args),
    revealFile: (...args) => host.call('revealFile', args),
    serverDownloadBegin: (...args) => host.call('serverDownloadBegin', args),
  });
  const [entry] = await api.resolveLocalPaths([FILE], 's1');
  host.expire();
  assert.equal(await api.openFilePath('C:/outside', 'report.txt', entry.accessToken, FILE), true);
  host.expire();
  assert.equal(await api.revealFile('C:/outside', 'report.txt', entry.accessToken), true);
  host.expire();
  assert.equal(await api.serverDownloadBegin('C:/outside', 'report.txt', entry.accessToken), true);
});

test('a refusal is told by its code, not by its message text', async () => {
  // The message names the grant (a file called after it), the code says access was denied.
  const lookalike = Object.assign(new Error(`EACCES: permission denied, open '${REFUSED}.txt'`), { code: 'EACCES' });
  const host = fakeHost();
  const call = withFileGrantRefresh(async (method, params = []) => {
    if (method !== 'readProjectFile') return host.call(method, params);
    host.calls.push([method, ...params]);
    throw lookalike;
  });
  const [entry] = await call('resolveLocalPaths', [[FILE], 's1']);
  await assert.rejects(
    call('readProjectFile', ['C:/outside', 'report.txt', entry.accessToken]),
    (e) => e === lookalike
  );
  assert.equal(count(host.calls, 'resolveLocalPaths'), 1);
  // A message-only error never counts as the host's refusal either.
  const plain = withFileGrantRefresh(async (method) => {
    host.calls.push([method]);
    throw new Error(REFUSED);
  });
  await assert.rejects(plain('readProjectFile', ['C:/outside', 'report.txt', 'x']), { message: REFUSED });
  assert.equal(count(host.calls, 'resolveLocalPaths'), 1);

  // The code alone is enough, whatever the host words the message.
  const worded = fakeHost({ message: 'That link has lapsed.' });
  const reopen = withFileGrantRefresh(worded.call);
  const [held] = await reopen('resolveLocalPaths', [[FILE], 's1']);
  worded.expire();
  const read = await reopen('readProjectFile', ['C:/outside', 'report.txt', held.accessToken]);
  assert.equal(read.content, 'linked report');
});

test('a call refused after a concurrent call renewed the grant uses that route without asking again', async () => {
  const live = new Set();
  const calls = [];
  const gates = [];
  let minted = 0;
  const host = async (method, params = []) => {
    calls.push([method, ...params]);
    if (method === 'resolveLocalPaths') {
      minted += 1;
      live.add(`t${minted}`);
      return [{ absolutePath: FILE, projectPath: 'C:/outside', relPath: 'report.txt', accessToken: `t${minted}` }];
    }
    const stale = !live.has(params[2]);
    if (params[2] === 't1') {
      // The first attempts are in flight until the test lets each answer.
      const gate = Promise.withResolvers();
      gates.push(gate);
      await gate.promise;
    }
    if (stale) throw refusal();
    return { content: 'linked report' };
  };
  const call = withFileGrantRefresh(host);
  const [entry] = await call('resolveLocalPaths', [[FILE], 's1']);
  live.clear();
  const first = call('readProjectFile', ['C:/outside', 'report.txt', entry.accessToken]);
  const second = call('readProjectFile', ['C:/outside', 'report.txt', entry.accessToken]);
  assert.equal(gates.length, 2);
  // The first is refused and renews the grant before the second hears its refusal.
  gates[0].resolve();
  assert.equal((await first).content, 'linked report');
  gates[1].resolve();
  assert.equal((await second).content, 'linked report');
  assert.equal(count(calls, 'resolveLocalPaths'), 2, 'one initial grant and one renewal');
  assert.deepEqual(calls.at(-1), ['readProjectFile', 'C:/outside', 'report.txt', 't2']);
});
