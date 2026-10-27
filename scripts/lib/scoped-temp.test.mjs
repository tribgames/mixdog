import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const MODULE = new URL('./scoped-temp.mjs', import.meta.url).href;

function runChild(body, env) {
  return spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `const m = await import(${JSON.stringify(MODULE)});\n${body}`],
    {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      windowsHide: true,
    }
  );
}

test('a MIXDOG_DATA_DIR that no creator registered is never removed, inside or outside the temp root', (t) => {
  const outer = mkdtempSync(join(tmpdir(), 'mixdog-scoped-guard-'));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const unregistered = join(outer, 'data');
  const outside = mkdtempSync(join(outer, 'outside-'));
  for (const target of [unregistered, outer, outside]) {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'keep'), 'x');
    const result = runChild('m.makeTempDirSync("guard");', { MIXDOG_DATA_DIR: target });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(target, 'keep')), true, target);
  }
});

test('registering a directory outside the system temp root is refused and leaves it alone', (t) => {
  const outer = mkdtempSync(join(tmpdir(), 'mixdog-scoped-guard-'));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const nested = join(outer, 'mixdog-nested');
  mkdirSync(nested);
  writeFileSync(join(nested, 'keep'), 'x');
  const elsewhere = mkdtempSync(join(tmpdir(), 'plain-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  const body = `for (const d of [${JSON.stringify(nested)}, ${JSON.stringify(elsewhere)}, ${JSON.stringify(tmpdir())}]) {
    try { m.registerOwnedTempDir(d); process.exitCode = 3; } catch {}
  }`;
  const result = runChild(body, {});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(nested, 'keep')), true);
  assert.equal(existsSync(elsewhere), true);
});

test('a registered temp-root directory is removed at exit at exit', () => {
  const body = `const d = m.makeTempDirSync("late"); process.on('exit', () => { import('node:fs').then(() => {}); });
    process.stdout.write(d);`;
  const result = runChild(body, {});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(result.stdout.trim()), false);
});
