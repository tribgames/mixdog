import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { smartReadTruncate } from '../tools/builtin/read-formatting.mjs';
import { shutdownStdioChild, killStdioChildTreeFast } from './child-tree.mjs';
import { makeToolEnvelope, normalizeToolEnvelope } from '../session/tool-envelope.mjs';
import { classifyResultKind } from '../session/result-classification.mjs';
import { createKeyedSingleflight } from './reconnect-singleflight.mjs';
import { createOwnerFairGate } from '../../../shared/owner-fair-gate.mjs';
import { currentToolExecutionOwner } from '../../../shared/tool-execution-owner.mjs';
import { positiveInt } from '../../../shared/numbers.mjs';
import { resolveMcpCallTimeoutMs, resolveMcpTransportKind, scrubMcpConnectionMessage } from './client-config.mjs';
import { createMcpTransport } from './client-transport.mjs';
import { runBoundedHandshake } from './client-handshake.mjs';

// Config interpretation (transport kind, URL policy, env expansion, headers,
// timeouts, log scrubbing) lives in client-config.mjs; re-exported so every
// existing importer resolves unchanged.
export {
  normalizeMcpTransportUrl,
  mcpUrlForLog,
  scrubMcpConnectionMessage,
  resolveMcpStdioEnvironment,
  resolveMcpHttpHeaders,
  resolveMcpTransportKind,
  resolveMcpStartupTimeoutMs,
} from './client-config.mjs';
// --- State ---
const servers = new Map();
const reconnects = createKeyedSingleflight();
const callAdmissions = new Map();
const DEFAULT_MCP_SCOPE_ID = 'global';
const _knownMcpScopes = new Set([DEFAULT_MCP_SCOPE_ID]);
const _connectAbortGenerations = new Map();
const _pendingConnects = new Set();
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
function normalizeMcpScopeId(value) {
  const raw = value && typeof value === 'object' ? value.scopeId : value;
  const scopeId = String(raw || '').trim();
  return scopeId || DEFAULT_MCP_SCOPE_ID;
}
function mcpServerRegistryKey(scopeId, name) {
  return `${normalizeMcpScopeId(scopeId)}\u0000${String(name || '')}`;
}
function scopedServer(scopeId, name) {
  return servers.get(mcpServerRegistryKey(scopeId, name));
}
function scopedServerEntries(scopeId) {
  const normalized = normalizeMcpScopeId(scopeId);
  return [...servers.entries()].filter(([, server]) => server?.scopeId === normalized);
}
function currentConnectAbortGeneration(scopeId) {
  return _connectAbortGenerations.get(normalizeMcpScopeId(scopeId)) || 0;
}
function bumpConnectAbortGeneration(scopeId) {
  const normalized = normalizeMcpScopeId(scopeId);
  const next = currentConnectAbortGeneration(normalized) + 1;
  _connectAbortGenerations.set(normalized, next);
  return next;
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
    import('@modelcontextprotocol/sdk/types.js'),
  ]).then(([clientMod, stdioMod, httpMod, sseMod, wsMod, typesMod]) => ({
    Client: clientMod.Client,
    StdioClientTransport: stdioMod.StdioClientTransport,
    StreamableHTTPClientTransport: httpMod.StreamableHTTPClientTransport,
    SSEClientTransport: sseMod.SSEClientTransport,
    WebSocketClientTransport: wsMod.WebSocketClientTransport,
    ListRootsRequestSchema: typesMod.ListRootsRequestSchema,
    ToolListChangedNotificationSchema: typesMod.ToolListChangedNotificationSchema,
  }));
  return mcpSdkPromise;
}
// --- Public API ---
/**
 * Connect to MCP servers defined in config.
 * Supports stdio (child process) and http (Streamable HTTP) transports.
 */
