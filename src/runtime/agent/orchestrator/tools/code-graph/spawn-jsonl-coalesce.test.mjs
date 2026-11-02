// spawnGraphJsonl coalescing: identical concurrent runs share one process.
// The fake "binary" is node itself; absRoot (argv[1]) is the script, so the
// script's own argv is [script, mode, logFile, ...].
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { ensureNativeSpawnServer } from '../lib/native-spawn-client.mjs';
import { spawnGraphJsonl } from './graph-binary/spawn-jsonl.mjs';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-spawn-coalesce-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const script = join(dir, 'fake-graph.mjs');
writeFileSync(
  script,
  `import { appendFileSync, readFileSync } from 'node:fs';
const [mode, log] = process.argv.slice(2);
appendFileSync(log, process.pid + '\\n');
let stdin = '';
if (mode === 'stdin') stdin = readFileSync(0, 'utf8');
if (mode === 'fail') { process.stderr.write('boom'); process.exit(3); }
if (mode === 'hang') setInterval(() => {}, 1000);
else setTimeout(() => {
  console.log(JSON.stringify(mode === 'norel' ? { table: 1 } : { rel: 'a.js', mode, stdin, fake: process.env.FAKE_VAR, cwd: process.cwd() }));
  process.exit(0);
}, 300);
`
);

let seq = 0;
function run(mode, { stdinLines, signal, tag = mode } = {}) {
  const log = join(dir, `log-${tag}-${(seq += 1)}.txt`);
  return { log, make: (overrides = {}) => spawnGraphJsonl({
    binPath: process.execPath,
    absRoot: script,
    extraArgs: [mode, log],
    stdinLines,
    signal,
    timeoutMs: 20_000,
    requireRel: true,
    ...overrides,
  }) };
}
const spawns = (log) => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (cond, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('N concurrent identical calls share one spawn and get equal, independent results', async () => {
  const { log, make } = run('ok');
  const results = await Promise.all(Array.from({ length: 9 }, () => make()));
  assert.equal(spawns(log).length, 1);
  for (const r of results) assert.deepEqual(r, results[0]);
  assert.equal(results[0][0].rel, 'a.js');
  assert.notEqual(results[0], results[1]);
  assert.notEqual(results[0][0], results[1][0]);
});

test('nothing is cached after completion', async () => {
  const { log, make } = run('ok');
  await make();
  await make();
  assert.equal(spawns(log).length, 2);
});

test('different inputs spawn separately', async () => {
  const a = run('ok', { tag: 'a' });
  const b = run('ok', { tag: 'b' });
  const s1 = run('stdin', { stdinLines: ['x'] });
  const s2 = { log: s1.log, make: (o) => s1.make({ stdinLines: ['y'], ...o }) };
  await Promise.all([a.make(), b.make(), a.make({ extraArgs: ['ok', a.log, '--other'] }), s1.make(), s2.make()]);
  assert.equal(spawns(a.log).length, 2);
  assert.equal(spawns(b.log).length, 1);
  assert.equal(spawns(s1.log).length, 2);
});

test('stdin lines reach the shared process', async () => {
  const { make } = run('stdin', { stdinLines: ['l1', 'l2'] });
  const [r1, r2] = await Promise.all([make(), make()]);
  assert.equal(r1[0].stdin, 'l1\nl2\n');
  assert.deepEqual(r1, r2);
});

test('one waiter aborting leaves the others served', async () => {
  const ac = new AbortController();
  const { log, make } = run('ok');
  const aborting = make({ signal: ac.signal });
  const others = [make(), make()];
  await until(() => spawns(log).length === 1);
  ac.abort();
  await assert.rejects(aborting, /aborted/);
  const results = await Promise.all(others);
  assert.equal(spawns(log).length, 1);
  assert.equal(results[0][0].rel, 'a.js');
});

test('all waiters aborting kills the process; a later call starts fresh', async () => {
  const a1 = new AbortController();
  const a2 = new AbortController();
  const { log, make } = run('hang');
  const p1 = make({ signal: a1.signal });
  const p2 = make({ signal: a2.signal });
  await until(() => spawns(log).length === 1);
  const pid = Number(spawns(log)[0]);
  a1.abort();
  await assert.rejects(p1, /aborted/);
  assert.equal(alive(pid), true);
  a2.abort();
  await assert.rejects(p2, /aborted/);
  await until(() => !alive(pid));
  const a3 = new AbortController();
  const p3 = make({ signal: a3.signal });
  await until(() => spawns(log).length === 2);
  assert.notEqual(Number(spawns(log)[1]), pid);
  a3.abort();
  await assert.rejects(p3, /aborted/);
});

test('an already-aborted signal rejects without spawning', async () => {
  const ac = new AbortController();
  ac.abort();
  const { log, make } = run('ok');
  await assert.rejects(make({ signal: ac.signal }), /aborted/);
  assert.equal(spawns(log).length, 0);
});

test('a failing run rejects every waiter', async () => {
  const { log, make } = run('fail');
  const settled = await Promise.allSettled(Array.from({ length: 4 }, () => make()));
  assert.equal(spawns(log).length, 1);
  for (const s of settled) {
    assert.equal(s.status, 'rejected');
    assert.match(s.reason.message, /exited 3: boom/);
  }
});

test('the main thread launches through the native spawn server, not child_process.spawn', async (t) => {
  try {
    await ensureNativeSpawnServer();
  } catch (error) {
    t.skip(`native spawn server unavailable: ${error?.message}`);
    return;
  }
  const original = cp.spawn;
  const direct = [];
  cp.spawn = (cmd, ...rest) => {
    direct.push(cmd);
    return original(cmd, ...rest);
  };
  syncBuiltinESMExports();
  try {
    const { log, make } = run('ok');
    const result = await make();
    assert.equal(result[0].rel, 'a.js');
    assert.equal(spawns(log).length, 1);
    assert.deepEqual(direct, []);
  } finally {
    cp.spawn = original;
    syncBuiltinESMExports();
  }
});

test('env and cwd are snapshotted at call time and keyed', async () => {
  const startCwd = process.cwd();
  const { log, make } = run('ok');
  try {
    process.env.FAKE_VAR = 'one';
    const first = make();
    const firstTwin = make();
    process.env.FAKE_VAR = 'two';
    const second = make();
    process.chdir(dir);
    const third = make();
    const [a, a2, b, c] = await Promise.all([first, firstTwin, make().then((r) => r), third]);
    assert.equal(a[0].fake, 'one');
    assert.deepEqual(a, a2);
    assert.equal((await second)[0].fake, 'two');
    assert.equal(b[0].fake, 'two');
    assert.equal(realpathSync.native(c[0].cwd), realpathSync.native(dir));
    assert.notEqual(realpathSync.native(a[0].cwd), realpathSync.native(c[0].cwd));
    // one = {first, twin}; two = {second}; third = chdir'd; last make() joins third
    assert.equal(spawns(log).length, 3);
  } finally {
    process.chdir(startCwd);
    delete process.env.FAKE_VAR;
  }
});

test('requireRel is judged per waiter on the shared output', async () => {
  const { log, make } = run('norel');
  const strict = make();
  const loose = make({ requireRel: false });
  await assert.rejects(strict, /invalid JSONL/);
  assert.equal((await loose).length, 1);
  assert.equal(spawns(log).length, 1);
});
