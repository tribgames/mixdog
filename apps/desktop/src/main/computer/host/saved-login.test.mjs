import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Isolated adapters, never the user's desktop or vault: the keychain is a byte
// reversal over a vault file in a temporary profile.
const userData = mkdtempSync(join(tmpdir(), 'mixdog-saved-login-'));
globalThis.__savedLoginUserData = userData;
process.on('exit', () => rmSync(userData, { recursive: true, force: true }));
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url:
            'data:text/javascript,' +
            encodeURIComponent(`
        export const app = { isPackaged: false, getPath: () => globalThis.__savedLoginUserData };
        export const safeStorage = {
          isEncryptionAvailable: () => true,
          encryptString: (text) => Buffer.from(String(text), 'utf8').reverse(),
          decryptString: (sealed) => Buffer.from(sealed).reverse().toString('utf8'),
        };
        export const session = { defaultSession: {} };
        export const BrowserWindow = { getAllWindows: () => [] };
        export const desktopCapturer = { getSources: async () => [] };
        export const nativeImage = {};
        export const screen = {};
      `),
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});
const { fillSavedLogin, assertSavedLoginPixelsAllowed, reconcileSavedLoginOwners } = await import('./saved-login.ts');
const { createSavedLoginVault } = await import('./saved-login-vault.ts');
const { createCommandRouter } = await import('./command-router.ts');
const { createExecutionState } = await import('./execution-state.ts');
const { createSessionState } = await import('../session/state.ts');
const { computerRunRecord } = await import('../session/run-log.ts');
const { createSecretInputs, secretInputs } = await import('../../secret-input.ts');
const { createBridgeServer } = await import('./bridge-server.ts');
const { upsertVaultLogin } = await import('../../browser/credential-vault.ts');

const PASSWORD = 'Pa55-"word"\\x';
const PAGE = 'https://login.example.com/signin?next=%2Fhome';
const ORIGIN = 'https://login.example.com';
const LABEL = 'j•••e@example.com';
const SESSION = 'saved-login-session';
const TARGET = {
  window_id: 'hwnd:0x1',
  pid: '4242',
  start_time: '133700000000000001',
  origin: ORIGIN,
  document_id: '42.1.4.5.1.20',
  runtime_id: '42.1.4.5.1.77',
  field: 'password',
  value_length: 0,
};
const OWNER = '00000000-0000-4000-8000-000000000001';
const OTHER_OWNER = '00000000-0000-4000-8000-000000000002';
const BRIDGE_OWNER = '00000000-0000-4000-8000-000000000003';
const BRIDGE_OWNER_2 = '00000000-0000-4000-8000-000000000004';
const BRIDGE_OWNER_3 = '00000000-0000-4000-8000-000000000005';
/** Each test owner's runtime process: a pid and an OS creation time. */
const processOf = (ownerId) => ({
  pid: 4000 + Number(ownerId.slice(-2)),
  created: `13370000000000${ownerId.slice(-4)}`,
});
const command = (field = 'password', extra = {}) => ({
  action: 'fill_saved_login',
  session_id: SESSION,
  window_id: 'hwnd:0x1',
  saved_account: LABEL,
  field,
  delivery: 'foreground',
  turn_id: 7,
  runtime_id: OWNER,
  ...extra,
});
const TURN = { sessionId: SESSION, turnId: 7, ownerId: OWNER };

/** The bridge's part of a fill: the owner attached and the fill admitted as
 *  it is accepted, then the fill itself, finished however it ends. */
async function admittedFill(cmd, logins, call, { attach = true, ...options } = {}) {
  const registry = options.registry ?? secretInputs;
  if (attach) registry.attachSavedLoginOwner(cmd.runtime_id, processOf(cmd.runtime_id));
  const finish = registry.admitSavedLoginFill({
    sessionId: cmd.session_id,
    turnId: Number(cmd.turn_id),
    ownerId: cmd.runtime_id,
  });
  if (typeof finish === 'string') throw new Error(`saved_login_unavailable: ${finish}; no input was sent`);
  try {
    return await fillSavedLogin(cmd, logins, call, { platform: 'win32', ...options, registry });
  } finally {
    finish();
  }
}

/** A fake worker: the check answers `check`, the write step `typed`; every
 *  request that reached it is kept, and `beforeSend` runs as the dispatcher's does. */
function worker({ check = { ok: true, result: { saved_login_target: TARGET } }, typed } = {}) {
  const requests = [];
  const call = async (request, beforeSend) => {
    beforeSend?.();
    requests.push(request);
    if (request.action === 'saved_login_check') return typeof check === 'function' ? check(request) : check;
    if (request.action === 'saved_login_type') {
      return typed
        ? typed(request)
        : { ok: true, result: { action: 'fill_saved_login', path: 'uia_setvalue', effect: 'confirmed' } };
    }
    throw new Error(`unexpected worker request ${request.action}`);
  };
  return { call, requests };
}

function savedLogins({
  enabled = true,
  values = { password: PASSWORD, username: 'jane.doe@example.com' },
  origin = ORIGIN,
} = {}) {
  const lookups = [];
  return {
    lookups,
    enabled: () => enabled,
    vault: {
      async value(url, account, field) {
        lookups.push({ url, account, field });
        return { value: values[field], label: LABEL, origin };
      },
    },
  };
}

const run = (logins, native, field = 'password', options = {}) =>
  admittedFill(command(field), logins, native.call, { registry: createSecretInputs(), ...options });
const actions = (native) => native.requests.map((request) => request.action);

