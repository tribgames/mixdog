import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

// Isolated adapters, never the user's desktop.
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron' ? {
      url: 'data:text/javascript,' + encodeURIComponent(`
        export const BrowserWindow = { getAllWindows: () => [] };
        export const desktopCapturer = { getSources: async () => globalThis.auditCaptureSources || [] };
        export const nativeImage = {};
        export const screen = {};
      `), shortCircuit: true,
    } : next(specifier, context);
  },
});
const { createCommandRouter } = await import('./command-router.ts');
const { createComputerExecutionPolicy } = await import('./execution-policy.ts');
const { createCaptureEngine } = await import('../observation/capture.ts');
const { createComputerCommandBudget } = await import('./command-budget.ts');

// The command router refuses every command off Windows before any routing runs.
const WINDOWS_ONLY = { skip: process.platform !== 'win32' };

test('observation-only routing refuses every input family before backend dispatch', WINDOWS_ONLY, async () => {
  let dispatched = 0;
  const router = createCommandRouter({
    isObserveOnly: () => true, sessionIdFor: () => 'test',
    callPowerShell: async () => { dispatched++; return { ok: true }; },
    runBoundedSequence: async () => { dispatched++; return { text: '' }; },
    diagnoseComputer: async () => ({ text: 'diagnosed' }),
  });
  for (const action of ['sequence', 'key', 'type', 'launch', 'clipboard_write', 'close_window']) {
    await assert.rejects(router.runCommand({ action }), /observation_only/);
  }
  assert.equal((await router.runCommand({ action: 'diagnose' })).text, 'diagnosed');
  assert.equal(dispatched, 0);
});

test('authority which expires during preparation never reaches the input backend', WINDOWS_ONLY, async () => {
  let now = 0;
  let dispatched = 0;
  const policy = createComputerExecutionPolicy({
    version: 1, actions: ['clipboard_write'], windows: [], expiresAt: new Date(1000).toISOString(),
  }, () => now);
  const router = createCommandRouter({
    policy, isObserveOnly: () => false, sessionIdFor: () => 'test',
    framesBySession: new Map(), elementTargetsBySession: new Map(), observedWindowBySession: new Map(),
    lastCaptureBySession: new Map(), sessionRecoveryBySession: new Map(),
    assertExecutionNotAborted() {}, resolveElementAliases: (command) => command,
    resolveInputTarget: async () => ({ allowedWindowIds: [] }), claimComputerTargets: async () => {},
    readComputerWindows: async () => { now = 2000; return []; },
    callPowerShell: async () => { dispatched++; return { ok: true }; },
  });
  await assert.rejects(router.runCommand({ action: 'clipboard_write', text: 'fixture' }), /computer_policy_expired/);
  assert.equal(dispatched, 0);
});

test('unavailable window compositor never falls back to pixels belonging to another window', async () => {
  const calls = [];
  const capture = createCaptureEngine({
    sessionIdFor: () => 'test', assertExecutionNotAborted() {},
    callPowerShell: async (request) => {
      calls.push(request.action);
      return { ok: true, result: {
        window_id: 'hwnd:0x1', title: 'Fixture', x: 0, y: 0, width: 600, height: 600,
        visible_samples: 5, image_base64: 'cHJpdmF0ZQ==',
      } };
    },
  });
  for (const sources of [[], [{ id: 'window:2:1', thumbnail: {} }]]) {
    globalThis.auditCaptureSources = sources;
    const result = await capture.captureScreenshot({ action: 'capture', window_id: 'hwnd:0x1' });
    assert.equal(result.image, undefined);
    assert.equal(result.pixelUnavailable.code, 'pixel_unavailable');
  }
  delete globalThis.auditCaptureSources;
  assert.deepEqual(calls, ['window_bounds', 'window_bounds']);
});

test('pending command admission is bounded per session and globally and releases once', () => {
  const budget = createComputerCommandBudget(3, 2);
  const first = budget.acquire('a');
  const second = budget.acquire('a');
  assert.throws(() => budget.acquire('a'), /capacity_exhausted/);
  const third = budget.acquire('b');
  assert.throws(() => budget.acquire('c'), /capacity_exhausted/);
  first(); first();
  budget.acquire('c')();
  second(); third();
});
