import { normalizeMcpTransportUrl } from './client-config.mjs';
import { withAccountParams } from './oauth-account.mjs';
import { loginFailed, reauthenticationRequired } from './oauth-shared.mjs';

/**
 * The SDK's OAuth client provider over one connection's credential `cache`
 * and login `flow` state.
 */
export function createOAuthProvider({ cache, flow, lifetimeSignal, client = null, credentialStore = null }) {
  const { creds, ready, update } = cache;
  // The SDK saves only inside a login, which holds the lock and has just
  // adopted the stored entry.
  const save = async (change) => {
    if (!(await update(change))) throw loginFailed();
  };
  // A pre-registered client (oauth-client.mjs) is the static client
  // information: nothing is registered, and its secret (the user's lives in
  // the keychain) goes with the token requests.
  const staticClient = async () => {
    const secret = client.secretAccount
      ? await credentialStore?.getSecretAsync(client.secretAccount)
      : client.clientSecret;
    return { client_id: client.clientId, ...(secret ? { client_secret: secret } : {}) };
  };
  return {
    /** A pre-registered client: a refresh needs no stored registration. */
    preRegistered: Boolean(client),
    // A pre-registered client's provider issues tokens for its own APIs
    // (Google): no RFC 8707 resource indicator is sent.
    ...(client ? { validateResourceURL: async () => undefined } : {}),
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
        ...(client?.scopes ? { scope: client.scopes.join(' ') } : {}),
      };
    },
    state: () => flow.state,
    clientInformation: async () => {
      await ready();
      if (client) return staticClient();
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
        // A browser sign-in may be another account: its identity replaces the
        // stored one (null when the server named nobody). A refresh keeps it
        // unless the response names the account again.
        if (flow.browserOpened) creds.identity = flow.identity ?? null;
        else if (flow.identity) creds.identity = flow.identity;
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
    // Kept in memory and stored with the login's next write (the client
    // registration or the tokens), sparing a keychain write of its own.
    saveDiscoveryState: (value) => {
      creds.discovery = value;
    },
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
      // A pre-registered client is stored with this login's redirect, as a
      // registration would be: the exchange and later refreshes (and the
      // revocation on 연결 해제) read them from the entry.
      if (client) {
        const issuedTo = await staticClient();
        await save(() => {
          creds.clientInformation = issuedTo;
        });
      }
      flow.browserOpened = true;
      // A pre-registered client asks for its own scopes (the server's list
      // may name far more) plus its provider's parameters (Google's
      // access_type=offline, without which no refresh token is issued).
      if (client?.scopes) target.searchParams.set('scope', client.scopes.join(' '));
      for (const [key, value] of Object.entries(client?.authParams || {})) target.searchParams.set(key, value);
      // The explicit sign-in's account mode (mcp-oauth-login.mjs) decides the
      // provider's documented account-choice parameter, if any.
      await flow.launchBrowser(withAccountParams(target.href, flow.launchBrowser.accountMode || 'connect').href);
    },
  };
}
