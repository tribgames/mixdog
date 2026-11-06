import assert from 'node:assert/strict';
import test from 'node:test';

import { createSavedLoginHost } from './saved-login-host.ts';

const PASSWORD = 'Pa55-"word"\\x';
const ORIGIN = 'https://login.example.com';

/** The vault as `BrowserProfileImportService.useCredentialByAccount` answers: the account's login for that
 *  origin only, a miss naming masked labels. Every lookup is kept. */
function vault() {
  const lookups = [];
  return {
    lookups,
    credentials: {
      async useCredentialByAccount(url, account, use) {
        lookups.push({ url, account });
        if (url !== ORIGIN) throw new Error('no saved login for this origin; saved: j•••e@example.com');
        if (account !== 'jane.doe@example.com' && account !== 'j•••e@example.com') {
          throw new Error('no saved login for that account; saved: j•••e@example.com');
        }
        return use({ username: 'jane.doe@example.com', password: PASSWORD });
      },
    },
  };
}

/** credential-vault.ts's rules (that module needs Electron): https origins only, a masked label. */
const text = async () => ({
  secureOrigin(value) {
    try {
      const url = new URL(value);
      return url.protocol !== 'https:' || url.username || url.password ? '' : url.origin;
    } catch {
      return '';
    }
  },
  maskedCredentialLabel: () => 'j•••e@example.com',
});

/** The computer host: it keeps every command it was asked and answers like the router for a step. */
function computerHost(answer) {
  const commands = [];
  return {
    commands,
    run: async (command) => {
      commands.push(command);
      return { text: '', saved_login_response: answer(command) };
    },
  };
}

const host = (options = {}) => {
  const worker = computerHost(options.answer ?? (() => ({ ok: true, result: { action: 'fill_saved_login' } })));
  const state = { on: options.on ?? true, worker, ...vault() };
  return { state, host: createSavedLoginHost({ autoSignIn: () => state.on, credentials: state.credentials, worker, text }) };
};
const ask = (turn = 7, extra = {}) => ({ turn_id: turn, origin: ORIGIN, account: 'j•••e@example.com', field: 'password', ...extra });

test('a value is handed over only for an admitted fill, once per lookup, and nothing is kept', async () => {
  const { state, host: saved } = host();
  await assert.rejects(saved.value('s1', ask()), /not admitted/);
  assert.deepEqual(state.lookups, [], 'an unadmitted fill reaches no vault');
  assert.deepEqual(saved.admit('s1', { turn_id: 7 }), { enabled: true });
  assert.deepEqual(await saved.value('s1', ask()), {
    enabled: true,
    value: PASSWORD,
    label: 'j•••e@example.com',
    origin: ORIGIN,
  });
  assert.deepEqual(await saved.value('s1', ask(7, { field: 'username' })), {
    enabled: true,
    value: 'jane.doe@example.com',
    label: 'j•••e@example.com',
    origin: ORIGIN,
  });
  // Another session or another turn was never admitted.
  await assert.rejects(saved.value('s2', ask()), /not admitted/);
  await assert.rejects(saved.value('s1', ask(8)), /not admitted/);
  // The host's own state holds no value: releasing ends the admission and a later lookup is refused.
  assert.deepEqual(saved.release('s1', { turn_id: 7 }), { released: true });
  await assert.rejects(saved.value('s1', ask()), /not admitted/);
  assert.ok(!JSON.stringify(Object.entries(saved)).includes(PASSWORD));
});

test('the lookup is for the exact secure origin of the fill', async () => {
  const { state, host: saved } = host();
  saved.admit('s1', { turn_id: 7 });
  await assert.rejects(saved.value('s1', ask(7, { origin: 'http://login.example.com' })), /secure origin/);
  await assert.rejects(saved.value('s1', ask(7, { origin: 'https://user:pw@login.example.com' })), /secure origin/);
  await assert.rejects(saved.value('s1', ask(7, { origin: 'not a url' })), /secure origin/);
  assert.deepEqual(state.lookups, []);
  await assert.rejects(saved.value('s1', ask(7, { origin: 'https://evil.example.com/login' })), /no saved login for this origin/);
  assert.deepEqual(state.lookups, [{ url: 'https://evil.example.com', account: 'j•••e@example.com' }]);
  // A page address is reduced to its origin before the vault is asked.
  assert.equal((await saved.value('s1', ask(7, { origin: `${ORIGIN}/signin?next=%2Fhome` }))).origin, ORIGIN);
});

