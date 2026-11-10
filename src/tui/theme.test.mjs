import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SCENARIOS, themeLayout, themePaths } from './theme-golden/scenarios.mjs';

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
  // Every state of this platform is recorded (the golden may hold more: the states of the platform it was recorded on).
  const recorded = new Set(golden.scenarios.map((s) => s.name));
  assert.deepEqual(SCENARIOS.filter((s) => !recorded.has(s.name)).map((s) => s.name), []);
});

for (const scenario of SCENARIOS) {
  test(`boot theme equals Node's: ${scenario.name}`, (t) => {
    const base = mkdtempSync(join(tmpdir(), 'mixdog-theme-state-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const { dataDir, readDir } = themePaths(base, scenario);
    const layout = themeLayout(base, scenario);
    scenario.setup({ dataDir, backupRoot: layout.backupRoot, legacyRoot: layout.legacyRoot });
    const saved = Object.fromEntries(['MIXDOG_HOME', 'MIXDOG_CONFIG_DIR', 'MIXDOG_USER_DATA_BACKUP_ROOT', 'USERPROFILE', 'HOME'].map((name) => [name, process.env[name]]));
    Object.assign(process.env, layout.env);
    for (const name of layout.unset) delete process.env[name];
    t.after(() => {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
    const before = snapshot(base);
    // A read that fails leaves the default palette, as Node's boot did.
    const recorded = golden.scenarios.find((s) => s.name === scenario.name).theme;
    assert.equal(readStoredThemeSetting(readDir), recorded === 'THROW' ? null : recorded);
    // The TUI never writes the config or renames a malformed one: that repair is not its to make.
    assert.deepEqual(snapshot(base), before);
  });
}

test('boot applies the stored theme', (t) => {
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(applyStoredThemeSetting('nord'), 'nord');
  assert.equal(getThemeSetting(), 'nord');
});
