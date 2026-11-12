// The host child ends with its daemon: a parent killed hard leaves no orphan.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('a host killed hard is reported exited once, by the look or by the event', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-host-exit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const helperUrl = new URL('./onnx-child-host.mjs', import.meta.url).href;
  writeFileSync(
    join(dir, 'host.mjs'),
    `import { parentPort } from ${JSON.stringify(helperUrl)};
parentPort.postMessage({ type: 'ready' });
setInterval(() => {}, 1000);`
  );
  const { ChildWorker } = await import(helperUrl);
  const host = new ChildWorker(join(dir, 'host.mjs'));
  await new Promise((resolve) => host.once('message', resolve));
  assert.equal(host.exited(), false);
  let exits = 0;
  const heard = new Promise((resolve) =>
    host.on('exit', () => {
      exits += 1;
      resolve();
    })
  );
  process.kill(host.pid, 'SIGKILL');
  // A request posted into the dead host is what notices it where the event is late.
  const posting = setInterval(() => host.postMessage({ action: 'ping' }), 10);
  const late = setTimeout(() => assert.fail('the exit of a killed host was never reported'), 30_000);
  await heard;
  clearInterval(posting);
  clearTimeout(late);
  assert.equal(host.exited(), true);
  await host.terminate();
  assert.equal(exits, 1);
});

test('a host child exits when its parent is killed', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-host-orphan-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const helperUrl = new URL('./onnx-child-host.mjs', import.meta.url).href;
  writeFileSync(
    join(dir, 'host.mjs'),
    `import { parentPort } from ${JSON.stringify(helperUrl)};
parentPort.postMessage({ type: 'ready', pid: process.pid });
setInterval(() => {}, 1000);`
  );
  writeFileSync(
    join(dir, 'parent.mjs'),
    `import { ChildWorker } from ${JSON.stringify(helperUrl)};
const host = new ChildWorker(${JSON.stringify(join(dir, 'host.mjs'))});
host.on('message', (m) => console.log('pid ' + m.pid));
setInterval(() => {}, 1000);`
  );
  const parent = spawn(process.execPath, [join(dir, 'parent.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
  const childPid = await new Promise((resolve, reject) => {
    parent.once('error', reject);
    parent.stdout.on('data', (chunk) => {
      const match = /pid (\d+)/.exec(String(chunk));
      if (match) resolve(Number(match[1]));
    });
  });
  assert.equal(alive(childPid), true);
  parent.kill('SIGKILL');
  const deadline = Date.now() + 5000;
  while (alive(childPid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(childPid), false, 'the host child ended with its parent');
});
