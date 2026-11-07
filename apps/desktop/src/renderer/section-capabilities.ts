// The session capabilities the core replaced by pushed sections (D-desktop-core-2, group 1), in the renderer. The
// source is chosen by the window's connection alone, as `desktop-core-route-1` chooses it: a window on a connection
// with a core endpoint reads the section store, any other window asks the Node host. On a core connection a section
// the store does not hold yet is waited for, never replaced by a request; a provider the core does not know is an
// error. `getProviderSetup`'s `force`/`refresh`/keychain options recompute the section first
// (`account/refreshProviderSetup`); the core pushes the new value before it answers.
import type {
  DesktopApi,
  DesktopCapabilityReadRequest,
  DesktopCapabilityReadResult,
  DesktopCapabilityRequest,
  DesktopCapabilityResult,
} from '../shared/contract';
import type { DesktopSectionsApi } from '../shared/contract-sections';
import { isSectionCapability, providerSetupRefresh, sectionOf, type SectionRef } from '../shared/section-capabilities';
import { installedSectionStore, type SectionStore, sectionStoreFor } from './section-store';

export { isSectionCapability };

export interface HeldCapability {
  readonly value: unknown;
}

/** What the source choice and the reads depend on; the window's own by default. */
export interface SectionSource {
  /** Whether this window's connection has a core endpoint. */
  core(): Promise<boolean>;
  store(): SectionStore | undefined;
  /** `account/refreshProviderSetup`. */
  recompute(params: Record<string, true>): Promise<unknown>;
}

type Host = { readonly sections?: DesktopSectionsApi } | undefined;

const CORE_OF_HOST = new WeakMap<object, Promise<boolean>>();

/** The source of a bridge object (`window.mixdogDesktop`, or a stand-in). A phone's store is the relay's, always a
 *  core's; the desktop asks its main process once per bridge. */
export function sectionSourceOf(host: Host): SectionSource {
  return {
    core: () => {
      if (installedSectionStore()) return Promise.resolve(true);
      const sections = host?.sections;
      if (!host || !sections) return Promise.resolve(false);
      let asked = CORE_OF_HOST.get(host);
      if (!asked) {
        asked = sections.core();
        CORE_OF_HOST.set(host, asked);
      }
      return asked;
    },
    store: () => sectionStoreFor(host),
    recompute: (params) => Promise.resolve(host?.sections?.call('account/refreshProviderSetup', params)),
  };
}

const windowSource = (): SectionSource => sectionSourceOf(typeof window === 'undefined' ? undefined : window.mixdogDesktop);

/** The value of `ref` once the store holds it. A keyed `providerAccounts` entry the core did not publish while it
 *  published others is an unknown provider; a closed connection ends the wait. */
export async function awaitEntry(store: SectionStore, ref: SectionRef): Promise<unknown> {
  await store.ready();
  for (;;) {
    const entry = store.get(ref.section, ref.key);
    if (entry) return entry.value;
    if (ref.section === 'providerAccounts' && store.list('providerAccounts').length > 0) {
      throw new Error('Unknown OAuth provider.');
    }
    if (store.status() === 'closed') throw new Error(`The ${ref.section} section is unavailable: the connection is closed.`);
    await new Promise<void>((resolve) => {
      const stop = store.subscribe('*', () => {
        stop();
        resolve();
      });
    });
  }
}

/** The capability's value from the section store: `undefined` for a capability the sections did not replace or a
 *  window whose connection has no core endpoint. */
export async function readHeldCapability(
  capability: string,
  args: readonly unknown[] = [],
  source: SectionSource = windowSource()
): Promise<HeldCapability | undefined> {
  if (!isSectionCapability(capability) || !(await source.core())) return undefined;
  const store = source.store();
  if (!store) throw new Error('This window has no section store.');
  const refresh = providerSetupRefresh(capability, args);
  if (refresh) await source.recompute(refresh);
  return { value: await awaitEntry(store, sectionOf(capability, args)) };
}

type CapabilityApi = Partial<Pick<DesktopApi, 'invokeCapability' | 'readCapabilities'>>;

/** `api.invokeCapability(request)`, except that on a core connection a capability the sections replaced is answered
 *  from the store. A held answer carries only the value (a section has no session state). */
export async function invokeOrHeld<T = unknown>(
  api: CapabilityApi | undefined,
  request: DesktopCapabilityRequest,
  source: SectionSource = windowSource()
): Promise<Pick<DesktopCapabilityResult<T>, 'value'> | undefined> {
  const held = await readHeldCapability(request.capability, request.args, source);
  if (held) return { value: held.value as T };
  return api?.invokeCapability?.<T>(request);
}

/** `api.readCapabilities(requests)`, with the replaced ones answered from the store on a core connection (a failed one
 *  is that request's `ok: false`, as a host read fails); the order of the results is the order of the requests. */
export async function readOrHeld(
  api: CapabilityApi,
  requests: DesktopCapabilityReadRequest[],
  source: SectionSource = windowSource()
): Promise<DesktopCapabilityReadResult[]> {
  const held: (DesktopCapabilityReadResult | undefined)[] = await Promise.all(
    requests.map(async (request) => {
      try {
        const answer = await readHeldCapability(request.capability, request.args, source);
        return answer ? { ok: true as const, value: answer.value } : undefined;
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
      }
    })
  );
  const rest = requests.filter((_, index) => !held[index]);
  const answered = rest.length > 0 ? await api.readCapabilities!(rest) : [];
  let next = 0;
  return held.map((result) => result ?? (answered[next++] as DesktopCapabilityReadResult));
}
