import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(join(tmpdir(), 'mixdog-project-authority-'));
const path = join(root, 'projects.json');
process.env.MIXDOG_PROJECTS_FILE = path;
const { listProjects, listProjectsStrict } = await import('./projects.mjs');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function validStore() {
  return JSON.stringify({ projects: [
    { path: join(root, 'old'), name: 'old', addedAt: 1 },
    { path: join(root, 'recent'), name: 'recent', addedAt: 2, lastSelectedAt: 3 },
  ] });
}

test('strict project lists preserve valid normalization/order without writing storage', () => {
  const raw = validStore();
  fs.writeFileSync(path, raw);
  assert.deepEqual(listProjectsStrict(), listProjects());
  assert.equal(listProjectsStrict()[0].name, 'recent');
  assert.equal(fs.readFileSync(path, 'utf8'), raw);
});

test('missing or explicitly empty project stores are definite empty registries', () => {
  fs.rmSync(path, { force: true });
  assert.deepEqual(listProjectsStrict(), []);
  fs.writeFileSync(path, '{"projects":[]}');
  assert.deepEqual(listProjectsStrict(), []);
});

test('corrupt registry documents cannot prove that a project was removed', () => {
  for (const raw of ['{', 'null', '{}', '{"projects":{}}', '{"projects":[null]}',
    '{"projects":[{"path":"relative"}]}', '{"projects":[{"path":""}]}']) {
    fs.writeFileSync(path, raw);
    assert.throws(() => listProjectsStrict(), (error) => error instanceof SyntaxError || error instanceof TypeError);
    assert.doesNotThrow(() => listProjects(), 'legacy tolerant behavior is unchanged');
    assert.equal(fs.readFileSync(path, 'utf8'), raw);
  }
  fs.writeFileSync(path, validStore());
  assert.equal(listProjectsStrict().length, 2, 'a subsequent healthy lookup recovers');
});

for (const code of ['EIO', 'EACCES']) {
  test(`strict project storage propagates ${code}, while tolerant lists retain their contract`, (t) => {
    fs.writeFileSync(path, validStore());
    const failure = Object.assign(new Error('injected storage uncertainty'), { code });
    const read = fs.readFileSync;
    const mocked = t.mock.method(fs, 'readFileSync', (file, ...args) => {
      if (file === path) throw failure;
      return read(file, ...args);
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => listProjectsStrict(), (error) => error === failure);
      assert.deepEqual(listProjects(), []);
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(listProjectsStrict().length, 2);
  });
}
