// MCP config/status/connect glue. Mutable runtime state is dependency-injected
// through accessors and the caller-owned `state` object.
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { clean } from './session-text.mjs';
import { envFlag } from './env.mjs';

export function createMcpGlue({
  mcpClient,
  getConfig,
  getCurrentCwd,
  getMcpScopeId = () => null,
  state,
}) {
  const scopeOptions = () => ({ scopeId: getMcpScopeId() });
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
    // MCP is machine-global. Project `.mcp.json` files and per-project
    // overrides are intentionally outside the runtime resolution chain.
    if (envFlag('MIXDOG_DISABLE_MCP')) return { servers: {}, sources: {} };
    const config = getConfig();
    const configured = config?.mcpServers && typeof config.mcpServers === 'object'
      ? config.mcpServers
      : {};
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
        status: cfg?.enabled === false ? 'disabled' : live ? 'connected' : fail ? 'failed' : 'disconnected',
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

  // Connect/disconnect exactly one server in the live registry, leaving all
  // others untouched. Used by the enable/disable toggle so a single-server
  // change never triggers a full disconnectAll()/reconnect freeze.
  async function applyMcpServerConnection(name, enabled) {
    const target = clean(name);
    if (!target) return;
    const { servers } = resolveEffectiveMcpServers();
    // Definitions stay in their original source. Enabled state is folded from
    // Mixdog's per-project override for both global and `.mcp.json` entries, so
    // acting on the effective entry keeps live state aligned without rewriting
    // a shared project file.
    // Changing this server's state clears any stale failure record for it.
    if (Array.isArray(state.mcpFailures)) {
      state.mcpFailures = state.mcpFailures.filter((row) => row.name !== target);
    }
    if (enabled === false) {
      await mcpClient.disconnectMcpServer?.(target, scopeOptions());
      return;
    }
    const cfg = servers[target];
    if (!cfg) return;
    // Drop any existing live entry first so connectMcpServers doesn't overwrite
    // the registry Map entry and leak the old transport/process.
    await mcpClient.disconnectMcpServer?.(target, scopeOptions());
    try {
      await mcpClient.connectMcpServers({ [target]: cfg }, scopeOptions());
    } catch (error) {
      const failures = Array.isArray(error?.failures)
        ? error.failures
        : [{ name: target, msg: error?.message || String(error) }];
      state.mcpFailures = [...(state.mcpFailures || []), ...failures];
    }
  }

  async function connectConfiguredMcp({ reset = false, only = null, enabled = true } = {}) {
    if (envFlag('MIXDOG_DISABLE_MCP')) {
      ++state.mcpConnectGeneration;
      state.mcpFailures = [];
      if (only) await mcpClient.disconnectMcpServer?.(only, scopeOptions());
      else await mcpClient.disconnectAll?.(scopeOptions());
      return mcpStatus();
    }
    // Scoped single-server toggle: non-superseding. It must NEVER cancel a
    // pending full {reset} (cwd-change/boot). So do not bump the generation;
    // just wait for any in-flight run, then bail if a newer full reset has
    // been requested in the meantime. Registering as in-flight makes a later
    // reset serialize behind us instead of interleaving disconnect/connect.
    if (only) {
      // Atomically capture the current generation AND the prior in-flight
      // promise in the same synchronous step, then chain our op onto it. No
      // await sits between the capture and the `state.mcpConnectInFlight = run`
      // assignment, so concurrent {only} calls queue FIFO instead of resuming
      // together and clobbering the in-flight slot. We never bump the
      // generation; a {reset} does, so any {only} queued behind a reset sees
      // the newer generation when its turn comes and bails.
      const gen = state.mcpConnectGeneration;
      const prev = state.mcpConnectInFlight;
      const run = (async () => {
        if (prev) { try { await prev; } catch { /* prior run's failures already captured */ } }
        if (gen !== state.mcpConnectGeneration) return;
        await applyMcpServerConnection(only, enabled);
      })();
      state.mcpConnectInFlight = run;
      try {
        await run;
      } finally {
        if (state.mcpConnectInFlight === run) state.mcpConnectInFlight = null;
      }
      return mcpStatus();
    }
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
      if (reset) await mcpClient.disconnectAll?.(scopeOptions());
      state.mcpFailures = [];
      const { servers } = resolveEffectiveMcpServers();
      if (Object.keys(servers).length === 0) return;
      try {
        await mcpClient.connectMcpServers(servers, scopeOptions());
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
    const coerceStringArray = (value) => Array.isArray(value)
      ? value.map((entry) => clean(entry)).filter(Boolean)
      : [];
    const withOptionalHeaders = (config) => {
      const headers = coerceStringRecord(input.headers);
      if (headers) config.headers = headers;
      const bearerTokenEnvVar = clean(input.bearer_token_env_var || input.bearerTokenEnvVar);
      if (bearerTokenEnvVar) config.bearer_token_env_var = bearerTokenEnvVar;
      const envHeaders = coerceStringRecord(input.env_http_headers || input.envHttpHeaders);
      if (envHeaders) config.env_http_headers = envHeaders;
      return config;
    };
    const url = clean(input.url);
    const type = clean(input.type).toLowerCase();
    if (url) {
      const secureUrl = (kind) => typeof mcpClient.normalizeMcpTransportUrl === 'function'
        ? mcpClient.normalizeMcpTransportUrl(url, kind)
        : url;
      if (type === 'sse') {
        return { name, config: withOptionalHeaders({ type: 'sse', url: secureUrl('sse') }) };
      }
      if (type === 'ws') {
        return { name, config: withOptionalHeaders({ type: 'ws', url: secureUrl('ws') }) };
      }
      if (type === 'http' || type === 'streamable-http') {
        return { name, config: withOptionalHeaders({ type: 'http', url: secureUrl('http') }) };
      }
      if (/^wss?:\/\//i.test(url)) {
        return { name, config: withOptionalHeaders({ type: 'ws', url: secureUrl('ws') }) };
      }
      return { name, config: withOptionalHeaders({ type: 'http', url: secureUrl('http') }) };
    }
    const command = clean(input.command);
    if (!command) throw new Error('MCP server command or URL is required');
    const args = Array.isArray(input.args)
      ? input.args.map((v) => String(v)).filter(Boolean)
      : clean(input.args).split(/\s+/).filter(Boolean);
    const requestedCwd = clean(input.cwd);
    const expandedCwd = requestedCwd.replace(/^~(?=$|[\\/])/, homedir());
    const resolvedCwd = expandedCwd ? resolve(currentCwd, expandedCwd) : '';
    const config = {
      type: 'stdio',
      command,
      args,
      ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
    };
    const env = coerceStringRecord(input.env);
    if (env) config.env = env;
    const envVars = coerceStringArray(input.env_vars || input.envVars);
    if (envVars.length > 0) config.env_vars = envVars;
    return { name, config };
  }

  // Turn gate: await the in-flight INITIAL connect, bounded by both the global
  // server startup budget and the caller's TTFT grace. A server still
  // connecting after the grace flows through the existing late-tool deferred
  // announcement path unchanged.
  async function awaitInitialMcpConnect(maxWaitMs = undefined) {
    const inFlight = state.mcpConnectInFlight;
    if (!inFlight) return;
    let budgetMs = 10000;
    try {
      const resolved = mcpClient.resolveMcpStartupTimeoutMs?.({});
      if (Number.isFinite(resolved)) budgetMs = resolved;
    } catch { /* fall back to default budget */ }
    if (maxWaitMs !== null && maxWaitMs !== undefined) {
      const requestedMaxWaitMs = Number(maxWaitMs);
      if (Number.isFinite(requestedMaxWaitMs) && requestedMaxWaitMs >= 0) {
        budgetMs = Math.min(budgetMs, requestedMaxWaitMs);
      }
    }
    // Swallow the in-flight rejection: failures are already captured in
    // state.mcpFailures, and this gate must never reject the turn.
    const settled = Promise.resolve(inFlight).catch(() => {});
    // Budget disabled (0/off) = no per-server startup timeout, so the connect
    // promise may never settle; never gate the turn on it — fall back to the
    // legacy fire-and-forget behavior (late servers use the deferred path).
    if (!(budgetMs > 0)) return;
    let timer = null;
    const budget = new Promise((resolveBudget) => { timer = setTimeout(resolveBudget, budgetMs); });
    try {
      await Promise.race([settled, budget]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    mcpTransportLabel,
    resolveEffectiveMcpServers,
    mcpStatus,
    getMcpServerConfig,
    connectConfiguredMcp,
    awaitInitialMcpConnect,
    normalizeMcpServerInput,
  };
}
