import { useCallback, useEffect, useState } from 'react';

import type { DesktopSshHost } from '../../shared/contract-ssh';
import { sshListHosts, sshOpenHost, subscribeSshHostsChanged } from '../connections-core-api';

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
export function useSshHosts(): { hosts: DesktopSshHost[]; refresh(): void } {
  const [hosts, setHosts] = useState<DesktopSshHost[]>([]);
  const refresh = useCallback(() => {
    void sshListHosts()
      .then((next) => setHosts(next ?? []))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    refresh();
    // The core says when a server was saved, changed, forgotten, opened or closed.
    return subscribeSshHostsChanged(refresh);
  }, [refresh]);
  return { hosts, refresh };
}