export async function connectMcpServers(config, options = {}) {
  const scopeId = normalizeMcpScopeId(options);
  _knownMcpScopes.add(scopeId);
  // Capture the abort generation SYNCHRONOUSLY at entry: the boot path fires
  // this un-awaited, so a runtime close can land while connectServer is still
  // loading the SDK. A capture taken any later would already see the bumped
  // generation and register the server anyway (leaking its stdio child).
  const genAtStart = currentConnectAbortGeneration(scopeId);
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
  const settled = await Promise.allSettled(entries.map(([name, cfg]) => connectServer(name, cfg, scopeId, genAtStart)));
  settled.forEach((res, i) => {
    if (res.status !== 'rejected') return;
    const [name, cfg] = entries[i];
    const rawMessage = res.reason instanceof Error ? res.reason.message : String(res.reason);
    const msg = scrubMcpConnectionMessage(rawMessage, cfg);
    mcpLog(`[mcp-client] Failed to connect "${name}": ${msg}\n`);
    failures.push({ name, msg });
  });
  if (failures.length > 0) {
    const detail = failures.map((f) => `${f.name}: ${f.msg}`).join('; ');
    const err = new Error(`[mcp-client] ${failures.length} MCP server(s) failed to connect — ${detail}`);
    err.failures = failures;
    throw err;
  }
}
/**
 * Get all tool definitions from connected MCP servers.
 * Tool names are prefixed: `mcp__{serverName}__{toolName}`
 */
export function getMcpTools(scopeId = DEFAULT_MCP_SCOPE_ID) {
  const tools = [];
  for (const [, server] of scopedServerEntries(scopeId)) {
    tools.push(...server.tools);
  }
  return tools;
}

function mcpFeatureTools(serverName, capabilities, protocolTools) {
  const tools = [];
  const used = new Set(protocolTools.map((tool) => tool.name));
  const add = (leaf, description, properties, required, operation) => {
    let name = `mcp__${serverName}__${leaf}`;
    while (used.has(name)) name += '_';
    used.add(name);
    tools.push({
      name,
      description,
      inputSchema: {
        type: 'object',
        properties,
        ...(required?.length ? { required } : {}),
        additionalProperties: false,
      },
      mcpOperation: operation,
    });
  };
  if (capabilities?.resources) {
    add(
      'mixdog_list_resources',
      'List resources exposed by this MCP server.',
      { cursor: { type: 'string', description: 'Pagination cursor from a previous result.' } },
      [],
      'list-resources'
    );
    add(
      'mixdog_list_resource_templates',
      'List resource URI templates exposed by this MCP server.',
      { cursor: { type: 'string', description: 'Pagination cursor from a previous result.' } },
      [],
      'list-resource-templates'
    );
    add(
      'mixdog_read_resource',
      'Read one resource exposed by this MCP server.',
      { uri: { type: 'string', description: 'Resource URI returned by the server.' } },
      ['uri'],
      'read-resource'
    );
  }
  if (capabilities?.prompts) {
    add(
      'mixdog_list_prompts',
      'List reusable prompts exposed by this MCP server.',
      { cursor: { type: 'string', description: 'Pagination cursor from a previous result.' } },
      [],
      'list-prompts'
    );
    add(
      'mixdog_get_prompt',
      'Render one reusable prompt exposed by this MCP server.',
      {
        name: { type: 'string', description: 'Prompt name returned by the server.' },
        arguments: {
          type: 'object',
          description: 'Prompt argument values.',
          additionalProperties: { type: 'string' },
        },
      },
      ['name'],
      'get-prompt'
    );
  }
  return tools;
}
export function getMcpServerStatus(scopeId = DEFAULT_MCP_SCOPE_ID) {
  return scopedServerEntries(scopeId).map(([, server]) => ({
    name: server.name,
    connected: true,
    toolCount: Array.isArray(server.tools) ? server.tools.length : 0,
    tools: (server.tools || []).map((tool) => ({
      name: tool.name,
      description: tool.description || '',
    })),
    capabilities: {
      tools: Boolean(server.capabilities?.tools),
      prompts: Boolean(server.capabilities?.prompts),
      resources: Boolean(server.capabilities?.resources),
    },
    transport: (() => {
      try {
        return resolveMcpTransportKind(server.cfg);
      } catch {
        return 'stdio';
      }
    })(),
  }));
}