test('Auto login off, another OS, a code field or a missing account refuse before anything is read', async () => {
  const native = worker();
  const off = savedLogins({ enabled: false });
  await assert.rejects(run(off, native), /saved_login_unavailable: Auto login is off.*no input was sent/);
  await assert.rejects(run(savedLogins(), native, 'password', { platform: 'darwin' }), /Windows only for now/);
  await assert.rejects(
    run(savedLogins(), native, 'code'),
    /field must be username or password; one-time codes.*handoff_user takeover/
  );
  await assert.rejects(
    fillSavedLogin(command('password', { saved_account: '  ' }), savedLogins(), native.call, { platform: 'win32' }),
    /saved_account must name a saved login/
  );
  // A fill its protection cannot be scoped to (no agent turn or runtime) is not made.
  for (const extra of [
    { turn_id: undefined },
    { turn_id: 0 },
    { turn_id: -1 },
    { turn_id: 1.5 },
    { turn_id: '7x' },
    { runtime_id: undefined },
  ]) {
    await assert.rejects(
      fillSavedLogin(command('password', extra), savedLogins(), native.call, { platform: 'win32' }),
      /saved_login_unavailable: the request names no runtime and agent turn.*no input was sent/
    );
  }
  // Nor one the bridge never admitted.
  await assert.rejects(
    fillSavedLogin(command(), savedLogins(), native.call, { platform: 'win32', registry: createSecretInputs() }),
    /not admitted by the bridge.*no input was sent/
  );
  assert.equal(native.requests.length, 0);
  assert.equal(off.lookups.length, 0);
});

test('a failed browser check reads no login, writes nothing and arms nothing', async () => {
  for (const refusal of [
    "saved_login_refused: the window belongs to 'notepad', not a Chrome or Edge browser window; saved logins are web logins; no input was sent",
    "saved_login_refused: the 'msedge' window's program is not signed by Microsoft Corporation; no input was sent",
    'saved_login_refused: the page is not an HTTPS page; no input was sent',
    'saved_login_refused: the focused field is not a password field; no input was sent',
    'saved_login_refused: the focused field is a password field, not a username field; no input was sent',
    'saved_login_refused: the focused field is inside an embedded frame or nested document, not the page itself; no input was sent',
    "saved_login_refused: the address bar does not show the page's own site; no input was sent",
    'saved_login_refused: Firefox is not supported yet: its page address cannot be read reliably through accessibility; no input was sent',
    'saved_login_refused: Brave is not supported yet: its code signer has not been verified; no input was sent',
  ]) {
    const native = worker({ check: { ok: false, error: refusal } });
    const logins = savedLogins();
    const registry = createSecretInputs();
    await assert.rejects(run(logins, native, 'password', { registry }), (error) => error.message === refusal);
    assert.deepEqual(actions(native), ['saved_login_check']);
    assert.equal(native.requests[0].text, null, 'the check carries no value');
    assert.equal(logins.lookups.length, 0);
    assert.deepEqual(registry.savedLoginPixelGuards(), []);
  }
});

test('a vault miss lists masked labels; an origin disagreement or refused activation writes nothing', async () => {
  const native = worker();
  const logins = savedLogins();
  logins.vault.value = async () => {
    throw new Error(`savedAccount "nobody" is not a stored login for ${ORIGIN}; stored: ${LABEL}, s•••d@example.com`);
  };
  await assert.rejects(
    run(logins, native),
    /^Error: saved_login_unavailable: savedAccount "nobody" is not a stored login for https:\/\/login\.example\.com; stored: j•••e@example\.com, s•••d@example\.com; no input was sent$/
  );
  assert.deepEqual(actions(native), ['saved_login_check']);
  // The worker's origin and the vault's secureOrigin must agree exactly.
  const mismatch = worker();
  await assert.rejects(
    run(savedLogins({ origin: 'https://login.example.com:8443' }), mismatch),
    /could not be matched exactly/
  );
  assert.deepEqual(actions(mismatch), ['saved_login_check']);
  // The foreground could not be taken: the worker's own refusal is the reply.
  const locked = worker({
    check: { ok: true, result: { action: 'focus_window', code: 'foreground_unavailable', delivery_accepted: false } },
  });
  const reply = await run(savedLogins(), locked);
  assert.equal(reply.result.code, 'foreground_unavailable');
  assert.equal(locked.requests.length, 1);
});

test('a password is looked up by the checked origin, redacted everywhere and guarded before it is sent', async () => {
  const logins = savedLogins({ values: { password: `${PASSWORD}\n` } });
  const registry = createSecretInputs();
  const atDispatch = {};
  const native = worker({
    typed: (request) => {
      // Already registered and armed when the value leaves the host.
      atDispatch.redacted = registry.redact('another-session', `x ${request.text} y ${PASSWORD} z`);
      atDispatch.guards = registry.savedLoginPixelGuards();
      return { ok: true, result: { action: 'fill_saved_login', path: 'uia_setvalue', effect: 'confirmed' } };
    },
  });
  const reply = await run(logins, native, 'password', { registry });
  assert.deepEqual(logins.lookups, [{ url: ORIGIN, account: LABEL, field: 'password' }]);
  const [check, written] = native.requests;
  assert.equal(check.action, 'saved_login_check');
  assert.equal(written.text, `${PASSWORD}\n`);
  assert.deepEqual(written.expected, TARGET, 'the write step must find what the check found');
  assert.equal(atDispatch.redacted, 'x [saved login] y [saved login] z', 'exact and newline-stripped forms');
  assert.deepEqual(atDispatch.guards, [{ ...TURN, windowId: 'hwnd:0x1', pid: '4242' }]);
  assert.deepEqual(reply.result.saved_login, { account: LABEL, origin: ORIGIN, field: 'password' });
  assert.match(reply.result.text, /the site receives it.*redisplays it can expose it.*withheld until this turn ends/);
  const text = JSON.stringify(reply);
  assert.equal(text.includes('Pa55'), false);
  assert.equal(text.includes('signin?next'), false);
  // Every spelling, for every session, as the fixed marker.
  for (const session of [SESSION, 'another-session', '']) {
    assert.equal(registry.redact(session, `a ${PASSWORD} b`), 'a [saved login] b');
    assert.equal(registry.redact(session, JSON.stringify({ value: PASSWORD })), '{"value":"[saved login]"}');
  }
});

