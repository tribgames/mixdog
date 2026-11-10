import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { runMixdogdExec } from './mixdogd-exec.mjs';

function fakeSpawn(calls, { out = '', err = '', code = 0, fail = null } = {}) {
  return (bin, args, options) => {
    calls.push({ bin, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      if (fail) return void child.emit('error', fail);
      child.stdout.end(out);
      child.stderr.end(err);
      child.stdout.on('end', () => setImmediate(() => child.emit('close', code)));
    });
    return child;
  };
}

test('a run is one hidden `mixdogd exec` with the route, folder, usage log and tool mode; answer and errors are streamed', async () => {
  const calls = [];
  let out = '';
  let err = '';
  const code = await runMixdogdExec(
    {
      message: '--looks like a flag',
      provider: 'p',
      model: 'm',
      effort: 'high',
      cwd: '/deck',
      webSearch: false,
      usageLogPath: '/deck/r.usage.json',
      toolMode: 'readonly',
      write: (chunk) => (out += chunk),
      writeErr: (chunk) => (err += chunk),
    },
    { spawnImpl: fakeSpawn(calls, { out: 'answer', err: 'warn', code: 3 }), env: { MIXDOGD_BIN: '/bin/mixdogd' } }
  );
  assert.equal(code, 3);
  assert.equal(out, 'answer');
  assert.equal(err, 'warn');
  assert.equal(calls[0].bin, '/bin/mixdogd');
  assert.deepEqual(calls[0].args, [
    'exec', '--provider', 'p', '--model', 'm', '--effort', 'high', '--cwd', '/deck',
    '--usage-log', '/deck/r.usage.json', '--tool-mode', 'readonly', '--', '--looks like a flag',
  ]);
  assert.equal(calls[0].options.windowsHide, true);
});

test('a mixdogd that cannot start is exit code 1 with the reason on stderr', async () => {
  let err = '';
  const code = await runMixdogdExec(
    { message: 'x', provider: 'p', model: 'm', writeErr: (chunk) => (err += chunk) },
    { spawnImpl: fakeSpawn([], { fail: new Error('spawn mixdogd ENOENT') }), env: {} }
  );
  assert.equal(code, 1);
  assert.match(err, /mixdogd exec could not start: spawn mixdogd ENOENT/);
});
