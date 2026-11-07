// The capabilities the core replaced by pushed sections, for the main process (D-desktop-core-2, group 1). The lane of
// `desktop-core-route-1` refuses them (nothing to send); this one answers them from the connection's section store, so
// every reader of the service client on a core connection (the approval grants' `listAgents`, the SSH server logins'
// `getProviderSetup`/`getProviderAccounts`, the window's `getOnboardingStatus`) gets the section's value. A section not
// published yet is waited for; the Node host is not asked.
import type { DesktopCapability, DesktopCapabilityReadRequest, DesktopCapabilityReadResult, DesktopCapabilityResult, SessionSnapshot } from '../../shared/contract';
import { isSectionCapability, providerSetupRefresh, sectionOf, type SectionRef } from '../../shared/section-capabilities';
import type { CapabilityLane } from './capability-route';
import type { ProtocolConnection } from './connection';

type SectionConnection = Pick<ProtocolConnection, 'call' | 'snapshot' | 'status' | 'watchSection'>;

/** The value of `ref` once the connection holds it. A `providerAccounts` provider the core did not publish while it
 *  published others is unknown; a closed connection ends the wait. */
export async function readProtocolSection(protocol: SectionConnection, ref: SectionRef): Promise<unknown> {
  for (;;) {
    const entries = protocol.snapshot().entries;
    const entry = entries.find((candidate) => candidate.section === ref.section && candidate.key === ref.key);
    if (entry) return entry.value;
    if (ref.section === 'providerAccounts' && entries.some((candidate) => candidate.section === 'providerAccounts')) {
      throw new Error('Unknown OAuth provider.');
    }
    if (protocol.status === 'closed') throw new Error(`The ${ref.section} section is unavailable: the connection is closed.`);
    await new Promise<void>((resolve) => {
      let stop: (() => void) | undefined;
      let changed = false;
      stop = protocol.watchSection(ref.section, () => {
        changed = true;
        stop?.();
        resolve();
      });
      if (changed) stop();
    });
  }
}

async function readHeld(protocol: SectionConnection, capability: string, args: readonly unknown[]): Promise<unknown> {
  const ref = sectionOf(capability, args);
  const refresh = providerSetupRefresh(capability, args);
  if (refresh) await protocol.call('account/refreshProviderSetup', refresh);
  return readProtocolSection(protocol, ref);
}

const failureMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** `lane`, with the replaced capabilities answered from `protocol`'s sections. `snapshot` is the shell snapshot held,
 *  as for `lane`. */
export function withSectionCapabilities({
  lane,
  protocol,
  snapshot,
}: {
  lane: CapabilityLane;
  protocol: SectionConnection;
  snapshot(): SessionSnapshot;
}): CapabilityLane {
  return {
    async invoke<T>(capability: DesktopCapability, args: unknown[] | undefined, sessionId: string | undefined) {
      if (!isSectionCapability(capability)) return lane.invoke<T>(capability, args, sessionId);
      const value = (await readHeld(protocol, capability, args ?? [])) as T;
      return { value, snapshot: snapshot() } satisfies DesktopCapabilityResult<T>;
    },
    async read(requests: ReadonlyArray<DesktopCapabilityReadRequest>) {
      const held: (DesktopCapabilityReadResult | undefined)[] = await Promise.all(
        requests.map(async (request): Promise<DesktopCapabilityReadResult | undefined> => {
          if (!isSectionCapability(request.capability)) return undefined;
          try {
            return { ok: true, value: await readHeld(protocol, request.capability, request.args ?? []) };
          } catch (error) {
            return { ok: false, error: failureMessage(error) };
          }
        })
      );
      const rest = requests.filter((_, index) => !held[index]);
      const answered = rest.length > 0 ? await lane.read(rest) : [];
      let next = 0;
      return held.map((result) => result ?? (answered[next++] as DesktopCapabilityReadResult));
    },
  };
}