function callAdmissionFor(server) {
  const registryKey = server.registryKey || mcpServerRegistryKey(server.scopeId, server.name);
  let gate = callAdmissions.get(registryKey);
  if (gate) return gate;
  const cfg = server?.cfg || {};
  gate = createOwnerFairGate({
    name: `MCP ${server.name}`,
    activeMax: positiveInt(cfg.maxConcurrency ?? cfg.max_concurrency ?? process.env.MIXDOG_MCP_MAX_INFLIGHT, 8),
    queueMax: positiveInt(cfg.maxQueue ?? cfg.max_queue ?? process.env.MIXDOG_MCP_MAX_QUEUE, 256),
    minOwnerQueue: 8,
    waitTimeoutMs: positiveInt(
      cfg.waitTimeoutMs ?? cfg.wait_timeout_ms ?? process.env.MIXDOG_MCP_WAIT_TIMEOUT_MS,
      30_000
    ),
  });
  gate.mcpServerName = server.name;
  gate.mcpScopeId = server.scopeId;
  callAdmissions.set(registryKey, gate);
  return gate;
}
function closeCallAdmission(scopeId, name, reason) {
  const registryKey = mcpServerRegistryKey(scopeId, name);
  const gate = callAdmissions.get(registryKey);
  if (!gate) return;
  callAdmissions.delete(registryKey);
  gate.close(reason || `MCP ${name} disconnected`);
}
export function getMcpAdmissionSnapshot(options = undefined) {
  const scoped = options !== undefined;
  const scopeId = scoped ? normalizeMcpScopeId(options) : null;
  return [...callAdmissions.values()]
    .filter((gate) => !scoped || gate.mcpScopeId === scopeId)
    .map((gate) => ({
      name: gate.mcpServerName,
      scopeId: gate.mcpScopeId,
      ...gate.snapshot(),
    }));
}

/** Snapshot of MCP initialize `instructions` per connected server (handshake time). */
export function getMcpServerInstructionsMap(scopeId = DEFAULT_MCP_SCOPE_ID) {
  const out = {};
  for (const [, server] of scopedServerEntries(scopeId)) {
    const text = typeof server.instructions === 'string' ? server.instructions.trim() : '';
    if (text) out[server.name] = text;
  }
  return out;
}

async function reconnectMcpServer(scopeId, serverName, failedServer) {
  const registryKey = mcpServerRegistryKey(scopeId, serverName);
  return reconnects.run(registryKey, async () => {
    const current = servers.get(registryKey);
    // A peer already completed the replacement while this failed call was
    // unwinding. Reuse it immediately instead of closing a fresh transport.
    if (current && current !== failedServer) return current;
    if (current) {
      await _closeServer(current);
      if (servers.get(registryKey) === current) servers.delete(registryKey);
    }
    try {
      await connectServer(serverName, failedServer.cfg, scopeId);
    } catch (reason) {
      const rawMessage = reason instanceof Error ? reason.message : String(reason);
      throw new Error(scrubMcpConnectionMessage(rawMessage, failedServer.cfg));
    }
    const replacement = servers.get(registryKey);
    if (!replacement) {
      throw new Error(`reconnect succeeded but server "${serverName}" entry is missing from registry`);
    }
    return replacement;
  });
}

/**
 * Execute an MCP tool call.
 * Name format: `mcp__{serverName}__{toolName}`
 */