test('a username is an identifier: neither redacted nor pixel-guarded, and any length is filled', async () => {
  const registry = createSecretInputs();
  const native = worker();
  const reply = await run(savedLogins({ values: { username: 'bob' } }), native, 'username', { registry });
  assert.equal(native.requests[1].text, 'bob');
  assert.equal(reply.result.saved_login.field, 'username');
  assert.match(reply.result.text, /a username is an identifier and is not hidden from you/);
  assert.equal(registry.redact(SESSION, 'jane.doe@example.com bob'), 'jane.doe@example.com bob');
  assert.deepEqual(registry.savedLoginPixelGuards(), []);
});

test('a short password is registered, guarded, typed and redacted like any other', async () => {
  const registry = createSecretInputs();
  const native = worker();
  await run(savedLogins({ values: { password: 'abc' } }), native, 'password', { registry });
  assert.deepEqual(actions(native), ['saved_login_check', 'saved_login_type']);
  assert.equal(native.requests[1].text, 'abc');
  assert.equal(registry.redact('another-session', 'echo abc'), 'echo [saved login]');
  assert.deepEqual(registry.savedLoginPixelGuards(), [{ ...TURN, windowId: 'hwnd:0x1', pid: '4242' }]);
});

test('Auto login switched off during the vault lookup or the dispatch authorization writes nothing', async () => {
  let enabled = true;
  const native = worker();
  const duringLookup = {
    enabled: () => enabled,
    vault: {
      async value() {
        enabled = false;
        return { value: PASSWORD, label: LABEL, origin: ORIGIN };
      },
    },
  };
  await assert.rejects(run(duringLookup, native), /Auto login is off.*no input was sent/);
  assert.deepEqual(actions(native), ['saved_login_check']);
  // During `await authorizeDispatch()`: the last check runs after it, right before sending.
  const logins = savedLogins();
  let on = true;
  logins.enabled = () => on;
  const sent = [];
  const call = async (request, beforeSend) => {
    if (request.action === 'saved_login_type') {
      await Promise.resolve();
      on = false;
    }
    beforeSend?.();
    sent.push(request.action);
    return request.action === 'saved_login_check'
      ? { ok: true, result: { saved_login_target: TARGET } }
      : { ok: true, result: { action: 'fill_saved_login', effect: 'confirmed' } };
  };
  await assert.rejects(
    admittedFill(command(), logins, call, { registry: createSecretInputs() }),
    (error) => /Auto login is off.*no input was sent/.test(error.message) && !/unconfirmed/.test(error.message)
  );
  assert.deepEqual(sent, ['saved_login_check'], 'the secret-bearing request was never sent');
});

test('once the value was sent, a failure is "possibly written", redacted and never retried', async () => {
  for (const typed of [
    () => ({
      ok: false,
      error:
        'saved_login_unconfirmed: the saved value may have been written into the checked field, but the field did not confirm it; it is not retried',
    }),
    () => Promise.reject(new Error(`worker exited while writing ${PASSWORD}`)),
  ]) {
    const native = worker({ typed });
    await assert.rejects(
      run(savedLogins(), native),
      (error) =>
        /^saved_login_unconfirmed: .*may have been written.*not retried/.test(error.message) &&
        !error.message.includes('Pa55')
    );
    assert.deepEqual(actions(native), ['saved_login_check', 'saved_login_type'], 'exactly one write attempt');
  }
  // A refusal the worker made before its write stays "nothing was written".
  const changed = worker({
    typed: () => ({
      ok: false,
      error: 'saved_login_changed: focus moved to another element since the check; nothing was written',
    }),
  });
  await assert.rejects(run(savedLogins(), changed), /^Error: saved_login_changed: .*nothing was written$/);
});

test('pixels of the filled browser are withheld for every session until the filling turn ends', async () => {
  const registry = createSecretInputs();
  await run(savedLogins(), worker(), 'password', { registry });
  const pids = { 'hwnd:0x1': '4242', 'hwnd:0x2': '4242', 'hwnd:0x9': '777' };
  const windowPid = async (id) => pids[id];
  const capture = (session, extra = {}) => ({ action: 'capture', session_id: session, mode: 'state', ...extra });
  const withheld =
    /capture_withheld: pixels of a browser a saved-login password was filled into are withheld until the end of this agent turn/;
  const check = (cmd, windowId, pid = windowPid) => assertSavedLoginPixelsAllowed(cmd, windowId, pid, registry);
  for (const session of [SESSION, 'another-session']) {
    await assert.rejects(check(capture(session), 'hwnd:0x1'), withheld, 'the filled window');
    await assert.rejects(check(capture(session), 'hwnd:0x2'), withheld, 'another window of the same browser process');
    await assert.rejects(check(capture(session, { mode: 'zoom' }), 'hwnd:0x1'), withheld, 'zoom');
    await assert.rejects(check(capture(session), ''), withheld, 'full screen');
    await assert.rejects(check(capture(session), 'hwnd:0x5'), withheld, 'a window whose process cannot be read');
    await assert.rejects(
      check(capture(session), 'hwnd:0x5', async () => {
        throw new Error('window list unavailable');
      }),
      withheld
    );
    await check(capture(session), 'hwnd:0x9');
    await check(capture(session, { mode: 'ax' }), 'hwnd:0x1');
  }
  // Only the filling turn's own settlement retires it: not another session's,
  // not a late settlement of an older turn, not another runtime's.
  await registry.settleSavedLoginTurn({ ...TURN, sessionId: 'another-session' });
  await registry.settleSavedLoginTurn({ ...TURN, turnId: 6 });
  await registry.settleSavedLoginTurn({ ...TURN, ownerId: OTHER_OWNER });
  await assert.rejects(check(capture(SESSION), 'hwnd:0x1'), withheld);
  assert.equal(registry.redact('x', PASSWORD), '[saved login]');
  await registry.settleSavedLoginTurn(TURN);
  await check(capture(SESSION), 'hwnd:0x1');
  assert.equal(registry.redact('x', PASSWORD), PASSWORD, 'its redaction retired with the turn');
});

