// Settings → System → Network proxy: how Mixdog reaches AI services
// (runtime/shared/llm/proxy-policy.mjs). Persisted at agent config
// `networkProxy` `{ mode, url, exceptions }`; defaults are not stored. Every
// outbound provider path reads the stored value on its next connection.
import { OPENAI_COMPAT_PRESETS } from '../runtime/agent/orchestrator/providers/openai-compat-presets.mjs';
import { adoptProxySetting, applyNetworkProxyPatch, normalizeNetworkProxy } from '../runtime/shared/llm/proxy-policy.mjs';
import {
  checkProxyConnection,
  explainProxyRoute,
  providerCheckOrigin,
} from '../runtime/shared/llm/proxy-diagnostics.mjs';

export function createNetworkProxySettings({ getConfig, saveConfigAndAdopt, flushConfigSaves }) {
  const origin = (provider) => providerCheckOrigin(provider, getConfig()?.providers, OPENAI_COMPAT_PRESETS);
  const current = () => normalizeNetworkProxy(getConfig()?.networkProxy);
  const view = async (provider) => {
    const setting = current();
    const endpoint = origin(provider);
    return { ...setting, origin: endpoint, route: await explainProxyRoute(endpoint, setting) };
  };
  return {
    /** `{ mode, url, exceptions, route }`; `route` describes the effective route to the main provider's endpoint. */
    getNetworkProxy(options) {
      return view(options?.provider);
    },
    /** Patch `{ mode?, url?, exceptions? }`: nothing is stored unless all of it is valid. */
    async setNetworkProxy(patch, options) {
      const config = getConfig() || {};
      saveConfigAndAdopt({ ...config, networkProxy: applyNetworkProxyPatch(config.networkProxy, patch) });
      // The connections of every process follow the stored file, so it is written before this answers.
      await flushConfigSaves?.({ requireSaved: true });
      // This process's next connection follows it at once; other processes hear the file's watch event.
      adoptProxySetting(getConfig().networkProxy);
      return view(options?.provider);
    },
    /** Connect to the main provider's endpoint through the current policy: `{ ok, ms, origin, status | code, route }`. */
    testNetworkProxy(options) {
      return checkProxyConnection(origin(options?.provider), current());
    },
  };
}
