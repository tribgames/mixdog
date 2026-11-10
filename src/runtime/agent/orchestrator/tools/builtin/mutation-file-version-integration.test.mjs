// Actual adapter/JS-dispatch calls. Only leaf filesystem timing is controlled;
// no replacement of the writer, snapshot functions, parsers or patch engine.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(join(tmpdir(), 'mixdog-write-version-integration-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
// Exercise the established no-native-artifact JS route, never download or
// start an unrelated engine merely to test the guarded writer's callers.
process.env.MIXDOG_PATCH_NATIVE_BIN = join(root, 'missing-patch-engine');
process.env.MIXDOG_EDIT_NATIVE_BIN = join(root, 'missing-edit-engine');
process.env.MIXDOG_PATCH_NATIVE_PREWARM = '0';
const { tryExecuteExternalToolAdapter } = await import('./external-tool-adapters.mjs');
const { dispatchJsPatchEntries } = await import('../patch/dispatch.mjs');
const { invalidateBuiltinResultCache } = await import('./cache-layers.mjs');
test.afterEach(() => invalidateBuiltinResultCache());
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
let sequence = 0;
function fixture() {
  const path = join(root, `file-${sequence++}.txt`);
  fs.writeFileSync(path, 'BEFORE\n');
  return path;
}
const routes = [
  {
    name: 'edit adapter',
    run: (path) =>
      tryExecuteExternalToolAdapter(
        'edit',
        {
          file_path: path,
          old_string: 'BEFORE',
          new_string: 'EDITED',
        },
        root,
        {}
      ),
  },
  {
    name: 'JS patch',
    run: (path) =>
      dispatchJsPatchEntries({
        rows: [{ fullPath: path, displayPath: basename(path), kind: 'modify' }],
        parsed: [
          {
            oldFileName: `a/${basename(path)}`,
            newFileName: `b/${basename(path)}`,
            hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-BEFORE', '+EDITED'] }],
          },
        ],
        basePath: root,
        dryRun: false,
        fuzzy: false,
        readStateScope: null,
      }),
  },
];

for (const route of routes) {
  test(`${route.name}: complete current evidence reaches the guarded writer`, async () => {
    const path = fixture();
    const result = String(await route.run(path));
    assert.doesNotMatch(result, /^Error:/);
    assert.equal(fs.readFileSync(path, 'utf8'), 'EDITED\n');
  });

  for (const field of ['mtimeMs', 'ctimeMs', 'ino', 'dev']) {
    test(`${route.name}: ${field} drift during temp creation is not written over`, async (t) => {
      const path = fixture();
      let drift = false;
      const originalStat = fs.statSync;
      const originalOpen = fsp.open;
      const statMock = t.mock.method(fs, 'statSync', (target, ...args) => {
        const st = originalStat(target, ...args);
        if (!drift || target !== path) return st;
        const value = field.endsWith('Ms') ? st[field] + 0.5 : st[field] === 0 ? 1 : 0;
        assert.notEqual(value, st[field]);
        st[field] = value;
        return st;
      });
      const openMock = t.mock.method(fsp, 'open', async (target, ...args) => {
        const fh = await originalOpen(target, ...args);
        if (String(target).includes(`${basename(path)}.mixdog-tmp-`)) drift = true;
        return fh;
      });
      syncBuiltinESMExports();
      t.after(() => {
        statMock.mock.restore();
        openMock.mock.restore();
        syncBuiltinESMExports();
      });
      const result = String(await route.run(path));
      assert.match(result, /^Error:.*changed on disk during (?:the edit|the patch)/);
      assert.equal(fs.readFileSync(path, 'utf8'), 'BEFORE\n');
      assert.equal(
        fs.readdirSync(root).some((name) => name.startsWith(`${basename(path)}.mixdog-tmp-`)),
        false
      );
    });
  }

  test(`${route.name}: a symlink is checked against the referent version and kept intact`, async (t) => {
    const target = fixture();
    const link = join(root, `link-${sequence++}.txt`);
    try {
      fs.symlinkSync(target, link, 'file');
    } catch (error) {
      if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
      return t.skip('Windows symlink creation is not permitted on this host');
    }
    assert.doesNotMatch(String(await route.run(link)), /^Error:/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'EDITED\n');
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  });
}

for (const code of ['EIO', 'EACCES']) {
  test(`edit adapter: failed pre-stat ${code} cannot authorize recreating a removed target`, async (t) => {
    const path = fixture();
    let removed = false;
    const originalStat = fs.statSync;
    const originalRead = fs.readFileSync;
    const statMock = t.mock.method(fs, 'statSync', (target, ...args) => {
      if (target === path && !removed) throw Object.assign(new Error('pre-stat uncertainty'), { code });
      return originalStat(target, ...args);
    });
    const readMock = t.mock.method(fs, 'readFileSync', (target, ...args) => {
      const buf = originalRead(target, ...args);
      if (target === path && !removed) {
        fs.unlinkSync(path);
        removed = true;
      }
      return buf;
    });
    syncBuiltinESMExports();
    t.after(() => {
      statMock.mock.restore();
      readMock.mock.restore();
      syncBuiltinESMExports();
    });
    const result = String(await routes[0].run(path));
    assert.equal(removed, true, 'exercise successful reading followed by real removal');
    assert.match(result, /^Error:.*changed on disk during the edit/);
    assert.equal(fs.existsSync(path), false, 'unknown pre-read version must not become expected absence');
    assert.equal(
      fs.readdirSync(root).some((name) => name.startsWith(`${basename(path)}.mixdog-tmp-`)),
      false
    );
  });
}