export async function executeMcpTool(name, args, options = {}) {
  // Parse: mcp__{server}__{tool}
  const match = name.match(/^mcp__(.+?)__(.+)$/);
  if (!match) throw new Error(`Not an MCP tool name: ${name}`);
  const [, serverName, toolName] = match;
  const scopeId = normalizeMcpScopeId(options);
  const server = scopedServer(scopeId, serverName);
  if (!server) throw new Error(`MCP server "${serverName}" not connected`);
  const definition = (server.tools || []).find((tool) => tool.name === name);
  const dispatch = (target) =>
    definition?.mcpOperation
      ? _callMcpFeatureWithTimeout(target, definition.mcpOperation, args, callSignal)
      : _callToolWithTimeout(target, toolName, args, callSignal);
  const gate = callAdmissionFor(server);
  const callSignal = options?.signal || null;
  return gate.run(
    options?.ownerKey || currentToolExecutionOwner(),
    async () => {
      // The gate stops forwarding the caller's abort once this task is
      // admitted, so the task itself observes the signal for its whole run.
      if (callSignal?.aborted) {
        throw mcpAbortError(
          callSignal,
          `MCP tool call aborted before dispatch (server="${serverName}", tool="${toolName}")`
        );
      }
      let result;
      try {
        result = await dispatch(server);
      } catch (firstErr) {
        const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
        if (isMcpCallAbortError(firstErr) || callSignal?.aborted) {
          // A cancelled call is not a transport failure: reconnecting and
          // replaying it would duplicate the side effect the caller just
          // walked away from.
          mcpLog(`[mcp-client] Tool call aborted by caller for "${serverName}/${toolName}".\n`);
          throw firstErr;
        }
        if (isMcpToolCallTimeoutError(firstErr)) {
          mcpLog(`[mcp-client] Tool call timed out; skipping reconnect retry for "${serverName}/${toolName}".\n`);
          throw firstErr;
        }
        mcpLog(`[mcp-client] Tool call failed, attempting shared reconnect...\n`);
        let retryServer;
        try {
          // The reconnect is SHARED (singleflight): the race only stops
          // THIS caller from waiting on it — the reconnect keeps running
          // for its other waiters. Without this, an abort mid-reconnect
          // could not settle the call and the admission slot stayed held
          // until the reconnect finished, or forever if it hung.
          retryServer = await raceMcpAbort(
            reconnectMcpServer(scopeId, serverName, server),
            callSignal,
            `MCP tool call aborted during reconnect (server="${serverName}", tool="${toolName}")`
          );
        } catch (reconnectErr) {
          if (isMcpCallAbortError(reconnectErr) || callSignal?.aborted) throw reconnectErr;
          const reconnectMsg = reconnectErr instanceof Error ? reconnectErr.message : String(reconnectErr);
          throw new Error(`Tool call failed: ${firstMsg}; reconnect also failed: ${reconnectMsg}`);
        }
        // A reconnect that outlived the caller's abort must not dispatch the
        // retry: that would run the side effect after cancellation.
        if (callSignal?.aborted) {
          throw mcpAbortError(
            callSignal,
            `MCP tool call aborted after reconnect (server="${serverName}", tool="${toolName}")`
          );
        }
        try {
          result = await dispatch(retryServer);
        } catch (retryErr) {
          if (isMcpCallAbortError(retryErr) || callSignal?.aborted) throw retryErr;
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          throw new Error(`Tool call failed: ${firstMsg}; retry after reconnect also failed: ${retryMsg}`);
        }
      }
      const normalized = normalizeToolEnvelope(normalizeMcpToolResult(result));
      const text = capMcpOutput(normalized.result);
      return normalized.explicitSuccess ? makeToolEnvelope(text, [], { explicitSuccess: true }) : text;
    },
    {
      signal: callSignal,
    }
  );
}

