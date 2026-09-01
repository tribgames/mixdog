import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectSuiteScripts, WORKSPACES } from './suite-health.mjs';

test('selection takes every test:/smoke: script and honors reasoned exclusions', () => {
  const scripts = {
    'test:a': '', smoke: '', 'smoke:b': '', 'bench:x': '', build: '', 'test:skip': '',
  };
  assert.deepEqual(
    selectSuiteScripts(scripts, { 'test:skip': 'reason' }),
    ['test:a', 'smoke', 'smoke:b'],
  );
});

test('a stale exclusion fails closed instead of silently shrinking the sweep', () => {
  assert.throws(
    () => selectSuiteScripts({ 'test:a': '' }, { 'test:gone': 'reason' }),
    /stale exclusions/,
  );
});

test('the configured workspaces select real, non-empty suite catalogs', () => {
  for (const ws of WORKSPACES) {
    const pkgUrl = new URL(
      ws.dir === '.' ? '../package.json' : `../${ws.dir}/package.json`,
      import.meta.url,
    );
    const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8'));
    const names = selectSuiteScripts(pkg.scripts || {}, ws.exclusions);
    assert.ok(names.length > 0, `${ws.dir} sweep must not be empty`);
    for (const excluded of Object.keys(ws.exclusions)) {
      assert.ok(!names.includes(excluded), `${excluded} must stay excluded`);
    }
  }
});
