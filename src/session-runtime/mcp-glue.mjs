// MCP config/status/connect glue, extracted from mixdog-session-runtime.mjs.
// Dependency-injected factory: all live state (config, currentCwd, connect
// generation/in-flight/failures) is threaded through accessors + a caller-owned
// `state` object so the facade's teardown/reconnect paths still observe it.
// Method behavior is byte-for-byte identical; only grouping changes.
import { resolve } from 'node:path';
import { statSync } from 'node:fs';
import { clean } from './session-text.mjs';
import { readProjectMcpServers } from './plugin-mcp.mjs';

// Cache project-local `.mcp.json` reads by path + mtime so repeated mcpStatus()
// calls skip existsSync+readFileSync+JSON.parse when the file is unchanged.
// Invalidated automatically on any mtime change (or create/delete via mtime=0).
const projectMcpCache = new Map();
const PROJECT_MCP_CACHE_MAX = 32;
function cachedProjectMcpServers(cwd) {
  const path = resolve(cwd || '.', '.mcp.json');
  let mtimeMs = 0;
  try { mtimeMs = statSync(path).mtimeMs; } catch { mtimeMs = 0; }
  const hit = projectMcpCache.get(path);
  if (hit && hit.mtimeMs === mtimeMs) return hit.value;
  const value = readProjectMcpServers(cwd);
  // Bound the cache: Map preserves insertion order, so drop the oldest entry.
  if (!projectMcpCache.has(path) && projectMcpCache.size >= PROJECT_MCP_CACHE_MAX) {
    projectMcpCache.delete(projectMcpCache.keys().next().value);
  }
  projectMcpCache.set(path, { mtimeMs, value });
  return value;
}

export function createMcpGlue({
  mcpClient,
  getConfig,
  getCurrentCwd,
  state,
}) {
  function mcpTransportLabel(cfg = {}) {
    if (cfg.autoDetect) return `autoDetect:${cfg.autoDetect}`;
    try {
      return mcpClient.resolveMcpTransportKind(cfg);
    } catch {
      return 'unknown';
    }
  }

  // Merge mixdog-config `agent.mcpServers` with project-local `.mcp.json`.
  // On name collision the project-local `.mcp.json` entry WINS
  // (precedence: project > user config). `sources[name]` records each server's
  // origin ('config' | 'project') for status reporting.
  function resolveEffectiveMcpServers() {
    const config = getConfig();
    const configured = config?.mcpServers && typeof config.mcpServers === 'object'
      ? config.mcpServers
      : {};
    const project = cachedProjectMcpServers(getCurrentCwd());
    const servers = { ...configured, ...project };
    const sources = {};
    for (const name of Object.keys(configured)) sources[name] = 'config';
    for (const name of Object.keys(project)) sources[name] = 'project';
    return { servers, sources };
  }

  function mcpStatus() {
    const { servers: configured, sources } = resolveEffectiveMcpServers();
    const connected = new Map((mcpClient.getMcpServerStatus?.() || []).map((row) => [row.name, row]));
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
        status: cfg?.enabled === false ? 'disabled' : live ? 'connected' : fail ? 'failed' : 'disconnected',
        transport: mcpTransportLabel(cfg),
        toolCount: live?.toolCount || 0,
        tools: live?.tools || [],
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

  async function connectConfiguredMcp({ reset = false } = {}) {
    // Serialize reconnects: boot connect, cwd-change reset, and rapid cwd
    // switches must never interleave their disconnect/connect phases, or an
    // older run finishing after a newer reset could re-add stale servers into
    // the shared client registry. Approach: a generation token + a single
    // in-flight promise. Each call bumps the generation, waits for any prior
    // run to finish, then bails if a newer call has superseded it — leaving the
    // latest requested effective-server-set in the registry.
    const gen = ++state.mcpConnectGeneration;
    if (state.mcpConnectInFlight) {
      try { await state.mcpConnectInFlight; } catch { /* prior run's failures already captured */ }
    }
    if (gen !== state.mcpConnectGeneration) return mcpStatus();
    const run = (async () => {
      if (reset) await mcpClient.disconnectAll?.();
      state.mcpFailures = [];
      const { servers } = resolveEffectiveMcpServers();
      if (Object.keys(servers).length === 0) return;
      try {
        await mcpClient.connectMcpServers(servers);
      } catch (error) {
        state.mcpFailures = Array.isArray(error?.failures)
          ? error.failures
          : [{ name: 'mcp', msg: error?.message || String(error) }];
      }
    })();
    state.mcpConnectInFlight = run;
    try {
      await run;
    } finally {
      if (state.mcpConnectInFlight === run) state.mcpConnectInFlight = null;
    }
    return mcpStatus();
  }

  function normalizeMcpServerInput(input = {}) {
    const currentCwd = getCurrentCwd();
    const name = clean(input.name).toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!name) throw new Error('MCP server name is required');
    const coerceStringRecord = (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const out = {};
      for (const [key, val] of Object.entries(value)) {
        if (val === undefined || val === null) continue;
        out[String(key)] = String(val);
      }
      return Object.keys(out).length > 0 ? out : null;
    };
    const withOptionalHeaders = (config) => {
      const headers = coerceStringRecord(input.headers);
      if (headers) config.headers = headers;
      return config;
    };
    const url = clean(input.url);
    const type = clean(input.type).toLowerCase();
    if (url) {
      if (type === 'sse') {
        if (!/^https?:\/\//i.test(url)) throw new Error('MCP URL must start with http:// or https://');
        return { name, config: withOptionalHeaders({ type: 'sse', url }) };
      }
      if (type === 'ws') {
        if (!/^(?:wss?|https?):\/\//i.test(url)) {
          throw new Error('MCP WebSocket URL must start with ws://, wss://, http://, or https://');
        }
        return { name, config: withOptionalHeaders({ type: 'ws', url }) };
      }
      if (type === 'http' || type === 'streamable-http') {
        if (!/^https?:\/\//i.test(url)) throw new Error('MCP URL must start with http:// or https://');
        return { name, config: withOptionalHeaders({ type: 'http', url }) };
      }
      if (/^wss?:\/\//i.test(url)) {
        return { name, config: withOptionalHeaders({ type: 'ws', url }) };
      }
      if (!/^https?:\/\//i.test(url)) throw new Error('MCP URL must start with http:// or https://');
      return { name, config: withOptionalHeaders({ type: 'http', url }) };
    }
    const command = clean(input.command);
    if (!command) throw new Error('MCP server command or URL is required');
    const args = Array.isArray(input.args)
      ? input.args.map((v) => String(v)).filter(Boolean)
      : clean(input.args).split(/\s+/).filter(Boolean);
    const requestedCwd = clean(input.cwd);
    const cwdForServer = requestedCwd ? resolve(currentCwd, requestedCwd) : currentCwd;
    const root = resolve(currentCwd);
    const resolvedCwd = resolve(cwdForServer);
    if (resolvedCwd !== root && !resolvedCwd.startsWith(`${root}\\`) && !resolvedCwd.startsWith(`${root}/`)) {
      throw new Error('MCP server cwd must stay under the current project');
    }
    const config = { type: 'stdio', command, args, cwd: resolvedCwd };
    const env = coerceStringRecord(input.env);
    if (env) config.env = env;
    return { name, config };
  }

  return {
    mcpTransportLabel,
    resolveEffectiveMcpServers,
    mcpStatus,
    connectConfiguredMcp,
    normalizeMcpServerInput,
  };
}
