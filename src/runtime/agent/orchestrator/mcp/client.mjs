import { readFileSync, existsSync, mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { smartReadTruncate } from '../tools/builtin/read-formatting.mjs';
import { shutdownStdioChild, killStdioChildTreeFast } from './child-tree.mjs';
import { readServicePort, markServiceUnreachable, isConnRefuseError } from '../../../shared/service-discovery.mjs';
// --- Types ---
/** Known auto-detect targets: port file path relative to tmpdir.
 *  Note: `mixdog` used to self-loopback via active-instance.json's
 *  httpPort, but that path went through channels' owner HTTP server which
 *  only exposes a subset of tools. The plugin's own tools are now injected
 *  in-process through agent's toolExecutor (see orchestrator/internal-tools),
 *  so this registry is for genuinely external port-based MCP targets only. */
const AUTO_DETECT_PORTS = {
    'mixdog-memory': { discovery: 'memory', dir: 'mixdog', file: 'active-instance.json', portField: 'memory_port', endpoint: '/mcp' },
};
const DEFAULT_MCP_CALL_TIMEOUT_MS = 0;
// Per-server STARTUP handshake budget (connect + listTools). Codex parity: 10s.
export const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 10000;
// --- State ---
const servers = new Map();
let mcpSdkPromise = null;
// Memo for mcpToolHasField(name, field) — keyed by `${toolName}|${field}`.
// The lookup (regex parse + servers Map get + tools.find + schema property
// inspection) runs on every MCP tool invocation but its result only changes
// when the servers/tools registry is (re)built. Cleared at every registry
// mutation point (connectServer / disconnectAll) so a stale positive or
// negative can never survive a tools-list change.
const _mcpToolFieldMemo = new Map();
function _invalidateMcpToolFieldMemo() {
    _mcpToolFieldMemo.clear();
}
function mcpLog(line) {
    if (process.env.MIXDOG_QUIET_MCP_LOG) return;
    process.stderr.write(line);
}

async function loadMcpSdk() {
    mcpSdkPromise ??= Promise.all([
        import('@modelcontextprotocol/sdk/client/index.js'),
        import('@modelcontextprotocol/sdk/client/stdio.js'),
        import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
        import('@modelcontextprotocol/sdk/client/sse.js'),
        import('@modelcontextprotocol/sdk/client/websocket.js'),
    ]).then(([clientMod, stdioMod, httpMod, sseMod, wsMod]) => ({
        Client: clientMod.Client,
        StdioClientTransport: stdioMod.StdioClientTransport,
        StreamableHTTPClientTransport: httpMod.StreamableHTTPClientTransport,
        SSEClientTransport: sseMod.SSEClientTransport,
        WebSocketClientTransport: wsMod.WebSocketClientTransport,
    }));
    return mcpSdkPromise;
}
/**
 * Expand `${VAR}` and `${env:VAR}` references in string values using the
 * provided env map (defaults to process.env). Recurses into arrays/objects.
 * Unknown vars expand to an empty string. No shell execution.
 */
export function expandEnvVars(value, env = process.env) {
    if (typeof value === 'string') {
        return value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name) => {
            const v = env?.[name];
            return v == null ? '' : String(v);
        });
    }
    if (Array.isArray(value)) {
        return value.map((v) => expandEnvVars(v, env));
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = expandEnvVars(v, env);
        }
        return out;
    }
    return value;
}
/**
 * Resolve the canonical transport kind for an MCP server config entry.
 * Returns one of: 'autoDetect' | 'stdio' | 'http' | 'sse' | 'ws'.
 * Throws when no transport can be determined.
 */
