import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getSecret } = require('../../lib/keychain-cjs.cjs');

// A custom provider's additional API keys are keychain secrets beside its
// primary key (`agent.<id>.apiKey`), one per key id of its roster
// (provider-accounts.mjs `setCustomProviderKeyIds`). Never config values.
export function customProviderKeyAccount(providerId, keyId) {
  return `agent.${providerId}.apiKey.${keyId}`;
}

/** The stored value of additional key `keyId`, or '' when it is not readable. */
export function readCustomProviderKey(providerId, keyId) {
  try {
    return getSecret(customProviderKeyAccount(providerId, keyId)) || '';
  } catch {
    return '';
  }
}
