import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NewTaskRequests } from './new-task-requests.ts';

// Every child process this process starts creates one PROCESSWRAP resource.
function countSpawns() {
  let spawned = 0;
  const hook = createHook({
    init(_id, type) {
      if (type === 'PROCESSWRAP') spawned += 1;
    },
  }).enable();
  return {
    get count() {
      return spawned;
    },
    stop: () => hook.disable(),
  };
}

async function accept(requests, id) {
  return requests.run(id, { prompt: id }, async (request) => {
    await request.commit('accepted');
    return request.sessionId;
  });
}

test('receipt writes secure their folder once and never start a process after that', async (t) => {
  const root = await fsp.realpath(await fsp.mkdtemp(join(tmpdir(), 'mixdog-receipts-')));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const folder = join(root, 'new-task-receipts');
  const spawns = countSpawns();
  t.after(() => spawns.stop());
  const requests = new NewTaskRequests(root);

  await accept(requests, 'first-task');
  const securing = spawns.count;
  if (process.platform === 'win32') assert.ok(securing >= 1, 'the folder ACL is applied once');
  for (let i = 0; i < 5; i += 1) await accept(requests, `task-${i}`);
  // A second host in the same process shares the secured folder.
  await accept(new NewTaskRequests(root), 'other-host-task');
  assert.equal(spawns.count, securing, 'receipt writes after the first start no process');

  // A recreated folder is a different folder: it is secured again.
  await fsp.rm(folder, { recursive: true, force: true });
  await accept(requests, 'after-recreate');
  if (process.platform === 'win32') assert.ok(spawns.count > securing, 'the recreated folder is secured again');
  const settled = spawns.count;
  await accept(requests, 'after-recreate-2');
  assert.equal(spawns.count, settled);
  spawns.stop();

  const receipts = fs.readdirSync(folder).filter((name) => name.endsWith('.json'));
  assert.equal(receipts.length, 2);
  const receipt = join(folder, receipts[0]);
  assert.equal(JSON.parse(fs.readFileSync(receipt, 'utf8')).phase, 'accepted');
  if (process.platform === 'win32') {
    // The file carries only the owner's grant, inherited from the folder.
    const user = execFileSync('whoami', { encoding: 'utf8' }).trim().toLowerCase();
    const grants = execFileSync('icacls', [receipt], { encoding: 'utf8' })
      .replace(receipt, '')
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter((line) => /:\(/.test(line));
    assert.deepEqual(grants, [`${user}:(i)(f)`]);
  } else {
    assert.equal(fs.statSync(folder).mode & 0o777, 0o700);
    assert.equal(fs.statSync(receipt).mode & 0o077, 0);
  }
});

test('startup securing keeps the first submission off the ACL path, and a submission during it joins it', async (t) => {
  const roots = [];
  t.after(() => Promise.all(roots.map((root) => fsp.rm(root, { recursive: true, force: true }))));
  const fresh = async () => {
    const root = await fsp.realpath(await fsp.mkdtemp(join(tmpdir(), 'mixdog-receipts-')));
    roots.push(root);
    return new NewTaskRequests(root);
  };
  const spawns = countSpawns();
  t.after(() => spawns.stop());

  // Securing finished at startup: the first submission starts no process.
  const ready = await fresh();
  await ready.prepare();
  const secured = spawns.count;
  if (process.platform === 'win32') assert.ok(secured >= 1, 'startup applied the folder ACL');
  await accept(ready, 'first-task');
  assert.equal(spawns.count, secured, 'the first submission did not secure again');

  // A submission while startup securing still runs waits for that same work.
  const racing = await fresh();
  const before = spawns.count;
  void racing.prepare();
  await accept(racing, 'first-task');
  const shared = spawns.count - before;
  assert.ok(shared <= secured, 'one securing, shared by startup and the submission');
  if (process.platform === 'win32') assert.ok(shared >= 1);
});

function grantsOf(path) {
  return execFileSync('icacls', [path], { encoding: 'utf8' })
    .replace(path, '')
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => /:\(/.test(line));
}

test(
  'a pre-existing receipts folder and its files lose every other grant before any receipt is used',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await fsp.realpath(await fsp.mkdtemp(join(tmpdir(), 'mixdog-receipts-')));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const folder = join(root, 'new-task-receipts');
    await fsp.mkdir(folder);
    const old = join(folder, 'old.json');
    await fsp.writeFile(old, '{}');
    // Everyone (S-1-1-0): inheritable read on the folder, explicit read on the file.
    execFileSync('icacls', [folder, '/grant', '*S-1-1-0:(OI)(CI)(RX)']);
    execFileSync('icacls', [old, '/grant', '*S-1-1-0:(R)']);
    assert.ok(grantsOf(old).some((line) => line.startsWith('everyone:')));

    const sessionId = await accept(new NewTaskRequests(root), 'first-task');
    const user = execFileSync('whoami', { encoding: 'utf8' }).trim().toLowerCase();
    assert.deepEqual(grantsOf(folder), [`${user}:(oi)(ci)(f)`]);
    assert.deepEqual(grantsOf(old), [`${user}:(i)(f)`]);
    const created = join(folder, `${sessionId.replace('sess_desktop_', '')}.json`);
    assert.deepEqual(grantsOf(created), [`${user}:(i)(f)`]);
  }
);
