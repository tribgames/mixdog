// MCP OAuth sign-in and sign-out of a configured server or of one account of a
// multi-account connector server: the interactive login flows
// (mcp-oauth-login.mjs), the transactional account switch, and the
// credential-free auth probe.
import { clean } from '../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { createMcpOAuthLogins } from './mcp-oauth-login.mjs';
import { connectorAccountServers, connectorAccountsOf } from '../runtime/shared/connector-catalog.mjs';
import { forgetConnectorAccountHealth } from '../runtime/connectors/connector-accounts-mcp.mjs';
import { accountTarget } from './resource-mcp-servers.mjs';

export function createMcpOAuthApi({
  sync,
  mcpStatus,
  connectConfiguredMcp,
  clearMcpServerOAuth,
  reloadFullConfig,
  awaitKeychainPrewarm,
  resolveMcpCatalog,
  cancelMcpLogin,
  completeMcpLogin,
  getMcpServerOAuthState,
  probeMcpServerAuth,
  startMcpServerOAuthSwitch,
  commitMcpServerOAuthSwitch,
}) {
  const reconnectOne = async (name) => {
    const status = await connectConfiguredMcp({ only: name, enabled: true });
    const row = status?.servers?.find((server) => server.name === name);
    return { connected: row?.connected === true, error: row?.error || null };
  };
  // Explicit OAuth sign-in: the one interactive MCP connect. On success the
  // other runtimes reconnect the server non-interactively with the new tokens.
  const oauthLogins = createMcpOAuthLogins({
    async connect(name, openBrowser) {
      const status = await connectConfiguredMcp({ only: name, enabled: true, login: { openBrowser } });
      const row = status?.servers?.find((server) => server.name === name);
      return { connected: row?.connected === true, error: row?.error || null };
    },
    cancel: (name) => cancelMcpLogin(name),
    completeCallback: completeMcpLogin,
    // 계정 바꾸기, transactionally: the working connection stays until the new
    // sign-in succeeded and connects; a cancel or failure changes nothing, and
    // a new sign-in that cannot connect is rolled back.
    // An account of a multi-account connector signs in the same way, any
    // mode: beside its stored sign-in (if any), then its server reconnects.
    async switchAccount(name, launch, attempt) {
      const servers = resolveMcpCatalog().servers;
      const target = accountTarget(servers, name);
      const cfg = target ? target.accountCfg : servers[name];
      const serverName = target ? target.serverName : name;
      // 연결 / 다시 인증 of a signed-in account: its stored sign-in (refreshed
      // as needed) is tried first; the browser opens only when that fails.
      if (target && launch.accountMode !== 'switch' && getMcpServerOAuthState(cfg)?.signedIn === true) {
        const repaired = await reconnectOne(serverName);
        if (repaired.connected && !connectorAccountError(name)) return repaired;
      }
      const switching = startMcpServerOAuthSwitch(cfg, launch, name);
      attempt.abort = () => switching.cancel();
      attempt.answer = (callbackUrl) => switching.answer(callbackUrl);
      const signIn = await switching.done;
      // The same account twice would leave `account` ambiguous.
      const address = String(signIn?.identity?.account || '').toLowerCase();
      if (target && address) {
        const twin = connectorAccountServers(target.cfg).find(
          (other) =>
            other.name !== name && String(getMcpServerOAuthState(other)?.account || '').toLowerCase() === address
        );
        if (twin) return { connected: false, error: `${signIn.identity.account} is already connected` };
      }
      const rollback = await commitMcpServerOAuthSwitch(cfg, signIn);
      const outcome = await reconnectOne(serverName);
      const accountError = target ? connectorAccountError(name) : '';
      if (outcome.connected && !accountError) return outcome;
      await rollback();
      await reconnectOne(serverName);
      return { connected: false, error: accountError || outcome.error || 'The new sign-in could not connect' };
    },
    onComplete: (name) =>
      sync.announce('mcp', {
        detail: {
          mcpChanges: [{ name: accountTarget(resolveMcpCatalog().servers, name)?.serverName || name, enabled: true }],
        },
      }),
  });
  /** The effective config of a server that signs in with MCP OAuth (HTTP/SSE
   *  without configured authentication). */
  const oauthServerConfig = async (name) => {
    const serverName = clean(name);
    if (!serverName) throw new Error('MCP server name is required');
    await awaitKeychainPrewarm();
    reloadFullConfig();
    const cfg = resolveMcpCatalog().servers[serverName];
    if (!cfg) throw new Error(`MCP server not configured: ${serverName}`);
    if (!getMcpServerOAuthState(cfg)) throw new Error(`MCP server "${serverName}" does not use OAuth sign-in`);
    return { serverName, cfg };
  };

  /** The sign-in account `name` addresses on a multi-account connector
   *  server — an account's name, or the server's name when it has exactly one
   *  sign-in account (`every`: all of them, for a sign-out) — as
   *  `{ serverName, cfg, account, accountCfg, signOut: [accountCfg…] }`;
   *  null for any other server. */
  const signInAccount = async (name, { every = false } = {}) => {
    const wanted = clean(name);
    if (!wanted) throw new Error('MCP server name is required');
    await awaitKeychainPrewarm();
    reloadFullConfig();
    const servers = resolveMcpCatalog().servers;
    const target = accountTarget(servers, wanted);
    if (target) {
      if (!getMcpServerOAuthState(target.accountCfg)) {
        throw new Error(`MCP server "${wanted}" does not use OAuth sign-in`);
      }
      return { ...target, signOut: [target.accountCfg] };
    }
    const cfg = servers[wanted];
    if (!connectorAccountsOf(cfg).length) return null;
    const signIns = connectorAccountServers(cfg).filter((accountCfg) => getMcpServerOAuthState(accountCfg));
    if (every && signIns.length) return { serverName: wanted, cfg, account: null, accountCfg: null, signOut: signIns };
    if (signIns.length === 1) {
      const account = connectorAccountsOf(cfg).find((entry) => entry.name === signIns[0].name);
      return { serverName: wanted, cfg, account, accountCfg: signIns[0], signOut: signIns };
    }
    throw new Error(
      signIns.length
        ? `MCP server "${wanted}" has several accounts; name the account to sign in`
        : `MCP server "${wanted}" does not use OAuth sign-in`
    );
  };

  /** What account `name` of a multi-account connector currently fails with ('' when fine). */
  function connectorAccountError(name) {
    for (const row of mcpStatus()?.servers || []) {
      const account = (Array.isArray(row.accounts) ? row.accounts : []).find((entry) => entry.name === name);
      if (account) return account.error || (account.authRequired ? 'Sign-in required' : '');
    }
    return '';
  }

  return {
    /** `{ flowId, state: 'pending', url }` once the browser login starts
     *  (`options.openBrowser === false` leaves opening `url` to the caller), or
     *  `{ flowId, state: 'complete' }` when stored credentials sufficed. */
    async beginMcpOAuthLogin(name, options = {}) {
      const account = await signInAccount(name);
      if (account) {
        if (account.cfg.enabled === false) throw new Error(`MCP server is disabled: ${account.serverName}`);
        // Beside the stored sign-in, whatever the mode: the account's server keeps running meanwhile.
        return oauthLogins.begin(account.account.name, { ...(options || {}), beside: true });
      }
      const { beside: _beside, ...ownOptions } = options || {};
      options = ownOptions;
      const { serverName, cfg } = await oauthServerConfig(name);
      if (cfg.enabled === false) throw new Error(`MCP server is disabled: ${serverName}`);
      // `mode`: `connect` (a normal authorization), `reauth` (repair the same
      // connection; a refresh is tried first) or `switch` (계정 바꾸기).
      if (options?.mode === 'switch' && !getMcpServerOAuthState(cfg)?.signedIn) {
        throw new Error(`MCP server "${serverName}" is not signed in`);
      }
      return oauthLogins.begin(serverName, options);
    },
    /** `{ flowId, state: 'pending' | 'complete' | 'failed' | 'cancelled',
     *  step?, error?, reason? }`; with `{ since, waitMs }` it resolves on the
     *  flow's next change (mcp-oauth-login.mjs). */
    getMcpOAuthLoginStatus(flowId, options) {
      return oauthLogins.status(flowId, options);
    },
    cancelMcpOAuthLogin(flowId) {
      return oauthLogins.cancel(flowId);
    },
    /** Remote / headless sign-in: complete the pending flow with the redirect
     *  URL pasted from the browser. `{ flowId, state: 'complete' | 'failed',
     *  error? }`; an invalid paste throws a fixed message and stays pending. */
    completeMcpOAuthLogin(flowId, callbackUrl) {
      return oauthLogins.complete(flowId, callbackUrl);
    },
    /** Forget the server's stored OAuth credentials (shared by every server
     *  with the same exact URL) and reconnect without a login, here and on
     *  peers, so it reports sign-in required. */
    async signOutMcpServer(name) {
      const account = await signInAccount(name, { every: true });
      if (account) {
        const accountName = account.account?.name || clean(name);
        return oauthLogins.cancelServer(accountName, async () => {
          let revoked = true;
          for (const accountCfg of account.signOut) {
            forgetConnectorAccountHealth(accountCfg.name);
            revoked = (await clearMcpServerOAuth(accountCfg, { revoke: true }))?.revoked === true && revoked;
          }
          const status = await sync.reconnectMcpAndAnnounce({
            only: account.serverName,
            enabled: account.cfg.enabled !== false,
          });
          return { ...status, revoked };
        });
      }
      const { serverName, cfg } = await oauthServerConfig(name);
      // A begin issued meanwhile waits until the credentials are gone.
      return oauthLogins.cancelServer(serverName, async () => {
        const { revoked = false } = (await clearMcpServerOAuth(cfg, { revoke: true })) || {};
        const status = await sync.reconnectMcpAndAnnounce({ only: serverName, enabled: cfg.enabled !== false });
        return { ...status, revoked };
      });
    },
    /** `{ auth: 'oauth' | 'none' | 'configured' | 'unreachable', error? }` for an
     *  HTTP/SSE config, without credentials or a browser. */
    probeMcpServerAuth(cfg) {
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new TypeError('MCP server config is required');
      const probe = {};
      for (const key of ['type', 'url', 'headers', 'bearer_token_env_var', 'env_http_headers']) {
        if (cfg[key] !== undefined) probe[key] = cfg[key];
      }
      if (probe.type !== 'http' && probe.type !== 'sse') throw new TypeError("type must be 'http' or 'sse'");
      return probeMcpServerAuth(probe);
    },
  };
}