test("a settlement waits for the turn's running fill, and a newer turn outlives an older settlement", async () => {
  const registry = createSecretInputs();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const native = worker({
    typed: async () => {
      await gate;
      return { ok: true, result: { action: 'fill_saved_login', effect: 'confirmed' } };
    },
  });
  const filling = run(savedLogins(), native, 'password', { registry });
  while (!native.requests.some((request) => request.action === 'saved_login_type'))
    await new Promise((r) => setImmediate(r));
  let settled = false;
  const settlement = registry.settleSavedLoginTurn(TURN).then(() => (settled = true));
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, 'the fill is still running');
  assert.equal(registry.savedLoginPixelGuards().length, 1);
  release();
  await filling;
  await settlement;
  assert.deepEqual(registry.savedLoginPixelGuards(), []);
  // Turn 8 fills; turn 7's settlement arriving late leaves turn 8's protection.
  await admittedFill(command('password', { turn_id: 8 }), savedLogins(), worker().call, { registry });
  await registry.settleSavedLoginTurn(TURN);
  assert.deepEqual(registry.savedLoginPixelGuards(), [{ ...TURN, turnId: 8, windowId: 'hwnd:0x1', pid: '4242' }]);
  // Closing the session retires everything it set up.
  registry.forget(SESSION);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(registry.savedLoginPixelGuards(), []);
});

test('a settlement shuts its turn at once: a fill accepted after it is refused, one accepted before it is waited for', async () => {
  const registry = createSecretInputs();
  registry.attachSavedLoginOwner(OWNER, processOf(OWNER));
  // Accepted by the bridge, still preparing its target (not yet filling).
  const finishEarly = registry.admitSavedLoginFill(TURN);
  assert.equal(typeof finishEarly, 'function');
  let settled = false;
  const settlement = registry.settleSavedLoginTurn(TURN).then(() => (settled = true));
  // A fill of the same turn (or an older one) accepted after the settlement started.
  for (const turnId of [7, 6]) {
    assert.match(String(registry.admitSavedLoginFill({ ...TURN, turnId })), /agent turn has already ended/);
  }
  const late = worker();
  await assert.rejects(
    admittedFill(command(), savedLogins(), late.call, { registry }),
    /already ended.*no input was sent/
  );
  assert.deepEqual(late.requests, [], 'nothing reached the worker');
  // The early fill now arms its guard while the settlement waits for it.
  const early = await fillSavedLogin(command(), savedLogins(), worker().call, { platform: 'win32', registry });
  assert.equal(early.ok, true);
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, 'the settlement waits for the fill accepted before it');
  assert.equal(registry.savedLoginPixelGuards().length, 1);
  finishEarly();
  await settlement;
  assert.deepEqual(registry.savedLoginPixelGuards(), [], 'the guard it armed retired with its turn');
  // The next turn is admitted as usual.
  assert.equal(typeof registry.admitSavedLoginFill({ ...TURN, turnId: 8 }), 'function');
});

test('only an OS-proven end of its process retires an owner; closed connections and other runtimes never do', async () => {
  const registry = createSecretInputs();
  const fill = (owner, turnId = 7, session = SESSION) =>
    admittedFill(
      command('password', { runtime_id: owner, turn_id: turnId, session_id: session }),
      savedLogins(),
      worker().call,
      {
        registry,
        attach: false,
      }
    );
  // The OS's answers, per process id: what a real worker's process_fate gives.
  const fates = new Map();
  const fate = async ({ pid }) => ({ state: fates.get(pid) ?? 'unknown' });
  const settle = () => new Promise((r) => setImmediate(r));
  // No owner connection: refused before anything is read.
  assert.match(String(registry.admitSavedLoginFill(TURN)), /no owner connection/);
  const first = registry.attachSavedLoginOwner(OWNER, processOf(OWNER));
  const second = registry.attachSavedLoginOwner(OWNER, processOf(OWNER));
  await fill(OWNER);
  // One owner id is bound to one process.
  assert.equal(registry.attachSavedLoginOwner(OWNER, { pid: 9999, created: '1' }), null);
  // Two connections, one closes (a bridge switch): nothing retires, fills still admitted.
  first();
  await reconcileSavedLoginOwners(fate, registry);
  assert.equal(registry.savedLoginPixelGuards().length, 1);
  const finish8 = registry.admitSavedLoginFill({ ...TURN, turnId: 8 });
  assert.equal(typeof finish8, 'function');
  finish8();
  // Even proven ended, an owner with a connection still attached is never retired.
  fates.set(processOf(OWNER).pid, 'ended');
  await reconcileSavedLoginOwners(fate, registry);
  assert.equal(registry.retireEndedSavedLoginOwner(OWNER), false);
  assert.equal(registry.savedLoginPixelGuards().length, 1);
  // The last connection closes: a socket loss alone proves nothing (running or unknown keep it).
  second();
  for (const state of ['running', 'unknown']) {
    fates.set(processOf(OWNER).pid, state);
    await reconcileSavedLoginOwners(fate, registry);
    await settle();
    assert.equal(registry.savedLoginPixelGuards().length, 1, state);
  }
  assert.match(
    String(registry.admitSavedLoginFill({ ...TURN, turnId: 9 })),
    /no owner connection/,
    'detached: no new fills'
  );
  // Another runtime's proven end never touches this owner's protection.
  const otherDetach = registry.attachSavedLoginOwner(OTHER_OWNER, processOf(OTHER_OWNER));
  await fill(OTHER_OWNER, 3, 'session-b');
  otherDetach();
  fates.set(processOf(OTHER_OWNER).pid, 'ended');
  await reconcileSavedLoginOwners(fate, registry);
  await settle();
  assert.deepEqual(
    registry.savedLoginPixelGuards().map((guard) => guard.ownerId),
    [OWNER]
  );
  assert.equal(
    registry.attachSavedLoginOwner(OTHER_OWNER, processOf(OTHER_OWNER)),
    null,
    'an ended owner never comes back'
  );
  // The owner's process proven ended: retired, once its running fill finished.
  const reattached = registry.attachSavedLoginOwner(OWNER, processOf(OWNER));
  const finishRunning = registry.admitSavedLoginFill({ ...TURN, turnId: 10 });
  reattached();
  fates.set(processOf(OWNER).pid, 'ended');
  await reconcileSavedLoginOwners(fate, registry);
  await settle();
  assert.equal(registry.savedLoginPixelGuards().length, 1, 'the running fill is waited for');
  finishRunning();
  await settle();
  assert.deepEqual(registry.savedLoginPixelGuards(), []);
  assert.equal(registry.redact('x', PASSWORD), PASSWORD);
});

