import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDirSync } from '../../../../../../scripts/lib/scoped-temp.mjs';

// Import before runtime modules: several paths are captured at module load.
// Removed when the importing test process exits.
export const fixtureRoot = makeTempDirSync('shell-fixture');
for (const name of [
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'MIXDOG_HOME',
  'MIXDOG_DATA_DIR',
  'MIXDOG_CONFIG_DIR',
  'MIXDOG_RUNTIME_ROOT',
  'MIXDOG_PROJECT_DIR',
  'npm_config_cache',
]) {
  const directory = join(fixtureRoot, name);
  mkdirSync(directory, { recursive: true });
  process.env[name] = directory;
}
process.env.npm_config_userconfig = join(fixtureRoot, 'user.npmrc');
process.env.npm_config_globalconfig = join(fixtureRoot, 'global.npmrc');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
process.env.MIXDOG_PATCH_REPLAY_CAPTURE = '0';
process.env.MIXDOG_TOOL_FAILURE_LOG_PATH = join(fixtureRoot, 'tool-failures.jsonl');
