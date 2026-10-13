// Which servers the remote install supports, decided from the platform probe
// that runs before anything else on the server: `uname -sm` plus glibc vs musl
// in the shell, then the node ABI inside the server program. Linux x64/arm64
// on glibc and macOS x64/arm64 are supported. The runtime's native modules
// (and node-pty's prebuilds, see REMOTE_PLATFORM_SOURCE) have no musl or
// Windows builds, so those servers stop with `unsupported-platform`.
import { RemoteBootstrapError } from './remote-install-errors';

export interface RemotePlatform {
  os: 'linux' | 'darwin';
  arch: 'x64' | 'arm64';
}

/** Prints `MIXDOG_PLATFORM <uname -s> <uname -m>|<libc>` before node is
 *  even looked for, so an unsupported server is named as such. */
export const REMOTE_PLATFORM_PROBE_SHELL = `
MIXDOG_LIBC=none
if [ "$(uname -s 2>/dev/null)" = Linux ]; then
  if [ -e /etc/alpine-release ] || ls /lib/ld-musl-* /usr/lib/ld-musl-* >/dev/null 2>&1 || { ldd --version 2>&1 | grep -qi musl; }; then
    MIXDOG_LIBC=musl
  elif getconf GNU_LIBC_VERSION >/dev/null 2>&1; then
    MIXDOG_LIBC=glibc
  else
    MIXDOG_LIBC=unknown
  fi
fi
printf 'MIXDOG_PLATFORM %s|%s\\n' "$(uname -sm 2>/dev/null)" "$MIXDOG_LIBC"
`;

const WINDOWS_SHELL_FAILURE =
  /is not recognized as an internal or external command|The term '?sh'? is not recognized|CommandNotFoundException/i;

const UNSUPPORTED_HINT = 'Mixdog servers need Linux (x64 or arm64, glibc) or macOS (x64 or arm64).';

/** stderr of a command line a Windows OpenSSH server (cmd.exe/PowerShell) refused. */
export function isWindowsShellFailure(stderr: string): boolean {
  return WINDOWS_SHELL_FAILURE.test(stderr);
}

export function windowsServerError(): RemoteBootstrapError {
  return new RemoteBootstrapError('unsupported-platform', `The server runs Windows. ${UNSUPPORTED_HINT}`);
}

/** The probe line, or null when the output carries none. */
export function parsePlatformLine(stdout: string): { uname: string; libc: string } | null {
  const match = /^MIXDOG_PLATFORM (.*)\|(\S*)\s*$/m.exec(stdout);
  return match ? { uname: match[1].trim(), libc: match[2] } : null;
}

/** Supported platform, or `unsupported-platform` naming what was found. */
export function classifyRemotePlatform(uname: string, libc: string): RemotePlatform {
  const [system = '', machine = ''] = uname.split(/\s+/);
  const unsupported = (found: string) =>
    new RemoteBootstrapError('unsupported-platform', `The server is ${found}. ${UNSUPPORTED_HINT}`);
  if (/^(MINGW|MSYS|CYGWIN|Windows)/i.test(system)) throw unsupported(`Windows (${uname})`);
  let os: 'linux' | 'darwin' | null = null;
  if (system === 'Linux') os = 'linux';
  else if (system === 'Darwin') os = 'darwin';
  if (!os) throw unsupported(uname ? `${uname}` : 'an unknown system (uname printed nothing)');
  let arch: 'x64' | 'arm64' | null = null;
  if (/^(x86_64|amd64)$/i.test(machine)) arch = 'x64';
  else if (/^(aarch64|arm64)$/i.test(machine)) arch = 'arm64';
  if (!arch) throw unsupported(`${system} on ${machine || 'an unknown CPU'}`);
  if (os === 'linux' && libc === 'musl') throw unsupported(`${system} ${machine} with musl libc (Alpine or similar)`);
  return { os, arch };
}

/** Defines platformInfo() and assertSupportedRuntime(info): the program's own
 *  view (process.platform/arch, glibc from the process report, node ABI). */
export const REMOTE_PLATFORM_SOURCE = `
function platformInfo() {
  let glibc = null;
  if (process.platform === 'linux') {
    try { glibc = process.report.getReport().header.glibcVersionRuntime || null; } catch {}
  }
  return {
    os: process.platform,
    arch: process.arch,
    libc: process.platform === 'linux' ? (glibc ? 'glibc' : 'musl') : 'system',
    glibc,
    node: process.versions.node,
    modules: process.versions.modules,
  };
}
function assertSupportedRuntime(info) {
  const hint = 'Mixdog servers need Linux (x64 or arm64, glibc) or macOS (x64 or arm64).';
  if (info.os !== 'linux' && info.os !== 'darwin') fail('unsupported-platform', 'The server node runs on ' + info.os + '. ' + hint);
  if (info.arch !== 'x64' && info.arch !== 'arm64') fail('unsupported-platform', 'The server node runs on ' + info.os + '-' + info.arch + '. ' + hint);
  if (info.libc === 'musl') fail('unsupported-platform', 'The server node runs on musl libc (Alpine or similar). ' + hint);
}
`;
