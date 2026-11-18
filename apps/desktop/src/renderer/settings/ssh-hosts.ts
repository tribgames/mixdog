import { useCallback, useEffect, useRef, useState } from 'react';

import type { DesktopSshHost } from '../../shared/contract-ssh';
import { sshListHosts, sshOpenHost, subscribeSshHostsChanged } from '../connections-core-api';
import { followSettingsReadConnection, startSettingsReadRecovery } from './read-recovery';

/** Opens a saved server. A window that is already open is just focused; any
 *  other case — or a focus that fails — goes through the connect dialog, which
 *  shows progress and the guidance for whatever is in the way. */
export async function openSshHost(host: DesktopSshHost, needsDialog: () => void): Promise<void> {
  try {
    if (host.open && (await sshOpenHost(host.id)).ok) return;
  } catch {
    /* the dialog reports it */
  }
  needsDialog();
}

/** The SSH servers saved on this machine, re-read when main says they changed. */
export function useSshHosts(enabled = true): { hosts: DesktopSshHost[]; refresh(): void } {
  const [hosts, setHosts] = useState<DesktopSshHost[]>([]);
  const recoveryRef = useRef<(() => void) | null>(null);
  const refresh = useCallback(() => recoveryRef.current?.(), []);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    const recovery = startSettingsReadRecovery(async (signal) => {
      const next = await sshListHosts();
      if (live && !signal.aborted && next) setHosts(next);
    }, 10_000, true, true);
    recoveryRef.current = recovery.replace;
    const stopLink = followSettingsReadConnection(window.mixdogDesktop, recovery);
    const unsubscribe = subscribeSshHostsChanged(refresh);
    return () => {
      live = false;
      recoveryRef.current = null;
      recovery.stop();
      stopLink?.();
      unsubscribe?.();
    };
  }, [enabled, refresh]);
  return { hosts, refresh };
}
