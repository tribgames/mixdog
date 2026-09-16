import assert from 'node:assert/strict';
import test from 'node:test';
import { createSequenceRunner } from './sequence-runner.ts';
import { createInputPreflight } from './input-preflight.ts';
import { normalizeComputerKeySequence } from '../input/keyboard.ts';

test('preflight uses dispatch grammar and preserves native refs on app-owned targets', async () => {
  const requests = [];
  const preflight = createInputPreflight({
    sessionIdFor: () => 'preflight',
    assertExecutionNotAborted() {},
    resolveElementAliases: (command) => (command.element === 1 ? { ...command, ref: 's1:e1' } : command),
    isAppOwnedWindow: () => true,
    callPowerShell: async (request) => {
      requests.push(request);
      return { ok: true };
    },
  });
  const command = { action: 'sequence', window_id: 'hwnd:0x1', delivery: 'background' };
  await preflight(command, [
    { ...command, action: 'key', keys: 'ctrl-s' },
    { ...command, action: 'key', keys: 'PageDown' },
    { ...command, action: 'type', text: 'private-text' },
    { ...command, action: 'type', element: 1, text: 'private-text' },
  ]);
  assert.deepEqual(requests[0].steps, [
    { action: 'key', keys: normalizeComputerKeySequence('ctrl-s') },
    { action: 'key', keys: normalizeComputerKeySequence('PageDown') },
    { action: 'type', ref: 's1:e1' },
  ]);
  assert.equal(requests[0].steps[0].keys, '^S');
  assert.equal(requests[0].steps[1].keys, '{PGDN}');
  assert.equal(requests[0].read_only, true);
  assert.equal(JSON.stringify(requests).includes('private-text'), false);
  await preflight({ ...command, delivery: 'foreground' }, [{ action: 'key', keys: 'ctrl-s' }]);
  assert.equal(requests.length, 1);
});

test('canonical modifier aliases fail preflight before the sequence can click', async () => {
  let clicks = 0;
  const preflight = createInputPreflight({
    sessionIdFor: () => 'preflight',
    assertExecutionNotAborted() {},
    resolveElementAliases: (command) => command,
    isAppOwnedWindow: () => false,
    callPowerShell: async (request) => {
      assert.equal(request.steps[0].keys, '^S');
      return { ok: false, error: 'background_unsupported|modifier input is unavailable; no input sent' };
    },
  });
  const runner = createSequenceRunner({
    sessionIdFor: () => 'preflight',
    freshObservedWindowScope: () => ({
      primaryWindowId: 'hwnd:0x1',
      relatedWindowIds: ['hwnd:0x1'],
      observedAt: performance.now(),
    }),
    preflightSteps: preflight,
    runCommand: async () => {
      clicks++;
      return { text: '{}' };
    },
    captureAfterAction: async () => ({ metadata: { ok: true } }),
  });
  await assert.rejects(
    runner.runBoundedSequence({
      action: 'sequence',
      window_id: 'hwnd:0x1',
      delivery: 'background',
      steps: [
        { action: 'click', ref: 's1:e1' },
        { action: 'key', keys: 'ctrl-s' },
      ],
    }),
    /background_unsupported/
  );
  assert.equal(clicks, 0);
});

test('all sequence steps are preflighted before any input, without changing delivery', async () => {
  const events = [];
  const runner = createSequenceRunner({
    sessionIdFor: () => 'preflight-test',
    freshObservedWindowScope: () => ({
      primaryWindowId: 'hwnd:0x1',
      relatedWindowIds: ['hwnd:0x1'],
      observedAt: performance.now(),
    }),
    preflightSteps: async (command, steps) => {
      events.push({
        kind: 'preflight',
        delivery: command.delivery,
        actions: steps.map((step) => step.action),
        keys: steps[1].keys,
      });
      throw new Error('background_unsupported|modifier keys require explicit foreground; no input sent');
    },
    runCommand: async () => {
      events.push({ kind: 'input' });
      return { text: '{}' };
    },
    captureAfterAction: async () => {
      events.push({ kind: 'capture' });
      return { metadata: { ok: true } };
    },
  });
  await assert.rejects(
    runner.runBoundedSequence({
      action: 'sequence',
      window_id: 'hwnd:0x1',
      delivery: 'background',
      steps: [
        { action: 'click', ref: 's1:e1' },
        { action: 'key', keys: '^s' },
      ],
    }),
    /background_unsupported/
  );
  assert.deepEqual(events, [{ kind: 'preflight', delivery: 'background', actions: ['click', 'key'], keys: '^s' }]);
});
