// MCP server configuration: add/save/remove/toggle of the user's servers, and
// the per-server intent (enabled flag) of servers registered plugins declare.
// Plugin servers are derived live (mcp-glue/plugin-servers.mjs) and are never
// written into `mcpServers`; ordinary edits refuse them.
import { clean } from '../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import {
  mergeMcpServerConfig,
  MCP_TIMEOUT_FIELD_GROUPS,
} from '../runtime/agent/orchestrator/runtime-core/plugin-mcp.mjs';
import { resolveMcpOAuthUrl } from '../runtime/agent/orchestrator/mcp/client-config.mjs';
import { withAdoptedCopies, withPinnedCollisionNames, withPluginServerIntent } from './mcp-glue/plugin-servers.mjs';
import { findRegisteredPlugin } from './resource-plugins-api.mjs';
import { migrateMergedConnectorServers } from './connector-merge-migration.mjs';
import { createMcpOAuthLogins } from './mcp-oauth-login.mjs';
import {
  connectorAccountEntry,
  connectorAccountServer,
  connectorAccountServers,
  connectorAccountsOf,
  connectorAccountsUrl,
  connectorById,
  connectorMultiAccount,
  connectorOfServer,
  gmailAppPasswordAccount,
  gmailAppPasswordValue,
  mergeConnectorAccountServers,
} from '../runtime/shared/connector-catalog.mjs';
import { saveMcpOAuthClientSecret } from '../runtime/agent/orchestrator/mcp/oauth-client.mjs';
import { forgetGmailAppPassword, saveGmailAppPassword } from '../runtime/connectors/gmail-app-password.mjs';
import { forgetConnectorAccountHealth } from '../runtime/connectors/connector-accounts-mcp.mjs';
import { extensionScopesFromConfig, withExtensionScope } from '../runtime/shared/extension-scopes.mjs';

/** The URL a server's OAuth credentials are stored under, or null. */
function oauthUrlOf(cfg) {
  try {
    return resolveMcpOAuthUrl(cfg);
  } catch {
    // No valid remote URL: such a server never logged in.
    return null;
  }
}

/** The `mcpServers` map of a config as a fresh object (never the live one). */
function mcpServersOf(config) {
  return config.mcpServers && typeof config.mcpServers === 'object' ? { ...config.mcpServers } : {};
}

/** The multi-account connector account `name` names in `servers`:
 *  `{ serverName, cfg, account, accountCfg }`, or null. */
function accountTarget(servers, name) {
  for (const [serverName, cfg] of Object.entries(servers || {})) {
    const account = connectorAccountsOf(cfg).find((entry) => entry.name === name);
    if (account) return { serverName, cfg, account, accountCfg: connectorAccountServer(cfg, account) };
  }
  return null;
}

/** The refusal of a new server name that is taken. A name a connector account
 *  holds is an account to the user (never a server), so it says so. */
function nameTakenError(servers, name) {
  const holder = accountTarget(servers, name);
  const connector = holder && connectorById(connectorOfServer(holder.cfg));
  return new Error(
    connector
      ? `The name "${name}" is used by a ${connector.name} account. Choose another name.`
      : `MCP server already exists: ${name}`
  );
}

/** The server of multi-account connector `connector` in `servers`, or ''. */
function connectorServerName(servers, connector) {
  return (
    Object.keys(servers).find(
      (name) => connectorOfServer(servers[name]) === connector && connectorAccountsOf(servers[name]).length > 0
    ) || ''
  );
}

/** Every config `servers` connects with, a multi-account server's accounts
 *  as the one-account configs they are. */
const expandedConfigs = (servers) =>
  Object.values(servers || {}).flatMap((cfg) => {
    const accounts = connectorAccountServers(cfg);
    return accounts.length ? accounts : [cfg];
  });

function pluginOwnedError(name, owner) {
  return new Error(
    `MCP server "${name}" is provided by plugin "${owner.id}" (server "${owner.key}"); ` +
      'enable or disable it with set_mcp_enabled, or manage the plugin instead'
  );
}

