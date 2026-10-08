// Event-loop lifetime of the REAL NativePatchServer while the prewarm ping and
// the contract handshake overlap. The only controlled part is the child
// process transport (node:child_process.spawn is replaced by a scripted child),
// so the engine's stdout framing is driven deterministically. Needs
// --experimental-test-module-mocks, which the documented `npm test` runner sets.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import * as realChildProcess from 'node:child_process';

const CONTRACT = 'mixdog-patch-engine-contract:3';

function refTracked(handle) {
  handle.refed = true;
  handle.ref = () => {
    handle.refed = true;
  };
  handle.unref = () => {
    handle.refed = false;
  };
  return handle;
}

async function checkPrewarmLifetime(validContract) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-prewarm-lifetime-'));
  const bin = join(dir, 'mixdog-patch');
  writeFileSync(bin, `engine ${CONTRACT}`);

  const child = refTracked(new EventEmitter());
  const stdout = refTracked(new PassThrough());
  const stderr = refTracked(new PassThrough());
  const stdin = refTracked(new EventEmitter());
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = stdin;
  child.kill = () => true;
  const handles = [child, stdin, stdout, stderr];
  const written = [];
  const refedAtContractWrite = [];
  let signalContractWrite;
  const contractWritten = new Promise((resolve) => {
    signalContractWrite = resolve;
  });
  stdin.write = (payload) => {
    const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
    written.push(text);
    if (text === 'CONTRACT\n') {
      refedAtContractWrite.push(...handles.map((handle) => handle.refed));
      signalContractWrite();
    }
    return true;
  };
  stdin.end = () => {
    queueMicrotask(() => child.emit('exit', 0, null));
  };

  let spawned = 0;
  const fakeSpawn = () => {
    spawned += 1;
    return child;
  };
  mock.module('node:child_process', {
    namedExports: { ...realChildProcess, spawn: fakeSpawn },
    defaultExport: { ...realChildProcess, spawn: fakeSpawn },
  });

  const saved = {
    bin: process.env.MIXDOG_PATCH_NATIVE_BIN,
    mode: process.env.MIXDOG_PATCH_NATIVE,
    prewarm: process.env.MIXDOG_PATCH_NATIVE_PREWARM,
  };
  process.env.MIXDOG_PATCH_NATIVE_BIN = bin;
  process.env.MIXDOG_PATCH_NATIVE = 'auto';
  delete process.env.MIXDOG_PATCH_NATIVE_PREWARM;

  const nativeServer = await import(`./native-server.mjs?prewarm-lifetime=${validContract}`);
  try {
    nativeServer.scheduleNativePatchPrewarm();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(written, ['PING\n'], 'prewarm pinged the real session');

    const server = nativeServer.getNativePatchServer();
    const verification = nativeServer.nativePatchSessionSatisfiesContract();
    assert.equal(server.contractPending, true);
    assert.equal(written.length, 2, 'the handshake wrote its nonce challenge');
    const probe = written[1].match(/mixdog-engine-challenge-[0-9a-f]+/)?.[0];
    assert.ok(probe, 'challenge carries the nonce probe path');

    // The PONG and the challenge reply land in ONE stdout chunk, so both
    // waiters resolve in the same synchronous readline pass.
    stdout.write(Buffer.from(`OK\tPONG\nERR\tstat ${probe}: no such file or directory\n`));

    // Await the observed write rather than spinning the event loop.
    await contractWritten;
    assert.equal(written[2], 'CONTRACT\n');
    assert.deepEqual(
      refedAtContractWrite,
      [true, true, true, true],
      'child and pipes stay referenced while the CONTRACT answer is pending'
    );

    stdout.write(Buffer.from(`OK\t${validContract ? CONTRACT : 'wrong-contract'}\n`));
    assert.equal(await verification, validContract);
    assert.equal(server.contractPending, false);
    assert.equal(spawned, 1, 'prewarm and handshake shared one session');
    // Idle unref is preserved once the handshake has settled.
    assert.deepEqual(
      handles.map((handle) => handle.refed),
      [false, false, false, false]
    );
  } finally {
    await nativeServer.closeNativePatchServerForTests();
    mock.reset();
    for (const [key, value] of [
      ['MIXDOG_PATCH_NATIVE_BIN', saved.bin],
      ['MIXDOG_PATCH_NATIVE', saved.mode],
      ['MIXDOG_PATCH_NATIVE_PREWARM', saved.prewarm],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const validContract of [true, false]) {
  test(`prewarm preserves handshake lifetime through ${validContract ? 'success' : 'failure'}`, () =>
    checkPrewarmLifetime(validContract)
  );
}
