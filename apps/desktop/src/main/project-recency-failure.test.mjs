import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { SessionHost } from './session-host.ts';
import { DesktopProjectRegistry } from './desktop-project-registry.ts';

const moduleUrl = new URL('../../../../src/runtime/shared/projects.mjs', import.meta.url).href;
let sequence = 0;
async function fixture(t) {
  const root = await fs.promises.realpath(fs.mkdtempSync(join(tmpdir(), 'mixdog-project-recency-')));
  const project = join(root, 'project');
  const file = join(root, 'projects.json');
  fs.mkdirSync(project);
  const original = JSON.stringify({ projects: [{ path: project, name: 'project', addedAt: 1 }] });
  fs.writeFileSync(file, original);
  const saved = process.env.MIXDOG_PROJECTS_FILE;
  process.env.MIXDOG_PROJECTS_FILE = file;
  let store;
  try {
    store = await import(`${moduleUrl}?recency=${sequence++}`);
  } finally {
    if (saved === undefined) delete process.env.MIXDOG_PROJECTS_FILE;
    else process.env.MIXDOG_PROJECTS_FILE = saved;
  }
  let sessionId = '';
  const calls = { creates: 0, submits: 0, unsubscribes: 0 };
  const snapshot = () => ({ sessionId, items: [], queued: [], cwd: project, currentProject: project });
  const client = {
    list: async () => ({ sessions: [] }),
    async create(params) {
      calls.creates++;
      sessionId = params.sessionId;
      return { sessionId, revision: 0, full: snapshot() };
    },
    async submit() {
      calls.submits++;
      return { sessionId, accepted: true, revision: 1, full: snapshot() };
    },
    read: async () => ({ sessionId, revision: 1, full: snapshot() }),
    async unsubscribe() {
      calls.unsubscribes++;
      return {};
    },
    close: async () => {},
  };
  const host = await SessionHost.create(
    { userDataPath: root, resourcesPath: root, appPath: root, packaged: false },
    {
      attachSessionClient: async () => client,
      loadProjects: async () => store,
      loadSessionStore: async () => ({ listStoredAgentWorkers: () => [] }),
      loadStatuslineSegments: async () => ({}),
      executeCodeGraphTool: async () => ({}),
    }
  );
  const registry = new DesktopProjectRegistry({ loadProjectsModule: async () => store, userDataRoot: () => root });
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await nextTurn();
    await host.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, project, file, original, store, registry, host, calls, client };
}

function failRegistryPublication(t, file) {
  const failure = Object.assign(new Error('registry publication failed'), { code: 'EIO' });
  const rename = fs.renameSync;
  let attempts = 0;
  t.mock.method(fs, 'renameSync', (from, to, ...args) => {
    if (to === file) {
      attempts++;
      throw failure;
    }
    return rename(from, to, ...args);
  });
  syncBuiltinESMExports();
  return { failure, attempts: () => attempts };
}

test('startProjectTask opens and publishes its shell despite a real recency publication failure', async (t) => {
  const f = await fixture(t);
  const failed = failRegistryPublication(t, f.file);
  const snapshot = await f.host.startProjectTask(f.project);
  assert.equal(snapshot.cwd, f.project);
  assert.equal(snapshot.currentProject, f.project);
  assert.equal(f.host.getSnapshot().cwd, f.project);
  assert.equal(failed.attempts(), 1);
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
});

for (const cause of ['publication', 'corrupt registry']) {
  test(`an accepted submission commits its receipt and stays subscribed after ${cause} breaks recency`, async (t) => {
    const f = await fixture(t);
    if (cause === 'publication') failRegistryPublication(t, f.file);
    else {
      const submit = f.client.submit;
      f.client.submit = async (...args) => {
        const result = await submit(...args);
        fs.writeFileSync(f.file, '{broken');
        return result;
      };
    }
    const options = { id: `recency-submit-${cause}` };
    const draft = { projectPath: f.project };
    const result = await f.host.submitNewTask('accepted work', options, draft);
    assert.equal(result.accepted, true);
    assert.equal(result.snapshot.sessionId, result.sessionId);
    const key = createHash('sha256').update(options.id).digest('hex');
    const receipt = JSON.parse(fs.readFileSync(join(f.root, 'new-task-receipts', `${key}.json`), 'utf8'));
    assert.equal(receipt.phase, 'accepted');
    assert.equal(receipt.sessionId, result.sessionId);
    // A retry takes the durable accepted path, rather than submitting again.
    assert.equal((await f.host.submitNewTask('accepted work', options, draft)).accepted, true);
    assert.deepEqual(f.calls, { creates: 1, submits: 1, unsubscribes: 0 });
  });
}

test('enter keeps registration and unhiding when only the recency write fails', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(
    join(f.root, 'desktop-projects.json'),
    JSON.stringify({ version: 2, hidden: [f.project], aliases: {} })
  );
  const failed = failRegistryPublication(t, f.file);
  assert.deepEqual(await f.registry.enter(f.project), [f.project]);
  assert.equal(failed.attempts(), 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(join(f.root, 'desktop-projects.json'), 'utf8')).hidden, []);
  assert.equal(await f.registry.knownPath(f.project), f.project);
});

for (const action of ['add', 'enter', 'rename', 'remove', 'touch']) {
  test(`explicit ${action} still rejects the original registry persistence error`, async (t) => {
    const f = await fixture(t);
    const newPath = join(f.root, 'new-project');
    fs.mkdirSync(newPath);
    const failed = failRegistryPublication(t, f.file);
    const run = {
      add: () => f.host.addProject(newPath),
      enter: () => f.host.startProject(newPath),
      rename: () => f.host.renameProject(f.project, 'renamed'),
      remove: () => f.host.removeProject(f.project),
      touch: () => f.registry.touchSelected(f.project),
    }[action];
    await assert.rejects(run(), (error) => error === failed.failure);
    assert.equal(failed.attempts(), 1);
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
    assert.equal(f.host.getSnapshot(), null);
  });
}

test('registration and project-authority failures are not swallowed as recency failures', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(f.file, '{broken');
  await assert.rejects(f.host.startProject(f.project), SyntaxError);
  await assert.rejects(f.host.startProjectTask(f.project), SyntaxError);
  await assert.rejects(
    f.host.submitNewTask('must not start', { id: 'bad-registry' }, { projectPath: f.project }),
    SyntaxError
  );
  assert.deepEqual(f.calls, { creates: 0, submits: 0, unsubscribes: 0 });
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{broken');
});
