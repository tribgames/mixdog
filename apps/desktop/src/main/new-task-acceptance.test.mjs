import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionHost } from './session-host.ts';

// Exercise the real host, receipt writer and metadata reader. Only the daemon
// transport is a fixture; faults are injected at individual filesystem calls.
async function fixture(t, kind = 'prompt') {
  const root = await fsp.realpath(await fsp.mkdtemp(join(tmpdir(), 'mixdog-task-acceptance-')));
  const oldDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  const id = `acceptance-${kind}`;
  const key = createHash('sha256').update(id).digest('hex');
  const sessionId = `sess_desktop_${key}`;
  const receiptPath = join(root, 'new-task-receipts', `${key}.json`);
  const metadataPath = join(root, 'desktop-session-metadata.json');
  const original = JSON.stringify({
    version: 2, titles: { keeper: 'Existing title' }, names: { keeper: 'User name' },
  });
  await fsp.writeFile(metadataPath, original);
  const state = { accepted: false, allow: true, creates: [], submits: [], goals: [], unsubscribes: [] };
  const warnings = [];
  const errors = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  t.mock.method(console, 'error', (...args) => errors.push(args));
  const full = () => ({ sessionId, items: [], queued: [], busy: state.accepted });
  const client = {
    list: async () => ({
      sessions: state.accepted ? [{ id: sessionId, preview: 'Accepted work', messageCount: 1 }] : [],
    }),
    async create(params) {
      state.creates.push(params.sessionId);
      return { sessionId: params.sessionId, revision: 0, full: full() };
    },
    async submit(params) {
      state.submits.push({ sessionId: params.sessionId, id: params.options.id });
      state.accepted = state.allow;
      return { sessionId, accepted: state.accepted, revision: 1, full: full() };
    },
    async configure(params) {
      assert.equal(params.action, 'goalControl');
      state.goals.push(params.sessionId);
      state.accepted = state.allow;
      return {
        sessionId, revision: 1, full: full(),
        value: state.accepted
          ? { ok: true, goal: { objective: 'Approved goal title' } }
          : { ok: false, message: 'Goal refused' },
      };
    },
    read: async () => ({ sessionId, revision: 1, full: full() }),
    async unsubscribe(params) {
      state.unsubscribes.push(params.sessionId);
      return {};
    },
    close: async () => {},
  };
  const hosts = [];
  const createHost = async () => {
    const host = await SessionHost.create(
      { userDataPath: root, resourcesPath: root, appPath: root, packaged: false },
      {
        attachSessionClient: async () => client,
        loadProjects: async () => ({}),
        loadSessionStore: async () => ({ listStoredAgentWorkers: () => [] }),
        loadStatuslineSegments: async () => ({}),
        executeCodeGraphTool: async () => ({}),
      }
    );
    hosts.push(host);
    return host;
  };
  const options = { id, ...(kind === 'goal' ? { goalCommand: 'Create a goal' } : {}) };
  const host = await createHost();
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    try {
      // Join any catalog read started by acceptance before removing its files.
      for (const item of hosts) {
        await item.listSessions();
        await item.dispose();
      }
    } finally {
      if (oldDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
      else process.env.MIXDOG_DATA_DIR = oldDataDir;
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
  return {
    host, createHost, state, warnings, errors, sessionId, receiptPath, metadataPath, original, options,
    submit: (target = host) => target.submitNewTask('Accepted work', options),
    receipt: () => JSON.parse(fs.readFileSync(receiptPath, 'utf8')),
  };
}

function failMetadataRead(t, f, code) {
  const failure = Object.assign(new Error('Injected metadata read failure'), { code });
  const read = fsp.readFile;
  const phases = [];
  t.mock.method(fsp, 'readFile', async (path, ...args) => {
    if (path === f.metadataPath && f.state.accepted) {
      phases.push(f.receipt().phase);
      throw failure;
    }
    return read(path, ...args);
  });
  syncBuiltinESMExports();
  return { failure, phases };
}

for (const kind of ['prompt', 'goal']) {
  for (const code of ['EACCES', 'EIO']) {
    test(`${kind}: metadata ${code} cannot undo acceptance, including coalesced retries and host replacement`, async (t) => {
      const f = await fixture(t, kind);
      const fault = failMetadataRead(t, f, code);
      const [first, concurrent] = await Promise.all([f.submit(), f.submit()]);
      assert.equal(first.accepted, true);
      assert.equal(first.sessionId, f.sessionId);
      assert.equal(first.snapshot.sessionId, f.sessionId);
      assert.deepEqual(concurrent, first);
      assert.equal(f.receipt().phase, 'accepted');
      assert.ok(fault.phases.length > 0);
      assert.ok(fault.phases.every((phase) => phase === 'accepted'), 'persist acceptance before advisory IO');
      assert.ok(f.warnings.some(([, error]) => error?.cause === fault.failure));
      assert.equal(fs.readFileSync(f.metadataPath, 'utf8'), f.original);
      assert.equal((await f.submit()).accepted, true);
      const replacement = await f.createHost();
      assert.equal((await f.submit(replacement)).sessionId, f.sessionId);
      assert.deepEqual(f.state.creates, [f.sessionId]);
      assert.equal(f.state.submits.length, kind === 'prompt' ? 1 : 0);
      assert.equal(f.state.goals.length, kind === 'goal' ? 1 : 0);
      assert.deepEqual(f.state.unsubscribes, []);
      await assert.rejects(replacement.submitNewTask('Different content', f.options), /different content/);
    });
  }

  test(`${kind}: healthy title generation preserves unrelated metadata`, async (t) => {
    const f = await fixture(t, kind);
    assert.equal((await f.submit()).accepted, true);
    await f.host.markSessionRead(f.sessionId, 1); // Also drains the real generated-title writer.
    const saved = JSON.parse(await fsp.readFile(f.metadataPath, 'utf8'));
    assert.equal(saved.titles[f.sessionId], kind === 'goal' ? 'Approved goal title' : 'Accepted work');
    assert.equal(saved.titles.keeper, 'Existing title');
    assert.equal(saved.names.keeper, 'User name');
    assert.equal(f.receipt().phase, 'accepted');
  });

  test(`${kind}: failure to persist rewritten metadata during load is advisory`, async (t) => {
    const f = await fixture(t, kind);
    const original = JSON.stringify({
      version: 2, titles: { keeper: 'x'.repeat(100) }, names: { keeper: 'User name' },
    });
    await fsp.writeFile(f.metadataPath, original);
    const rename = fsp.rename;
    const failure = Object.assign(new Error('Metadata rewrite failed'), { code: 'EIO' });
    let attempts = 0;
    t.mock.method(fsp, 'rename', async (from, to) => {
      if (to === f.metadataPath) {
        attempts++;
        throw failure;
      }
      return rename(from, to);
    });
    syncBuiltinESMExports();
    assert.equal((await f.submit()).accepted, true);
    assert.ok(attempts > 0);
    assert.equal(f.receipt().phase, 'accepted');
    assert.deepEqual(f.state.unsubscribes, []);
    assert.ok(f.warnings.some(([, error]) => error === failure));
    assert.ok(f.errors.some(([, error]) => error === failure), 'metadata writer still reports its failed save');
    assert.equal(fs.readFileSync(f.metadataPath, 'utf8'), original);
    assert.equal((await f.submit(await f.createHost())).accepted, true);
  });

  test(`${kind}: an accepted-receipt publication failure remains fatal and retries the same address`, async (t) => {
    const f = await fixture(t, kind);
    const failure = Object.assign(new Error('Receipt publication failed'), { code: 'EIO' });
    const rename = fsp.rename;
    const read = fsp.readFile;
    let failing = true;
    let advisoryReads = 0;
    t.mock.method(fsp, 'rename', async (from, to) => {
      if (failing && to === f.receiptPath && JSON.parse(fs.readFileSync(from, 'utf8')).phase === 'accepted') {
        throw failure;
      }
      return rename(from, to);
    });
    t.mock.method(fsp, 'readFile', async (path, ...args) => {
      if (path === f.metadataPath) advisoryReads++;
      return read(path, ...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(f.submit(), (error) => error === failure);
    assert.equal(f.receipt().phase, 'configured');
    assert.equal(advisoryReads, 0, 'failed durable acceptance must not advance optional title work');
    assert.deepEqual(f.state.unsubscribes, [f.sessionId]);
    assert.equal(fs.readFileSync(f.metadataPath, 'utf8'), f.original);
    failing = false;
    assert.equal((await f.submit(await f.createHost())).accepted, true);
    assert.equal(f.receipt().phase, 'accepted');
    assert.ok(f.state.creates.every((id) => id === f.sessionId));
    assert.ok(f.state.submits.every((call) => call.sessionId === f.sessionId && call.id === f.options.id));
    // A failed receipt leaves an ambiguous outcome; replay uses the existing
    // stable daemon address/id rather than claiming the daemon was rolled back.
  });

  test(`${kind}: a refused daemon operation never records acceptance or a generated title`, async (t) => {
    const f = await fixture(t, kind);
    f.state.allow = false;
    if (kind === 'goal') await assert.rejects(f.submit(), /Goal refused/);
    else assert.deepEqual(await f.submit(), { accepted: false, sessionId: '', snapshot: null });
    assert.equal(f.receipt().phase, 'configured');
    assert.equal(fs.readFileSync(f.metadataPath, 'utf8'), f.original);
    assert.deepEqual(f.state.unsubscribes, [f.sessionId]);
  });
}

for (const phase of ['reserved', 'configured']) {
  test(`${phase} receipt failures still prevent submission`, async (t) => {
    const f = await fixture(t);
    const rename = fsp.rename;
    const failure = Object.assign(new Error('Early receipt failure'), { code: 'EIO' });
    t.mock.method(fsp, 'rename', async (from, to) => {
      if (to === f.receiptPath && JSON.parse(fs.readFileSync(from, 'utf8')).phase === phase) throw failure;
      return rename(from, to);
    });
    syncBuiltinESMExports();
    await assert.rejects(f.submit(), (error) => error === failure);
    assert.equal(f.state.creates.length, phase === 'reserved' ? 0 : 1);
    assert.deepEqual(f.state.submits, []);
    assert.deepEqual(f.state.goals, []);
    if (phase === 'reserved') assert.equal(fs.existsSync(f.receiptPath), false);
    else assert.equal(f.receipt().phase, 'reserved');
  });
}

for (const failureKind of ['read', 'write']) {
  test(`explicit metadata ${failureKind} failures are not made nonfatal`, async (t) => {
    const f = await fixture(t);
    const failure = Object.assign(new Error('Explicit metadata mutation failed'), { code: 'EIO' });
    const method = failureKind === 'read' ? 'readFile' : 'rename';
    const real = fsp[method];
    t.mock.method(fsp, method, async (...args) => {
      if (args[failureKind === 'read' ? 0 : 1] === f.metadataPath) throw failure;
      return real(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(
      f.host.markSessionRead(f.sessionId, 1),
      (error) => error === failure || error.cause === failure
    );
    assert.equal(fs.readFileSync(f.metadataPath, 'utf8'), f.original);
    assert.deepEqual(f.state.creates, []);
    assert.deepEqual(f.state.submits, []);
  });
}