export function resolveMcpTransportKind(cfg) {
    if (cfg?.autoDetect) return 'autoDetect';
    if (cfg?.type != null && cfg.type !== '') {
        let t = String(cfg.type).toLowerCase();
        if (t === 'streamable-http' || t === 'streamablehttp') t = 'http';
        if (t === 'stdio' || t === 'http' || t === 'sse' || t === 'ws') return t;
    }
    if (cfg?.transport === 'http') return 'http';
    if (cfg?.command) return 'stdio';
    if (cfg?.url) return 'http';
    throw new Error(`Invalid config: need autoDetect, type (stdio/http/sse/ws), url (http), or command (stdio)`);
}
// --- Public API ---
/**
 * Connect to MCP servers defined in config.
 * Supports stdio (child process) and http (Streamable HTTP) transports.
 */
export async function connectMcpServers(config) {
    // Capture the abort generation SYNCHRONOUSLY at entry: the boot path fires
    // this un-awaited, so a runtime close can land while connectServer is still
    // loading the SDK. A capture taken any later would already see the bumped
    // generation and register the server anyway (leaking its stdio child).
    const genAtStart = _connectAbortGeneration;
    const failures = [];
    const entries = Object.entries(config).filter(([name, cfg]) => {
        if (cfg?.enabled === false) {
            mcpLog(`[mcp-client] Skipping disabled server "${name}"\n`);
            return false;
        }
        return true;
    });
    // Connect all servers in PARALLEL: a slow/hung server (bounded by its
    // per-server startup timeout) must never delay the others' handshakes.
    const settled = await Promise.allSettled(
        entries.map(([name, cfg]) => connectServer(name, cfg, genAtStart)),
    );
    settled.forEach((res, i) => {
        if (res.status !== 'rejected') return;
        const [name] = entries[i];
        const msg = res.reason instanceof Error ? res.reason.message : String(res.reason);
        mcpLog(`[mcp-client] Failed to connect "${name}": ${msg}\n`);
        failures.push({ name, msg });
    });
    if (failures.length > 0) {
        const detail = failures.map(f => `${f.name}: ${f.msg}`).join('; ');
        const err = new Error(`[mcp-client] ${failures.length} MCP server(s) failed to connect — ${detail}`);
        err.failures = failures;
        throw err;
    }
}
/**
 * Get all tool definitions from connected MCP servers.
 * Tool names are prefixed: `mcp__{serverName}__{toolName}`
 */
export function getMcpTools() {
    const tools = [];
    for (const server of servers.values()) {
        tools.push(...server.tools);
    }
    return tools;
}
export function getMcpServerStatus() {
    return [...servers.values()].map((server) => ({
        name: server.name,
        connected: true,
        toolCount: Array.isArray(server.tools) ? server.tools.length : 0,
        tools: (server.tools || []).map((tool) => ({
            name: tool.name,
            description: tool.description || '',
        })),
        transport: (() => {
            try {
                return resolveMcpTransportKind(server.cfg);
            } catch {
                return 'stdio';
            }
        })(),
    }));
}

/** Snapshot of MCP initialize `instructions` per connected server (handshake time). */
export function getMcpServerInstructionsMap() {
    const out = {};
    for (const server of servers.values()) {
        const text = typeof server.instructions === 'string' ? server.instructions.trim() : '';
        if (text) out[server.name] = text;
    }
    return out;
}
/**
 * Execute an MCP tool call.
 * Name format: `mcp__{serverName}__{toolName}`
 */
