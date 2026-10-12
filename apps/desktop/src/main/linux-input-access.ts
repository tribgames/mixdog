/**
 * Computer Use on Wayland needs write access to /dev/uinput. The .deb ships a
 * uaccess udev rule for it; other installs (AppImage, tarball) install the same
 * rule here with one polkit prompt, then reload udev so the ACL applies to the
 * signed-in user immediately, without logging out.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import type { DesktopComputerInputAccess } from '../shared/contract-computer';

export type LinuxInputAccessResult = DesktopComputerInputAccess;

const DEVICE = '/dev/uinput';
const RULE_FILE = '70-mixdog-uinput.rules';
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
  /** Effective access as the current user: the same W_OK probe the Computer Use readiness check uses. */
  canAccess(): boolean;
  /** Whether the /dev/uinput node exists at all (separates a missing module from a missing permission). */
  deviceExists(): boolean;
  /** Exit status of `pkexec /bin/sh -c script`; 'missing' when pkexec cannot be started. */
  runPkexec(script: string): Promise<number | 'missing'>;
  /** Pause between access rechecks while udev applies the ACL. */
  wait(ms: number): Promise<void>;
}

/** Bounded wait for udev to apply the ACL after the repair script exits. */
const RECHECK_ATTEMPTS = 12;
const RECHECK_INTERVAL_MS = 250;

const realDeps: LinuxInputAccessDeps = {
  platform: process.platform,
  canAccess: () => {
    try {
      accessSync(DEVICE, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
  deviceExists: () => existsSync(DEVICE),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  runPkexec: (script) =>
    new Promise((resolve) => {
      const child = spawn('pkexec', ['/bin/sh', '-c', script], { stdio: 'ignore', windowsHide: true });
      child.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'ENOENT' ? 'missing' : 1));
      child.once('close', (status) => resolve(status ?? 1));
    }),
};

let inFlight: Promise<LinuxInputAccessResult> | null = null;

async function repair(deps: LinuxInputAccessDeps): Promise<LinuxInputAccessResult> {
  const status = await deps.runPkexec(INSTALL_SCRIPT);
  if (status === 'missing') {
    return {
      ok: false,
      reason: 'pkexec_missing',
      message: 'pkexec (polkit) is not installed, so the /dev/uinput access rule cannot be installed from here.',
    };
  }
  // pkexec exits 126 when the user dismisses the dialog or is not authorized.
  if (status === 126) return { ok: false, reason: 'cancelled', message: 'Authorization was cancelled or denied.' };
  if (status !== 0) {
    return {
      ok: false,
      reason: 'failed',
      exitCode: status,
      message: `The repair script failed (exit ${status}); the /dev/uinput access rule was not applied.`,
    };
  }
  // A clean exit is not proof: confirm the signed-in user can really open the device.
  for (let attempt = 0; attempt < RECHECK_ATTEMPTS; attempt += 1) {
    if (deps.canAccess()) return { ok: true };
    await deps.wait(RECHECK_INTERVAL_MS);
  }
  if (deps.canAccess()) return { ok: true };
  const present = deps.deviceExists();
  const message = present
    ? 'The access rule is installed but /dev/uinput is still not writable for this session. Sign out and sign in again (or restart), and make sure you are on a local desktop seat; if it persists, add your user to the input group.'
    : '/dev/uinput does not exist: the uinput kernel module is not loaded or is unavailable on this kernel. Run `sudo modprobe uinput` or restart, then try again.';
  return { ok: false, reason: 'access_unavailable', detail: present ? 'relogin' : 'no-module', message };
}

export function requestLinuxInputAccess(deps: LinuxInputAccessDeps = realDeps): Promise<LinuxInputAccessResult> {
  if (deps.platform !== 'linux') return Promise.resolve({ ok: false, reason: 'failed' });
  // One prompt at a time: an in-flight repair is never bypassed, even once its rule file or ACL has appeared.
  if (inFlight) return inFlight;
  // Skip privileged work only when access really works, not merely because a rule file exists.
  if (deps.canAccess()) return Promise.resolve({ ok: true });
  inFlight = repair(deps).finally(() => {
    inFlight = null;
  });
  return inFlight;
}
