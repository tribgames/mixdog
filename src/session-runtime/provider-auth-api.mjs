import { renderProviderStatus } from '../standalone/provider-admin.mjs';
import { createAuthRefresh } from './provider-auth/refresh.mjs';
import { createAccountApi } from './provider-auth/accounts.mjs';
import { createSetupApi } from './provider-auth/setup.mjs';
import { createLoginApi } from './provider-auth/login.mjs';

// Provider auth / catalog / preset surface. The stateless admin helpers are
// imported directly and the runtime injects the closure-owned config/cache
// callbacks. provider-auth/: refresh (post-credential-change chain), accounts
// (roster + switching), setup (read-side snapshots), login (mutations).
export function createProviderAuthApi(deps) {
  const resolved = {
    ...deps,
    isKeychainPrewarmReady: deps.isKeychainPrewarmReady === undefined ? () => true : deps.isKeychainPrewarmReady,
    hasProviderSetupCached: deps.hasProviderSetupCached === undefined ? () => true : deps.hasProviderSetupCached,
  };
  const { cfgMod, displayConfig } = resolved;
  const refresh = createAuthRefresh(resolved);

  return {
    ...createAccountApi(resolved, refresh),
    listProviders() {
      return renderProviderStatus(displayConfig());
    },
    ...createSetupApi(resolved),
    ...createLoginApi(resolved, refresh),
    listPresets() {
      return cfgMod.listPresets(displayConfig());
    },
  };
}
