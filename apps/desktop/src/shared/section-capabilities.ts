// The session capabilities the core replaced by pushed sections (D-desktop-core-2 group 1): which section carries each
// one's value. On a connection with a core endpoint the capability is answered from that section and never sent; on any
// other connection it goes to the Node host. The choice is the connection's alone (desktop-core-route-1), never
// whether a section happens to be present.

export interface SectionRef {
  readonly section: string;
  readonly key: string | null;
}

const SECTION_OF: Readonly<Record<string, string>> = {
  listPresets: 'presets',
  listAgents: 'agents',
  listWorkflows: 'workflows',
  getWebSearchRoute: 'webSearch',
  getProviderSetup: 'providerSetup',
  listProviders: 'providerSetup',
};

const SETUP_OPTIONS = ['force', 'refresh', 'unlockKeychain', 'recheckKeychain'] as const;

/** True for a capability the sections replaced. */
export function isSectionCapability(capability: string): boolean {
  return capability in SECTION_OF || capability === 'getProviderAccounts' || capability === 'getOnboardingStatus';
}

/** The `(section, key)` that carries the capability's value; `getProviderAccounts` is keyed by its provider argument and
 *  `getOnboardingStatus` is the `onboarding` key of `config` (desktop-services.md D10). */
export function sectionOf(capability: string, args: readonly unknown[] = []): SectionRef {
  if (capability === 'getOnboardingStatus') return { section: 'config', key: 'onboarding' };
  if (capability === 'getProviderAccounts') {
    if (typeof args[0] !== 'string') throw new TypeError('Unknown OAuth provider.');
    return { section: 'providerAccounts', key: args[0] };
  }
  const section = SECTION_OF[capability];
  if (!section) throw new TypeError(`${capability} is not carried by a section.`);
  return { section, key: null };
}

/** The recompute `getProviderSetup(options)` asks for (`account/refreshProviderSetup`), `undefined` for none. */
export function providerSetupRefresh(capability: string, args: readonly unknown[] = []): Record<string, true> | undefined {
  if (capability !== 'getProviderSetup') return undefined;
  const options = args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) ? (args[0] as Record<string, unknown>) : {};
  const asked = SETUP_OPTIONS.filter((name) => options[name] === true);
  return asked.length > 0 ? Object.fromEntries(asked.map((name) => [name, true as const])) : undefined;
}