test('Auto login off admits nothing and stops a fill that was admitted', async () => {
  const off = host({ on: false });
  assert.deepEqual(off.host.admit('s1', { turn_id: 7 }), { enabled: false });
  await assert.rejects(off.host.value('s1', ask()), /not admitted/);
  const { state, host: saved } = host();
  saved.admit('s1', { turn_id: 7 });
  state.on = false;
  await assert.rejects(saved.value('s1', ask()), /Auto login is off/);
  assert.deepEqual(state.lookups, []);
});

test('a request that names no session, turn, field or account is refused', async () => {
  const { host: saved } = host();
  assert.throws(() => saved.admit('', { turn_id: 7 }), /no session and agent turn/);
  assert.throws(() => saved.admit('s1', { turn_id: 0 }), /no session and agent turn/);
  assert.throws(() => saved.release('s1', {}), /no session and agent turn/);
  saved.admit('s1', { turn_id: 7 });
  await assert.rejects(saved.value('s1', ask(7, { field: 'otp' })), /field must be username or password/);
  await assert.rejects(saved.value('s1', ask(7, { account: '  ' })), /account must name a saved login/);
});

test('releasing a turn ends it and the older turns of that session only', async () => {
  const { host: saved } = host();
  for (const [session, turn] of [['s1', 1], ['s1', 2], ['s1', 3], ['s2', 1]]) saved.admit(session, { turn_id: turn });
  saved.release('s1', { turn_id: 2 });
  await assert.rejects(saved.value('s1', ask(1)), /not admitted/);
  await assert.rejects(saved.value('s1', ask(2)), /not admitted/);
  assert.equal((await saved.value('s1', ask(3))).value, PASSWORD);
  assert.equal((await saved.value('s2', ask(1))).value, PASSWORD);
});
const TARGET = { window_id: 'hwnd:0x1', pid: '4242', origin: ORIGIN };
const step = (extra = {}) => ({ turn_id: 7, window_id: 'hwnd:0x1', account: 'j•••e@example.com', field: 'password', ...extra });

test('a worker step is the computer host fill command of an admitted fill, and its response comes back as it is', async () => {
  const answer = (command) =>
    command.saved_login_step === 'check'
      ? { ok: true, result: { saved_login_target: TARGET } }
      : { ok: false, error: 'field changed' };
  const { state, host: saved } = host({ answer });
  await assert.rejects(saved.check('s1', step()), /not admitted/);
  assert.deepEqual(state.worker.commands, [], 'an unadmitted fill reaches no computer host');
  saved.admit('s1', { turn_id: 7 });
  assert.deepEqual(await saved.check('s1', step()), { ok: true, result: { saved_login_target: TARGET } });
  assert.deepEqual(await saved.type('s1', step({ text: PASSWORD, expected: TARGET })), { ok: false, error: 'field changed' });
  assert.deepEqual(state.worker.commands, [
    {
      action: 'fill_saved_login',
      session_id: 's1',
      window_id: 'hwnd:0x1',
      saved_account: 'j•••e@example.com',
      field: 'password',
      delivery: 'foreground',
      turn_id: 7,
      runtime_id: 'core',
      saved_login_step: 'check',
    },
    {
      action: 'fill_saved_login',
      session_id: 's1',
      window_id: 'hwnd:0x1',
      saved_account: 'j•••e@example.com',
      field: 'password',
      delivery: 'foreground',
      turn_id: 7,
      runtime_id: 'core',
      saved_login_step: 'type',
      saved_login_text: PASSWORD,
      saved_login_expected: TARGET,
    },
  ]);
  // The check names no value; only the write carries it.
  assert.ok(!JSON.stringify(state.worker.commands[0]).includes(PASSWORD));
  saved.release('s1', { turn_id: 7 });
  await assert.rejects(saved.type('s1', step({ text: PASSWORD, expected: TARGET })), /not admitted/);
});

test('a worker step without its window, account, field, value or checked target is refused before the computer host', async () => {
  const { state, host: saved } = host();
  saved.admit('s1', { turn_id: 7 });
  await assert.rejects(saved.check('s1', step({ window_id: ' ' })), /exact window_id/);
  await assert.rejects(saved.check('s1', step({ account: '' })), /account must name/);
  await assert.rejects(saved.check('s1', step({ field: 'otp' })), /field must be username or password/);
  await assert.rejects(saved.type('s1', step({ expected: TARGET })), /needs its value and the target/);
  await assert.rejects(saved.type('s1', step({ text: PASSWORD })), /needs its value and the target/);
  await assert.rejects(saved.check('', step()), /no session and agent turn/);
  assert.deepEqual(state.worker.commands, []);
});

test('a computer host that gives no worker answer is an error, not a fill', async () => {
  const { host: saved } = host({ answer: () => undefined });
  saved.admit('s1', { turn_id: 7 });
  await assert.rejects(saved.check('s1', step()), /gave no worker answer/);
});