async function _callMcpFeatureWithTimeout(server, operation, args, signal = null) {
  const requestOptions = signal ? { signal } : undefined;
  const cursor = typeof args?.cursor === 'string' && args.cursor ? { cursor: args.cursor } : {};
  let request;
  if (operation === 'list-resources') {
    request = server.client.listResources(cursor, requestOptions);
  } else if (operation === 'list-resource-templates') {
    request = server.client.listResourceTemplates(cursor, requestOptions);
  } else if (operation === 'read-resource') {
    request = server.client.readResource({ uri: String(args?.uri || '') }, requestOptions);
  } else if (operation === 'list-prompts') {
    request = server.client.listPrompts(cursor, requestOptions);
  } else if (operation === 'get-prompt') {
    request = server.client.getPrompt(
      {
        name: String(args?.name || ''),
        arguments:
          args?.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments) ? args.arguments : {},
      },
      requestOptions
    );
  } else {
    throw new Error(`Unsupported MCP feature operation: ${operation}`);
  }
  let timer;
  const timeoutMs = resolveMcpCallTimeoutMs(server?.cfg);
  const abortMessage = `MCP feature call aborted (server="${server?.name}", operation="${operation}")`;
  const bounded =
    timeoutMs > 0
      ? Promise.race([
          request,
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              try {
                _closeServer(server).catch(() => {});
              } catch {
                /* ignore */
              }
              const error = new Error(
                `MCP feature call timed out after ${timeoutMs}ms (server="${server.name}", operation="${operation}")`
              );
              error.code = 'EMCPTOOLTIMEOUT';
              reject(error);
            }, timeoutMs);
            if (timer.unref) timer.unref();
          }),
        ])
      : request;
  try {
    const result = await raceMcpAbort(bounded, signal, abortMessage);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      isError: false,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Preserve MCP failure metadata across the object→string boundary. The
// session loop classifies the canonical Error: prefix as toolKind:error.
function normalizeMcpToolResult(result) {
  const content = result.content;
  let text;
  if (Array.isArray(content)) {
    text = content.map((c) => (c.type === 'text' ? c.text || '' : JSON.stringify(c))).join('\n');
  } else {
    text = typeof content === 'string' ? content : JSON.stringify(content);
  }
  if (result.isError === true) return !text.startsWith('Error:') ? `Error: ${text}` : text;
  if (result.isError === false && classifyResultKind(text) === 'error') {
    return makeToolEnvelope(text, [], { explicitSuccess: true });
  }
  return text;
}

function isMcpToolCallTimeoutError(err) {
  return err?.code === 'EMCPTOOLTIMEOUT';
}

// Caller-driven cancellation (hook timeout, aborted turn, closed pane).
// Admission alone is not cancellation: an admitted call that ignores the
// caller's signal keeps its concurrency slot until the SERVER timeout, which an
// operator may have disabled entirely.
function mcpAbortError(signal, message) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(reason ? String(reason) : message);
  error.code = 'EMCPCALLABORTED';
  return error;
}

function isMcpCallAbortError(err) {
  return err?.code === 'EMCPCALLABORTED' || err?.name === 'AbortError';
}

/** Settle as soon as `signal` aborts. Promise.race keeps a later rejection of
 *  `promise` handled, so the abandoned call cannot surface as an unhandled
 *  rejection. */
function raceMcpAbort(promise, signal, message) {
  if (!signal) return promise;
  if (signal.aborted) {
    void Promise.resolve(promise).catch(() => {});
    return Promise.reject(mcpAbortError(signal, message));
  }
  let onAbort = null;
  const aborted = new Promise((_resolve, reject) => {
    onAbort = () => reject(mcpAbortError(signal, message));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => {
    if (onAbort) {
      try {
        signal.removeEventListener('abort', onAbort);
      } catch {
        /* already detached */
      }
    }
  });
}

async function _callToolWithTimeout(server, toolName, args, signal = null) {
  let timer;
  const timeoutMs = resolveMcpCallTimeoutMs(server?.cfg);
  // The signal goes INTO the SDK request: an aborted caller cancels the live
  // JSON-RPC request (notifications/cancelled) instead of merely walking away
  // from it. The race below additionally frees the admission slot at once.
  const requestOptions = signal ? { signal } : undefined;
  const abortMessage = `MCP tool call aborted (server="${server?.name}", tool="${toolName}")`;
  if (!(timeoutMs > 0)) {
    // Server timeout disabled: the caller's signal is then the ONLY bound.
    return raceMcpAbort(
      server.client.callTool({ name: toolName, arguments: args }, undefined, requestOptions),
      signal,
      abortMessage
    );
  }
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => {
      // Route through the full tree-shutdown path so a timed-out stdio
      // server never orphans grandchildren. Fire-and-forget.
      try {
        _closeServer(server).catch(() => {});
      } catch {
        /* ignore */
      }
      const err = new Error(
        `MCP tool call timed out after ${timeoutMs}ms (server="${server.name}", tool="${toolName}")`
      );
      err.code = 'EMCPTOOLTIMEOUT';
      err.serverName = server.name;
      err.toolName = toolName;
      err.timeoutMs = timeoutMs;
      rej(err);
    }, timeoutMs);
    if (timer.unref) timer.unref();
  });
  try {
    return await raceMcpAbort(
      Promise.race([server.client.callTool({ name: toolName, arguments: args }, undefined, requestOptions), timeout]),
      signal,
      abortMessage
    );
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
    writeFile(spillPath, s, 'utf-8').catch(() => {
      /* spill best-effort */
    });
  } catch {
    /* spill best-effort */
  }
  const spillNote = spillPath ? `\n\n... [full output spilled to ${spillPath}] ...` : '';
  return `${text}${spillNote}`;
}
/**
 * Check if a tool name is an MCP tool.
 */
