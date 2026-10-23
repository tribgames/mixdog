/**
 * Per-connection settings that follow one connect attempt through every ssh
 * the attempt starts (probe, install, daemon start, tunnel), however deep the
 * connections code is that spawns them. The attempt runs `connections.open`
 * inside `runWithSshContext`; `defaultSshSpawn` reads the context to add the
 * askpass helper and the identity file, and the connections code reads the
 * rest (`remoteCwd`, `autoReconnect`, `forceRestart`) when it builds the
 * remote session.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import type { DesktopSshHostSettings, DesktopSshModelLogin } from '../../shared/contract-ssh';
import type { AskpassSession } from './ssh-auth';

export type SshHostSettings = DesktopSshHostSettings;
export type SshModelLogin = DesktopSshModelLogin;

export interface SshRunContext {
  settings?: SshHostSettings;
  /** Passed to the remote ensure step: stop whatever daemon is running and start ours. */
  forceRestart?: boolean;
  /** Which server's diagnostics ring the ssh runs of this attempt write to (ssh-diagnostics.ts). */
  diagnosticsKey?: string;
  /** Set for the interactive (password / passphrase / OTP) retry of an attempt. */
  askpass?: AskpassSession;
}

const storage = new AsyncLocalStorage<SshRunContext>();

export const runWithSshContext = <T>(context: SshRunContext, run: () => T): T => storage.run(context, run);

/** The context of the connect attempt this code runs under, if any. */
export const currentSshContext = (): SshRunContext | undefined => storage.getStore();
