import assert from 'node:assert/strict';
import test from 'node:test';
import { createCaptureAuthorizer, listAuthorizationWindows } from './host-authorization.ts';
import { fillSavedLogin } from './saved-login.ts';
import { CHROME_SETUP_SESSION_ID } from '../shared/common.ts';
import { secretInputs } from '../../secret-input.ts';

const capture = (extra = {}) => ({ action: 'capture', session_id: 'auth-session', mode: 'state', ...extra });

function policyStub(restricted) {
  const asserted = [];
  return {
    asserted,
    policy: {
      restricted,
      assertWindow: (command, records) => asserted.push({ command, records }),
    },
  };
}

function authorizer({ restricted = false, windows = [] } = {}) {
  const reads = [];
  const fates = [];
  const { policy, asserted } = policyStub(restricted);
  const authorize = createCaptureAuthorizer({
    policy,
    readComputerWindows: async (command) => {
      reads.push(command);
      return windows;
    },
    sessionIdFor: (command) => String(command.session_id || 'default'),
    processFate: async (process) => {
      fates.push(process);
      return { state: 'running', created: '' };
    },
  });
  return { authorize, reads, fates, asserted };
}

test('authorization settings list the current app windows by id, pid, app and title only', async () => {
  const calls = [];
  const listed = await listAuthorizationWindows(async (...args) => {
    calls.push(args);
    return [{ id: 'hwnd:0x1', pid: 7, app: 'notepad', title: 'a.txt', className: 'Edit', focused: true }];
  });
  assert.deepEqual(calls, [[{ action: 'list_windows', session_id: 'computer-settings' }, true]]);
  assert.deepEqual(listed, [{ id: 'hwnd:0x1', pid: 7, app: 'notepad', title: 'a.txt' }]);
  await assert.rejects(
    listAuthorizationWindows(async () => null),
    /^Error: computer_windows_unavailable: could not read current app windows$/
  );
});

test('an unrestricted policy and the Chrome setup session capture without a window check', async () => {
  const open = authorizer();
  await open.authorize(capture(), '');
  assert.deepEqual(open.reads, []);
  assert.deepEqual(open.asserted, []);
  const setup = authorizer({ restricted: true });
  await setup.authorize(capture({ session_id: CHROME_SETUP_SESSION_ID }), '');
  assert.deepEqual(setup.asserted, []);
});

test('a restricted policy refuses full screen and checks the window as a capture', async () => {
  const windows = [{ id: 'hwnd:0x2', pid: 9 }];
  const gated = authorizer({ restricted: true, windows });
  await assert.rejects(
    gated.authorize(capture(), ''),
    /^Error: computer_policy_denied: full-screen capture is not authorized$/
  );
  await gated.authorize(capture({ action: 'zoom', window_id: 'hwnd:0x9' }), 'hwnd:0x2');
  assert.deepEqual(gated.asserted, [
    { command: { ...capture(), action: 'capture', window_id: 'hwnd:0x2' }, records: windows },
  ]);
});

test('a saved-login guard is checked first, against the live owner of the target window', async () => {
  const owner = '00000000-0000-4000-8000-0000000000a1';
  const turn = { sessionId: 'auth-fill', turnId: 3, ownerId: owner };
  const target = {
    window_id: 'hwnd:0x1',
    pid: '4242',
    start_time: '133700000000000001',
    origin: 'https://login.example.com',
    document_id: '42.1.4.5.1.20',
    runtime_id: '42.1.4.5.1.77',
    field: 'password',
    value_length: 0,
  };
  const detach = secretInputs.attachSavedLoginOwner(owner, { pid: 4001, created: '1' });
  const finish = secretInputs.admitSavedLoginFill(turn);
  assert.equal(typeof finish, 'function');
  try {
    await fillSavedLogin(
      {
        action: 'fill_saved_login',
        session_id: turn.sessionId,
        window_id: 'hwnd:0x1',
        saved_account: 'j•••e@example.com',
        field: 'password',
        delivery: 'foreground',
        turn_id: turn.turnId,
        runtime_id: owner,
      },
      {
        enabled: () => true,
        vault: {
          value: async () => ({ value: 'Guarded-Pa55', label: 'j•••e@example.com', origin: target.origin }),
        },
      },
      async (request, beforeSend) => {
        beforeSend?.();
        return request.action === 'saved_login_check'
          ? { ok: true, result: { saved_login_target: target } }
          : { ok: true, result: { action: 'fill_saved_login', path: 'uia_setvalue', effect: 'confirmed' } };
      },
      { platform: 'win32' }
    );
  } finally {
    finish();
  }
  try {
    // Unrestricted: the guard alone decides. Another window of the filled
    // browser's process is found in the window list case-insensitively.
    const browser = authorizer({ windows: [{ id: 'HWND:0X2', pid: 4242 }] });
    await assert.rejects(browser.authorize(capture(), 'hwnd:0x2'), /^Error: capture_withheld: /);
    assert.deepEqual(browser.reads, [capture()]);
    const other = authorizer({ windows: [{ id: 'hwnd:0x9', pid: 777 }] });
    await other.authorize(capture(), 'hwnd:0x9');
    // A window whose owner cannot be read refuses.
    await assert.rejects(authorizer({ windows: [] }).authorize(capture(), 'hwnd:0x9'), /^Error: capture_withheld: /);
  } finally {
    await secretInputs.settleSavedLoginTurn(turn);
    detach?.();
    secretInputs.forget(turn.sessionId);
  }
  assert.deepEqual(secretInputs.savedLoginPixelGuards(), []);
});