export function isMcpTool(name) {
  return name.startsWith('mcp__');
}
/** True when the prefixed name exists on a connected MCP server. */
export function isRegisteredMcpTool(name, scopeId = DEFAULT_MCP_SCOPE_ID) {
  if (!isMcpTool(name)) return false;
  const match = name.match(/^mcp__(.+?)__(.+)$/);
  if (!match) return false;
  const [, serverName] = match;
  const server = scopedServer(scopeId, serverName);
  if (!server || !Array.isArray(server.tools)) return false;
  return server.tools.some((t) => t?.name === name);
}
/**
 * Check whether the inputSchema for an MCP tool declares the given top-level
 * property. Used to decide if the orchestrator should auto-inject context
 * (e.g. cwd) into the args before dispatch — schemas that don't declare the
 * field would reject the unknown argument.
 */
export function mcpToolHasField(name, field, scopeId = DEFAULT_MCP_SCOPE_ID) {
  const normalizedScopeId = normalizeMcpScopeId(scopeId);
  const memoKey = `${normalizedScopeId}|${name}|${field}`;
  const memoized = _mcpToolFieldMemo.get(memoKey);
  if (memoized !== undefined) return memoized;
  const match = name.match(/^mcp__(.+?)__(.+)$/);
  if (!match) {
    _mcpToolFieldMemo.set(memoKey, false);
    return false;
  }
  const [, serverName] = match;
  const server = scopedServer(normalizedScopeId, serverName);
  if (!server) {
    _mcpToolFieldMemo.set(memoKey, false);
    return false;
  }
  const tool = server.tools.find((t) => t.name === name);
  if (!tool) {
    _mcpToolFieldMemo.set(memoKey, false);
    return false;
  }
  const props = tool.inputSchema?.properties;
  const result = Boolean(props && Object.hasOwn(props, field));
  _mcpToolFieldMemo.set(memoKey, result);
  return result;
}
/**
 * Disconnect all MCP servers.
 */
