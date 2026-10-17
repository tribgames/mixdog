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
    version: 2,
    titles: { keeper: 'Existing title' },
    names: { keeper: 'User name' },
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
      if (state.onConfigure && params.action !== 'goalControl') return state.onConfigure(params);
      assert.equal(params.action, 'goalControl');
      state.goals.push(params.sessionId);
      state.accepted = state.allow;
      return {
        sessionId,
        revision: 1,
        full: full(),
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
    host,
    createHost,
    state,
    warnings,
    errors,
    sessionId,
    receiptPath,
    metadataPath,
    original,
    options,
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
      assert.ok(
        fault.phases.every((phase) => phase === 'accepted'),
        'persist acceptance before advisory IO'
      );
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
      version: 2,
      titles: { keeper: 'x'.repeat(100) },
      names: { keeper: 'User name' },
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
    assert.ok(
      f.errors.some(([, error]) => error === failure),
      'metadata writer still reports its failed save'
    );
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

test('a worktree draft enters its worktree before the prompt is submitted; a large repository resends the same submission', async (t) => {
  const f = await fixture(t);
  const requests = [];
  f.state.onConfigure = async (params) => {
    assert.equal(params.action, 'requestWorktree');
    const [input] = params.args;
    requests.push({ ...input, submitted: f.state.submits.length });
    if (!input.confirmLarge) {
      throw Object.assign(new Error('The repository is large; confirm before creating a worktree.'), {
        code: 'WORKTREE_LARGE_REPO_CONFIRM',
      });
    }
    return {
      sessionId: f.sessionId,
      revision: 1,
      full: { sessionId: f.sessionId, items: [] },
      value: { pending: false, workspace: { worktreeId: 'add-dark-mode' } },
    };
  };
  await assert.rejects(f.host.submitNewTask('Accepted work', f.options, { worktree: {} }), (error) => {
    assert.match(error.message, /^WORKTREE_LARGE_REPO_CONFIRM: /);
    return true;
  });
  assert.deepEqual(f.state.submits, [], 'a refused worktree never sends the prompt');
  const accepted = await f.host.submitNewTask('Accepted work', f.options, { worktree: { confirmLarge: true } });
  assert.equal(accepted.accepted, true);
  assert.deepEqual(
    requests.map(({ provision, confirmLarge, prompt, txId, submitted }) => [
      provision,
      confirmLarge,
      prompt,
      txId,
      submitted,
    ]),
    [
      [true, false, 'Accepted work', f.options.id, 0],
      [true, true, 'Accepted work', f.options.id, 0],
    ]
  );
  assert.equal(f.state.submits.length, 1);
});

for (const create of [false, true]) {
  test(`a branch draft resolves its checkout before first send (create=${create})`, async (t) => {
    const f = await fixture(t, `branch-${create}`);
    let applied = false;
    const requests = [];
    f.state.onConfigure = async (params) => {
      assert.equal(params.action, 'selectBranch');
      assert.equal(f.state.submits.length, 0, 'the prompt cannot precede the workspace move');
      requests.push(params.args[0]);
      return {
        sessionId: f.sessionId,
        revision: 1,
        full: { sessionId: f.sessionId, items: [] },
        value: { workspace: { branch: applied ? 'feature/login' : 'main', worktreeId: create ? 'login' : null } },
      };
    };
    const draft = { worktree: { branch: 'feature/login', create } };
    await assert.rejects(f.host.submitNewTask('Accepted work', f.options, draft), /WORKTREE_NOT_IMPLEMENTED/);
    assert.equal(f.state.submits.length, 0);
    applied = true;
    const result = await f.host.submitNewTask('Accepted work', f.options, draft);
    assert.equal(result.accepted, true);
    assert.deepEqual(
      requests,
      Array.from({ length: 2 }, () => ({
        branch: 'feature/login',
        create,
        confirmLarge: false,
      }))
    );
    assert.equal(f.state.submits.length, 1);
  });
}

test('a draft remembering a deleted workflow starts on Default; other workflow failures still refuse', async (t) => {
  const f = await fixture(t);
  const workflows = [];
  let missing = 'workflow "gone" not found';
  f.state.onConfigure = async (params) => {
    assert.equal(params.action, 'setWorkflow');
    const [id] = params.args;
    workflows.push(id);
    if (id === 'gone') throw new Error(missing);
    return { sessionId: f.sessionId, revision: 1, full: { sessionId: f.sessionId, items: [] }, value: id };
  };
  const other = await f.createHost();
  missing = 'workflow store is unreadable';
  await assert.rejects(other.submitNewTask('Other work', { id: 'other-draft' }, { workflowId: 'gone' }), /unreadable/);
  missing = 'workflow "gone" not found';
  const accepted = await f.host.submitNewTask('Accepted work', f.options, { workflowId: 'gone' });
  assert.equal(accepted.accepted, true);
  assert.deepEqual(workflows, ['gone', 'gone', 'default']);
  assert.equal(f.state.submits.length, 1);
});

test('a worktree draft whose session cannot be created (no model) or is not bound never sends the prompt', async (t) => {
  const f = await fixture(t);
  let reply = 'no-model';
  f.state.onConfigure = async (params) => {
    assert.equal(params.action, 'requestWorktree');
    if (reply === 'no-model') {
      // Provisioning materializes the session, which resolves the model route first.
      throw new Error('No provider models available. Open /providers to sign in, then /model to choose a model.');
    }
    // A runtime that only armed the lazy intent.
    return {
      sessionId: f.sessionId,
      revision: 1,
      full: { sessionId: f.sessionId, items: [] },
      value: { pending: true },
    };
  };
  await assert.rejects(
    f.host.submitNewTask('Accepted work', f.options, { worktree: {} }),
    /No provider models available/
  );
  assert.deepEqual(f.state.submits, [], 'model resolution failed before the prompt was submitted');
  reply = 'lazy';
  await assert.rejects(f.host.submitNewTask('Accepted work', f.options, { worktree: {} }), (error) => {
    assert.match(error.message, /^WORKTREE_NOT_IMPLEMENTED: /);
    return true;
  });
  assert.deepEqual(f.state.submits, [], 'an unbound session never receives the prompt');
  assert.notEqual(f.receipt().phase, 'accepted');
});

test('a reserved receipt failure still prevents submission', async (t) => {
  const f = await fixture(t);
  const rename = fsp.rename;
  const failure = Object.assign(new Error('Early receipt failure'), { code: 'EIO' });
  t.mock.method(fsp, 'rename', async (from, to) => {
    if (to === f.receiptPath && JSON.parse(fs.readFileSync(from, 'utf8')).phase === 'reserved') throw failure;
    return rename(from, to);
  });
  syncBuiltinESMExports();
  await assert.rejects(f.submit(), (error) => error === failure);
  assert.equal(f.state.creates.length, 0);
  assert.deepEqual(f.state.submits, []);
  assert.deepEqual(f.state.goals, []);
  assert.equal(fs.existsSync(f.receiptPath), false);
});

test('an ambiguous acceptance replays without reapplying the draft, even once it can no longer be applied', async (t) => {
  const f = await fixture(t);
  const draft = { workflowId: 'kept' };
  const configured = [];
  let available = true;
  f.state.onConfigure = async (params) => {
    configured.push(params.action);
    if (!available) throw new Error('route unavailable');
    return { sessionId: f.sessionId, revision: 1, full: { sessionId: f.sessionId, items: [] }, value: 'kept' };
  };
  const failure = Object.assign(new Error('Receipt publication failed'), { code: 'EIO' });
  const rename = fsp.rename;
  let failing = true;
  t.mock.method(fsp, 'rename', async (from, to) => {
    if (failing && to === f.receiptPath && JSON.parse(fs.readFileSync(from, 'utf8')).phase === 'accepted') {
      throw failure;
    }
    return rename(from, to);
  });
  syncBuiltinESMExports();
  await assert.rejects(f.host.submitNewTask('Accepted work', f.options, draft), (error) => error === failure);
  assert.equal(f.state.accepted, true, 'the daemon accepted before the receipt failed');
  assert.equal(f.receipt().phase, 'configured');
  assert.deepEqual(configured, ['setWorkflow']);
  failing = false;
  available = false;
  const replayed = await (await f.createHost()).submitNewTask('Accepted work', f.options, draft);
  assert.equal(replayed.accepted, true);
  assert.equal(replayed.sessionId, f.sessionId);
  assert.deepEqual(configured, ['setWorkflow'], 'replay skipped the draft configuration');
  assert.ok(f.state.submits.every((call) => call.sessionId === f.sessionId && call.id === f.options.id));
  assert.equal(f.receipt().phase, 'accepted');
});

test('a configured receipt replays without reconfiguring the draft', async (t) => {
  const f = await fixture(t);
  const signature = createHash('sha256')
    .update(JSON.stringify({ draft: { workflowId: 'kept' }, options: { id: f.options.id }, prompt: 'Accepted work' }))
    .digest('hex');
  await fsp.mkdir(join(f.receiptPath, '..'), { recursive: true });
  await fsp.writeFile(f.receiptPath, JSON.stringify({ signature, sessionId: f.sessionId, phase: 'configured' }));
  const configured = [];
  f.state.onConfigure = async (params) => configured.push(params.action);
  const accepted = await f.host.submitNewTask('Accepted work', f.options, { workflowId: 'kept' });
  assert.equal(accepted.accepted, true);
  assert.deepEqual(configured, [], 'the draft was already applied before the earlier version recorded it');
  assert.equal(f.receipt().phase, 'accepted');
});

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
