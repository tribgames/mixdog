import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { callAgentDispatch } from '../src/runtime/memory/lib/agent-ipc.mjs';
import { createAgentDispatchBroker } from '../src/standalone/agent-dispatch-broker.mjs';
import { createChannelTransport } from '../src/standalone/channel-transport.mjs';

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test('singleton agent broker keeps memory dispatch parallel and cancellation isolated', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-agent-broker-'));
  const previousRoot = process.env.MIXDOG_RUNTIME_ROOT;
  process.env.MIXDOG_RUNTIME_ROOT = root;
  const gates = new Map();
  const started = [];
  let active = 0;
  let maxActive = 0;
  let providerInitCalls = 0;
  const activity = [];

  const broker = createAgentDispatchBroker({
    loadConfig: () => ({ providers: { stub: { enabled: true } } }),
    initProviders: async () => { providerInitCalls += 1; },
    onActivityChanged: (snapshot) => activity.push(snapshot.inFlight),
    makeAgentDispatch: ({ agent }) => async ({ prompt, parentSignal }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      started.push({ agent, prompt });
      try {
        if (prompt === 'abort-me') {
          await new Promise((resolve, reject) => {
            const onAbort = () => reject(parentSignal.reason || new Error('aborted'));
            if (parentSignal.aborted) onAbort();
            else parentSignal.addEventListener('abort', onAbort, { once: true });
          });
        } else {
          const gate = Promise.withResolvers();
          gates.set(prompt, gate);
          await gate.promise;
        }
        return `done:${prompt}`;
      } finally {
        active -= 1;
      }
    },
  });
  const transport = createChannelTransport({
    handleCall: async () => ({ ok: true }),
    agentBroker: broker,
  });
  const endpoint = await transport.start();
  writeFileSync(join(root, 'daemon.json'), JSON.stringify({
    pid: process.pid,
    startedAt: Date.now(),
    endpoints: { channel: endpoint },
  }));
  t.after(async () => {
    await transport.stop();
    broker.close('test cleanup');
    if (previousRoot === undefined) delete process.env.MIXDOG_RUNTIME_ROOT;
    else process.env.MIXDOG_RUNTIME_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
  });

  await broker.warmup();

  const first = callAgentDispatch({ agent: 'cycle1-agent', timeout: 5000 }, 'first');
  const second = callAgentDispatch({ agent: 'cycle2-agent', timeout: 5000 }, 'second');
  while (started.length < 2) await nextTurn();
  assert.equal(maxActive, 2, 'singleton broker must not serialize independent cycle calls');
  assert.equal(broker.snapshot().inFlight, 2);
  gates.get('first').resolve();
  gates.get('second').resolve();
  assert.deepEqual(await Promise.all([first, second]), ['done:first', 'done:second']);

  const burstSize = 24;
  const burst = Array.from({ length: burstSize }, (_, index) => {
    const prompt = `burst-${index}`;
    return callAgentDispatch({
      agent: `cycle${(index % 3) + 1}-agent`,
      timeout: 5000,
    }, prompt);
  });
  while (started.filter((entry) => entry.prompt.startsWith('burst-')).length < burstSize) {
    await nextTurn();
  }
  assert.equal(broker.snapshot().inFlight, burstSize);
  assert.ok(maxActive >= burstSize, 'all default-lane burst calls must run concurrently');
  for (let index = 0; index < burstSize; index += 1) {
    gates.get(`burst-${index}`).resolve();
  }
  assert.deepEqual(
    await Promise.all(burst),
    Array.from({ length: burstSize }, (_, index) => `done:burst-${index}`),
  );

  const controller = new AbortController();
  const canceled = callAgentDispatch({
    agent: 'cycle3-agent',
    timeout: 5000,
    signal: controller.signal,
  }, 'abort-me');
  while (!started.some((entry) => entry.prompt === 'abort-me')) await nextTurn();
  controller.abort(new Error('cycle caller stopped'));
  await assert.rejects(canceled, /cycle caller stopped/);

  assert.equal(broker.snapshot().activeMax, null);
  assert.equal(broker.snapshot().dispatchers, 3);
  assert.equal(providerInitCalls, 1, 'identical provider config is prepared once for the whole singleton');
  assert.ok(activity.some((count) => count === burstSize));
  assert.equal(activity.at(-1), 0);
});

test('memory runtime source does not load a second provider or Transformers graph', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/runtime/memory/index.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /orchestrator\/providers\/registry\.mjs/);
  assert.doesNotMatch(source, /agent-runtime\/agent-dispatch\.mjs/);
  assert.doesNotMatch(source, /@huggingface\/transformers/);
  assert.match(source, /createCycleLlmAdapters\(\{ callAgentDispatch \}\)/);
});

test('canceling one waiter never cancels shared provider preparation or its peer', async () => {
  const providerGate = Promise.withResolvers();
  const calls = [];
  const broker = createAgentDispatchBroker({
    loadConfig: () => ({ providers: { stub: { enabled: true } } }),
    initProviders: () => providerGate.promise,
    makeAgentDispatch: ({ agent }) => async ({ prompt }) => {
      calls.push([agent, prompt]);
      return `done:${prompt}`;
    },
  });
  const first = broker.dispatch({
    agent: 'cycle1-agent',
    prompt: 'first',
  }, { callId: 'first' });
  const second = broker.dispatch({
    agent: 'cycle2-agent',
    prompt: 'second',
  }, { callId: 'second' });
  await nextTurn();

  const firstCanceled = broker.cancelAndWait('first', 'only first stopped');
  providerGate.resolve();
  assert.equal(await firstCanceled, true);
  await assert.rejects(first, /only first stopped/);
  assert.equal(await second, 'done:second');
  assert.deepEqual(calls, [['cycle2-agent', 'second']]);
  broker.close('test cleanup');
});