export async function disconnectAll(options = undefined) {
  const hasExplicitScope = options && typeof options === 'object' && Object.hasOwn(options, 'scopeId');
  const scopes = hasExplicitScope
    ? new Set([normalizeMcpScopeId(options)])
    : new Set([
        ..._knownMcpScopes,
        ...[...servers.values()].map((server) => server.scopeId),
        ...[..._pendingConnects].map((entry) => entry.scopeId),
      ]);
  // Abort handshakes still in flight: bump the generation so a connect that
  // completes after this point tears itself down instead of registering, and
  // reap any already-spawned stdio child now so its ref'd ChildProcess handle
  // can't keep the event loop alive (close-during-connect previously leaked
  // the uvx/npx wrapper tree and hung process exit).
  for (const scopeId of scopes) bumpConnectAbortGeneration(scopeId);
  for (const entry of [..._pendingConnects]) {
    if (!scopes.has(entry.scopeId)) continue;
    _pendingConnects.delete(entry);
    // Mid-handshake child: nothing to shut down gracefully — hard-kill the
    // tree without holding the event loop (this path runs during process
    // exit; the spec-order grace dance would delay exit by seconds).
    try {
      killStdioChildTreeFast(entry.transport);
    } catch {
      /* ignore */
    }
    try {
      void entry.client.close().catch(() => {
        /* ignore */
      });
    } catch {
      /* ignore */
    }
  }
  for (const [registryKey, server] of [...servers]) {
    if (!scopes.has(server.scopeId)) continue;
    try {
      await _closeServer(server);
    } catch {
      /* ignore */
    }
    servers.delete(registryKey);
    closeCallAdmission(server.scopeId, server.name, `MCP ${server.name} disconnected`);
  }
  _invalidateMcpToolFieldMemo();
}
/**
 * Disconnect a single MCP server by name. No-op (returns false) when the
 * server is not in the live registry; otherwise closes its transport, removes
 * it, and invalidates the tool-field memo. Lets callers toggle one server
 * without a full disconnectAll()/reconnect cycle.
 */
export async function disconnectMcpServer(name, options = {}) {
  const scopeId = normalizeMcpScopeId(options);
  const registryKey = mcpServerRegistryKey(scopeId, name);
  const server = servers.get(registryKey);
  if (!server) return false;
  try {
    await _closeServer(server);
  } catch {
    /* ignore */
  }
  servers.delete(registryKey);
  closeCallAdmission(scopeId, name, `MCP ${name} disconnected`);
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
  if (transport?._process) {
    try {
      await shutdownStdioChild(transport);
    } catch {
      /* ignore */
    }
  }
  try {
    await server.client.close();
  } catch {
    /* ignore */
  }
}
// Connects whose handshake has not finished yet: disconnectAll() must be able
// to see (and tear down) their transports, because `servers` only lists fully
// handshaken entries. Generation token aborts a connect that outlives a
// disconnectAll() issued mid-handshake (runtime close during boot connect).
async function connectServer(
  name,
  cfg,
  scopeId = DEFAULT_MCP_SCOPE_ID,
  genAtStart = currentConnectAbortGeneration(scopeId)
) {
  scopeId = normalizeMcpScopeId(scopeId);
  _knownMcpScopes.add(scopeId);
  const sdk = await loadMcpSdk();
  if (genAtStart !== currentConnectAbortGeneration(scopeId)) {
    // disconnectAll() ran while the SDK was loading: nothing spawned yet —
    // abort before creating a transport/child at all.
    throw new Error(`MCP server "${name}" connect aborted by shutdown`);
  }
  const client = createMcpClient(sdk, name, cfg);
  const { transport, autoDetectAdvert } = createMcpTransport({ name, cfg, sdk, log: mcpLog });
  const pending = { scopeId, name, client, transport };
  _pendingConnects.add(pending);
  try {
    const { instructions, toolsResult, capabilities } = await runBoundedHandshake({
      name,
      cfg,
      client,
      transport,
      autoDetectAdvert,
      closeServer: _closeServer,
    });
    if (!toolsResult || !Array.isArray(toolsResult.tools)) {
      throw new Error(`[mcp-client] ListTools returned invalid shape for "${name}": missing or non-array tools field`);
    }
    if (genAtStart !== currentConnectAbortGeneration(scopeId)) {
      // disconnectAll() ran mid-handshake: never register — tear down.
      try {
        await _closeServer({ client, transport });
      } catch {
        /* ignore */
      }
      throw new Error(`MCP server "${name}" connect aborted by shutdown`);
    }
    const tools = mcpServerTools(name, capabilities, toolsResult.tools);
    const registryKey = mcpServerRegistryKey(scopeId, name);
    servers.set(registryKey, {
      scopeId,
      registryKey,
      name,
      client,
      transport,
      tools,
      cfg,
      instructions,
      capabilities,
      generation: genAtStart,
    });
    if (capabilities?.tools?.listChanged && sdk.ToolListChangedNotificationSchema) {
      client.setNotificationHandler(sdk.ToolListChangedNotificationSchema, () =>
        refreshServerTools(registryKey, client, name, cfg, capabilities)
      );
    }
    _invalidateMcpToolFieldMemo();
    mcpLog(`[mcp] connected: ${tools.length} tools — ${tools.map((t) => t.name).join(', ')}\n`);
  } finally {
    _pendingConnects.delete(pending);
  }
}

