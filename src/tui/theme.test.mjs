import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SCENARIOS } from './theme-golden/scenarios.mjs';

const root = mkdtempSync(join(tmpdir(), 'mixdog-theme-'));
process.env.MIXDOG_HOME = join(root, 'home');
process.env.MIXDOG_CONFIG_DIR = join(root, 'home');
const { applyStoredThemeSetting, getThemeSetting } = await import('./theme.mjs');
const { readStoredThemeSetting } = await import('./theme-config.mjs');
const golden = JSON.parse(readFileSync(new URL('./theme-golden/node-theme.golden.json', import.meta.url), 'utf8'));

// Every file under a folder with its bytes: the read must leave the data dir exactly as it found it.
const snapshot = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
    .map((file) => [file, readFileSync(file, 'utf8')]);

test('the golden covers every state, recorded from b6f10295a', () => {
  assert.match(golden.recordedFrom, /^b6f10295a[0-9a-f]{31}$/);
  assert.deepEqual(golden.scenarios.map((s) => s.name), SCENARIOS.map((s) => s.name));
});

for (const scenario of SCENARIOS) {
  test(`boot theme equals Node's: ${scenario.name}`, (t) => {
    const base = mkdtempSync(join(tmpdir(), 'mixdog-theme-state-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const dataDir = join(base, 'data');
    const backupRoot = join(base, 'backups');
    scenario.setup({ dataDir, backupRoot });
    process.env.MIXDOG_USER_DATA_BACKUP_ROOT = backupRoot;
    t.after(() => delete process.env.MIXDOG_USER_DATA_BACKUP_ROOT);
    const before = snapshot(base);
    // A read that fails leaves the default palette, as Node's boot did.
    const recorded = golden.scenarios.find((s) => s.name === scenario.name).theme;
    assert.equal(readStoredThemeSetting(dataDir), recorded === 'THROW' ? null : recorded);
    // The TUI never writes the config or renames a malformed one: that repair is not its to make.
    assert.deepEqual(snapshot(base), before);
  });
}

test('boot applies the stored theme', (t) => {
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(applyStoredThemeSetting('nord'), 'nord');
  assert.equal(getThemeSetting(), 'nord');
});
