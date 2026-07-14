import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));

function source(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

test('Windows-sensitive Node re-execs keep their windows hidden', () => {
  const cli = source('src/cli.mjs');
  const jitRebuild = source('src/tui/dev/jit-rebuild.mjs');

  assert.match(cli, /spawnSync\(process\.execPath, \[fileURLToPath\(import\.meta\.url\), \.\.\.argv\], \{\r?\n\s*stdio: 'inherit',\r?\n\s*env: \{ \.\.\.process\.env, MIXDOG_SWAP_REEXEC: '1' \},\r?\n\s*windowsHide: true,\r?\n\s*\}\)/);
  assert.match(jitRebuild, /spawnSync\(process\.execPath, \[script\], \{\r?\n\s*stdio: process\.env\.MIXDOG_TUI_DEV_VERBOSE \? 'inherit' : 'ignore',\r?\n\s*windowsHide: true,\r?\n\s*\}\)/);
});
