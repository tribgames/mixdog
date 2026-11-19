// Every path belongs to one recording; the daemon receives no user service or credential settings.
import { join } from 'node:path';

/** The only parent variables a child needs: Windows system locations, no PATH entries of the user. */
const SYSTEM_ROOT = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
const BASE_ENV = {
  SystemRoot: SYSTEM_ROOT,
  windir: SYSTEM_ROOT,
  ComSpec: join(SYSTEM_ROOT, 'System32', 'cmd.exe'),
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  PATH: `${join(SYSTEM_ROOT, 'System32')};${SYSTEM_ROOT}`,
};
export function isolatedPaths(envRoot) {
  const home = join(envRoot, 'home');
  return {
    envRoot,
    home,
    mixdogHome: join(home, '.mixdog'),
    dataDir: join(home, '.mixdog', 'data'),
    runtimeRoot: join(envRoot, 'runtime'),
    appData: join(home, 'AppData', 'Roaming'),
    localAppData: join(home, 'AppData', 'Local'),
    tmp: join(envRoot, 'tmp'),
    workspace: join(envRoot, 'ws'),
  };
}

/** A child's environment: a fixed system base plus the isolated roots; nothing is inherited from the parent. */
export function daemonEnv(paths, extra = {}) {
  return {
    ...BASE_ENV,
    MIXDOG_DATA_DIR: paths.dataDir,
    MIXDOG_HOME: paths.mixdogHome,
    MIXDOG_CONFIG_DIR: paths.mixdogHome,
    MIXDOG_DESKTOP_USER_DATA: join(paths.appData, 'Mixdog'),
    MIXDOG_RUNTIME_ROOT: paths.runtimeRoot,
    MIXDOG_SKIP_USER_DATA_BACKUP: '1',
    MIXDOG_DISABLE_MCP: '1',
    HOME: paths.home,
    USERPROFILE: paths.home,
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.localAppData,
    TEMP: paths.tmp,
    TMP: paths.tmp,
    TMPDIR: paths.tmp,
    NO_PROXY: '127.0.0.1,localhost',
    ...extra,
  };
}
