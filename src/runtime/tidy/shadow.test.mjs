import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectEngineShadows, shadowNote } from './shadow.mjs';

const windows = process.platform === 'win32';

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'tidy-shadow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A real executable that answers --version, the way a stray package would. */
function fakeVersionBin(dir, name, version) {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, windows ? `${name}.cmd` : name);
  const batch = version ? `echo ${name} ${version}` : 'exit /b 1';
  const shell = version ? `echo "${name} ${version}"` : 'exit 1';
  const body = windows ? `@echo off\r\n${batch}\r\n` : `#!/bin/sh\n${shell}\n`;
  writeFileSync(target, body, windows ? {} : { mode: 0o755 });
  return target;
}

function managedBin(root, id, version) {
  const dir = join(root, 'tools', id, version);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, windows ? `${id}.exe` : id);
  writeFileSync(target, '');
  return target;
}

test('a PATH binary with an engine name that tidy does not run is reported with both paths and versions', async (t) => {
  const root = workspace(t);
  const shadowPath = fakeVersionBin(join(root, 'path'), 'biome', '0.3.3');
  const managed = managedBin(root, 'biome', '2.5.13');

  const shadows = await detectEngineShadows({
    engines: [{ id: 'biome', source: 'managed', path: managed, command: managed, version: '2.5.13' }],
    env: { PATH: join(root, 'path'), Path: join(root, 'path'), npm_config_cache: join(root, 'empty-cache') },
  });

  assert.equal(shadows.length, 1);
  assert.equal(shadows[0].id, 'biome');
  assert.equal(shadows[0].bin, 'biome');
  assert.equal(shadows[0].via, 'path');
  assert.deepEqual(shadows[0].shadow, { path: shadowPath, version: '0.3.3' });
  assert.deepEqual(shadows[0].engine, { source: 'managed', path: managed, version: '2.5.13' });
  const note = shadowNote(shadows[0]);
  assert.match(note, /0\.3\.3/);
  assert.match(note, /2\.5\.13/);
  assert.match(note, /not the biome tidy uses/);
});

test('the binary tidy runs is never reported as its own shadow', async (t) => {
  const root = workspace(t);
  const binPath = fakeVersionBin(join(root, 'path'), 'ruff', '0.5.0');
  const shadows = await detectEngineShadows({
    engines: [{ id: 'ruff', source: 'path', path: binPath, command: binPath, version: '0.5.0' }],
    env: { PATH: join(root, 'path'), Path: join(root, 'path'), npm_config_cache: join(root, 'empty-cache') },
  });
  assert.deepEqual(shadows, []);
});

test('an npx-cached package with an engine name shadows the engine tidy runs', async (t) => {
  const root = workspace(t);
  const cache = join(root, 'npm-cache');
  const shadowPath = fakeVersionBin(join(cache, '_npx', 'b040de3f3c289dd6', 'node_modules', '.bin'), 'biome', '0.3.3');
  const managed = managedBin(root, 'biome', '2.5.13');

  const shadows = await detectEngineShadows({
    engines: [{ id: 'biome', source: 'managed', path: managed, command: managed, version: '2.5.13' }],
    env: { PATH: '', Path: '', npm_config_cache: cache },
  });

  assert.equal(shadows.length, 1);
  assert.equal(shadows[0].via, 'npx-cache');
  assert.deepEqual(shadows[0].shadow, { path: shadowPath, version: '0.3.3' });
  assert.equal(shadows[0].engine.path, managed);
});

test('a missing engine still reports its shadow, and an unreadable version stays empty', async (t) => {
  const root = workspace(t);
  const shadowPath = fakeVersionBin(join(root, 'path'), 'shellcheck', '');
  const shadows = await detectEngineShadows({
    engines: [{ id: 'shellcheck', source: 'missing', path: '', missing: true }],
    env: { PATH: join(root, 'path'), Path: join(root, 'path'), npm_config_cache: join(root, 'empty-cache') },
  });
  assert.equal(shadows.length, 1);
  assert.deepEqual(shadows[0].shadow, { path: shadowPath, version: '' });
  assert.deepEqual(shadows[0].engine, { source: 'missing' });
  assert.match(shadowNote(shadows[0]), /tidy has no shellcheck/);
  assert.match(shadowNote(shadows[0]), /version unknown/);
});

test('an engine reached through an alternate host binary is not a shadow of itself', async (t) => {
  const root = workspace(t);
  // psscriptanalyzer resolves through pwsh or powershell; the host that did not
  // win is the same engine, not a second one.
  const host = fakeVersionBin(join(root, 'path'), 'powershell', '5.1.0');
  fakeVersionBin(join(root, 'path'), 'pwsh', '7.4.0');
  const shadows = await detectEngineShadows({
    engines: [{ id: 'psscriptanalyzer', source: 'path', path: host, command: host, version: '1.22.0' }],
    env: { PATH: join(root, 'path'), Path: join(root, 'path'), npm_config_cache: join(root, 'empty-cache') },
  });
  assert.deepEqual(shadows, []);
});
