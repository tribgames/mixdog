/**
 * config-providers-merge.mjs — how the stored `providers` section is folded
 * onto the probe-built defaults: unknown per-provider keys survive the merge,
 * a stored `enabled` outranks the credential probe, keychain API keys are
 * overlaid onto the entries that own one, and the OAuth-only cursor-api entry
 * is dropped.
 */
import { AGENT_PROVIDER_ENV, getAgentApiKey } from '../../shared/config.mjs';
import { OPENAI_COMPAT_PRESETS } from './providers/openai-compat-presets.mjs';

export function mergeStoredProviders({ raw, defaults, includeSecrets }) {
  // Deep-merge provider subkeys: unknown per-provider values are
  // preserved through save/load so future fields round-trip
  // without schema updates here.
  const mergedProviders = { ...defaults.providers };
  if (raw.providers && typeof raw.providers === 'object') {
    for (const [name, val] of Object.entries(raw.providers)) {
      if (val && typeof val === 'object') {
        mergedProviders[name] = { ...(mergedProviders[name] || {}), ...val };
        // A STORED `enabled` is the user's own decision (setup
        // UI disable / hand edit) and outranks the probe: keep
        // it authoritative by dropping the probe-availability
        // marker, so a disable still removes the provider even
        // while its credential file happens to be unreadable.
        if (Object.hasOwn(val, 'enabled')) {
          delete mergedProviders[name].credentialProbeUnavailable;
        }
      } else {
        mergedProviders[name] = val;
      }
    }
  }
  // Provider API keys live in the OS keychain (std env / MIXDOG_AGENT_*
  // -> keychain), never plaintext in config. Overlay them so the
  // provider clients see config.apiKey populated.
  // AGENT_PROVIDER_ENV covers first-class key providers; OPENAI_COMPAT_PRESETS
  // covers compat providers (opencode-go, …) whose key also lives in
  // the keychain. Without the union, a compat provider with a valid
  // stored key still ships 'no-key' → 401.
  if (includeSecrets) {
    for (const name of new Set([...Object.keys(AGENT_PROVIDER_ENV), ...Object.keys(OPENAI_COMPAT_PRESETS)])) {
      const kc = getAgentApiKey(name);
      if (kc) {
        mergedProviders[name] = {
          ...(mergedProviders[name] || {}),
          apiKey: kc,
          enabled: raw.providers?.[name]?.enabled !== false,
        };
      }
    }
  }
  // Cursor account access is OAuth-only. The dashboard's "API"
  // meter is a quota bucket on that account, not a separate provider.
  delete mergedProviders['cursor-api'];
  return mergedProviders;
}