export async function executeMcpTool(name, args) {
    // Parse: mcp__{server}__{tool}
    const match = name.match(/^mcp__(.+?)__(.+)$/);
    if (!match)
        throw new Error(`Not an MCP tool name: ${name}`);
    const [, serverName, toolName] = match;
    const server = servers.get(serverName);
    if (!server)
        throw new Error(`MCP server "${serverName}" not connected`);
    let result;
    try {
        result = await _callToolWithTimeout(server, toolName, args);
    } catch (firstErr) {
        const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
        if (isMcpToolCallTimeoutError(firstErr)) {
            mcpLog(`[mcp-client] Tool call timed out; skipping reconnect retry for "${serverName}/${toolName}".\n`);
            throw firstErr;
        }
        mcpLog(`[mcp-client] Tool call failed, attempting reconnect...\n`);
        await new Promise(r => setTimeout(r, 500));
        try {
            await _closeServer(server);
        } catch { /* ignore close error */ }
        try {
            await connectServer(serverName, server.cfg);
        } catch (reconnectErr) {
            const reconnectMsg = reconnectErr instanceof Error ? reconnectErr.message : String(reconnectErr);
            throw new Error(`Tool call failed: ${firstMsg}; reconnect also failed: ${reconnectMsg}`);
        }
        const retryServer = servers.get(serverName);
        if (!retryServer) {
            throw new Error(`Tool call failed: ${firstMsg}; reconnect succeeded but server "${serverName}" entry is missing from registry`);
        }
        try {
            result = await _callToolWithTimeout(retryServer, toolName, args);
        } catch (retryErr) {
            const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            throw new Error(`Tool call failed: ${firstMsg}; retry after reconnect also failed: ${retryMsg}`);
        }
    }
    const content = result.content;
    let text;
    if (Array.isArray(content)) {
        text = content
            .map((c) => (c.type === 'text' ? c.text || '' : JSON.stringify(c)))
            .join('\n');
    } else {
        text = typeof content === 'string' ? content : JSON.stringify(content);
    }
    return capMcpOutput(text);
}

// MCP per-tool-call timeout. Disabled by default: external MCP tools can be
// long-running, and replaying an arbitrary tool after a timeout can duplicate
// side effects. Operators may opt in with MIXDOG_MCP_CALL_TIMEOUT_MS or a
// per-server timeoutMs/callTimeoutMs config value. On expiry we close the
// transport so the next dispatch reconnects fresh, but we do not retry the
// timed-out call automatically.
export function resolveMcpCallTimeoutMs(cfg = {}, env = process.env) {
    const raw = cfg?.timeoutMs ?? cfg?.timeout_ms ?? cfg?.callTimeoutMs ?? cfg?.call_timeout_ms
        ?? env?.MIXDOG_MCP_CALL_TIMEOUT_MS;
    if (raw == null || raw === '' || raw === false) return DEFAULT_MCP_CALL_TIMEOUT_MS;
    if (typeof raw === 'string' && /^(0|off|none|false)$/i.test(raw.trim())) return 0;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MCP_CALL_TIMEOUT_MS;
    return Math.round(parsed);
}

export function isMcpToolCallTimeoutError(err) {
    return err?.code === 'EMCPTOOLTIMEOUT';
}

// MCP per-server STARTUP timeout: bounds the connect + listTools handshake so a
// slow or hung server can't stall boot or the first turn. Default 10s (codex
// parity). Per-server override: startupTimeoutMs / startupTimeoutSec. Global
// env: MIXDOG_MCP_STARTUP_TIMEOUT_MS. A value of 0/off/none/false disables it.
export function resolveMcpStartupTimeoutMs(cfg = {}, env = process.env) {
    const rawMs = cfg?.startupTimeoutMs ?? cfg?.startup_timeout_ms;
    const rawSec = cfg?.startupTimeoutSec ?? cfg?.startup_timeout_sec;
    const rawEnv = env?.MIXDOG_MCP_STARTUP_TIMEOUT_MS;
    let raw;
    let scale = 1;
    if (rawMs != null && rawMs !== '') raw = rawMs;
    else if (rawSec != null && rawSec !== '') { raw = rawSec; scale = 1000; }
    else if (rawEnv != null && rawEnv !== '') raw = rawEnv;
    else return DEFAULT_MCP_STARTUP_TIMEOUT_MS;
    if (raw === 0 || (typeof raw === 'string' && /^(0|off|none|false)$/i.test(raw.trim()))) return 0;
    const parsed = Number(raw) * scale;
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MCP_STARTUP_TIMEOUT_MS;
    return Math.round(parsed);
}

