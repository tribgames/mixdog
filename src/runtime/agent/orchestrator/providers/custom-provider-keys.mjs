// The engine a custom provider sends with when one of its additional API keys
// serves (account-pool.mjs `createCustomKeyPoolProvider`). Every key reaches
// the same endpoint, so the engine is a view of the primary instance: the
// catalog, discovered models, wire routes and settings stay the primary's,
// and only the credential and the client built from it are the key's own.

import { readCustomProviderKey } from '../../../shared/custom-provider-keys.mjs';

function keyView(engine, providerId, keyId, key) {
  const view = Object.create(engine);
  const rekey = (value) => {
    // The key is the only source: an environment variable names the primary key alone.
    view.config = { ...engine.config, apiKey: value, apiKeyEnv: undefined };
    view.apiKey = value;
    view.client = view._createClient(value);
  };
  rekey(key);
  // An auth retry re-reads this key, never the primary's keychain entry.
  view.reloadApiKey = () => {
    const fresh = readCustomProviderKey(providerId, keyId);
    if (fresh) rekey(fresh);
  };
  return view;
}

/** `primary` sending with additional key `keyId` of custom provider `providerId`. */
export function customKeyEngine(primary, providerId, keyId) {
  const key = readCustomProviderKey(providerId, keyId);
  if (!key) throw new Error(`An additional API key of ${providerId} is not readable; enter it again in its settings.`);
  const engine = keyView(primary, providerId, keyId, key);
  // A Messages-wire route sends through the bound Anthropic engine.
  if (primary.messagesEngine) engine.messagesEngine = keyView(primary.messagesEngine, providerId, keyId, key);
  return engine;
}