/** Captures checked against a registry with the OS's answers (`fates`, per owner
 *  process id; a `throws` answer is a worker failure) and the pids of the
 *  windows; `asked` lists the process ids the OS was asked about. */
function guardedCaptures(registry) {
  const fates = new Map();
  const asked = [];
  const pids = { 'hwnd:0x1': '4242', 'hwnd:0x2': '4242', 'hwnd:0x3': '4242', 'hwnd:0x9': '777' };
  const fate = async ({ pid }) => {
    asked.push(pid);
    const state = fates.get(pid) ?? 'unknown';
    if (state === 'throws') throw new Error('worker unavailable');
    return { state };
  };
  const capture = (extra = {}) => ({ action: 'capture', session_id: 'another-session', mode: 'state', ...extra });
  const check = (windowId, cmd = capture()) =>
    assertSavedLoginPixelsAllowed(cmd, windowId, async (id) => pids[id], registry, fate);
  return { fates, asked, capture, check };
}
const WITHHELD = /capture_withheld: pixels of a browser a saved-login password was filled into are withheld/;
const nextTick = () => new Promise((resolve) => setImmediate(resolve));

test("a detached owner's guard releases at the next capture it would withhold once the OS proves the process ended", async () => {
  const registry = createSecretInputs();
  const { fates, asked, capture, check } = guardedCaptures(registry);
  const ownerPid = processOf(OWNER).pid;
  const detach = registry.attachSavedLoginOwner(OWNER, processOf(OWNER));
  await admittedFill(command(), savedLogins(), worker().call, { registry, attach: false });
  // Connected: the guard holds and nothing is asked of the OS.
  await assert.rejects(check('hwnd:0x1'), WITHHELD);
  assert.deepEqual(asked, []);
  // The connection drops while the process runs: the guard is correctly kept,
  // and a running, unknown or failed OS answer keeps it at every capture.
  detach();
  for (const state of ['running', 'unknown', 'throws']) {
    fates.set(ownerPid, state);
    for (const windowId of ['hwnd:0x1', 'hwnd:0x2', '']) {
      await assert.rejects(check(windowId), WITHHELD, `${state} ${windowId || 'full screen'}`);
    }
    assert.equal(registry.savedLoginPixelGuards().length, 1, state);
    assert.equal(registry.redact('x', PASSWORD), '[saved login]', state);
  }
  // A capture the guard does not withhold asks nothing.
  const questions = asked.length;
  await check('hwnd:0x9');
  await check('hwnd:0x1', capture({ mode: 'ax' }));
  assert.equal(asked.length, questions);
  // The process then ends without settling its turn: the next guarded capture
  // (any session, any window of that browser, or the full screen) releases it.
  fates.set(ownerPid, 'ended');
  await check('hwnd:0x2');
  assert.deepEqual(registry.savedLoginPixelGuards(), []);
  assert.equal(registry.redact('x', PASSWORD), PASSWORD, 'its redaction retired with it');
  await check('');
  await check('hwnd:0x1');
  assert.equal(registry.attachSavedLoginOwner(OWNER, processOf(OWNER)), null, 'an ended owner never comes back');
});

test('a capture asks the OS only about detached owners whose guards withhold it, and a running fill keeps its guard', async () => {
  const registry = createSecretInputs();
  const { fates, asked, check } = guardedCaptures(registry);
  const arm = (ownerId, windowId, pid) =>
    assert.equal(registry.armSavedLoginPixels({ sessionId: 'other', turnId: 1, ownerId, windowId, pid }), true);
  // A: filled hwnd:0x1, detached, process ended. C: another browser, detached,
  // also ended. B: same browser as A, still connected.
  const detachA = registry.attachSavedLoginOwner(OWNER, processOf(OWNER));
  await admittedFill(command(), savedLogins(), worker().call, { registry, attach: false });
  const detachC = registry.attachSavedLoginOwner(BRIDGE_OWNER, processOf(BRIDGE_OWNER));
  arm(BRIDGE_OWNER, 'hwnd:0x9', '777');
  registry.attachSavedLoginOwner(OTHER_OWNER, processOf(OTHER_OWNER));
  arm(OTHER_OWNER, 'hwnd:0x3', '4242');
  // A still has a fill running (its connection is gone since): its guard may
  // not be dropped before that fill finishes.
  const finishRunning = registry.admitSavedLoginFill({ ...TURN, turnId: 8 });
  assert.equal(typeof finishRunning, 'function');
  detachA();
  detachC();
  fates.set(processOf(OWNER).pid, 'ended');
  fates.set(processOf(BRIDGE_OWNER).pid, 'ended');
  await assert.rejects(check('hwnd:0x1'), WITHHELD);
  assert.deepEqual(asked, [processOf(OWNER).pid], 'only the owner whose guard withholds this capture is asked');
  assert.equal(
    registry.savedLoginPixelGuards().filter((guard) => guard.ownerId === OWNER).length,
    1,
    'the running fill is waited for'
  );
  finishRunning();
  await nextTick();
  // A is gone; B (connected) still withholds the browser; C was not asked.
  assert.deepEqual(
    registry.savedLoginPixelGuards().map((guard) => guard.ownerId),
    [BRIDGE_OWNER, OTHER_OWNER]
  );
  await assert.rejects(check('hwnd:0x2'), WITHHELD);
  assert.deepEqual(asked, [processOf(OWNER).pid], 'a connected owner is never asked');
  // C's own browser: now C is the one asked, and its ended process releases it.
  await check('hwnd:0x9');
  assert.deepEqual(asked, [processOf(OWNER).pid, processOf(BRIDGE_OWNER).pid]);
  assert.deepEqual(
    registry.savedLoginPixelGuards().map((guard) => guard.ownerId),
    [OTHER_OWNER]
  );
});

