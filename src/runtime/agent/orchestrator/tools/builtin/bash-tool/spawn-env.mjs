import { applySessionScratchEnv } from '../../../../../shared/session-scratch.mjs';
import { withSkillLauncherPath } from '../../../../../shared/skill-script-runtime.mjs';
import {
  applyShellEgressPolicy,
  scrubLoaderVars,
  scrubProviderSecrets,
  scrubRuntimeRootVars,
} from '../../env-scrub.mjs';

// `sessionId` points TEMP/TMP/TMPDIR at that session's scratch directory.
export function buildShellSpawnEnv(cwd, baseEnv = process.env, sessionId = null) {
  const spawnEnv = {
    ...baseEnv,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    MIXDOG_SESSION_CWD: String(cwd || ''),
  };
  if (process.platform === 'win32') {
    if (spawnEnv.PYTHONUTF8 === undefined) spawnEnv.PYTHONUTF8 = '1';
    if (spawnEnv.PYTHONIOENCODING === undefined) spawnEnv.PYTHONIOENCODING = 'utf-8';
  }
  scrubProviderSecrets(spawnEnv);
  scrubLoaderVars(spawnEnv);
  scrubRuntimeRootVars(spawnEnv);
  applyShellEgressPolicy(spawnEnv);
  // `mixdog-skill-node` (a skill's ${MIXDOG_SKILL_NODE}) resolves in every
  // model shell; only this env gets the entry, never the daemon's own.
  withSkillLauncherPath(spawnEnv);
  return applySessionScratchEnv(spawnEnv, sessionId);
}