const transportType = (type) => (type === 'streamable-http' ? 'http' : type);

/** UI editors send complete transports; setup may send a partial patch. Merge
 *  the patch over the existing entry, keeping omitted fields (including
 *  credentials) unless the transport itself changed. */
function mergedServerInput(input, existing, originalName) {
  const transportChanged =
    (input.type && transportType(input.type) !== transportType(existing.type || (existing.url ? 'http' : 'stdio'))) ||
    (input.command && existing.url) ||
    (input.url && !existing.url);
  const maps = {};
  if (!transportChanged) {
    for (const key of ['env', 'headers', 'env_http_headers']) {
      if (Object.hasOwn(input, key)) maps[key] = { ...(existing[key] || {}), ...input[key] };
    }
  }
  // Existing timeouts are kept by mergeMcpServerConfig; the normalizer must only
  // see (and validate) newly supplied ones, so a stored 0/'off' never blocks
  // an unrelated save.
  const { ...base } = transportChanged ? {} : existing;
  for (const field of MCP_TIMEOUT_FIELD_GROUPS.flat()) delete base[field];
  return {
    ...base,
    ...input,
    ...maps,
    name: clean(input.name) || originalName,
  };
}

export function createMcpResourceApi({ deps, sync, decorate }) {
  const {
    getConfig,
    saveConfigAndAdopt,
    normalizeMcpServerInput,
    mcpStatus,
    getMcpServerConfig,
    connectConfiguredMcp,
    clearMcpServerOAuth,
    reloadFullConfig,
    awaitKeychainPrewarm,
    pluginsStatus,
    resolveMcpCatalog = () => ({ servers: {}, adoption: null, plugins: {}, entries: {} }),
    resolveConfiguredMcpCatalog = resolveMcpCatalog,
    pluginMcpServer = () => null,
    flushSkillsSave,
    cancelMcpLogin = () => {},
    completeMcpLogin,
    getMcpServerOAuthState = () => null,
    probeMcpServerAuth,
    startMcpServerOAuthSwitch,
    commitMcpServerOAuthSwitch,
    gmailAppPassword = { save: saveGmailAppPassword, forget: forgetGmailAppPassword },
    saveOAuthClientSecret = saveMcpOAuthClientSecret,
  } = deps;

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
        detail: { mcpChanges: [{ name: accountTarget(resolveMcpCatalog().servers, name)?.serverName || name, enabled: true }] },
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

  /** The config with any adoptable plugin server copies already adopted, so
   *  every write also persists the adoption and never re-adds a copy. */
  const adoptedConfig = () => withAdoptedCopies(getConfig(), resolveMcpCatalog().adoption);

  /** Persist a new `mcpServers` map; project overrides never survive a global
   *  edit. A plugin server pushed off its name by the edit keeps the collision
   *  name it gets, so it does not flip again later. */
  const saveServers = (servers) => {
    const nextConfig = { ...adoptedConfig() };
    delete nextConfig.mcpProjectOverrides;
    saveConfigAndAdopt({ ...nextConfig, mcpServers: servers });
    const saved = getConfig();
    const pinned = withPinnedCollisionNames(saved, resolveMcpCatalog());
    if (pinned !== saved) saveConfigAndAdopt(pinned);
  };
  // Every write starts from the merged form: one server per multi-account connector.
  const userServers = () => mergeConnectorAccountServers(mcpServersOf(adoptedConfig())).servers;
  /** What account `name` of a multi-account connector currently fails with ('' when fine). */
  function connectorAccountError(name) {
    for (const row of mcpStatus()?.servers || []) {
      const account = (Array.isArray(row.accounts) ? row.accounts : []).find((entry) => entry.name === name);
      if (account) return account.error || (account.authRequired ? 'Sign-in required' : '');
    }
    return '';
  }
  /** A name no server, plugin server or account has yet: `base`, else `base-2`… */
  const freeName = (servers, base) => {
    const taken = new Set(
      Object.entries(servers).flatMap(([name, cfg]) => [name, ...connectorAccountsOf(cfg).map((a) => a.name)])
    );
    const free = (name) => !taken.has(name) && !pluginMcpServer(name);
    if (free(base)) return base;
    for (let n = 2; ; n += 1) if (free(`${base}-${n}`)) return `${base}-${n}`;
  };
  const refusePluginServer = (name) => {
    const owned = name ? pluginMcpServer(name) : null;
    if (owned) throw pluginOwnedError(name, owned.owner);
  };
  // The user's OAuth client secret (custom connector → 고급 설정 → 비밀값)
  // goes to the keychain only; clearing the client id forgets it.
  const storeOAuthClientSecret = async (input, cfg, previous = {}) => {
    if (!cfg?.url) return;
    const secret = typeof input.oauthClientSecret === 'string' ? input.oauthClientSecret.trim() : '';
    if (cfg.oauthClientId && secret) await saveOAuthClientSecret(cfg.url, secret);
    else if (!cfg.oauthClientId && previous.oauthClientId) await saveOAuthClientSecret(previous.url || cfg.url, '');
  };
  // Gmail with an app password (connector-catalog.mjs GMAIL_APP_PASSWORD): the
  // password is checked with Gmail before anything is saved and goes to the
  // keychain only. A new connection needs one; an edit without one keeps it.
  const storeGmailAppPassword = async (input, cfg, required) => {
    const account = gmailAppPasswordAccount(cfg);
    if (!account) return;
    const password = gmailAppPasswordValue(input.appPassword);
    if (password) await gmailAppPassword.save(account, password);
    else if (required || input.appPassword !== undefined) {
      throw new Error('GMAIL_APP_PASSWORD_FORMAT: An app password has 16 characters.');
    }
  };
  // A server's OAuth tokens and client registration go with it, unless another
  // configured server (plugin or disabled ones included, even with MCP
  // disabled for this runtime) still uses them through the same exact URL.
  // `signIn` tells the caller what happened to the sign-in: `removed` (local
  // secrets deleted, `revoked` when the provider confirmed the revocation
  // too), `shared` (another server still uses it), or none (null).
  const releaseOAuth = async (cfg) => {
    const url = oauthUrlOf(cfg);
    if (!url) return null;
    if (expandedConfigs(resolveConfiguredMcpCatalog().servers).some((other) => oauthUrlOf(other) === url)) {
      return { signIn: 'shared', revoked: false };
    }
    const { revoked = false } = (await clearMcpServerOAuth(cfg, { revoke: true })) || {};
    return { signIn: 'removed', revoked };
  };
  // An app password is deleted once no configured server uses its account.
  const forgetUnusedGmailAppPassword = async (account) => {
    if (!account) return false;
    const servers = expandedConfigs(resolveConfiguredMcpCatalog().servers);
    if (servers.some((cfg) => gmailAppPasswordAccount(cfg) === account)) return false;
    await gmailAppPassword.forget(account);
    return true;
  };
  // Peers reload config from disk on receipt: land the write before publishing.
  const persisted = async () => {
    await flushSkillsSave?.();
  };
  // A removed account keeps no sign-in another configured server or account
  // does not share: `{ signIn, revoked }` as removeMcpServer reports it.
  const releaseAccount = async (accountCfg) => {
    forgetConnectorAccountHealth(accountCfg.name);
    const address = gmailAppPasswordAccount(accountCfg);
    if (address) {
      const forgotten = await forgetUnusedGmailAppPassword(address);
      return { signIn: forgotten ? 'removed' : 'shared', revoked: false };
    }
    return releaseOAuth(accountCfg);
  };

  /** One more account of multi-account connector `connector` (one-account
   *  config `accountCfg` as normalized from `input`): into its server, or a
   *  new server named `name` holding it. The same Gmail address again takes
   *  the new app password. Resolves `{ name, account, status }`. */
  async function addConnectorAccount(servers, connector, name, accountCfg, input) {
    const serverName = connectorServerName(servers, connector);
    const address = gmailAppPasswordAccount(accountCfg);
    const cfg = serverName ? servers[serverName] : null;
    const same =
      cfg && address
        ? connectorAccountsOf(cfg).find((account) => gmailAppPasswordAccount(connectorAccountServer(cfg, account)) === address)
        : null;
    if (same) {
      await storeGmailAppPassword(input, accountCfg, true);
      const status = await sync.reconnectMcpAndAnnounce({ only: serverName, enabled: cfg.enabled !== false });
      return { name: serverName, account: same.name, status };
    }
    if (!serverName && (Object.hasOwn(servers, name) || pluginMcpServer(name) || accountTarget(servers, name))) {
      throw nameTakenError(servers, name);
    }
    const accountName = serverName ? freeName(servers, name) : name;
    const account = connectorAccountEntry(accountName, accountCfg);
    // Sign-in tokens are stored per exact URL: another account needs its own.
    const backendUrl = connectorById(connector)?.backend?.url;
    if (
      !address &&
      cfg &&
      connectorAccountServers(cfg).some((other) => oauthUrlOf(other) === oauthUrlOf({ type: 'http', url: account.url }))
    ) {
      account.url = `${backendUrl}?account=${encodeURIComponent(accountName)}`;
    }
    const storedCfg = connectorAccountServer({ connector }, account);
    await storeOAuthClientSecret(input, storedCfg);
    await storeGmailAppPassword(input, storedCfg, true);
    forgetConnectorAccountHealth(accountName);
    let target = serverName;
    if (cfg) {
      servers[serverName] = { ...cfg, accounts: [...connectorAccountsOf(cfg), account] };
    } else {
      // The server's own settings (timeouts, enabled) ride on the input.
      const { type: _type, url: _url, headers: _headers, oauthClientId: _client, ...rest } = accountCfg;
      target = name;
      servers[name] = { ...rest, type: 'http', url: connectorAccountsUrl(connector), connector, accounts: [account] };
    }
    saveServers(servers);
    const status = await sync.reconnectMcpAndAnnounce({ only: target, enabled: servers[target].enabled !== false });
    return { name: target, account: accountName, status };
  }

  /** An edit of one account (`target` from accountTarget): its transport,
   *  app password or own client, as an edit of its one-account server was. */
  async function saveConnectorAccount(servers, target, input) {
    const { serverName, cfg, account, accountCfg } = target;
    const { config } = normalizeMcpServerInput(mergedServerInput({ ...input, name: account.name }, accountCfg, account.name));
    const next = mergeMcpServerConfig(accountCfg, config);
    next.connector = cfg.connector;
    await storeOAuthClientSecret(input, next, accountCfg);
    await storeGmailAppPassword(input, next, false);
    // Settings that are not the account's transport (timeouts) are the server's.
    const { type: _type, url: _url, headers: _headers, oauthClientId: _client, ...serverFields } = config;
    const server = { ...cfg };
    for (const group of MCP_TIMEOUT_FIELD_GROUPS) {
      if (group.some((field) => Object.hasOwn(serverFields, field))) for (const field of group) delete server[field];
    }
    servers[serverName] = {
      ...server,
      ...serverFields,
      accounts: connectorAccountsOf(cfg).map((entry) =>
        entry.name === account.name ? connectorAccountEntry(account.name, next) : entry
      ),
    };
    saveServers(servers);
    forgetConnectorAccountHealth(account.name);
    const previousAddress = gmailAppPasswordAccount(accountCfg);
    const address = gmailAppPasswordAccount(next);
    if (previousAddress !== address) await forgetUnusedGmailAppPassword(previousAddress);
    // An account switched from the Google sign-in to an app password keeps no sign-in.
    if (address && !previousAddress) await releaseOAuth(accountCfg);
    const status = await sync.reconnectMcpAndAnnounce({ only: serverName, enabled: cfg.enabled !== false });
    return { name: serverName, account: account.name, source: 'config', status };
  }

  /** Whether `input` edits the server `target` belongs to rather than the
   *  account: the account carries the server's name and the input the
   *  server's own address (its config editor). */
  const editsServerItself = (target, input) => {
    if (target.serverName !== target.account.name || !clean(input.url)) return false;
    try {
      return oauthUrlOf({ type: input.type || 'http', url: input.url }) === oauthUrlOf(target.cfg);
    } catch {
      return false;
    }
  };

  return {
    /** One-time, idempotent: merge the one-account servers of a multi-account
     *  connector (`gmail`, `gmail-2`…) into one server holding the accounts
     *  (connector-catalog.mjs mergeConnectorAccountServers). Every account
     *  keeps its address, so its stored sign-in and app password stay as
     *  they are. Settings keyed by a merged-away server name go with it:
     *  scopes (`extensionScopes.mcp`) are dropped, on/off are the server's;
     *  per-agent / per-project connector settings and data-dir hooks move to
     *  the surviving server first (connector-merge-migration.mjs); a store
     *  that fails stays in a pending record that every start retries.
     *  Returns what was merged. */
    migrateConnectorAccounts() {
      const config = getConfig();
      const { servers, merged } = mergeConnectorAccountServers(mcpServersOf(config));
      // Also retries, without a merge, what an earlier start could not migrate.
      const settings = migrateMergedConnectorServers(deps.cfgMod?.getPluginData?.() || deps.STANDALONE_DATA_DIR, merged);
      if (!merged.length) return merged;
      // Neither migrated nor recorded for a retry: merging again next start is the retry.
      if (settings.unrecorded && settings.failed.length) return [];
      let next = { ...config, mcpServers: servers };
      const scoped = extensionScopesFromConfig(config).mcp;
      for (const { name, from } of merged) {
        for (const gone of from) if (gone !== name && Object.hasOwn(scoped, gone)) next = withExtensionScope(next, 'mcp', gone, null);
      }
      saveConfigAndAdopt(next);
      return merged;
    },
    /** One-time, idempotent: move server copies an earlier plugin enable wrote
     *  into `mcpServers` to per-server plugin intent. Returns adopted names. */
    migratePluginMcpCopies() {
      const { adoption } = resolveMcpCatalog();
      if (!adoption) return [];
      saveConfigAndAdopt(withAdoptedCopies(getConfig(), adoption));
      return adoption.removed;
    },
    mcpStatus() {
      return decorate.mcp(mcpStatus());
    },
    getMcpServerConfig(name) {
      return getMcpServerConfig(name);
    },
    async reconnectMcp(name) {
      await awaitKeychainPrewarm();
      reloadFullConfig();
      // An account reconnects with its server.
      const serverName = accountTarget(resolveMcpCatalog().servers, clean(name))?.serverName || clean(name);
      if (!serverName) return sync.reconnectMcpAndAnnounce();
      const { enabled } = getMcpServerConfig(serverName);
      return sync.reconnectMcpAndAnnounce({ only: serverName, enabled });
    },
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
            revoked = ((await clearMcpServerOAuth(accountCfg, { revoke: true })) || {}).revoked === true && revoked;
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
    async addMcpServer(input = {}) {
      const { name, config: serverConfig } = normalizeMcpServerInput(input);
      // A catalog connector's server keeps its catalog id (connector-catalog.mjs).
      const connector = clean(input.connector);
      if (connector) {
        if (!connectorById(connector)) throw new Error(`Unknown connector: ${connector}`);
        serverConfig.connector = connector;
      }
      const servers = userServers();
      // A multi-account connector's account (as its own server config) joins
      // that connector's one server.
      if (connector && connectorMultiAccount(connectorById(connector)) && !Array.isArray(input.accounts)) {
        return addConnectorAccount(servers, connector, name, serverConfig, input);
      }
      if (Object.hasOwn(servers, name) || accountTarget(servers, name)) {
        throw nameTakenError(servers, name);
      }
      const owned = pluginMcpServer(name);
      if (owned) throw new Error(`MCP server already exists: ${name} (provided by plugin "${owned.owner.id}")`);
      await storeOAuthClientSecret(input, serverConfig);
      await storeGmailAppPassword(input, serverConfig, true);
      saveServers({ ...servers, [name]: serverConfig });
      const status = await sync.reconnectMcpAndAnnounce({ only: name, enabled: serverConfig.enabled !== false });
      return { name, status };
    },
    async saveMcpServer(input = {}) {
      const servers = userServers();
      // A name of a multi-account connector's account edits that account.
      const accountOf = accountTarget(servers, clean(input.originalName) || clean(input.name));
      if (accountOf && !editsServerItself(accountOf, input)) return saveConnectorAccount(servers, accountOf, input);
      // An explicit originalName must exist; a bare name edits a matching
      // server and otherwise creates a new one. Plugin servers are never
      // edited, renamed or shadowed here.
      const explicitOriginal = clean(input.originalName);
      if (explicitOriginal && !Object.hasOwn(servers, explicitOriginal)) {
        refusePluginServer(explicitOriginal);
        throw new Error(`MCP server not configured: ${explicitOriginal}`);
      }
      const bareName = clean(input.name);
      if (!explicitOriginal && !Object.hasOwn(servers, bareName)) refusePluginServer(bareName);
      const originalName = explicitOriginal || (Object.hasOwn(servers, bareName) ? bareName : '');
      const existing = originalName ? servers[originalName] : {};
      const normalizedInput = normalizeMcpServerInput(mergedServerInput(input, existing, originalName));
      const name = originalName && clean(input.name) === originalName ? originalName : normalizedInput.name;
      if (
        name !== originalName &&
        (Object.hasOwn(servers, name) || pluginMcpServer(name) || accountTarget(servers, name))
      ) {
        throw nameTakenError(servers, name);
      }
      if (originalName && originalName !== name) delete servers[originalName];
      servers[name] = mergeMcpServerConfig(existing, normalizedInput.config);
      await storeOAuthClientSecret(input, servers[name], existing);
      await storeGmailAppPassword(input, servers[name], false);
      saveServers(servers);
      const previousAccount = gmailAppPasswordAccount(existing);
      const account = gmailAppPasswordAccount(servers[name]);
      if (previousAccount !== account) await forgetUnusedGmailAppPassword(previousAccount);
      // Gmail switched from the Google sign-in to an app password keeps no sign-in.
      if (account && !previousAccount) await releaseOAuth(existing);
      const status = await sync.reconnectMcpAndAnnounce({
        only: name,
        enabled: servers[name].enabled !== false,
        drop: originalName && originalName !== name ? [originalName] : [],
      });
      return { name, source: 'config', status };
    },
    async removeMcpServer(name) {
      const serverName = clean(name);
      if (!serverName) throw new Error('MCP server name is required');
      const servers = userServers();
      // A name of a multi-account connector's account removes that account;
      // the server goes with its last one.
      const target = accountTarget(servers, serverName);
      if (target) {
        const rest = connectorAccountsOf(target.cfg).filter((entry) => entry.name !== serverName);
        if (rest.length) servers[target.serverName] = { ...target.cfg, accounts: rest };
        else delete servers[target.serverName];
        saveServers(servers);
        const status = rest.length
          ? await sync.reconnectMcpAndAnnounce({ only: target.serverName, enabled: target.cfg.enabled !== false })
          : await sync.reconnectMcpAndAnnounce({ drop: [target.serverName] });
        const released = await releaseAccount(target.accountCfg);
        return released ? { ...status, ...released } : status;
      }
      if (!Object.hasOwn(servers, serverName)) {
        refusePluginServer(serverName);
        throw new Error(`MCP server not configured: ${serverName}`);
      }
      const removed = servers[serverName];
      delete servers[serverName];
      saveServers(servers);
      const status = await sync.reconnectMcpAndAnnounce({ drop: [serverName] });
      // The server of a multi-account connector takes every account's sign-in with it.
      const accountCfgs = connectorAccountServers(removed);
      if (accountCfgs.length) {
        const released = (await Promise.all(accountCfgs.map(releaseAccount))).filter(Boolean);
        if (!released.length) return status;
        return {
          ...status,
          signIn: released.every((one) => one.signIn === 'removed') ? 'removed' : 'shared',
          revoked: released.every((one) => one.revoked === true),
        };
      }
      // A removed server keeps no sign-in another server does not share: an
      // app password leaves the keychain (it is revoked at Google only).
      const account = gmailAppPasswordAccount(removed);
      if (account) {
        const forgotten = await forgetUnusedGmailAppPassword(account);
        return { ...status, signIn: forgotten ? 'removed' : 'shared', revoked: false };
      }
      const released = await releaseOAuth(removed);
      return released ? { ...status, ...released } : status;
    },
    async setMcpServerEnabled(name, enabled) {
      // The accounts of a multi-account connector are switched on and off with their server.
      const serverName = accountTarget(userServers(), clean(name))?.serverName || clean(name);
      if (!serverName) throw new Error('MCP server name is required');
      const want = enabled !== false;
      const owned = pluginMcpServer(serverName);
      if (owned) {
        // Server intent only: the effective state still requires the plugin.
        // Only a choice that differs from the declared default is stored.
        const { owner, pluginEnabled, declaredEnabled } = owned;
        saveConfigAndAdopt(
          withPluginServerIntent(adoptedConfig(), owner.id, owner.key, (intent) => ({
            ...intent,
            enabled: want === (declaredEnabled !== false) ? undefined : want,
          }))
        );
        await persisted();
        const effective = want && pluginEnabled;
        const status = await sync.scheduleMcpToggle(serverName, effective);
        await sync.publish('mcp', { mcpChanges: [{ name: serverName, enabled: effective }] });
        return status;
      }
      const shadowRow = mcpStatus().servers.find((s) => s.name === serverName);
      if (!shadowRow) throw new Error(`MCP server not configured: ${serverName}`);
      const servers = userServers();
      const current = servers[serverName];
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        throw new Error(`MCP server not configured: ${serverName}`);
      }
      servers[serverName] = { ...current, enabled: want };
      saveServers(servers);
      const status = await sync.scheduleMcpToggle(serverName, want);
      await sync.publish('mcp', { mcpChanges: [{ name: serverName, enabled: want }] });
      return status;
    },
    /** Kept for older callers: plugin servers appear on their own once the
     *  plugin is registered and enabled. This clears any per-server "off"
     *  intent of the plugin's servers and reconnects them (here and on peers);
     *  a disabled plugin stays disabled. */
    async enablePluginMcp(plugin = {}) {
      const registered = findRegisteredPlugin(pluginsStatus, plugin) || plugin;
      const id = clean(registered.id || registered.name);
      const catalog = resolveMcpCatalog();
      const row = catalog.plugins[id];
      if (!row) throw new Error(`plugin not registered: ${clean(plugin.id || plugin.name || plugin) || id}`);
      if (!row.servers.length) {
        const detail = row.errors.map((error) => error.message).join('; ');
        throw new Error(`plugin declares no MCP servers${detail ? `: ${detail}` : ''}`);
      }
      let next = withAdoptedCopies(getConfig(), catalog.adoption);
      for (const name of row.servers) {
        const { owner, declaredEnabled } = catalog.entries[name];
        next = withPluginServerIntent(next, id, owner.key, (intent) => ({
          ...intent,
          enabled: declaredEnabled === false ? true : undefined,
        }));
      }
      saveConfigAndAdopt(next);
      await persisted();
      const mcpChanges = row.servers.map((name) => ({ name, enabled: row.enabled }));
      let status;
      for (const change of mcpChanges)
        status = await connectConfiguredMcp({ only: change.name, enabled: change.enabled });
      await sync.announce('mcp', { detail: { mcpChanges } });
      return { serverName: row.servers[0], serverNames: row.servers, status };
    },
  };
}
