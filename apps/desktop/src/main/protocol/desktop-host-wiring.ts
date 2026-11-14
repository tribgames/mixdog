// Binds the host role (main/host) to this PC's protocol connection: it claims the role when the connection is ready,
// claims it again after every reconnect (the core drops a claim with the socket), and turns the `computer` section
// into the overlay's pill source. Window-less, so it lives for the app.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bindPointerPresence } from '../computer/host/pointer-cursor';
import { computerUseCoordinator } from '../computer/session/coordinator';
import { createComputerPillSource, type ComputerSectionValue } from '../host/computer-pill';
import { createDesktopHost, type DesktopHostOptions } from '../host';
import { createHostConnection } from './host-connection';
import type { ProtocolConnection } from './connection';

/** The id this install claims the host role with; created once and kept in the profile. */
export function readOrCreateHostId(userDataDir: string): string {
  const path = join(userDataDir, 'host-id');
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* first run */
  }
  const created = randomUUID();
  writeFileSync(path, created, 'utf8');
  return created;
}

export interface LocalHostRoleOptions extends Omit<DesktopHostOptions, 'connection'> {
  protocol: ProtocolConnection;
  /** A failed claim (another desktop holds the role, or the core refused) is reported, never retried on a timer:
   *  the next reconnect claims again. */
  onClaimFailed(error: unknown): void;
}

export function createLocalHostRole({ protocol, onClaimFailed, ...options }: LocalHostRoleOptions) {
  const host = createDesktopHost({ ...options, connection: createHostConnection(protocol) });
  // The presence mirror: the pill and the arrow follow the core's section (the in-process coordinator while the section
  // names the desktop's own host as the backend); moving the real mouse releases the agent's pointer in the core.
  const computerPill = createComputerPillSource(Date.now, {
    coordinator: computerUseCoordinator,
    notifyPointerReleased: (sessionThreadId) => protocol.notify('computer/pointerReleased', { sessionThreadId }),
  });
  bindPointerPresence(computerPill);
  protocol.watchSection('computer', (entry) => {
    const value = entry?.value as ComputerSectionValue | null | undefined;
    computerPill.apply(
      value ?? { active: false, observeOnly: false, controller: null, sessionThreadId: null, sessions: [] }
    );
  });
  let wasReady = false;
  const claim = (): void => void host.claim().catch(onClaimFailed);
  protocol.onEvent((event) => {
    if (event.type !== 'status') return;
    const ready = (event as { status: { state: string } }).status.state === 'ready';
    if (ready && !wasReady) claim();
    wasReady = ready;
  });
  return {
    host,
    computerPill,
    /** The first claim, once `protocol.start()` resolved. */
    claimNow(): void {
      wasReady = true;
      claim();
    },
  };
}
