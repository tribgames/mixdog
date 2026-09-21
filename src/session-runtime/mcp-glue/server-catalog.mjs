// Effective MCP server set and its status projection: config entries folded
// with plugin ownership, per-server config reads, and the live/failed rollup.
import { clean } from '../session-text.mjs';
import { envFlag } from '../../runtime/shared/env.mjs';

function mcpServerStatus(cfg, live, fail) {
  if (cfg?.enabled === false) return 'disabled';
  if (live) return 'connected';
  return fail ? 'failed' : 'disconnected';
}

export function createMcpServerCatalog({ mcpClient, getConfig, getMcpScopeId, state }) {
  function mcpTransportLabel(cfg = {}) {
    if (cfg.autoDetect) return `autoDetect:${cfg.autoDetect}`;
    try {
      return mcpClient.resolveMcpTransportKind(cfg);
    } catch {
      return 'unknown';
    }
  }

  function resolveEffectiveMcpServers() {
    // MCP is machine-global. Project `.mcp.json` files and per-project
    // overrides are intentionally outside the runtime resolution chain.
    if (envFlag('MIXDOG_DISABLE_MCP')) return { servers: {}, sources: {} };
    const config = getConfig();
    const configured = config?.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {};
    const servers = {};
    for (const [name, cfg] of Object.entries(configured)) {
      servers[name] = {
        ...cfg,
        ...(cfg?._mixdogPluginDisabled === true ? { enabled: false } : {}),
      };
    }
    // A plugin-owned server is installed by enablePluginMcp and carries the
    // plugin root in its env; it belongs to the plugin's own toggle and stays
    // out of the standalone MCP list.
    const sources = {};
    for (const [name, cfg] of Object.entries(configured)) {
      sources[name] = cfg?.env?.MIXDOG_PLUGIN_ROOT ? 'plugin' : 'config';
    }
    return { servers, sources };
  }

  function getMcpServerConfig(name) {
    const serverName = clean(name);
    if (!serverName) throw new Error('MCP server name is required');
    const { servers } = resolveEffectiveMcpServers();
    const effective = servers[serverName];
    if (!effective) throw new Error(`MCP server not configured: ${serverName}`);
    const raw = getConfig()?.mcpServers?.[serverName];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`MCP server config is unavailable: ${serverName}`);
    }
    return {
      name: serverName,
      source: raw?.env?.MIXDOG_PLUGIN_ROOT ? 'plugin' : 'config',
      enabled: effective.enabled !== false,
      config: { ...raw },
    };
  }

  function mcpStatus() {
    if (envFlag('MIXDOG_DISABLE_MCP')) {
      return { servers: [], configuredCount: 0, connectedCount: 0, failedCount: 0 };
    }
    const { servers: configured, sources } = resolveEffectiveMcpServers();
    const connected = new Map((mcpClient.getMcpServerStatus?.(getMcpScopeId()) || []).map((row) => [row.name, row]));
    const failures = new Map((state.mcpFailures || []).map((row) => [row.name, row]));
    const servers = [];
    for (const [name, cfg] of Object.entries(configured)) {
      const live = connected.get(name);
      const fail = failures.get(name);
      servers.push({
        name,
        configured: true,
        enabled: cfg?.enabled !== false,
        connected: Boolean(live),
        status: mcpServerStatus(cfg, live, fail),
        transport: mcpTransportLabel(cfg),
        toolCount: live?.toolCount || 0,
        tools: live?.tools || [],
        capabilities: live?.capabilities || { tools: false, prompts: false, resources: false },
        error: fail?.msg || null,
        source: sources[name] || 'config',
      });
      connected.delete(name);
    }
    for (const live of connected.values()) {
      servers.push({ ...live, configured: false, status: 'connected' });
    }
    servers.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return {
      servers,
      configuredCount: Object.keys(configured).length,
      connectedCount: servers.filter((row) => row.connected).length,
      failedCount: servers.filter((row) => row.status === 'failed').length,
    };
  }

  return { mcpTransportLabel, resolveEffectiveMcpServers, getMcpServerConfig, mcpStatus };
}
