import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { applyConfigOverlay, applyPassEnv, mergeConfigOverlay, parsePassEnv } from './dev-isolated.mjs';

test('mergeConfigOverlay merges objects deeply and replaces arrays and scalars', () => {
  const base = { a: 1, agent: { onboarding: { completed: true }, list: [1, 2] }, keep: 'x' };
  const merged = mergeConfigOverlay(base, { a: 2, agent: { onboarding: { skipped: false }, list: [3] }, extra: { n: 1 } });
  assert.deepEqual(merged, {
    a: 2,
    agent: { onboarding: { completed: true, skipped: false }, list: [3] },
    keep: 'x',
    extra: { n: 1 },
  });
  assert.equal(base.agent.onboarding.skipped, undefined);
});

test('mergeConfigOverlay ignores __proto__ and starts from nothing', () => {
  const merged = mergeConfigOverlay(null, JSON.parse('{"__proto__":{"polluted":true},"k":1}'));
  assert.equal({}.polluted, undefined);
  assert.equal(merged.polluted, undefined);
  assert.deepEqual(merged, { k: 1 });
});

test('applyConfigOverlay lays the file over the seeded config, or makes one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dev-iso-hooks-'));
  try {
    const overlay = join(dir, 'overlay.json');
    await writeFile(overlay, JSON.stringify({ agent: { provider: 'local' } }));
    await applyConfigOverlay(dir, overlay);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'mixdog-config.json'), 'utf8')), { agent: { provider: 'local' } });
    await writeFile(overlay, JSON.stringify({ agent: { model: 'm' } }));
    await applyConfigOverlay(dir, overlay);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'mixdog-config.json'), 'utf8')), {
      agent: { provider: 'local', model: 'm' },
    });
    await writeFile(overlay, '[1]');
    await assert.rejects(applyConfigOverlay(dir, overlay), /object/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parsePassEnv accepts MIXDOG_ names only', () => {
  assert.deepEqual(parsePassEnv('MIXDOG_DIAGNOSTICS, MIXDOG_AGENT_TRACE_TIMING,MIXDOG_DIAGNOSTICS'), [
    'MIXDOG_DIAGNOSTICS',
    'MIXDOG_AGENT_TRACE_TIMING',
  ]);
  assert.deepEqual(parsePassEnv(undefined), []);
  assert.throws(() => parsePassEnv('PATH'), /MIXDOG_/);
  assert.throws(() => parsePassEnv('MIXDOG_OK,ELECTRON_RUN_AS_NODE'), /ELECTRON_RUN_AS_NODE/);
});

test('applyPassEnv keeps named variables and refuses isolation-owned ones', () => {
  const env = { MIXDOG_DATA_DIR: '/inst/data' };
  const parent = { MIXDOG_DIAGNOSTICS: '1', MIXDOG_DATA_DIR: '/shared' };
  applyPassEnv(env, ['MIXDOG_DIAGNOSTICS', 'MIXDOG_UNSET'], parent);
  assert.equal(env.MIXDOG_DIAGNOSTICS, '1');
  assert.equal('MIXDOG_UNSET' in env, false);
  assert.throws(() => applyPassEnv(env, ['MIXDOG_DATA_DIR'], parent), /isolation/);
  assert.equal(env.MIXDOG_DATA_DIR, '/inst/data');
});

test('a packaged core never receives the test hooks; a dev core does', () => {
  // local-core.ts is TypeScript: a child process with the desktop's own loader evaluates it.
  const desktopDir = fileURLToPath(new URL('..', import.meta.url));
  const script = `
    const { coreEnvironment } = await import('./src/main/protocol/local-core.ts');
    const base = { MIXDOGD_TEST_HOOKS: '1', MIXDOG_DEV_COMPUTER_RUN: '1', MIXDOG_DIAGNOSTICS: '1' };
    console.log(JSON.stringify({
      packaged: coreEnvironment(true, '/res', '/user', base),
      dev: coreEnvironment(false, '/res', '/user', base) === base,
    }));`;
  const out = execFileSync(
    process.execPath,
    ['--import', './scripts/test-env.mjs', '--import', './scripts/test-tsx.mjs', '--input-type=module', '-e', script],
    { cwd: desktopDir, encoding: 'utf8' }
  );
  const { packaged, dev } = JSON.parse(out.trim().split(/\r?\n/).pop());
  assert.equal('MIXDOGD_TEST_HOOKS' in packaged, false);
  assert.equal('MIXDOG_DEV_COMPUTER_RUN' in packaged, false);
  assert.equal(packaged.MIXDOG_DIAGNOSTICS, '1');
  assert.equal(dev, true);
});
