/**
 * Computer Use on Wayland needs write access to /dev/uinput. The .deb ships a
 * uaccess udev rule for it; other installs (AppImage, tarball) install the same
 * rule here with one polkit prompt, then reload udev so the ACL applies to the
 * signed-in user immediately, without logging out.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export type LinuxInputAccessResult = { ok: true } | { ok: false; reason: 'cancelled' | 'pkexec_missing' | 'failed' };

const RULE_FILE = '70-mixdog-uinput.rules';
const RULE_PATHS = [`/etc/udev/rules.d/${RULE_FILE}`, `/usr/lib/udev/rules.d/${RULE_FILE}`, `/lib/udev/rules.d/${RULE_FILE}`];
// Identical to apps/desktop/build/linux/70-mixdog-uinput.rules and mixdog-uinput.conf.
const RULE_LINES = [
  '# Mixdog Computer Use: grant the active local seat user access to /dev/uinput',
  '# (uaccess ACL; no group membership or re-login needed).',
  'KERNEL=="uinput", SUBSYSTEM=="misc", TAG+="uaccess", OPTIONS+="static_node=uinput"',
];
const MODULES_LINES = ['# Mixdog Computer Use: load the uinput module at boot.', 'uinput'];

const shellLines = (lines: string[]) => lines.map((line) => `'${line}'`).join(' ');

/** The one privileged script: constants only, so nothing user-controlled reaches the shell. */
export const INSTALL_SCRIPT = [
  'set -e',
  `printf '%s\\n' ${shellLines(RULE_LINES)} > /etc/udev/rules.d/${RULE_FILE}`,
  `printf '%s\\n' ${shellLines(MODULES_LINES)} > /etc/modules-load.d/mixdog-uinput.conf`,
  'modprobe uinput',
  'udevadm control --reload',
  'udevadm trigger --action=add --subsystem-match=misc --sysname-match=uinput',
  'udevadm settle --timeout=5',
].join('\n');

export interface LinuxInputAccessDeps {
  platform: NodeJS.Platform;
  ruleExists(): boolean;
  /** Exit status of `pkexec /bin/sh -c script`; 'missing' when pkexec cannot be started. */
  runPkexec(script: string): Promise<number | 'missing'>;
}

const realDeps: LinuxInputAccessDeps = {
  platform: process.platform,
  ruleExists: () => RULE_PATHS.some((file) => existsSync(file)),
  runPkexec: (script) =>
    new Promise((resolve) => {
      const child = spawn('pkexec', ['/bin/sh', '-c', script], { stdio: 'ignore', windowsHide: true });
      child.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'ENOENT' ? 'missing' : 1));
      child.once('close', (status) => resolve(status ?? 1));
    }),
};

let inFlight: Promise<LinuxInputAccessResult> | null = null;

export function requestLinuxInputAccess(deps: LinuxInputAccessDeps = realDeps): Promise<LinuxInputAccessResult> {
  if (deps.platform !== 'linux') return Promise.resolve({ ok: false, reason: 'failed' });
  if (deps.ruleExists()) return Promise.resolve({ ok: true });
  // One prompt at a time, however often the UI asks.
  inFlight ??= deps
    .runPkexec(INSTALL_SCRIPT)
    .then((status): LinuxInputAccessResult => {
      if (status === 0) return { ok: true };
      if (status === 'missing') return { ok: false, reason: 'pkexec_missing' };
      // pkexec exits 126 when the user dismisses the dialog or is not authorized.
      return { ok: false, reason: status === 126 ? 'cancelled' : 'failed' };
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}