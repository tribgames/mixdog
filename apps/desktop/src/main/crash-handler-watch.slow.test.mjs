import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';

import { CRASHPAD_PIPE_ENV, watchCrashHandler } from './crash-handler-watch.ts';

test(
  'the PowerShell finder names the handler child, exits, and the in-process poll reports its exit',
  { skip: process.platform !== 'win32', timeout: 60_000 },
  async () => {
    // Stand-in handler: a child of this process with the handler's switch in
    // its command line, exiting once the watch reports it.
    const handler = spawn(
      process.execPath,
      ['-e', "process.stdin.once('data', () => process.exit(-1073741819))", '--', '--type=crashpad-handler'],
      { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true }
    );
    await once(handler, 'spawn');
    const env = { [CRASHPAD_PIPE_ENV]: '\\\\.\\pipe\\crashpad_test_pipe' };
    const events = [];
    let stop = () => {};
    // The poll is unref'd (it must never hold the app open); this test process
    // has nothing else alive once the stand-in exits.
    const keepAlive = setInterval(() => {}, 1_000);
    try {
      const lost = new Promise((resolve) => {
        stop = watchCrashHandler({
          mainPid: process.pid,
          env,
          pollMs: 50,
          onEvent: (event) => {
            events.push(event);
            if (event.state === 'watching') handler.stdin.write('exit\n');
            else resolve(event);
          },
        });
      });
      const event = await lost;
      assert.deepEqual(events[0], { state: 'watching', handlerPid: handler.pid });
      assert.deepEqual(event, { state: 'lost', handlerPid: handler.pid, reason: 'exited', pipeCleared: true });
      assert.equal(CRASHPAD_PIPE_ENV in env, false);
    } finally {
      clearInterval(keepAlive);
      stop();
      handler.kill();
    }
  }
);