async function _callToolWithTimeout(server, toolName, args) {
    let timer;
    const timeoutMs = resolveMcpCallTimeoutMs(server?.cfg);
    if (!(timeoutMs > 0)) {
        return server.client.callTool({ name: toolName, arguments: args });
    }
    const timeout = new Promise((_, rej) => {
        timer = setTimeout(() => {
            // Route through the full tree-shutdown path so a timed-out stdio
            // server never orphans grandchildren. Fire-and-forget.
            try { _closeServer(server).catch(() => {}); } catch { /* ignore */ }
            const err = new Error(`MCP tool call timed out after ${timeoutMs}ms (server="${server.name}", tool="${toolName}")`);
            err.code = 'EMCPTOOLTIMEOUT';
            err.serverName = server.name;
            err.toolName = toolName;
            err.timeoutMs = timeoutMs;
            rej(err);
        }, timeoutMs);
        if (timer.unref) timer.unref();
    });
    try {
        return await Promise.race([
            server.client.callTool({ name: toolName, arguments: args }),
            timeout,
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function countTextLines(text) {
    const s = String(text ?? '');
    if (s.length === 0) return 0;
    let lines = 1;
    for (let i = 0; i < s.length; i += 1) {
        if (s.charCodeAt(i) === 10) lines += 1;
    }
    return lines;
}

function capMcpOutput(content) {
    const s = typeof content === 'string' ? content : String(content ?? '');
    const bodyBytes = Buffer.byteLength(s, 'utf8');
    const bodyLines = countTextLines(s);
    const { text, truncated } = smartReadTruncate(s, bodyLines, bodyBytes);
    if (!truncated) return text;
    // Spill the full body to a tmp file so the caller can recover content
    // elided by the head/tail cap (parity with the prior head-only spill).
    let spillPath = null;
    try {
        const dir = join(tmpdir(), 'mixdog-mcp-output');
        mkdirSync(dir, { recursive: true });
        spillPath = join(dir, `mcp-${Date.now()}-${randomUUID().slice(0, 8)}.txt`);
        // Fire-and-forget: the spill path is returned to the caller
        // immediately (below) for later recovery; the write itself must not
        // block this hot tool-result path.
        writeFile(spillPath, s, 'utf-8').catch(() => { /* spill best-effort */ });
    } catch { /* spill best-effort */ }
    const spillNote = spillPath
        ? `\n\n... [full output spilled to ${spillPath}] ...`
        : '';
    return `${text}${spillNote}`;
}
/**
 * Check if a tool name is an MCP tool.
 */
export function isMcpTool(name) {
    return name.startsWith('mcp__');
}
/** True when the prefixed name exists on a connected MCP server. */
export function isRegisteredMcpTool(name) {
    if (!isMcpTool(name)) return false;
    const match = name.match(/^mcp__(.+?)__(.+)$/);
    if (!match) return false;
    const [, serverName] = match;
    const server = servers.get(serverName);
    if (!server || !Array.isArray(server.tools)) return false;
    return server.tools.some((t) => t?.name === name);
}
/**
 * Check whether the inputSchema for an MCP tool declares the given top-level
 * property. Used to decide if the orchestrator should auto-inject context
 * (e.g. cwd) into the args before dispatch — schemas that don't declare the
 * field would reject the unknown argument.
 */
export function mcpToolHasField(name, field) {
    const memoKey = `${name}|${field}`;
    const memoized = _mcpToolFieldMemo.get(memoKey);
    if (memoized !== undefined) return memoized;
    const match = name.match(/^mcp__(.+?)__(.+)$/);
    if (!match) { _mcpToolFieldMemo.set(memoKey, false); return false; }
    const [, serverName] = match;
    const server = servers.get(serverName);
    if (!server) { _mcpToolFieldMemo.set(memoKey, false); return false; }
    const tool = server.tools.find((t) => t.name === name);
    if (!tool) { _mcpToolFieldMemo.set(memoKey, false); return false; }
    const props = tool.inputSchema?.properties;
    const result = Boolean(props && Object.prototype.hasOwnProperty.call(props, field));
    _mcpToolFieldMemo.set(memoKey, result);
    return result;
}
/**
 * Disconnect all MCP servers.
 */
export async function disconnectAll() {
    // Abort handshakes still in flight: bump the generation so a connect that
    // completes after this point tears itself down instead of registering, and
    // reap any already-spawned stdio child now so its ref'd ChildProcess handle
    // can't keep the event loop alive (close-during-connect previously leaked
    // the uvx/npx wrapper tree and hung process exit).
    _connectAbortGeneration++;
    for (const entry of [..._pendingConnects]) {
        _pendingConnects.delete(entry);
        // Mid-handshake child: nothing to shut down gracefully — hard-kill the
        // tree without holding the event loop (this path runs during process
        // exit; the spec-order grace dance would delay exit by seconds).
        try { killStdioChildTreeFast(entry.transport); }
        catch { /* ignore */ }
        try { void entry.client.close().catch(() => { /* ignore */ }); }
        catch { /* ignore */ }
    }
    for (const [name, server] of servers) {
        try {
            await _closeServer(server);
        }
        catch { /* ignore */ }
        servers.delete(name);
    }
    _invalidateMcpToolFieldMemo();
}
/**
 * Disconnect a single MCP server by name. No-op (returns false) when the
 * server is not in the live registry; otherwise closes its transport, removes
 * it, and invalidates the tool-field memo. Lets callers toggle one server
 * without a full disconnectAll()/reconnect cycle.
 */
export async function disconnectMcpServer(name) {
    const server = servers.get(name);
    if (!server) return false;
    try {
        await _closeServer(server);
    }
    catch { /* ignore */ }
    servers.delete(name);
    _invalidateMcpToolFieldMemo();
    return true;
}
/**
 * Close a single server: for stdio transports first shut down the full child
 * process tree (close stdin -> grace -> tree kill) so wrapper chains such as
 * uvx/npx/uv never orphan grandchildren, then release the SDK client. The
 * tree teardown runs before client.close() because the SDK's own close()
 * only kills the direct child and discards the pid we need to walk the tree.
 */
async function _closeServer(server) {
    const transport = server?.transport;
    // Live stdio transports expose the spawned ChildProcess on _process.
    if (transport && transport._process) {
        try { await shutdownStdioChild(transport); }
        catch { /* ignore */ }
    }
    try { await server.client.close(); }
    catch { /* ignore */ }
}
// Connects whose handshake has not finished yet: disconnectAll() must be able
// to see (and tear down) their transports, because `servers` only lists fully
// handshaken entries. Generation token aborts a connect that outlives a
// disconnectAll() issued mid-handshake (runtime close during boot connect).
let _connectAbortGeneration = 0;
const _pendingConnects = new Set();
async function connectServer(name, cfg, genAtStart = _connectAbortGeneration) {
    const {
        Client,
        StdioClientTransport,
        StreamableHTTPClientTransport,
        SSEClientTransport,
        WebSocketClientTransport,
    } = await loadMcpSdk();
    if (genAtStart !== _connectAbortGeneration) {
        // disconnectAll() ran while the SDK was loading: nothing spawned yet —
        // abort before creating a transport/child at all.
        throw new Error(`MCP server "${name}" connect aborted by shutdown`);
    }
    const client = new Client({ name: `mixdog-agent/${name}`, version: '1.0.0' });
    let transport;
    const kind = resolveMcpTransportKind(cfg);
    // When the autoDetect port comes from a discovery advert (not the legacy
    // port file), remember { service, port } so a connect/handshake failure can
    // distrust it — a pid-live advert can point at a recycled-pid corpse port,
    // and this transport has no other health probe of its own.
    let _autoDetectAdvert = null;
    // Auto-detect: read port from a running service's port file
    if (kind === 'autoDetect') {
        const spec = AUTO_DETECT_PORTS[cfg.autoDetect];
        if (!spec)
            throw new Error(`Unknown autoDetect target: "${cfg.autoDetect}"`);
        // Prefer the single-writer discovery advert (discovery/<service>.json),
        // pid-validated. Fall back to the legacy active-instance.json portField
        // when no live advert is present (cross-version compat).
        let port = spec.discovery ? readServicePort(spec.discovery, { requirePid: false }) : null;
        if (port && spec.discovery) _autoDetectAdvert = { service: spec.discovery, port };
        let portFile = null;
        if (!port) {
          portFile = spec.dir === 'mixdog' && process.env.MIXDOG_RUNTIME_ROOT
            ? join(process.env.MIXDOG_RUNTIME_ROOT, spec.file)
            : join(tmpdir(), spec.dir, spec.file);
          if (!existsSync(portFile)) {
            throw new Error(`autoDetect server "${name}": port file missing (${portFile})`);
          }
          const raw = readFileSync(portFile, 'utf-8').trim();
          if (spec.portField) {
            try {
                const json = JSON.parse(raw);
                const v = json[spec.portField];
                port = (typeof v === 'number' && Number.isFinite(v)) ? v : Number(v);
                if (!Number.isFinite(port)) {
                    throw new Error(`autoDetect server "${name}": portField "${spec.portField}" is not numeric in ${portFile}`);
                }
            } catch (jsonErr) {
                if (jsonErr instanceof Error && jsonErr.message.startsWith('autoDetect server')) throw jsonErr;
                throw new Error(`autoDetect server "${name}": invalid JSON in port file ${portFile}`);
            }
          }
          else {
            port = parseInt(raw, 10);
          }
        }
        if (!Number.isFinite(port) || port < 1 || port > 65535) {
            throw new Error(`autoDetect server "${name}": invalid port value${portFile ? ` in ${portFile}` : ''}`);
        }
        const url = `http://127.0.0.1:${port}${spec.endpoint}`;
        transport = new StreamableHTTPClientTransport(new URL(url));
        mcpLog(`[mcp-client] Connecting "${name}" via autoDetect HTTP: ${url}\n`);
    }
    else if (kind === 'http') {
        const url = expandEnvVars(String(cfg.url ?? ''));
        const headers = expandEnvVars(cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {});
        const opts = (headers && Object.keys(headers).length > 0)
            ? { requestInit: { headers } }
            : undefined;
        transport = opts
            ? new StreamableHTTPClientTransport(new URL(url), opts)
            : new StreamableHTTPClientTransport(new URL(url));
        mcpLog(`[mcp-client] Connecting "${name}" via HTTP: ${url}\n`);
    }
    else if (kind === 'sse') {
        const url = expandEnvVars(String(cfg.url ?? ''));
        const headers = expandEnvVars(cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {});
        const opts = (headers && Object.keys(headers).length > 0)
            ? { requestInit: { headers } }
            : undefined;
        transport = opts
            ? new SSEClientTransport(new URL(url), opts)
            : new SSEClientTransport(new URL(url));
        mcpLog(`[mcp-client] Connecting "${name}" via SSE: ${url}\n`);
    }
    else if (kind === 'ws') {
        // WebSocketClientTransport ctor takes only a URL; headers are ignored.
        const url = expandEnvVars(String(cfg.url ?? ''));
        transport = new WebSocketClientTransport(new URL(url));
        mcpLog(`[mcp-client] Connecting "${name}" via WebSocket: ${url}\n`);
    }
    else if (kind === 'stdio') {
        transport = new StdioClientTransport({
            command: expandEnvVars(String(cfg.command ?? '')),
            args: Array.isArray(cfg.args) ? expandEnvVars(cfg.args) : cfg.args,
            cwd: cfg.cwd,
            env: { ...process.env, ...expandEnvVars(cfg.env && typeof cfg.env === 'object' ? cfg.env : {}) },
            stderr: cfg.stderr ?? 'pipe',
        });
        transport.stderr?.on?.('data', (chunk) => {
            mcpLog(`[mcp:${name}:stderr] ${String(chunk)}`);
        });
    }
    else {
        throw new Error(`Invalid config for "${name}": need autoDetect, type (stdio/http/sse/ws), url (http), or command (stdio)`);
    }
    const pending = { name, client, transport };
    _pendingConnects.add(pending);
    try {
        // Bound the connect + listTools handshake so a slow/hung server can't
        // stall boot or the first turn. On expiry we tear down the pending
        // transport/child (nothing leaks) and fail this server like any other
        // connect failure — the parallel Promise.allSettled means other servers
        // are unaffected.
        const startupTimeoutMs = resolveMcpStartupTimeoutMs(cfg);
        let startupTimer = null;
        let startupTimedOut = false;
        const handshake = (async () => {
            await client.connect(transport);
            const instructionsRaw = typeof client.getInstructions === 'function'
                ? client.getInstructions()
                : undefined;
            const instr = typeof instructionsRaw === 'string' ? instructionsRaw.trim() : '';
            const result = await client.listTools();
            return { instructions: instr, toolsResult: result };
        })();
        let instructions;
        let toolsResult;
        try {
            if (startupTimeoutMs > 0) {
                const guard = new Promise((_, rej) => {
                    startupTimer = setTimeout(() => {
                        startupTimedOut = true;
                        const err = new Error(`MCP server "${name}" startup exceeded ${startupTimeoutMs}ms budget — raise per-server "startupTimeoutSec"/"startupTimeoutMs" or env MIXDOG_MCP_STARTUP_TIMEOUT_MS`);
                        err.code = 'EMCPSTARTUPTIMEOUT';
                        rej(err);
                    }, startupTimeoutMs);
                });
                ({ instructions, toolsResult } = await Promise.race([handshake, guard]));
            } else {
                ({ instructions, toolsResult } = await handshake);
            }
        } catch (err) {
            // A discovery-advert port that fails to connect is a corpse (recycled
            // pid): distrust it so the next connect falls back to the legacy port
            // file instead of re-trusting the same advert. Connection-level errors
            // ONLY — a startup/handshake timeout is a slow-but-alive server.
            if (_autoDetectAdvert && isConnRefuseError(err)) markServiceUnreachable(_autoDetectAdvert.service, _autoDetectAdvert.port);
            if (startupTimedOut) {
                // Tear down the pending transport/child so a hung handshake never
                // leaks a stdio process or socket — fire-and-forget (like the
                // tool-call timeout path) so a slow tree-kill never delays this
                // server's failure or the parallel batch's resolution.
                try { _closeServer({ client, transport }).catch(() => {}); }
                catch { /* ignore */ }
                // Never let the late handshake settle into an unhandled rejection.
                handshake.catch(() => {});
            }
            throw err;
        } finally {
            if (startupTimer) clearTimeout(startupTimer);
        }
        if (!toolsResult || !Array.isArray(toolsResult.tools)) {
            throw new Error(`[mcp-client] ListTools returned invalid shape for "${name}": missing or non-array tools field`);
        }
        if (genAtStart !== _connectAbortGeneration) {
            // disconnectAll() ran mid-handshake: never register — tear down.
            try { await _closeServer({ client, transport }); }
            catch { /* ignore */ }
            throw new Error(`MCP server "${name}" connect aborted by shutdown`);
        }
        const tools = toolsResult.tools.map((t) => ({
            name: `mcp__${name}__${t.name}`,
            description: t.description || '',
            inputSchema: (t.inputSchema || { type: 'object', properties: {} }),
            ...(t.annotations && typeof t.annotations === 'object' ? { annotations: t.annotations } : {}),
        }));
        const toolNames = tools.map(t => t.name);
        servers.set(name, { name, client, transport, tools, cfg, instructions });
        _invalidateMcpToolFieldMemo();
        mcpLog(`[mcp] connected: ${tools.length} tools — ${toolNames.join(', ')}\n`);
    }
    finally {
        _pendingConnects.delete(pending);
    }
}
