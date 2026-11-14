// invokeCapability and readCapabilities of the renderer's direct API: the session capability lane over this window's core
// connection (the one main ran in ipc-window-settings.ts), plus what only the Electron host can add around it: the
// human-only confirmation that turns on "Allow all actions", the sign-in raise of the window, and a server window's
// provider quota, which is this PC's. Input checks live in the core; a failure is mapped as the IPC path returned it.
import type {
  DesktopCapabilityReadRequest,
  DesktopCapabilityReadResult,
  DesktopCapabilityRequest,
  DesktopApi,
  DesktopCapabilityResult,
  SessionSnapshot,
} from '../../shared/contract';
import type { DesktopHostExtras, DirectKey } from '../../shared/desktop-api-split.ts';

import { createCapabilityLane } from '../../shared/core-lanes/capability-route.ts';
import { withSectionCapabilities } from '../../main/protocol/section-capability-lane.ts';
import { windowOfReply } from './client.ts';
import type { DirectContext } from './context.ts';
import { withDirectErrors } from './errors.ts';

/** The host calls this API makes: what window.mixdogDesktopHost carries for the capabilities. */
export type CapabilitiesHost = Pick<
  DesktopHostExtras,
  'enableAllowAllActions' | 'observeSignIn' | 'invokePcQuotaCapability' | 'readPcQuotaCapabilities'
>;

export interface CapabilitiesApiOptions {
  /** The Electron host's side of the capabilities; defaults to window.mixdogDesktopHost. */
  host?: CapabilitiesHost;
  /** The shell snapshot held, which a capability answered from a section carries as the lane's own results carry theirs.
   *  Defaults to the snapshot of the last call this API answered with one; none until there is one. */
  snapshot?: () => SessionSnapshot;
}

/** The capabilities whose result the host's sign-in raise watches (sign-in-focus.ts). */
const SIGN_IN_CAPABILITIES: ReadonlySet<string> = new Set([
  'beginMcpOAuthLogin',
  'cancelMcpOAuthLogin',
  'getMcpOAuthLoginStatus',
]);
/** The shared Lead face: paired phones re-read it from the settings-changed event. */
const LEAD_FACE_CAPABILITIES: ReadonlySet<string> = new Set(['setLeadAppearance', 'setBotOrder']);

const turnsOnAllowAllActions = (capability: string, args: readonly unknown[] = []): boolean =>
  capability === 'setDeveloperOption' && args[0] === 'allowAllActions' && args[1] === true;

const hostOfWindow = (): CapabilitiesHost | undefined =>
  (globalThis as { mixdogDesktopHost?: CapabilitiesHost }).mixdogDesktopHost;

export function createCapabilitiesApi(
  ctx: DirectContext,
  options: CapabilitiesApiOptions = {}
): Pick<DesktopApi, DirectKey<'capabilities'>> {
  const { connection } = ctx;
  const hostBridge = (): CapabilitiesHost => {
    const host = options.host ?? hostOfWindow();
    if (!host) throw new Error('The desktop host bridge is not available.');
    return host;
  };
  let lastSnapshot: SessionSnapshot | undefined;
  const lane = withSectionCapabilities({
    lane: createCapabilityLane({ protocol: connection }),
    protocol: {
      call: (method, params) => connection.call(method, params),
      snapshot: () => connection.snapshot(),
      get status() {
        return connection.status;
      },
      // A section's change is a store change of type `section`; the caller reads the section again itself.
      watchSection: (section, listener) =>
        connection.onStoreChange((change) => {
          if (change.type === 'section' && change.section === section) listener(undefined);
        }),
    },
    snapshot: () => (options.snapshot ? options.snapshot() : (lastSnapshot as SessionSnapshot)),
  });
  // A server window's model calls run on this PC's sign-ins, so its provider quota is this PC's: the host answers it (narrowed
  // to the providers the server may use) and answers null for any call that is not. The window is a server window when
  // this PC's core names its socket `server:<connectionId>` (its primary socket goes to the server's core as `main`).
  const onServer = (): boolean => {
    const pc = ctx.pcClient();
    return pc ? windowOfReply(pc.server)?.role?.startsWith('server:') === true : false;
  };
  const notifySettingsChanged = (): void => {
    void ctx.call('ui/settings/announce', { scope: 'desktop' }).catch(() => {});
  };

  return {
    invokeCapability<T = unknown>(request: DesktopCapabilityRequest): Promise<DesktopCapabilityResult<T>> {
      return withDirectErrors(
        (async (): Promise<DesktopCapabilityResult<T>> => {
          const { capability, args, sessionId } = request;
          if (onServer()) {
            const quota = (await hostBridge().invokePcQuotaCapability(request)) as DesktopCapabilityResult<T> | null;
            if (quota) return quota;
          }
          // Turning on "Allow all actions" is the person's, confirmed in the main process under the human-only lock; the
          // host writes it only once confirmed and answers the developer settings either way.
          if (turnsOnAllowAllActions(capability, args)) {
            return (await hostBridge().enableAllowAllActions()) as DesktopCapabilityResult<T>;
          }
          const result = await lane.invoke<T>(capability, args, sessionId);
          if (result?.snapshot !== undefined) lastSnapshot = result.snapshot;
          if (SIGN_IN_CAPABILITIES.has(capability)) {
            const host = options.host ?? hostOfWindow();
            host?.observeSignIn(capability, args ?? [], result?.value);
          }
          if (LEAD_FACE_CAPABILITIES.has(capability)) notifySettingsChanged();
          return result;
        })()
      );
    },
    readCapabilities(requests: DesktopCapabilityReadRequest[]): Promise<DesktopCapabilityReadResult[]> {
      return withDirectErrors(
        (async (): Promise<DesktopCapabilityReadResult[]> => {
          if (!onServer()) return lane.read(requests);
          // Positional results: the PC answers its quota reads, null for the others, which the core answers.
          const pc = (await hostBridge().readPcQuotaCapabilities(requests)) as (DesktopCapabilityReadResult | null)[];
          const rest = requests.filter((_, index) => !pc[index]);
          const answered = rest.length > 0 ? await lane.read(rest) : [];
          let next = 0;
          return requests.map((_, index) => pc[index] ?? (answered[next++] as DesktopCapabilityReadResult));
        })()
      );
    },
  };
}

