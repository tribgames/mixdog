import { modelProxyClientMode } from '../../../shared/model-proxy-mode.mjs';
import { isOAuthProviderAvailable } from './oauth-credential-probes.mjs';

/**
 * Whether the named provider may be looked up or sent through right now. Remote
 * client mode serves the PC's providers, whose availability the PC already
 * decided; only a locally run provider answers to the local Developer option.
 */
export function providerAvailable(name) {
  return modelProxyClientMode() || isOAuthProviderAvailable(name);
}

/** The error a send raises when its provider was switched off after lookup. */
export function providerUnavailableError(name) {
  return Object.assign(
    new Error(`Provider "${name}" is disabled: its Developer option was switched off before the request was sent.`),
    { code: 'EPROVIDERUNAVAILABLE', provider: name }
  );
}
