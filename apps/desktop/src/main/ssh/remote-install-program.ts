// The one script every bootstrap, install and cleanup run executes on the
// server (LR §8.1). It is POSIX `sh` only: it probes the platform, unpacks the
// uploaded bundle (`mixdogd` + its JS runtime) privately after checking its sha256, and
// hands everything else to `mixdogd server-ensure` — the install lock, the
// version decision (`compat::order`), replacing or starting the core and the
// garbage collection all live there, in Rust, never in this script.
//
// Contract with `mixdogd server-ensure <args>`:
//   argv   one argument: the base64 JSON of `RemoteProgramArgs`.
//   stdout `MIXDOG_RESULT <json>` (last such line wins) or
//          `MIXDOG_ERROR <code> <message>`; exit 0 / 3.
//   The result carries `home`, `uid`, `runtimeRoot`, `versionDir`, `installed`,
//   `daemonJson` (the raw discovery file, LR §4), `healthy`, `coreCurrent`,
//   `started`, `replaced`, `gcRemoved` and, while an older core winds down
//   with work still running, `drain` (`drainId`, `running`, `confirmToken`).
//   It installs itself into `versions/<installId>/mixdogd` when it runs from
//   the staging file and the order is not `ClientOlder`.
import { REMOTE_PLATFORM_PROBE_SHELL } from './remote-install-platform';

/** Server-side directory, relative to the remote $HOME, holding every
 *  desktop-installed artifact. */
export const REMOTE_STATE_DIRECTORY = '.mixdog-remote';

/** How long an ensure run waits for another holder of the install lock before
 *  `install-locked`, and when a holder is presumed crashed. */
export const REMOTE_INSTALL_LOCK_WAIT_MS = 240_000;
export const REMOTE_INSTALL_LOCK_STALE_MS = 15 * 60_000;

/** Arguments of one `server-ensure` run. */
export interface RemoteProgramArgs {
  mode: 'probe' | 'ensure' | 'cleanup';
  /** `<version>-<build>`: the version directory name. */
  installId: string;
  version: string;
  build: string;
  /** The bundle (gzip tar of `mixdogd` and `payload/`, its sha256 `bundleSha256`) follows on stdin; the
   *  bootstrap checks it, unpacks it and runs `server-ensure` from the unpacked `mixdogd`, whose own
   *  sha256 is `sha256`. `server-ensure` installs the binary and `payload/` as one version directory. */
  upload?: boolean;
  sha256?: string;
  bundleSha256?: string;
  /** ensure: the user confirmed aborting the running work the last drain listed. */
  confirmToken?: string;
  /** probe/ensure: 'server' wants a core that runs models with the server's own logins. */
  modelLogin?: 'server';
  /** cleanup: 'stop' stops the core only; 'remove' also deletes files. */
  phase?: 'stop' | 'remove';
  removeUserData?: boolean;
  lockWaitMs?: number;
  lockStaleMs?: number;
}

const FAIL_SHELL = `fail() { printf 'MIXDOG_ERROR %s %s\\n' "$1" "$2"; exit 3; }`;

/** POSIX single-quote quoting. */
export function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function encodeProgramArgs(args: RemoteProgramArgs): string {
  return Buffer.from(JSON.stringify(args), 'utf8').toString('base64');
}

const SAFE_INSTALL_ID = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Not installed: the probe still reports where the server's home is. */
const PROBE_NOT_INSTALLED_SHELL = `
HOME_JSON=$(printf %s "$HOME" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g')
printf 'MIXDOG_RESULT {"home":"%s","uid":%s,"installed":false}\\n' "$HOME_JSON" "$(id -u)"
`;

/** Keep the upload in a private file, check its digest, unpack it (still under `$ROOT`, so the
 *  install can move `payload/` by rename) and run `server-ensure` from the unpacked `mixdogd`.
 *  Both are removed on every exit. */
function uploadShell(bundleSha256: string): string {
  return `
command -v gzip >/dev/null 2>&1 || fail install-failed "gzip was not found on the server."
command -v tar >/dev/null 2>&1 || fail install-failed "tar was not found on the server."
if command -v sha256sum >/dev/null 2>&1; then SHA_TOOL="sha256sum"
elif command -v shasum >/dev/null 2>&1; then SHA_TOOL="shasum -a 256"
else fail install-failed "Neither sha256sum nor shasum was found on the server."; fi
mkdir -p "$ROOT/tmp" && chmod 700 "$ROOT" "$ROOT/tmp" 2>/dev/null
WORK="$ROOT/tmp/upload.$$"
BUNDLE="$WORK.tgz"
trap 'rm -rf "$WORK" "$BUNDLE"' EXIT
trap 'exit 1' HUP INT TERM
cat > "$BUNDLE" || fail install-failed "The uploaded Mixdog runtime could not be stored on the server."
ACTUAL=$($SHA_TOOL "$BUNDLE" | cut -d' ' -f1)
[ "$ACTUAL" = ${shQuote(bundleSha256)} ] || fail install-failed "The uploaded Mixdog runtime does not match its digest."
mkdir -m 700 "$WORK" || fail install-failed "The upload directory could not be created on the server."
gzip -dc < "$BUNDLE" | tar -xf - -C "$WORK" || fail install-failed "The uploaded Mixdog runtime could not be unpacked on the server."
chmod 700 "$WORK/mixdogd" || fail install-failed "The uploaded Mixdog runtime holds no mixdogd."
chmod 755 "$WORK/payload/js/node" 2>/dev/null
"$WORK/mixdogd" server-ensure "$ARGS"
exit $?
`;
}

/** Platform probe, then the run: the installed `mixdogd`, or the uploaded one. */
export function remoteProgramScript(args: RemoteProgramArgs): string {
  if (!SAFE_INSTALL_ID.test(args.installId)) throw new Error(`Server install id is not a safe path segment: ${args.installId}`);
  if (args.upload && !(SHA256_HEX.test(args.sha256 ?? '') && SHA256_HEX.test(args.bundleSha256 ?? ''))) {
    throw new Error('An upload needs the sha256 of the runtime and of its bundle.');
  }
  const head = [
    FAIL_SHELL,
    REMOTE_PLATFORM_PROBE_SHELL,
    `ROOT="$HOME/${REMOTE_STATE_DIRECTORY}"`,
    `INSTALLED="$ROOT/versions/${args.installId}/mixdogd"`,
    `ARGS=${shQuote(encodeProgramArgs(args))}`,
  ];
  if (args.upload) return [...head, uploadShell(args.bundleSha256 as string)].join('\n');
  const installed = `exec "$INSTALLED" server-ensure "$ARGS"`;
  if (args.mode === 'probe') {
    return [...head, `if [ -x "$INSTALLED" ]; then ${installed}; fi`, PROBE_NOT_INSTALLED_SHELL].join('\n');
  }
  return [
    ...head,
    `[ -x "$INSTALLED" ] || fail install-missing "The Mixdog runtime is not installed on the server and must be uploaded."`,
    installed,
    '',
  ].join('\n');
}

/** The command line handed to the user's login shell. Only base64 crosses
 *  it, inside single quotes, so bash, zsh, fish and csh all pass the script
 *  to `sh` unchanged. */
export function remoteShellCommand(script: string): string {
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  return `sh -c 'eval "$(printf %s ${encoded} | base64 -d)"'`;
}
