import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-theme-'));
process.env.MIXDOG_DATA_DIR = dir;
const { applyStoredThemeSetting, getThemeSetting, readStoredThemeSetting } = await import('./theme.mjs');

test('boot reads ui.theme from the config file and applies it', (t) => {
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(readStoredThemeSetting(), null);
  writeFileSync(join(dir, 'mixdog-config.json'), JSON.stringify({ ui: { theme: 'nord' } }));
  assert.equal(readStoredThemeSetting(), 'nord');
  assert.equal(applyStoredThemeSetting('nord'), 'nord');
  assert.equal(getThemeSetting(), 'nord');
  writeFileSync(join(dir, 'mixdog-config.json'), '{ broken');
  assert.equal(readStoredThemeSetting(), null);
});
