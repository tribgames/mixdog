import {
  applyShellEgressPolicy,
  scrubLoaderVars,
  scrubProviderSecrets,
  scrubRuntimeRootVars,
} from '../../env-scrub.mjs';

export function buildShellSpawnEnv(cwd, baseEnv = process.env) {
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
  return spawnEnv;
}
