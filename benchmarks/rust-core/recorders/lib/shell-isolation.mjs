// The environment the phone-terminal recordings and replays give the shells: a profile folder the run owns (USERPROFILE, HOME, APPDATA,
// LOCALAPPDATA, TEMP, TMP), so nothing a shell writes for itself (PSReadLine's history, temp files) lands in the user's real profile, and
// nothing in it reaches the recording.
//
// PowerShell's own profile scripts are not found through the environment: `$PROFILE` is under the Documents known folder, which on this
// machine is an absolute registry value (redirected to OneDrive), so no variable moves it. The run therefore checks, with the shells
// themselves under the isolated environment, that no profile script exists where they would load one, and refuses to run otherwise:
// a recording that loaded a user's profile would not be Node's behaviour but the profile's.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** The isolated variables for a run whose profile folder is `dir` (made here). */
export function isolatedProfile(dir) {
  const roaming = join(dir, 'AppData', 'Roaming');
  const local = join(dir, 'AppData', 'Local');
  const temp = join(local, 'Temp');
  for (const folder of [roaming, temp]) mkdirSync(folder, { recursive: true });
  return { USERPROFILE: dir, HOME: dir, APPDATA: roaming, LOCALAPPDATA: local, TEMP: temp, TMP: temp };
}

/** Throws, naming the file, when a PowerShell (pwsh or Windows PowerShell) would load a profile script under `env`. */
export function assertNoPowerShellProfile(env) {
  const command = '$PROFILE.AllUsersAllHosts; $PROFILE.AllUsersCurrentHost; $PROFILE.CurrentUserAllHosts; $PROFILE.CurrentUserCurrentHost';
  for (const shell of ['pwsh.exe', 'powershell.exe']) {
    const ran = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', command], { env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    if (ran.error?.code === 'ENOENT') continue;
    if (ran.error || ran.status !== 0) throw new Error(`${shell} did not name its profile scripts within 60 s (${ran.status}): ${ran.error?.message ?? ran.stderr}`);
    for (const file of ran.stdout.split(/\r?\n/).filter(Boolean)) {
      if (existsSync(file)) throw new Error(`${shell} would load the profile script ${file}: the recording would hold the profile's output, not Node's. Run on an account without one.`);
    }
  }
}
