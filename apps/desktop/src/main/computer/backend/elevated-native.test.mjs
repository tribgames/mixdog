import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { runElevatedRequest } from './elevated-launcher.ts';
import { processIdentityGone, readProcessStartTicks } from './inactive-ledger-registry.ts';

process.env.MIXDOG_COMPUTER_BIN ||= 'mixdog-computer';

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 222, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {},
  });
  const finishes = [], identities = [], commands = [];
  let cancel;
  const result = runElevatedRequest({ request: { action: 'click', delivery: 'foreground', window_id: 'hwnd:0x1' },
    id: 7, directory: 'unused', inputMarker: '81', inactiveLedger: 'fixture.ledger',
    spawnProcess(program, args, options) { commands.push({ program, args, options }); return child; },
    onWorkerIdentity(identity) { identities.push(identity); },
    begin(callback) { cancel = callback; return { finish(stopped) { finishes.push(stopped); } }; },
  });
  return { child, finishes, identities, commands, result, cancel: () => cancel(),
    send(value) { child.stdout.write(`${JSON.stringify(value)}\n`); },
    close() { child.stdout.end(); child.emit('close', 0); } };
}

test('native adapter sends one request, forwards cancellation and waits for the final receipt', async () => {
  const f = fixture();
  assert.deepEqual(f.commands[0].args, ['--elevated-launch']);
  assert.equal(f.commands[0].options.windowsHide, true);
  const request = JSON.parse(f.child.stdin.read().toString());
  assert.equal(request.request.id, 7);
  assert.equal(request.inactiveLedger, 'fixture.ledger');
  assert.equal(request.inputMarker, '81');
  f.cancel();
  assert.deepEqual(JSON.parse(f.child.stdin.read().toString()), { cancel: true });
  f.send({ kind: 'identity', pid: 33, startTicks: '638661232000000000' });
  f.send({ kind: 'result', stopped: true, response: { id: 7, ok: true, result: { text: '한글' } } });
  assert.deepEqual(f.finishes, []);
  f.close();
  assert.equal((await f.result).result.text, '한글');
  assert.deepEqual(f.finishes, [true]);
  assert.deepEqual(f.identities, [{ pid: 33, startTicks: '638661232000000000' }]);
});

test('unconfirmed cleanup and lost receipt keep pool capacity held', async () => {
  for (const receipt of [null, { kind: 'result', stopped: false, error: 'privileged_worker_cleanup_unconfirmed' }]) {
    const f = fixture();
    if (receipt) f.send(receipt);
    f.close();
    await assert.rejects(f.result, /cleanup_unconfirmed/);
    assert.deepEqual(f.finishes, [false]);
  }
});

test('declined UAC is confirmed stopped but request identity mismatch is rejected', async () => {
  const declined = fixture();
  declined.send({ kind: 'result', stopped: true, error: 'privileged_worker_cancelled: UAC consent was declined' });
  declined.close();
  await assert.rejects(declined.result, /UAC consent was declined/);
  assert.deepEqual(declined.finishes, [true]);
  const wrong = fixture();
  wrong.send({ kind: 'result', stopped: true, response: { id: 8, ok: true, result: {} } });
  wrong.close();
  await assert.rejects(wrong.result, /response id mismatch/);
});

test('an access denied identity query never promotes a held worker to gone', async () => {
  const identity = { pid: 33, startTicks: '638661232000000000' };
  assert.equal(await processIdentityGone(identity, async () => { throw new Error('access denied'); }), false);
  assert.equal(await processIdentityGone(identity, async () => identity.startTicks), false);
  assert.equal(await processIdentityGone(identity, async () => null), true);
  assert.equal(await processIdentityGone(identity, async () => '638661232000000001'), true);
});

test('identity query waits for stdout draining after exit before declaring a PID absent', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill() {} });
  let settled = false;
  const query = readProcessStartTicks(33, () => child).then((answer) => { settled = true; return answer; });
  child.emit('exit', 0);
  await Promise.resolve();
  assert.equal(settled, false);
  child.stdout.write('638661232000000000');
  child.emit('close', 0);
  assert.equal(await query, '638661232000000000');
});
