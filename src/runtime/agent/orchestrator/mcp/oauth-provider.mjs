import { normalizeMcpTransportUrl } from './client-config.mjs';
import { loginFailed, reauthenticationRequired } from './oauth-shared.mjs';

/**
 * The SDK's OAuth client provider over one connection's credential `cache`
 * and login `flow` state.
 */
export function createOAuthProvider({ cache, flow, lifetimeSignal }) {
  const { creds, ready, update } = cache;
  // The SDK saves only inside a login, which holds the lock and has just
  // adopted the stored entry.
  const save = async (change) => {
    if (!(await update(change))) throw loginFailed();
  };
  return {
    get redirectUrl() {
      return creds.redirectUrl;
    },
    get clientMetadata() {
      return {
        client_name: 'Mixdog',
        redirect_uris: [creds.redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      };
    },
    state: () => flow.state,
    clientInformation: async () => {
      await ready();
      // A connect that cannot open a sign-in never registers a client (the
      // SDK registers one after dropping a rejected registration): the next
      // explicit sign-in registers it.
      if (!creds.clientInformation && !flow.allowBrowser) throw reauthenticationRequired();
      return creds.clientInformation;
    },
    saveClientInformation: (value) =>
      save(() => {
        creds.clientInformation = value;
      }),
    tokens: async () => {
      await ready();
      return creds.tokens;
    },
    saveTokens: async (value) => {
      lifetimeSignal.throwIfAborted();
      await save(() => {
        creds.tokens = value;
      });
    },
    saveCodeVerifier: (value) => {
      flow.verifier = value;
    },
    codeVerifier: () => {
      if (!flow.verifier) throw loginFailed();
      return flow.verifier;
    },
    discoveryState: () => creds.discovery,
    saveDiscoveryState: (value) =>
      save(() => {
        creds.discovery = value;
      }),
    // The SDK invalidates 'all' when the token endpoint rejects the client
    // (invalid_client / unauthorized_client) and 'tokens' when it rejects the
    // grant (invalid_grant). The registration goes in both cases: an
    // authorization server that forgot its clients (a restart) may answer the
    // refresh with invalid_grant, and reusing that registration would fail
    // every later sign-in at the authorization endpoint; re-registering is cheap.
    invalidateCredentials: async (scope) => {
      if (scope === 'all' || scope === 'verifier') flow.verifier = undefined;
      if (scope === 'discovery') creds.discovery = undefined;
      if (scope !== 'all' && scope !== 'tokens' && scope !== 'client') return;
      await update(
        () => {
          if (scope !== 'client') creds.tokens = undefined;
          creds.clientInformation = undefined;
          if (scope === 'all') creds.discovery = undefined;
        },
        { remove: scope === 'all' }
      );
    },
    redirectToAuthorization: async (authorizationUrl) => {
      if (!flow.allowBrowser || flow.browserOpened) throw reauthenticationRequired();
      const target = new URL(normalizeMcpTransportUrl(authorizationUrl));
      if (
        target.searchParams.get('state') !== flow.state ||
        target.searchParams.get('code_challenge_method') !== 'S256' ||
        !flow.verifier
      )
        throw loginFailed();
      flow.browserOpened = true;
      await flow.launchBrowser(target.href);
    },
  };
}
