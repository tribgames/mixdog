import { useCallback, useEffect, useState } from 'react';

import type { DesktopSshHost } from '../../shared/contract-ssh';
import type { CapabilityApi } from './capability-data';

const SSH_HOSTS_REFRESH_MS = 3_000;

/** Opens a saved server. A window that is already open is just focused; any
 *  other case — or a focus that fails — goes through the connect dialog, which
 *  shows progress and the guidance for whatever is in the way. */
export async function openSshHost(api: CapabilityApi, host: DesktopSshHost, needsDialog: () => void): Promise<void> {
  try {
    if (host.open && api.sshOpenHost && (await api.sshOpenHost(host.id)).ok) return;
  } catch {
    /* the dialog reports it */
  }
  needsDialog();
}

/** The SSH servers saved on this machine, refreshed on a short heartbeat. */
export function useSshHosts(api: CapabilityApi): { hosts: DesktopSshHost[]; refresh(): void } {
  const [hosts, setHosts] = useState<DesktopSshHost[]>([]);
  const refresh = useCallback(() => {
    void api
      .sshListHosts?.()
      .then((next) => setHosts(next ?? []))
      .catch(() => undefined);
  }, [api]);
  useEffect(() => {
    if (!api.sshListHosts) return undefined;
    refresh();
    const timer = window.setInterval(refresh, SSH_HOSTS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [api, refresh]);
  return { hosts, refresh };
}