/** The SDK client for one server, advertising the project root when known. */
function createMcpClient(sdk, name, cfg) {
  const projectRoot = String(cfg?._mixdogProjectRoot || cfg?.cwd || '').trim();
  const client = new sdk.Client(
    { name: `mixdog-agent/${name}`, version: '1.0.0' },
    { capabilities: projectRoot ? { roots: { listChanged: false } } : {} }
  );
  if (projectRoot && sdk.ListRootsRequestSchema) {
    client.setRequestHandler(sdk.ListRootsRequestSchema, async () => {
      const rootPath = resolve(projectRoot);
      return {
        roots: [
          {
            uri: pathToFileURL(rootPath).href,
            name: basename(rootPath) || rootPath,
          },
        ],
      };
    });
  }
  return client;
}

/** Protocol tools under the `mcp__<server>__` prefix plus the feature tools. */
function mcpServerTools(name, capabilities, rawTools) {
  const protocolTools = (rawTools || []).map((t) => ({
    name: `mcp__${name}__${t.name}`,
    description: t.description || '',
    inputSchema: t.inputSchema || { type: 'object', properties: {} },
    ...(t.annotations && typeof t.annotations === 'object' ? { annotations: t.annotations } : {}),
  }));
  return [...protocolTools, ...mcpFeatureTools(name, capabilities, protocolTools)];
}

async function refreshServerTools(registryKey, client, name, cfg, capabilities) {
  const live = servers.get(registryKey);
  if (!live || live.client !== client) return;
  try {
    const refreshed = await client.listTools();
    live.tools = mcpServerTools(name, capabilities, refreshed.tools);
    _invalidateMcpToolFieldMemo();
  } catch (error) {
    mcpLog(
      `[mcp-client] Failed to refresh tools for "${name}": ${scrubMcpConnectionMessage(error?.message || error, cfg)}\n`
    );
  }
}

// Test seam for registry scoping without launching an MCP transport.
export function _registerMcpServerForTest(scopeId, name, rawTools = [], options = {}) {
  const normalizedScopeId = normalizeMcpScopeId(scopeId);
  const registryKey = mcpServerRegistryKey(normalizedScopeId, name);
  const tools = rawTools.map((tool) => ({
    ...tool,
    name: String(tool?.name || '').startsWith('mcp__')
      ? String(tool.name)
      : `mcp__${name}__${String(tool?.name || '')}`,
    inputSchema: tool?.inputSchema || { type: 'object', properties: {} },
  }));
  const capabilities = options.capabilities || {};
  const server = {
    scopeId: normalizedScopeId,
    registryKey,
    name,
    tools: [...tools, ...mcpFeatureTools(name, capabilities, tools)],
    cfg: options.cfg || {},
    instructions: options.instructions || '',
    capabilities,
    transport: null,
    client: {
      callTool:
        typeof options.callTool === 'function'
          ? options.callTool
          : async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      ...(options.client && typeof options.client === 'object' ? options.client : {}),
      // Injectable so a test can stall teardown (and therefore the shared
      // reconnect) without a transport or a child process.
      close: typeof options.close === 'function' ? options.close : async () => {},
    },
    generation: currentConnectAbortGeneration(normalizedScopeId),
  };
  _knownMcpScopes.add(normalizedScopeId);
  servers.set(registryKey, server);
  _invalidateMcpToolFieldMemo();
  return server;
}
