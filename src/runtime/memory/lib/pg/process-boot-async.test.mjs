import assert from 'node:assert/strict';
import * as realChildProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { mock } from 'node:test';

// The PG boot path (initdb, pg_ctl start/reload/stop) must never block the
// hosting daemon's loop: every child goes through an injected async spawn and
// any synchronous child API fails the test.
const syncCalls = [];
const forbidSync =
  (name) =>
  (...args) => {
    syncCalls.push([name, ...args]);
    throw new Error(`${name} on the PG boot path`);
  };

const spawned = [];
const servers = new Map();
let stopHangs = false;

function argAfter(args, flag) {
  return args[args.indexOf(flag) + 1];
}

// Minimal ChildProcess: run(child) resolves to an exit code, or undefined to
// keep running until kill().
function fakeChild(run) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 4242;
  child.killed = false;
  child.unref = () => {};
  let done = false;
  const finish = (code, signal = null) => {
    if (done) return;
    done = true;
    child.stdout.end();
    child.stderr.end();
    setImmediate(() => {
      child.emit('exit', code, signal);
      child.emit('close', code, signal);
    });
  };
  child.kill = () => {
    child.killed = true;
    finish(null, 'SIGTERM');
    return true;
  };
  setImmediate(async () => {
    try {
      const code = await run(child);
      if (code !== undefined) finish(code);
    } catch (error) {
      child.stderr.write(String(error?.message || error));
      finish(1);
    }
  });
  return child;
}

async function fakePgCtl(args) {
  const verb = args[0];
  const pgdata = argAfter(args, '-D');
  if (verb === 'start') {
    const port = Number(/-p (\d+)/.exec(argAfter(args, '-o'))[1]);
    const server = createServer((socket) => socket.destroy());
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    servers.set(pgdata, server);
    writeFileSync(join(pgdata, 'postmaster.pid'), `${process.pid}\n${pgdata}\n0\n${port}\n`);
    return 0;
  }
  if (verb === 'stop') {
    if (stopHangs) return undefined;
    await new Promise((resolve) => servers.get(pgdata)?.close(resolve) ?? resolve());
    servers.delete(pgdata);
    rmSync(join(pgdata, 'postmaster.pid'), { force: true });
    return 0;
  }
  return 0; // reload / status
}

function fakeSpawn(file, args = []) {
  const name = basename(String(file)).replace(/\.exe$/i, '');
  spawned.push({ name, args });
  return fakeChild(async () => {
    if (name === 'initdb') {
      const pgdata = argAfter(args, '-D');
      mkdirSync(pgdata, { recursive: true });
      writeFileSync(join(pgdata, 'PG_VERSION'), '17\n');
      writeFileSync(join(pgdata, 'postgresql.conf'), 'max_connections = 100\nshared_buffers = 128MB\n');
      return 0;
    }
    if (name === 'pg_ctl') return fakePgCtl(args);
    throw new Error(`unexpected spawn ${name}`);
  });
}

const { default: _childProcessDefault, ...childProcessNamed } = realChildProcess;
mock.module('node:child_process', {
  namedExports: {
    ...childProcessNamed,
    spawn: fakeSpawn,
    spawnSync: forbidSync('spawnSync'),
    execFileSync: forbidSync('execFileSync'),
    execSync: forbidSync('execSync'),
  },
});
// healthcheckPg's SELECT 1 lands on a client that always answers.
mock.module('pg', {
  defaultExport: {
    Client: class {
      on() {}
      async connect() {}
      async query() {
        return { rows: [{ '?column?': 1 }] };
      }
      async end() {}
    },
  },
});

const { reconcileConfV2, startPg, stopPg } = await import('./process.mjs');

const root = mkdtempSync(join(tmpdir(), 'mixdog-pg-boot-async-'));
const runtimeDir = join(root, 'runtime');
const pgdataDir = join(root, 'pgdata');
const logPath = join(root, 'pg.log');
const confPath = join(pgdataDir, 'postgresql.conf');

test.after(async () => {
  for (const server of servers.values()) await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

test('a first boot runs initdb and pg_ctl start as async children', async () => {
  const started = await startPg({ runtimeDir, pgdataDir, logPath });
  assert.equal(started.pid, process.pid);
  assert.ok(started.port > 0);
  assert.deepEqual(
    spawned.map(({ name, args }) => `${name}${name === 'pg_ctl' ? ` ${args[0]}` : ''}`),
    ['initdb', 'pg_ctl start']
  );
  assert.deepEqual(syncCalls, [], 'no synchronous child on the boot path');
});

test('a fresh cluster conf already holds every block later boots reconcile', async () => {
  const conf = readFileSync(confPath, 'utf8');
  assert.match(conf, /# mixdog overrides v2/);
  assert.match(conf, /# mixdog overrides v3/);
  assert.match(conf, /# mixdog overrides v4/);
  assert.match(conf, /^shared_buffers = 32MB$/m);

  spawned.length = 0;
  assert.deepEqual(await reconcileConfV2(runtimeDir, pgdataDir), { applied: false, reloaded: false });
  // Attaching to the running cluster (the next boot's path) neither rewrites
  // the conf nor reloads it.
  const attached = await startPg({ runtimeDir, pgdataDir, logPath });
  assert.equal(attached.attached, true);
  assert.equal(readFileSync(confPath, 'utf8'), conf, 'conf is byte-identical');
  assert.equal(
    spawned.some(({ args }) => args[0] === 'reload'),
    false,
    'no pg_ctl reload (shared_buffers cannot change by reload)'
  );
  assert.deepEqual(syncCalls, []);
});

test('a NUL-filled postgresql.conf is rebuilt from the overrides instead of left unparsable', async () => {
  writeFileSync(confPath, Buffer.alloc(64));
  const result = await reconcileConfV2(runtimeDir, pgdataDir);
  assert.equal(result.applied, true);
  const conf = readFileSync(confPath, 'utf8');
  assert.equal(conf.includes('\0'), false);
  assert.match(conf, /# mixdog overrides v4/);
  assert.match(conf, /^shared_buffers = 32MB$/m);
});

test('stopPg is a bounded async pg_ctl stop -m fast; the next boot starts without initdb or reload', async () => {
  spawned.length = 0;
  await stopPg({ runtimeDir, pgdataDir, timeoutMs: 4_000 });
  assert.equal(spawned.length, 1);
  const stopArgs = spawned[0].args;
  assert.deepEqual(stopArgs.slice(0, 3), ['stop', '-m', 'fast']);
  assert.equal(argAfter(stopArgs, '-t'), '4');
  assert.equal(existsSync(join(pgdataDir, 'postmaster.pid')), false);

  const conf = readFileSync(confPath, 'utf8');
  spawned.length = 0;
  const restarted = await startPg({ runtimeDir, pgdataDir, logPath });
  assert.equal(restarted.attached, undefined);
  assert.deepEqual(
    spawned.map(({ name, args }) => `${name} ${args[0]}`),
    ['pg_ctl start']
  );
  assert.equal(readFileSync(confPath, 'utf8'), conf);
  assert.deepEqual(syncCalls, []);
});

test('a wedged pg_ctl stop is killed at its bound and rejects', async () => {
  stopHangs = true;
  spawned.length = 0;
  await assert.rejects(stopPg({ runtimeDir, pgdataDir, timeoutMs: 1_000 }), /pg_ctl stop failed/);
  assert.equal(spawned.length, 1);
  assert.deepEqual(syncCalls, []);
  stopHangs = false;
});
