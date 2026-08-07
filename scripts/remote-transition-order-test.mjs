#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createRemoteTransitionQueue } from '../src/session-runtime/remote-transition-queue.mjs';
import { createRemoteTranscript } from '../src/session-runtime/remote-transcript.mjs';
import { createSessionApiB } from '../src/tui/session/session-api-ext.mjs';

test('remote OFF completes before the following ON starts', async () => {
  const queue = createRemoteTransitionQueue();
  const events = [];
  let finishOff;
  const offGate = new Promise((resolve) => { finishOff = resolve; });
  const off = queue.run(async () => {
    events.push('off:start');
    await offGate;
    events.push('off:done');
  });
  const on = queue.run(async () => {
    events.push('on:start');
    events.push('on:done');
  });

  await Promise.resolve();
  assert.deepEqual(events, ['off:start']);
  finishOff();
  await Promise.all([off, on]);
  assert.deepEqual(events, ['off:start', 'off:done', 'on:start', 'on:done']);
});

test('a failed transition does not poison later Remote toggles', async () => {
  const queue = createRemoteTransitionQueue();
  await assert.rejects(queue.run(async () => { throw new Error('disconnect failed'); }));
  let restarted = false;
  await queue.run(async () => { restarted = true; });
  assert.equal(restarted, true);
  await queue.settled();
});

test('runtime Remote capabilities await the serialized lifecycle', async () => {
  // The lifecycle itself moved into remote-control.mjs; runtime-core still owns
  // the queue instance it is handed.
  const [runtime, control, turn] = await Promise.all([
    readFile(new URL('../src/session-runtime/runtime-core.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/session-runtime/remote-control.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/session-runtime/session-turn-api.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(runtime, /const remoteTransitions = createRemoteTransitionQueue\(\);/);
  assert.match(runtime, /remoteTransitions,/);
  assert.equal((control.match(/return remoteTransitions\.run\(async \(\) => \{/g) || []).length, 2);
  const releaseBlock = control.match(/function releaseRemote\(reason\) \{([\s\S]*?)\n  \}\n\n  \/\//)?.[1];
  assert.ok(releaseBlock, 'releaseRemote block should be present');
  assert.doesNotMatch(releaseBlock, /\}\)\(\);/);
  assert.doesNotMatch(runtime, /remoteAutoStartRequested|claimIfVacant/);
  assert.doesNotMatch(control, /intent === ['"]auto['"]|claimIfVacant/);
  assert.doesNotMatch(turn, /channels\.execute\(['"]activate_channel_bridge['"]/);
});

test('transcript refresh never transfers Remote to another session', () => {
  let owner = 'manual-owner';
  const remote = createRemoteTranscript({
    getSession: () => ({ id: 'other-session' }),
    getCwd: () => process.cwd(),
    isRemoteEnabled: () => true,
    getRemoteSessionId: () => owner,
    setRemoteSessionId: (next) => { owner = next; },
    isCloseRequested: () => false,
    channelsEnabled: () => true,
    channels: { execute: async () => ({ ok: true }) },
    bootProfile: () => {},
  });
  assert.equal(remote.ensureRemoteTranscriptWriter(), false);
  assert.equal(owner, 'manual-owner');
});

test('Remote capabilities paint desired state before the session settles', async () => {
  let state = {
    sessionId: 'session-a',
    remoteEnabled: false,
    remoteSessionId: null,
  };
  let sessionEnabled = false;
  let sessionSessionId = null;
  let finishClaim;
  let finishRelease;
  const claimGate = new Promise((resolve) => { finishClaim = resolve; });
  const releaseGate = new Promise((resolve) => { finishRelease = resolve; });
  const runtime = {
    startRemote: async () => {
      await claimGate;
      sessionEnabled = true;
      sessionSessionId = 'session-a';
    },
    releaseRemote: async () => {
      await releaseGate;
      sessionEnabled = false;
      sessionSessionId = null;
    },
    isRemoteEnabled: () => sessionEnabled,
    getRemoteSessionId: () => sessionSessionId,
  };
  const api = createSessionApiB({
    runtime,
    getState: () => state,
    set: (update) => { state = { ...state, ...update }; },
  });

  const claiming = api.claimRemote();
  assert.equal(state.remoteEnabled, true);
  assert.equal(state.remoteSessionId, 'session-a');
  finishClaim();
  assert.equal(await claiming, true);
  assert.equal(state.remoteEnabled, true);

  const releasing = api.releaseRemote();
  assert.equal(state.remoteEnabled, false);
  assert.equal(state.remoteSessionId, null);
  finishRelease();
  assert.equal(await releasing, false);
  assert.equal(state.remoteEnabled, false);
});

test('an optimistic Remote claim reconciles after session failure', async () => {
  let state = {
    sessionId: 'session-a',
    remoteEnabled: false,
    remoteSessionId: null,
  };
  let failClaim;
  const gate = new Promise((_, reject) => { failClaim = reject; });
  const api = createSessionApiB({
    runtime: {
      startRemote: () => gate,
      isRemoteEnabled: () => false,
      getRemoteSessionId: () => null,
    },
    getState: () => state,
    set: (update) => { state = { ...state, ...update }; },
  });

  const claiming = api.claimRemote();
  assert.equal(state.remoteEnabled, true);
  failClaim(new Error('cold boot failed'));
  await assert.rejects(claiming, /cold boot failed/);
  assert.equal(state.remoteEnabled, false);
  assert.equal(state.remoteSessionId, null);
});