test('concurrent guarded captures share one OS question per detached owner', async () => {
  const registry = createSecretInputs();
  let asked = 0;
  let answer = () => {};
  const gate = new Promise((resolve) => (answer = resolve));
  const fate = async () => {
    asked++;
    await gate;
    return { state: 'ended' };
  };
  const detach = registry.attachSavedLoginOwner(OWNER, processOf(OWNER));
  await admittedFill(command(), savedLogins(), worker().call, { registry, attach: false });
  detach();
  const captures = [1, 2, 3].map(() =>
    assertSavedLoginPixelsAllowed(
      { action: 'capture', session_id: 's', mode: 'state' },
      'hwnd:0x1',
      async () => '4242',
      registry,
      fate
    )
  );
  await nextTick();
  assert.equal(asked, 1, 'one question in flight');
  assert.equal(registry.savedLoginPixelGuards().length, 1);
  answer();
  await Promise.all(captures);
  assert.equal(asked, 1);
  assert.deepEqual(registry.savedLoginPixelGuards(), []);
});

test('the vault answers Browser Use account rules for the exact page origin only', async () => {
  await upsertVaultLogin({ origin: ORIGIN, username: 'jane.doe@example.com', password: PASSWORD, source: 'manual' });
  await upsertVaultLogin({ origin: ORIGIN, username: 'second@example.com', password: 'other-pass', source: 'manual' });
  const vault = createSavedLoginVault();
  assert.deepEqual(await vault.value(ORIGIN, 'Jane.Doe@example.com', 'password'), {
    value: PASSWORD,
    label: LABEL,
    origin: ORIGIN,
  });
  // Path, query and fragment never take part: scheme, host and effective port decide.
  assert.equal((await vault.value(`${PAGE}#step2`, LABEL, 'username')).value, 'jane.doe@example.com');
  assert.equal((await vault.value('https://LOGIN.example.com:443/x', LABEL, 'username')).origin, ORIGIN);
  await assert.rejects(
    vault.value(ORIGIN, 'nobody@example.com', 'password'),
    (error) =>
      error.message ===
        `savedAccount "nobody@example.com" is not a stored login for ${ORIGIN}; stored: ${LABEL}, s•••d@example.com` &&
      !error.message.includes('jane.doe')
  );
  await assert.rejects(
    vault.value('https://evil.example.net/login', 'jane.doe@example.com', 'password'),
    /No stored login for https:\/\/evil\.example\.net/
  );
  await assert.rejects(vault.value('https://login.example.com:8443/', LABEL, 'password'), /No stored login/);
  await assert.rejects(vault.value('http://login.example.com/signin', LABEL, 'password'), /secure HTTPS pages/);
});

function routerHost(savedLoginService, native) {
  const requests = [];
  const host = {
    ...createExecutionState(),
    ...createSessionState({ callPowerShell: async () => ({ ok: true }) }),
    isObserveOnly: () => false,
    sessionIdFor: (value) => String(value.session_id || 'default'),
    framesBySession: new Map(),
    elementTargetsBySession: new Map(),
    observedWindowBySession: new Map(),
    lastCaptureBySession: new Map(),
    sessionRecoveryBySession: new Map(),
    sessionDesktopAnchor: new Map(),
    assertExecutionNotAborted() {},
    resolveElementAliases: (value) => value,
    resolveInputTarget: async () => ({
      targetWindowId: 'hwnd:0x1',
      allowedWindowIds: ['hwnd:0x1'],
      observedScope: {
        primaryWindowId: 'hwnd:0x1',
        relatedWindowIds: ['hwnd:0x1'],
        observedAt: performance.now(),
        inputObservation: { monitor: 'monitor-1', sequence: 7, ready: true },
      },
    }),
    claimComputerTargets: async () => {},
    readComputerWindows: async () => [],
    readInputRecovery: async () => undefined,
    readWindowIntegrity: async () => ({ known: true, higher: false }),
    invalidateWindowTargets() {},
    invalidateObservationsForWindows() {},
    settleWindowTransition: async () => ({ transition: null, settleDelayMs: 0 }),
    captureAfterAction: async () => assert.fail('a saved-login fill never captures the field it filled'),
    callPowerShell: async (request) => {
      requests.push(request);
      return native.call(request);
    },
    savedLogins: savedLoginService,
  };
  return { host, requests };
}

