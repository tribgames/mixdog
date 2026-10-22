import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { MACRO_LOCKDOWN_REGISTRY, runSoffice, sharedProfileDir, sofficeConvertArguments } from './portable-soffice.mjs';

const sleeper = (pidFile) =>
  `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pidOf(file) {
  for (let i = 0; i < 200; i += 1) {
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8');
      if (text) return Number(text);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('child never started');
}

test('a cancelled conversion is reported only after its process has exited', async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), 'soffice-life-')), 'pid');
  const controller = new AbortController();
  const run = runSoffice(process.execPath, ['-e', sleeper(pidFile)], {
    signal: controller.signal,
    timeoutMs: 60_000,
    timeoutMessage: 'timed out',
    cancelMessage: 'cancelled',
  });
  const pid = await pidOf(pidFile);
  controller.abort();
  assert.deepEqual(await run, { ok: false, error: 'cancelled' });
  assert.equal(alive(pid), false);
});

test('a timed-out conversion is reported only after its process has exited', async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), 'soffice-life-')), 'pid');
  const run = runSoffice(process.execPath, ['-e', sleeper(pidFile)], {
    signal: null,
    timeoutMs: 700,
    timeoutMessage: 'timed out',
    cancelMessage: 'cancelled',
  });
  const result = await run;
  assert.deepEqual(result, { ok: false, error: 'timed out' });
  assert.equal(alive(await pidOf(pidFile)), false);
});

test('conversions launch in a private profile with first-start and recovery prompts off', () => {
  const profile = join(tmpdir(), 'profile-x');
  const args = sofficeConvertArguments(profile, { to: 'xlsx', outDir: 'out', input: 'in.xls' });
  assert.equal(args[0], `-env:UserInstallation=${pathToFileURL(profile).href}`);
  for (const flag of ['--headless', '--norestore', '--nofirststartwizard', '--nologo', '--invisible']) {
    assert.ok(args.includes(flag), flag);
  }
  assert.deepEqual(args.slice(-5), ['--convert-to', 'xlsx', '--outdir', 'out', 'in.xls']);
});

test('the private profile starts with macros locked down', async () => {
  const profile = await sharedProfileDir();
  const registry = readFileSync(join(profile, 'user', 'registrymodifications.xcu'), 'utf8');
  assert.equal(registry, MACRO_LOCKDOWN_REGISTRY);
  assert.match(registry, /oor:name="MacroSecurityLevel" oor:op="fuse"><value>3<\/value>/);
  assert.match(registry, /oor:name="DisableMacrosExecution" oor:op="fuse"><value>true<\/value>/);
  assert.match(registry, /Office\.Common\/Security\/Scripting/);
});
