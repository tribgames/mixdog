import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { smartReadTruncate } from '../tools/builtin/read-formatting.mjs';
// --- Types ---
/** Known auto-detect targets: port file path relative to tmpdir.
 *  Note: `mixdog` used to self-loopback via active-instance.json's
 *  httpPort, but that path went through channels' owner HTTP server which
 *  only exposes a subset of tools. The plugin's own tools are now injected
 *  in-process through agent's toolExecutor (see orchestrator/internal-tools),
 *  so this registry is for genuinely external port-based MCP targets only. */
const AUTO_DETECT_PORTS = {
    'mixdog-memory': { dir: 'mixdog', file: 'active-instance.json', portField: 'memory_port', endpoint: '/mcp' },
};
const DEFAULT_MCP_CALL_TIMEOUT_MS = 0;
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
    ]).then(([clientMod, stdioMod, httpMod]) => ({
        Client: clientMod.Client,
        StdioClientTransport: stdioMod.StdioClientTransport,
        StreamableHTTPClientTransport: httpMod.StreamableHTTPClientTransport,
    }));
    return mcpSdkPromise;
}
// --- Public API ---
/**
 * Connect to MCP servers defined in config.
 * Supports stdio (child process) and http (Streamable HTTP) transports.
 */
export async function connectMcpServers(config) {
    const failures = [];
    for (const [name, cfg] of Object.entries(config)) {
        if (cfg?.enabled === false) {
            mcpLog(`[mcp-client] Skipping disabled server "${name}"\n`);
            continue;
        }
        try {
            await connectServer(name, cfg);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            mcpLog(`[mcp-client] Failed to connect "${name}": ${msg}\n`);
            failures.push({ name, msg });
        }
    }
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
        transport: server.cfg?.autoDetect
                ? 'autoDetect'
                : server.cfg?.transport === 'http' || server.cfg?.url
                    ? 'http'
                    : 'stdio',
    }));
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
            await server.client.close();
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

async function _callToolWithTimeout(server, toolName, args) {
    let timer;
    const timeoutMs = resolveMcpCallTimeoutMs(server?.cfg);
    if (!(timeoutMs > 0)) {
        return server.client.callTool({ name: toolName, arguments: args });
    }
    const timeout = new Promise((_, rej) => {
        timer = setTimeout(() => {
            try { server.client.close().catch(() => {}); } catch { /* ignore */ }
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
        writeFileSync(spillPath, s, 'utf-8');
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
export const drainMcpClients = disconnectAll;
export async function disconnectAll() {
    for (const [name, server] of servers) {
        try {
            await server.client.close();
        }
        catch { /* ignore */ }
        servers.delete(name);
    }
    _invalidateMcpToolFieldMemo();
}
/**
 * Load MCP server configs from a JSON file.
 * Supports both `{ mcpServers: { ... } }` and flat `{ name: { ... } }` format.
 */

async function connectServer(name, cfg) {
    const { Client, StdioClientTransport, StreamableHTTPClientTransport } = await loadMcpSdk();
    const client = new Client({ name: `mixdog-agent/${name}`, version: '1.0.0' });
    let transport;
    // Auto-detect: read port from a running service's port file
    if (cfg.autoDetect) {
        const spec = AUTO_DETECT_PORTS[cfg.autoDetect];
        if (!spec)
            throw new Error(`Unknown autoDetect target: "${cfg.autoDetect}"`);
        const portFile = spec.dir === 'mixdog' && process.env.MIXDOG_RUNTIME_ROOT
            ? join(process.env.MIXDOG_RUNTIME_ROOT, spec.file)
            : join(tmpdir(), spec.dir, spec.file);
        if (!existsSync(portFile)) {
            throw new Error(`autoDetect server "${name}": port file missing (${portFile})`);
        }
        let port;
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
        if (!Number.isFinite(port) || port < 1 || port > 65535) {
            throw new Error(`autoDetect server "${name}": invalid port value in ${portFile}`);
        }
        const url = `http://127.0.0.1:${port}${spec.endpoint}`;
        transport = new StreamableHTTPClientTransport(new URL(url));
        mcpLog(`[mcp-client] Connecting "${name}" via autoDetect HTTP: ${url}\n`);
    }
    else if (cfg.transport === 'http' && cfg.url) {
        transport = new StreamableHTTPClientTransport(new URL(cfg.url));
        mcpLog(`[mcp-client] Connecting "${name}" via HTTP: ${cfg.url}\n`);
    }
    else if (cfg.command) {
        transport = new StdioClientTransport({
            command: cfg.command,
            args: cfg.args,
            cwd: cfg.cwd,
            env: { ...process.env, ...cfg.env },
            stderr: cfg.stderr ?? 'pipe',
        });
        transport.stderr?.on?.('data', (chunk) => {
            mcpLog(`[mcp:${name}:stderr] ${String(chunk)}`);
        });
    }
    else {
        throw new Error(`Invalid config for "${name}": need autoDetect, url (http), or command (stdio)`);
    }
    await client.connect(transport);
    const toolsResult = await client.listTools();
    if (!toolsResult || !Array.isArray(toolsResult.tools)) {
        throw new Error(`[mcp-client] ListTools returned invalid shape for "${name}": missing or non-array tools field`);
    }
    const tools = toolsResult.tools.map((t) => ({
        name: `mcp__${name}__${t.name}`,
        description: t.description || '',
        inputSchema: (t.inputSchema || { type: 'object', properties: {} }),
        ...(t.annotations && typeof t.annotations === 'object' ? { annotations: t.annotations } : {}),
    }));
    const toolNames = tools.map(t => t.name);
    servers.set(name, { name, client, transport, tools, cfg });
    _invalidateMcpToolFieldMemo();
    mcpLog(`[mcp] connected: ${tools.length} tools — ${toolNames.join(', ')}\n`);
}