test('the bridge redacts replies and errors for every session, lifts guards at turn end, and refuses worker steps', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mixdog-saved-login-bridge-'));
  const served = [];
  let enabled = true;
  // The OS's answers about the test runtimes' processes (worker process_fate).
  const bridgeFates = new Map();
  // A pending OS answer, per pid (the connection may close meanwhile).
  const fateGates = new Map();
  const created = new Map(
    [BRIDGE_OWNER, BRIDGE_OWNER_2, BRIDGE_OWNER_3].map((id) => [processOf(id).pid, processOf(id).created])
  );
  const server = createBridgeServer({
    processFate: async ({ pid }) => {
      await fateGates.get(pid);
      return { state: bridgeFates.get(pid) ?? 'running', created: created.get(pid) ?? '' };
    },
    dataDirectory: () => directory,
    isBridgeWanted: () => enabled,
    isDisposed: () => false,
    diagnose() {},
    powerShellBySession: new Map(),
    elevatedSessionIds: () => [],
    callPowerShell: async () => ({ ok: true }),
    reapIdleSessionWorkers() {},
    abortComputerSession: async () => ({ text: 'aborted' }),
    // The real fill registers the value with the shared registry; later replies
    // echo it, as a field read back into an observation or an error would.
    executeSerialized: async (request) => {
      served.push(request.action);
      if (request.action === 'fill_saved_login') {
        const filled = await fillSavedLogin(request, savedLogins(), worker().call, { platform: 'win32' });
        return {
          text: JSON.stringify({ ...filled.result, echoed: PASSWORD }),
          image: { mimeType: 'image/png', data: 'cGl4ZWxz' },
        };
      }
      if (request.action === 'clipboard_read') return { text: `clipboard: ${PASSWORD}` };
      if (request.action === 'execution_end') return { text: 'computer execution ended' };
      if (request.action === 'session_release') return { text: 'released' };
      throw new Error(`page says ${PASSWORD}`);
    },
  });
  try {
    server.startBridge();
    let record;
    for (let attempt = 0; attempt < 100 && !record?.port; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      try {
        record = JSON.parse(readFileSync(join(directory, 'computer-bridge.json'), 'utf8'));
      } catch {
        /* published atomically */
      }
    }
    const send = (body) =>
      fetch(`http://127.0.0.1:${record.port}/command`, {
        method: 'POST',
        headers: { authorization: `Bearer ${record.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((response) => response.json());
    // A runtime's held owner connection, as client.mjs opens it.
    const openOwner = (runtimeId) =>
      new Promise((resolve, reject) => {
        const body = JSON.stringify({ runtime_id: runtimeId, pid: processOf(runtimeId).pid });
        const held = httpRequest(
          {
            host: '127.0.0.1',
            port: record.port,
            path: '/owner',
            method: 'POST',
            agent: false,
            headers: { authorization: `Bearer ${record.token}`, 'content-length': Buffer.byteLength(body) },
          },
          (response) => {
            if (response.statusCode !== 200) reject(new Error(`owner refused: ${response.statusCode}`));
            response.once('data', () => resolve(held));
            response.once('close', () => reject(new Error('owner response closed before data')));
          }
        );
        held.once('error', reject);
        held.end(body);
      });
    const fillAs = (runtimeId, extra = {}) =>
      send({ ...command(), session_id: 'bridge-session', runtime_id: runtimeId, ...extra });
    // No owner connection yet: refused as it is accepted, before the queue.
    const unowned = await fillAs(BRIDGE_OWNER);
    assert.match(unowned.error, /saved_login_unavailable: this runtime holds no owner connection.*no input was sent/);
    assert.equal(served.length, 0);
    const owner = await openOwner(BRIDGE_OWNER);
    const reply = await fillAs(BRIDGE_OWNER);
    assert.equal(reply.ok, true);
    assert.equal(reply.value.image, undefined);
    assert.equal(JSON.stringify(reply).includes('Pa55'), false);
    assert.equal(secretInputs.savedLoginPixelGuards().length, 1);
    // Another session's clipboard read and error never carry it either.
    const clip = await send({ action: 'clipboard_read', session_id: 'bridge-other' });
    assert.equal(clip.value.text, 'clipboard: [saved login]');
    const failed = await send({ action: 'list_windows', session_id: 'bridge-other' });
    assert.equal(failed.error, 'page says [saved login]');
    for (const action of ['saved_login_check', 'saved_login_type']) {
      const forged = await send({ action, session_id: 'bridge-session', window_id: 'hwnd:0x1', text: 'x' });
      assert.equal(forged.ok, false);
      assert.match(forged.error, /invalid_action/);
    }
    // Input cleanup (a cancelled request's abort, execution end, release) never
    // retires the protection, nor does another session's or an older turn's
    // settlement; only the filling turn's settlement does.
    for (const body of [
      { action: 'session_abort', session_id: 'bridge-session' },
      { action: 'execution_end', session_id: 'bridge-session' },
      { action: 'session_release', session_id: 'bridge-session' },
      { action: 'turn_settle', session_id: 'bridge-other', turn_id: 7, runtime_id: BRIDGE_OWNER },
      { action: 'turn_settle', session_id: 'bridge-session', turn_id: 6, runtime_id: BRIDGE_OWNER },
      { action: 'turn_settle', session_id: 'bridge-session', turn_id: 7, runtime_id: OTHER_OWNER },
    ]) {
      assert.equal((await send(body)).ok, true, body.action);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(secretInputs.savedLoginPixelGuards().length, 1, JSON.stringify(body));
    }
    assert.match(
      (await send({ action: 'turn_settle', session_id: 'bridge-session', runtime_id: BRIDGE_OWNER })).error,
      /positive turn_id and a runtime_id/
    );
    assert.equal(
      (await send({ action: 'turn_settle', session_id: 'bridge-session', turn_id: 7, runtime_id: BRIDGE_OWNER })).ok,
      true
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(secretInputs.savedLoginPixelGuards(), []);
    // The settled turn takes no more fills.
    assert.match((await fillAs(BRIDGE_OWNER)).error, /agent turn has already ended/);
    assert.equal(served.filter((action) => action === 'fill_saved_login').length, 1);
    // A live runtime switching connections (it opens a new one, closes the
    // old, as on a discovery change) keeps its next turn's guard; so does a
    // closed last connection while its process runs.
    assert.equal((await fillAs(BRIDGE_OWNER, { turn_id: 8 })).ok, true);
    const replacement = await openOwner(BRIDGE_OWNER);
    const pause = () => new Promise((resolve) => setTimeout(resolve, 50));
    owner.destroy();
    await pause();
    assert.equal(secretInputs.savedLoginPixelGuards().length, 1, 'one of two connections closed');
    assert.equal((await fillAs(BRIDGE_OWNER, { turn_id: 9 })).ok, true, 'still attached through the other');
    replacement.destroy();
    await pause();
    assert.equal(secretInputs.savedLoginPixelGuards().length, 2, 'socket loss alone is no proof of death');
    // The OS then proves the process ended: retired at the next reconciliation
    // (another runtime attaching), and that runtime is never admitted again.
    bridgeFates.set(processOf(BRIDGE_OWNER).pid, 'ended');
    const second = await openOwner(BRIDGE_OWNER_2);
    for (let attempt = 0; attempt < 100 && secretInputs.savedLoginPixelGuards().length; attempt++) await pause();
    assert.deepEqual(secretInputs.savedLoginPixelGuards(), []);
    await assert.rejects(openOwner(BRIDGE_OWNER), /owner refused: 400/);
    // A connection that closes while its process is still being read is never
    // attached: the runtime holds no owner connection afterwards.
    let releaseFate = () => {};
    fateGates.set(
      processOf(BRIDGE_OWNER_3).pid,
      new Promise((resolve) => {
        releaseFate = resolve;
      })
    );
    const racingBody = JSON.stringify({ runtime_id: BRIDGE_OWNER_3, pid: processOf(BRIDGE_OWNER_3).pid });
    const racing = httpRequest({
      host: '127.0.0.1',
      port: record.port,
      path: '/owner',
      method: 'POST',
      agent: false,
      headers: { authorization: `Bearer ${record.token}`, 'content-length': Buffer.byteLength(racingBody) },
    });
    racing.once('error', () => {});
    racing.end(racingBody);
    await pause();
    racing.destroy();
    await pause();
    releaseFate();
    await pause();
    assert.match(
      (await fillAs(BRIDGE_OWNER_3, { session_id: 'bridge-d', turn_id: 1 })).error,
      /holds no owner connection/
    );
    // The bridge shutting down only detaches a live runtime: its guard stays.
    void second;
    assert.equal((await fillAs(BRIDGE_OWNER_2, { session_id: 'bridge-c', turn_id: 1 })).ok, true);
    enabled = false;
    await server.stopBridge();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(
      secretInputs.savedLoginPixelGuards().map((guard) => [guard.ownerId, guard.sessionId]),
      [[BRIDGE_OWNER_2, 'bridge-c']]
    );
  } finally {
    secretInputs.forget('bridge-session');
    secretInputs.forget('bridge-c');
    secretInputs.forget('bridge-d');
    enabled = false;
    await server.stopBridge();
    rmSync(directory, { recursive: true, force: true });
  }
});

const WINDOWS = { skip: process.platform !== 'win32' && 'saved logins are filled on Windows only' };

test('through the router: reply, history record and diagnostics never hold the value', WINDOWS, async () => {
  const records = [];
  const { host, requests } = routerHost(savedLogins(), worker());
  host.recordDiagnostic = (_session, record) => records.push(record);
  const router = createCommandRouter(host);
  const startedAt = performance.now();
  secretInputs.attachSavedLoginOwner(OWNER, processOf(OWNER));
  const finish = secretInputs.admitSavedLoginFill(TURN);
  const reply = await router.runCommand(command()).finally(finish);
  const payload = JSON.parse(reply.text);
  assert.equal(payload.ok, true);
  assert.equal(payload.action, 'fill_saved_login');
  assert.deepEqual(payload.saved_login, { account: LABEL, origin: ORIGIN, field: 'password' });
  assert.equal(reply.image, undefined);
  assert.deepEqual(
    requests.map((request) => [
      request.action,
      request.observed_input_monitor_id,
      request.observed_input_user_sequence,
    ]),
    [
      ['saved_login_check', 'monitor-1', 7],
      ['saved_login_type', 'monitor-1', 7],
    ]
  );
  const logged = JSON.stringify([reply, computerRunRecord(command(), startedAt, reply), records]);
  assert.equal(logged.includes('Pa55'), false);
  assert.equal(logged.includes('signin?next'), false);
  secretInputs.forget(SESSION);
});

test(
  'through the router: Auto login switched off after the dispatch authorization sends no value',
  WINDOWS,
  async () => {
    const logins = savedLogins();
    let on = true;
    logins.enabled = () => on;
    const { host, requests } = routerHost(logins, worker());
    // The observe-only gate runs right after `await authorizeDispatch()`; the
    // user turns Auto login off there, just before the secret-bearing request.
    host.isObserveOnly = () => {
      if (requests.some((request) => request.action === 'saved_login_check')) on = false;
      return false;
    };
    secretInputs.attachSavedLoginOwner(OWNER, processOf(OWNER));
    const finish = secretInputs.admitSavedLoginFill({ ...TURN, turnId: 70 });
    await assert.rejects(
      createCommandRouter(host)
        .runCommand(command('password', { turn_id: 70 }))
        .finally(finish),
      /Auto login is off.*no input was sent/
    );
    assert.deepEqual(
      requests.map((request) => request.action),
      ['saved_login_check']
    );
    secretInputs.forget(SESSION);
  }
);

test('through the router: Auto login off is refused before the target is touched', WINDOWS, async () => {
  const native = worker();
  const { host, requests } = routerHost(savedLogins({ enabled: false }), native);
  let prepared = 0;
  host.resolveInputTarget = async () => {
    prepared++;
    return { allowedWindowIds: [] };
  };
  await assert.rejects(createCommandRouter(host).runCommand(command()), /saved_login_unavailable: Auto login is off/);
  assert.equal(prepared, 0);
  assert.equal(requests.length, 0);
  const bare = routerHost(undefined, native);
  await assert.rejects(createCommandRouter(bare.host).runCommand(command()), /saved_login_unavailable/);
  assert.equal(bare.requests.length, 0);
});
