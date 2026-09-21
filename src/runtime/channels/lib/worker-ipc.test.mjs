import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const sent = [];
mock.module(new URL('../../shared/safe-ipc-send.mjs', import.meta.url).href, {
  namedExports: {
    safeIpcSend: (_process, message) => {
      sent.push(message);
      return true;
    },
  },
});
const { runWorkerIpc } = await import('./worker-ipc.mjs');

test('worker IPC preserves dependency reads, readiness, and tool result/error envelopes', async (t) => {
  const handlers = new Map();
  const register = (event, handler) => {
    handlers.set(event, handler);
    return process;
  };
  t.mock.method(process, 'on', register);
  t.mock.method(process, 'once', register);
  const reads = [];
  const calls = [];
  runWorkerIpc({
    start: async () => calls.push('start'),
    stop: async () => {},
    stopVoiceWhisperServer: async () => {},
    cleanupInstanceRuntimeFiles() {},
    clearServerPid() {},
    instanceId: 'fixture',
    get statusState() {
      reads.push('statusState');
      return {};
    },
    get getProvider() {
      reads.push('getProvider');
      return () => ({});
    },
    get getConfig() {
      reads.push('getConfig');
      return () => ({});
    },
    handleMemoryCallResponse: () => false,
    handleToolCallWithBridgeRetry: async (name, args, signal) => {
      calls.push({ name, args, aborted: signal.aborted });
      if (name === 'fail') throw new Error('fixture error');
      return { content: [{ type: 'text', text: 'fixture result' }] };
    },
    bootProfile() {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reads, ['statusState', 'getProvider', 'getConfig']);
  assert.deepEqual(calls, ['start']);
  assert.deepEqual(sent, [{ type: 'ready' }]);

  await handlers.get('message')({ type: 'call', callId: 'one', name: 'fixture', args: { active: true } });
  await handlers.get('message')({ type: 'call', callId: 'two', name: 'fail' });
  assert.deepEqual(calls.slice(1), [
    { name: 'fixture', args: { active: true }, aborted: false },
    { name: 'fail', args: {}, aborted: false },
  ]);
  assert.deepEqual(sent.slice(1), [
    { type: 'result', callId: 'one', result: { content: [{ type: 'text', text: 'fixture result' }] } },
    { type: 'result', callId: 'two', error: 'fixture error' },
  ]);
});
