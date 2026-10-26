// Pure reads of an `mcpServers` map shared by the MCP server API units
// (resource-mcp-api.mjs): OAuth URLs, multi-account connector account lookup,
// name refusals and the merge of a partial server edit.
import { clean } from '../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { MCP_TIMEOUT_FIELD_GROUPS } from '../runtime/agent/orchestrator/runtime-core/plugin-mcp.mjs';
import { resolveMcpOAuthUrl } from '../runtime/agent/orchestrator/mcp/client-config.mjs';
import {
  connectorAccountServer,
  connectorAccountsOf,
  connectorById,
  connectorOfServer,
} from '../runtime/shared/connector-catalog.mjs';

/** The URL a server's OAuth credentials are stored under, or null. */
export function oauthUrlOf(cfg) {
  try {
    return resolveMcpOAuthUrl(cfg);
  } catch {
    // No valid remote URL: such a server never logged in.
    return null;
  }
}

/** The `mcpServers` map of a config as a fresh object (never the live one). */
export function mcpServersOf(config) {
  return config.mcpServers && typeof config.mcpServers === 'object' ? { ...config.mcpServers } : {};
}

/** The multi-account connector account `name` names in `servers`:
 *  `{ serverName, cfg, account, accountCfg }`, or null. */
export function accountTarget(servers, name) {
  for (const [serverName, cfg] of Object.entries(servers || {})) {
    const account = connectorAccountsOf(cfg).find((entry) => entry.name === name);
    if (account) return { serverName, cfg, account, accountCfg: connectorAccountServer(cfg, account) };
  }
  return null;
}

/** The refusal of a new server name that is taken. A name a connector account
 *  holds is an account to the user (never a server), so it says so. */
export function nameTakenError(servers, name) {
  const holder = accountTarget(servers, name);
  const connector = holder && connectorById(connectorOfServer(holder.cfg));
  return new Error(
    connector
      ? `The name "${name}" is used by a ${connector.name} account. Choose another name.`
      : `MCP server already exists: ${name}`
  );
}

const transportType = (type) => (type === 'streamable-http' ? 'http' : type);

/** UI editors send complete transports; setup may send a partial patch. Merge
 *  the patch over the existing entry, keeping omitted fields (including
 *  credentials) unless the transport itself changed. */
export function mergedServerInput(input, existing, originalName) {
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
