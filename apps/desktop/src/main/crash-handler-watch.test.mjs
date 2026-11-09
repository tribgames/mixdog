import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { waitForQuiet, waitUntil } from '../shared/core-src/runtime/shared/wait-until.test-support.mjs';
import { CRASHPAD_PIPE_ENV, crashHandlerFinderScript, watchCrashHandler } from './crash-handler-watch.ts';

function fakeFinder() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  // The finder prints once and exits.
  child.finish = (line, code = 0) => {
    if (line) child.stdout.write(`${line}\r\n`);
    child.exitCode = code;
    setImmediate(() => child.emit('close', code, null));
  };
  return child;
}

function startWatch(env) {
  const finder = fakeFinder();
  const events = [];
  const alive = new Set();
  let polls = 0;
  let script = '';
  const stop = watchCrashHandler({
    mainPid: 4242,
    env,
    pollMs: 1,
    onEvent: (event) => events.push(event),
    isAlive: (pid) => {
      polls += 1;
      return alive.has(pid);
    },
    spawnFinder: (source) => {
      script = source;
      return finder;
    },
  });
  const eventCount = (count) => waitUntil(() => events.length >= count, { message: `\${count} watch event(s)` });
  // Resolves once the poller has gone quiet (no liveness probe for a window).
  const pollingStopped = () => waitForQuiet(() => polls);
  return { finder, events, alive, stop, eventCount, pollingStopped, script: () => script };
}

test('a handler that dies later is reported and its dead pipe is dropped for later children', async () => {
  const env = { [CRASHPAD_PIPE_ENV]: '\\\\.\\pipe\\crashpad_4242_DEAD', PATH: 'C:\\Windows' };
  const { finder, events, alive, eventCount, pollingStopped, script } = startWatch(env);
  assert.match(script(), /ParentProcessId = 4242/);
  alive.add(777);
  finder.finish('found 777');
  await eventCount(1);
  assert.deepEqual(events, [{ state: 'watching', handlerPid: 777 }]);
  assert.equal(env[CRASHPAD_PIPE_ENV], '\\\\.\\pipe\\crashpad_4242_DEAD', 'a live handler keeps its pipe');
  alive.delete(777);
  await eventCount(2);
  assert.deepEqual(events.slice(1), [{ state: 'lost', handlerPid: 777, reason: 'exited', pipeCleared: true }]);
  assert.equal(CRASHPAD_PIPE_ENV in env, false);
  assert.equal(env.PATH, 'C:\\Windows');
  await pollingStopped();
  assert.equal(events.length, 2, 'polling stops after the loss');
});

test('a handler absent when the watch starts, or gone before polling, counts as lost', async () => {
  const absentEnv = { [CRASHPAD_PIPE_ENV]: '\\\\.\\pipe\\crashpad_4242_GONE' };
  const absent = startWatch(absentEnv);
  absent.finder.finish('missing');
  await absent.eventCount(1);
  assert.deepEqual(absent.events, [{ state: 'lost', handlerPid: null, reason: 'missing', pipeCleared: true }]);
  assert.equal(CRASHPAD_PIPE_ENV in absentEnv, false);

  const raceEnv = { [CRASHPAD_PIPE_ENV]: '\\\\.\\pipe\\crashpad_4242_RACE' };
  const race = startWatch(raceEnv);
  race.finder.finish('found 31');
  await race.eventCount(1);
  assert.deepEqual(race.events, [{ state: 'lost', handlerPid: 31, reason: 'missing', pipeCleared: true }]);
});

test('a finder that fails or cannot start is reported without touching the pipe', async () => {
  const env = { [CRASHPAD_PIPE_ENV]: '\\\\.\\pipe\\crashpad_4242_LIVE' };
  const broken = startWatch(env);
  broken.finder.finish('', 1);
  await broken.eventCount(1);
  assert.deepEqual(broken.events, [{ state: 'watch-failed', reason: 'finder exited code=1 signal=-' }]);

  const failed = startWatch(env);
  failed.finder.emit('error', new Error('spawn powershell.exe ENOENT'));
  await failed.eventCount(1);
  assert.deepEqual(failed.events, [{ state: 'watch-failed', reason: 'spawn powershell.exe ENOENT' }]);
  assert.equal(env[CRASHPAD_PIPE_ENV], '\\\\.\\pipe\\crashpad_4242_LIVE');
});

test('stopping the watch at quit silences the handler exit that follows', async () => {
  const env = { [CRASHPAD_PIPE_ENV]: '\\\\.\\pipe\\crashpad_4242_QUIT' };
  const { finder, events, alive, stop, eventCount, pollingStopped } = startWatch(env);
  alive.add(5);
  finder.finish('found 5');
  await eventCount(1);
  stop();
  assert.equal(finder.killed, false, 'an exited finder is not killed again');
  alive.delete(5);
  await pollingStopped();
  assert.deepEqual(events, [{ state: 'watching', handlerPid: 5 }]);
  assert.equal(env[CRASHPAD_PIPE_ENV], '\\\\.\\pipe\\crashpad_4242_QUIT');

  const early = startWatch(env);
  early.stop();
  assert.equal(early.finder.killed, true, 'a still-running finder is killed at quit');
  assert.throws(() => crashHandlerFinderScript(0), /Main process id is invalid/);
});
