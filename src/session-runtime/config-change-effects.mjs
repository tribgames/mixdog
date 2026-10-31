// The change-driven effect step of one runtime. Every persisted change (a
// config write or a keychain write, by this runtime, another runtime, another
// process or a hand edit) reaches each subscribing runtime as one
// notification; the runtime reloads, compares the result with the snapshot it
// last applied, and runs only the effects keyed by what changed. The writer
// takes the same step, so no effect depends on which process wrote.

/** The setup-changed action announcing a settings change this runtime applied. */
export const SETTINGS_CHANGED_SETUP_ACTION = 'settings_changed';

// Provider credentials: `agent.<id>.apiKey` and a custom provider's extra keys
// `agent.<id>.apiKey.<keyId>` (custom-provider-keys.mjs).
// A deletion (config.mjs `#deleted`) may remove a secret the marker never
// listed (stored before it existed), so it counts for providers and MCP alike.
const PROVIDER_SECRET_ACCOUNT = /^(agent\.[^.]+\.apiKey(\.|$)|#deleted$)/;
// What an MCP connection depends on beside its config: OAuth sign-ins and
// client secrets, Gmail app passwords, and the plugin registry (plugin
// servers). Token refreshes are not announced (oauth-credentials.mjs).
const MCP_STATE_ACCOUNT = /^(mcp-oauth\.|mcp-oauth-client\.|gmail-app-password\.|#plugins$|#deleted$)/;

// Secret values are compared through their change tokens, never by value.
function tokensSignature(tokens, filter = () => true) {
  const entries = Object.entries(tokens && typeof tokens === 'object' ? tokens : {});
  return JSON.stringify(entries.filter(([account]) => filter(account)).sort(([a], [b]) => a.localeCompare(b)));
}

/** What a runtime last applied: the persisted root (the desktop section has
 *  its own owners), the applied secret change tokens and the effective MCP
 *  servers. Provider and settings changes are judged on the stored state, not
 *  the effective provider entries: those depend on whether a load read secrets
 *  and ran credential probes (boot loads without), so the boot config is an
 *  exact first baseline. MCP servers load the same either way. */
export function configChangeSnapshot({ config, root, secretTokens }) {
  const { desktop: _desktop, ...settingsRoot } = root && typeof root === 'object' ? root : {};
  const agents = config?.agents && typeof config.agents === 'object' ? config.agents : {};
  return {
    providers: JSON.stringify([
      settingsRoot.agent?.providers ?? null,
      // Developer provider options (e.g. cursorOAuth) shape provider clients.
      config?.developer ?? null,
      tokensSignature(secretTokens, (account) => PROVIDER_SECRET_ACCOUNT.test(account)),
    ]),
    cacheWarming: config?.promptCacheWarming === true,
    autoClear: JSON.stringify(config?.autoClear ?? null),
    agentRoutes: Object.fromEntries(Object.entries(agents).map(([id, route]) => [id, JSON.stringify(route ?? null)])),
    mcp: JSON.stringify([
      config?.mcpServers ?? null,
      config?.pluginMcp ?? null,
      tokensSignature(secretTokens, (account) => MCP_STATE_ACCOUNT.test(account)),
    ]),
    settings: JSON.stringify([settingsRoot, tokensSignature(secretTokens)]),
  };
}

export function diffConfigSnapshots(before, after) {
  const routes = new Set([...Object.keys(before.agentRoutes || {}), ...Object.keys(after.agentRoutes || {})]);
  return {
    providers: before.providers !== after.providers,
    mcp: before.mcp !== after.mcp,
    settings: before.settings !== after.settings,
    // The new value when it changed, else null.
    cacheWarming: before.cacheWarming !== after.cacheWarming ? after.cacheWarming : null,
    autoClear: before.autoClear !== after.autoClear,
    // Bots whose stored route was set, changed or cleared.
    agentRoutes: [...routes].filter((id) => before.agentRoutes?.[id] !== after.agentRoutes?.[id]).sort(),
  };
}

/** Whether a diff found nothing changed. */
export function configChangeIsEmpty(change) {
  return (
    !change.providers &&
    !change.mcp &&
    !change.settings &&
    change.cacheWarming === null &&
    !change.autoClear &&
    !change.agentRoutes.length
  );
}

// A domain whose effect failed: it differs from every snapshot value, so the
// next diff carries the domain again and its effect is retried.
const PENDING = Symbol('pending');

/** The effect domains a diff carries (`agentRoutes:<id>` per bot). */
export function configChangeDomains(change) {
  return [
    ...['providers', 'mcp', 'autoClear', 'settings'].filter((domain) => change[domain]),
    ...(change.cacheWarming !== null && change.cacheWarming !== undefined ? ['cacheWarming'] : []),
    ...(change.agentRoutes || []).map((id) => `agentRoutes:${id}`),
  ];
}

/** `snapshot` with `domain` marked not applied. */
export function withConfigDomainPending(snapshot, domain) {
  if (domain.startsWith('agentRoutes:')) {
    const id = domain.slice('agentRoutes:'.length);
    return { ...snapshot, agentRoutes: { ...snapshot.agentRoutes, [id]: PENDING } };
  }
  return { ...snapshot, [domain]: PENDING };
}

/** The effects themselves, keyed by the diff. `change` may be all-false (a
 *  rewrite of identical content): only the always-on invalidation runs.
 *  `config` is the reloaded effective config the diff was taken against.
 *  Answers a promise of the domains whose effect failed. One domain's effects
 *  never overlap: a later one starts once the earlier settled (it runs at
 *  once when none is in flight), so the latest change is applied last. */
export function createConfigChangeEffects({
  invalidateContextStatusCache,
  reinitProviders,
  releaseAdmissionCooldowns,
  reconcileMcp,
  announceSettingsChange,
  noteCacheWarmingEnabled = () => {},
  refreshLiveSessionsCacheOpts = () => {},
  publishAgentRoute = () => {},
}) {
  const inFlight = new Map();
  // domain → the failure last warned about: a retry failing the same way is
  // not warned about again until the domain recovers.
  const warned = new Map();
  function run(domain, effect) {
    const attempt = () => {
      try {
        return Promise.resolve(effect()).then(
          () => {
            warned.delete(domain);
            return null;
          },
          (error) => failed(domain, error)
        );
      } catch (error) {
        return Promise.resolve(failed(domain, error));
      }
    };
    const prior = inFlight.get(domain);
    const done = prior ? prior.then(attempt) : attempt();
    inFlight.set(domain, done);
    void done.then(() => {
      if (inFlight.get(domain) === done) inFlight.delete(domain);
    });
    return done;
  }
  function failed(domain, error) {
    const message = error?.message || String(error);
    if (warned.get(domain) !== message) {
      warned.set(domain, message);
      console.warn(`[config] applying the ${domain} change failed: ${message}`);
    }
    return domain;
  }

  return function applyConfigChangeEffects(change, config) {
    invalidateContextStatusCache();
    const runs = [];
    if (change.providers) {
      // Cooldowns and initialized clients belong to the old credentials.
      runs.push(
        run('providers', () => {
          releaseAdmissionCooldowns();
          return reinitProviders();
        })
      );
    }
    if (change.mcp) runs.push(run('mcp', reconcileMcp));
    // Every session of this process warms (or stops warming, armed chains
    // included) as the setting now says.
    if (change.cacheWarming !== null && change.cacheWarming !== undefined) {
      runs.push(run('cacheWarming', () => noteCacheWarmingEnabled(change.cacheWarming)));
    }
    // Live sessions take the new idle window as their cache lifetime.
    if (change.autoClear) runs.push(run('autoClear', () => refreshLiveSessionsCacheOpts(config)));
    // The bots' chats this process hosts move onto their new routes.
    for (const id of change.agentRoutes || []) runs.push(run(`agentRoutes:${id}`, () => publishAgentRoute(id, config)));
    if (change.settings) runs.push(run('settings', announceSettingsChange));
    return Promise.all(runs).then((results) => results.filter(Boolean));
  };
}
