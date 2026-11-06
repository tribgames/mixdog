import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Isolated adapters, never the user's desktop: the electron module is a stub.
const userData = mkdtempSync(join(tmpdir(), 'mixdog-saved-login-step-'));
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
const { createCommandRouter } = await import('./command-router.ts');
const { createExecutionState } = await import('./execution-state.ts');
const { createSessionState } = await import('../session/state.ts');
const { computerRunRecord } = await import('../session/run-log.ts');

const PASSWORD = 'Pa55-"word"\\x';
const LABEL = 'j•••e@example.com';
const TARGET = { window_id: 'hwnd:0x1', pid: '4242', origin: 'https://login.example.com', field: 'password' };
const WINDOWS = { skip: process.platform !== 'win32' && 'saved logins are filled on Windows only' };

/** The router over a fake worker: every request that reached it is kept. The vault must never be asked. */
function routerHost({ enabled = () => true, answers = {} } = {}) {
  const requests = [];
  const vaultAsks = [];
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
    captureAfterAction: async () => assert.fail('a saved-login step never captures the field it filled'),
    callPowerShell: async (request) => {
      requests.push(request);
      return answers[request.action] ?? { ok: true, result: {} };
    },
    savedLogins: {
      enabled,
      vault: {
        async value(...asked) {
          vaultAsks.push(asked);
          throw new Error('the core owns the lookup; the host vault is not asked');
        },
      },
    },
  };
  return { host, requests, vaultAsks };
}

const step = (name, extra = {}) => ({
  action: 'fill_saved_login',
  session_id: 'step-session',
  window_id: 'hwnd:0x1',
  saved_account: LABEL,
  field: 'password',
  delivery: 'foreground',
  turn_id: 7,
  runtime_id: 'core',
  saved_login_step: name,
  ...extra,
});

test('a check step is one authorized worker request whose response comes back unsettled', WINDOWS, async () => {
  const response = { ok: true, result: { saved_login_target: TARGET } };
  const { host, requests, vaultAsks } = routerHost({ answers: { saved_login_check: response } });
  const reply = await createCommandRouter(host).runCommand(step('check'));
  assert.deepEqual(reply, { text: '', saved_login_response: response });
  assert.deepEqual(
    requests.map((request) => [request.action, request.field, request.text, request.observed_input_monitor_id, request.observed_input_user_sequence]),
    [['saved_login_check', 'password', null, 'monitor-1', 7]]
  );
  assert.deepEqual(vaultAsks, []);
});

test('a type step writes the core value once after the last Auto login check, and a worker failure is returned, not thrown', WINDOWS, async () => {
  const failed = { ok: false, error: 'the field changed' };
  const { host, requests, vaultAsks } = routerHost({ answers: { saved_login_type: failed } });
  const router = createCommandRouter(host);
  const command = step('type', { saved_login_text: PASSWORD, saved_login_expected: TARGET });
  const startedAt = performance.now();
  const reply = await router.runCommand(command);
  assert.deepEqual(reply, { text: '', saved_login_response: failed });
  assert.deepEqual(
    requests.map((request) => [request.action, request.field, request.text, request.expected]),
    [['saved_login_type', 'password', PASSWORD, TARGET]]
  );
  assert.deepEqual(vaultAsks, []);
  // Nothing the host logs about the command or its reply holds the value.
  assert.equal(JSON.stringify([computerRunRecord(command, startedAt, reply), reply]).includes('Pa55'), false);
});

test('Auto login switched off sends nothing, before the check and right before the write', WINDOWS, async () => {
  const off = routerHost({ enabled: () => false });
  await assert.rejects(createCommandRouter(off.host).runCommand(step('check')), /saved_login_unavailable: Auto login is off/);
  assert.deepEqual(off.requests, []);
  let on = true;
  const late = routerHost({ enabled: () => on });
  // The observe-only gate runs right after the authorization, just before the secret-bearing request.
  late.host.isObserveOnly = () => {
    on = false;
    return false;
  };
  await assert.rejects(
    createCommandRouter(late.host).runCommand(step('type', { saved_login_text: PASSWORD, saved_login_expected: TARGET })),
    /Auto login is off/
  );
  assert.deepEqual(late.requests, [], 'the value was never sent');
});