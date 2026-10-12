// Network-change detection for the relay leg. A dead network is otherwise
// noticed only when a ping goes unanswered; this fires the moment the machine
// comes back online or its set of network addresses changes (Wi-Fi switch,
// VPN toggle, dock), so the leg redials immediately.
import { networkInterfaces } from 'node:os';

const NETWORK_POLL_MS = 2_000;

/** A stable signature of the machine's external addresses. */
export function networkSignature(
  interfaces: NodeJS.Dict<Array<{ address: string; internal: boolean }>> = networkInterfaces()
): string {
  const addresses: string[] = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const entry of list ?? []) if (!entry.internal) addresses.push(`${name}:${entry.address}`);
  }
  return addresses.sort().join('|');
}

export function createNetworkWatcher(deps: {
  isOnline(): boolean;
  signature(): string;
  /** Online again, or the network changed while online. */
  onChange(): void;
  intervalMs?: number;
}): { stop(): void } {
  let online = deps.isOnline();
  let signature = deps.signature();
  const timer = setInterval(() => {
    const nowOnline = deps.isOnline();
    const nowSignature = deps.signature();
    const cameBack = nowOnline && !online;
    const changed = nowOnline && nowSignature !== signature;
    online = nowOnline;
    signature = nowSignature;
    if (cameBack || changed) deps.onChange();
  }, deps.intervalMs ?? NETWORK_POLL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
