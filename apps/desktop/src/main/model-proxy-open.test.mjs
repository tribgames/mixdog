// While a server connection is open its model sends run on this PC like local
// use: no grant, time, call, token, rate or concurrency limit applies (only the
// size guards, model-proxy-host-trust.test.mjs). Old saved grant and
// background settings are read and ignored.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DESKTOP_IPC } from '../shared/contract.ts';
import { createDesktopConnection } from './connections/index.ts';
import { createModelProxyHost } from './model-proxy-host.ts';
import { parseHostSettings } from './ssh/ssh-host-store.ts';
import {
  MODEL_PROXY_REQUEST_EVENT,
  ModelProxyChannel,
} from '../../../../src/runtime/agent/orchestrator/providers/model-proxy-channel.mjs';
import { ModelProxyProvider } from '../../../../src/runtime/agent/orchestrator/providers/model-proxy-provider.mjs';

async function within(promise, limitMs = 5_000) {
  let timer;
  const limit = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${limitMs}ms`)), limitMs);
  });
  try {
    return await Promise.race([promise, limit]);
  } finally {
    clearTimeout(timer);
  }
}

/** A provider reporting `tokens` of usage per send. */
function usageProvider(tokens) {
  const provider = {
    sends: 0,
    async send() {
      provider.sends += 1;
      return { content: 'ok', usage: { inputTokens: tokens, outputTokens: 0 } };
    },
    async listModels() {
      return ['gpt'];
    },
  };
  return provider;
}

function fakeRuntime(provider) {
  return {
    provider: async (name) => (name === 'openai' ? provider : undefined),
    providerConfig: async () => ({ providers: { openai: { enabled: true } }, ready: true }),
    finalizeTools: (tools) => tools,
  };
}

function connect(t, provider, hostOptions) {
  const channel = new ModelProxyChannel();
  const host = createModelProxyHost({
    invoke: async (operation, args) =>
      JSON.parse(JSON.stringify((await channel.handleOperation(operation, JSON.parse(JSON.stringify(args)))) ?? null)),
    loadRuntime: async () => fakeRuntime(provider),
    ...hostOptions,
  });
  const detach = channel.attachPublisher((snapshot) => {
    const value = JSON.parse(JSON.stringify(snapshot));
    setImmediate(() => host.handleDesktopEvent(MODEL_PROXY_REQUEST_EVENT, value));
  });
  t.after(() => {
    detach();
    host.dispose();
  });
  const send = () => within(new ModelProxyProvider('openai', {}, channel).send([], 'gpt', undefined, {}));
  return { channel, host, send };
}

test('sends run with no action in the window, however many calls and tokens they add up to', async (t) => {
  const provider = usageProvider(25_000_000);
  const { send } = connect(t, provider);
  // Past the old 2000-call and 20M-token totals of a grant, and 25M tokens in one call.
  for (let sent = 0; sent < 2_100; sent += 1) await send();
  assert.equal(provider.sends, 2_100);
});

test('a server connection has no grant to trust, view or keep alive', async (t) => {
  const { host } = connect(t, usageProvider(1));
  assert.equal(host.trust, undefined);
  assert.equal(host.grant, undefined);
  assert.equal(DESKTOP_IPC.connectionAllowModelUse, undefined);
  assert.equal(DESKTOP_IPC.sshHostModelUse, undefined);
  const connection = createDesktopConnection(
    { id: 'srv-open', kind: 'ssh', name: 'Box', target: 'root@127.0.0.1:2223' },
    {
      moduleUrl: () => 'file:///unused.mjs',
      environmentReady: () => Promise.resolve(),
      sessionOptions: () => ({
        userDataPath: '',
        packaged: false,
        resourcesPath: '',
        appPath: '',
        appVersion: '0.0.0',
        rendererDir: '',
      }),
      loadModelProxyRuntime: async () => fakeRuntime(usageProvider(1)),
      appVersion: '0.0.0',
      bundlePath: 'daemon.cjs',
    }
  );
  t.after(() => connection.dispose());
  assert.equal(connection.modelProxy.trust, undefined);
  assert.equal(connection.modelProxy.grant, undefined);
});

test('old saved grant and background settings load and are ignored', () => {
  assert.deepEqual(
    parseHostSettings({
      grantMinutes: 30,
      grantCalls: 5_000,
      grantTokens: 'junk',
      allowBackgroundModelUse: true,
      backgroundCallsPerHour: 10,
      backgroundTokensPerDay: 5,
      graceMinutes: 20,
    }),
    { graceMinutes: 20 }
  );
  assert.deepEqual(parseHostSettings({ grantMinutes: 5, backgroundCallsPerHour: 1.5 }), {});
});
