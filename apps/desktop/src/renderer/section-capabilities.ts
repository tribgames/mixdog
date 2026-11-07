// The session capabilities the core replaced by pushed sections (D-desktop-core-2, group 1): on a window whose section
// store holds the section, the capability is answered from the store with the value Node's action returned, and
// nothing is requested. A window whose store does not hold it (a connection without a core endpoint) asks the
// capability as before. `getProviderSetup`'s `force`/`refresh`/keychain options recompute the section first
// (`account/refreshProviderSetup`), which the core answers after it pushed the new value.
import type {
  DesktopApi,
  DesktopCapabilityReadRequest,
  DesktopCapabilityReadResult,
  DesktopCapabilityRequest,
  DesktopCapabilityResult,
} from '../shared/contract';
import { recordOrNull } from './record-utils';
import { type SectionStore, windowSectionStore } from './section-store';

export interface HeldCapability {
  readonly value: unknown;
}

/** The capability → the section that carries its value. `getProviderAccounts` (key = provider) and
 *  `getOnboardingStatus` (the `agent` subtree of `config`) are read apart. */
const SECTION_OF: Readonly<Record<string, string>> = {
  listPresets: 'presets',
  listAgents: 'agents',
  listWorkflows: 'workflows',
  getWebSearchRoute: 'webSearch',
  getProviderSetup: 'providerSetup',
  listProviders: 'providerSetup',
};

/** `STARTER_GUIDE_STEPS` (`starter-guide-state.mjs`). */
const STARTER_GUIDE_STEPS = ['provider', 'project', 'workflow', 'extensions', 'remote'];

const SETUP_OPTIONS = ['force', 'refresh', 'unlockKeychain', 'recheckKeychain'] as const;

/** `storedStarterGuide(value)`: the stored copy read tolerantly, `null` when there is none. */
function storedStarterGuide(value: unknown) {
  const guide = recordOrNull(value);
  if (!guide) return null;
  const visited = Array.isArray(guide.visited) ? guide.visited : [];
  return {
    closed: guide.closed === true,
    welcomed: guide.welcomed === true,
    visited: STARTER_GUIDE_STEPS.filter((step) => visited.includes(step)),
  };
}

/** `getOnboardingStatus()` as the `config` section's `agent` subtree carries it: what a renderer reads of it
 *  (`completed`, `version`, `default`, `starterGuide`); `workflowRoutes` needs the route summary, which only the
 *  core computes and no renderer reads. */
export function onboardingStatusOf(agent: unknown) {
  const root = recordOrNull(agent) ?? {};
  const onboarding = recordOrNull(root.onboarding) ?? {};
  return {
    completed: onboarding.completed === true,
    version: onboarding.version || 0,
    default: root.default || null,
    starterGuide: storedStarterGuide(onboarding.starterGuide),
  };
}

/** True for a capability the sections replaced. */
export function isSectionCapability(capability: string): boolean {
  return capability in SECTION_OF || capability === 'getProviderAccounts' || capability === 'getOnboardingStatus';
}

/** The capability's value as the store holds it now; `undefined` when the store does not hold its section. */
export function heldCapability(
  capability: string,
  args: readonly unknown[] = [],
  store: SectionStore | undefined = windowSectionStore()
): HeldCapability | undefined {
  if (!store) return undefined;
  if (capability === 'getOnboardingStatus') {
    const entry = store.get('config', 'agent');
    return entry ? { value: onboardingStatusOf(entry.value) } : undefined;
  }
  if (capability === 'getProviderAccounts') {
    const provider = args[0];
    const entry = typeof provider === 'string' ? store.get('providerAccounts', provider) : undefined;
    return entry ? { value: entry.value } : undefined;
  }
  const section = SECTION_OF[capability];
  const entry = section ? store.get(section) : undefined;
  return entry ? { value: entry.value } : undefined;
}

type CapabilityApi = Partial<Pick<DesktopApi, 'invokeCapability' | 'readCapabilities'>>;

/** `api.invokeCapability(request)`, except that a capability the sections replaced is answered from the store when
 *  it holds the section. A held answer carries only the value (a section has no session state). */
export async function invokeOrHeld<T = unknown>(
  api: CapabilityApi | undefined,
  request: DesktopCapabilityRequest
): Promise<Pick<DesktopCapabilityResult<T>, 'value'> | undefined> {
  if (isSectionCapability(request.capability)) {
    const held = await readHeldCapability(request.capability, request.args);
    if (held) return { value: held.value as T };
  }
  return api?.invokeCapability?.<T>(request);
}

/** `api.readCapabilities(requests)`, with the held ones answered from the store; the order of the results is the
 *  order of the requests. */
export async function readOrHeld(
  api: CapabilityApi,
  requests: DesktopCapabilityReadRequest[]
): Promise<DesktopCapabilityReadResult[]> {
  const results: (DesktopCapabilityReadResult | undefined)[] = await Promise.all(
    requests.map(async (request) => {
      if (!isSectionCapability(request.capability)) return undefined;
      const held = await readHeldCapability(request.capability, request.args);
      return held ? { ok: true as const, value: held.value } : undefined;
    })
  );
  const rest = requests.filter((_, index) => !results[index]);
  const answered = rest.length > 0 ? await api.readCapabilities!(rest) : [];
  let next = 0;
  return results.map((held) => held ?? (answered[next++] as DesktopCapabilityReadResult));
}

/** `heldCapability`, after the recompute `getProviderSetup`'s options ask for. */
export async function readHeldCapability(
  capability: string,
  args: readonly unknown[] = [],
  store: SectionStore | undefined = windowSectionStore(),
  recompute: (params: Record<string, boolean>) => Promise<unknown> = (params) =>
    Promise.resolve(window.mixdogDesktop.sections?.call('account/refreshProviderSetup', params))
): Promise<HeldCapability | undefined> {
  // Only a window whose store holds the section recomputes it; any other asks the capability itself.
  if (capability === 'getProviderSetup' && store?.get('providerSetup')) {
    const options = recordOrNull(args[0]) ?? {};
    const asked = Object.fromEntries(SETUP_OPTIONS.filter((name) => options[name] === true).map((name) => [name, true]));
    if (Object.keys(asked).length > 0) await recompute(asked);
  }
  return heldCapability(capability, args, store);
}
