import { setMaxListeners } from 'node:events';
import { mkdirSync } from 'node:fs';
import { writeFileAtomicSync } from '../../../shared/atomic-file.mjs';
import { writeFile } from 'node:fs/promises';
import {
  MAX_ATTACHMENT_BLOB_BYTES,
  MAX_IMAGE_BYTES,
  MAX_PDF_BYTES,
  MAX_PDF_PAGES,
  SUPPORTED_IMAGE_MIME_TYPES,
} from '../../../attachments/limits.mjs';
import { inspectPdfBuffer } from '../../../attachments/pdf-extract.mjs';
import { inlineFileKind } from '../../../shared/inline-file-kind.mjs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { smartReadTruncate } from '../tools/builtin/read-formatting.mjs';
import { shutdownStdioChild, killStdioChildTreeFast } from './child-tree.mjs';
import { makeToolEnvelope, normalizeToolEnvelope } from '../session/tool-envelope.mjs';
import { classifyResultKind } from '../session/result-classification.mjs';
import { createKeyedSingleflight } from './reconnect-singleflight.mjs';
import { createOwnerFairGate } from '../../../shared/owner-fair-gate.mjs';
import { currentToolExecutionOwner } from '../../../shared/tool-execution-owner.mjs';
import { positiveInt } from '../../../shared/numbers.mjs';
import {
  providerSafeMcpToolName,
  resolveMcpOAuthUrl,
  resolveMcpRequestTimeouts,
  resolveMcpTransportKind,
  scrubMcpConnectionMessage,
  scrubMcpSecrets,
} from './client-config.mjs';
import { createLazyOutputValidator } from './lazy-output-validator.mjs';
import { appendMcpStderrTail, createMcpTransport, hasConfiguredMcpAuth } from './client-transport.mjs';
import { listAllMcpTools, MCP_CONNECT_CANCELLED, runBoundedHandshake } from './client-handshake.mjs';
import { rememberServerConnector } from './server-connectors.mjs';
import { mcpOAuthClientFor, mcpOAuthDisplayName } from './oauth-client.mjs';
import { googleMcpService, withGoogleMcp } from '../../../connectors/google-mcp.mjs';
import { gmailAppPasswordService } from '../../../connectors/gmail-app-password.mjs';
import { connectorAccountServers } from '../../../shared/connector-catalog.mjs';
import {
  clearMcpOAuth,
  commitMcpOAuthSwitch,
  hasStoredMcpOAuthTokens,
  isMcpOAuthReauthenticationRequired,
  isMcpOAuthScopeNotGranted,
  MCP_OAUTH_CALLBACK_NOT_PENDING,
  startMcpOAuthSwitch,
  storedMcpOAuthIdentity,
} from './oauth.mjs';
export { probeMcpServerAuth } from './oauth-probe.mjs';

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
  resolveMcpCallTimeoutMs,
  resolveMcpMaxTotalTimeoutMs,
  resolveMcpRequestTimeouts,
} from './client-config.mjs';
const servers = new Map();
const reconnects = createKeyedSingleflight();
const callAdmissions = new Map();
const DEFAULT_MCP_SCOPE_ID = 'global';
// `mcp__{serverName}__{toolName}` → [, serverName, toolName].
const MCP_TOOL_NAME_RE = /^mcp__(.+?)__(.+)$/;
const _knownMcpScopes = new Set([DEFAULT_MCP_SCOPE_ID]);
const _connectAbortGenerations = new Map();
const _pendingConnects = new Set();
// scopeId -> root path advertised by that scope's scope-following servers.
const _scopeRoots = new Map();
// One stdio process per server config, shared by every scope that connects
// the same server with the same resolved config: share key -> connection
// { key, client, transport, liveness, stderrTail, warnings, tools,
// capabilities, instructions, users: Set<registryKey> }. Every session
// runtime has its own scope, so per-scope processes multiplied with the
// number of retained sessions. A scope's close releases only its own use; the
// process tree is shut down when its last user releases it.
const _sharedStdio = new Map();
let mcpSdkPromise = null;
// Memo for mcpToolHasField(name, field) — keyed by `${scopeId}|${toolName}|${field}`.
// The lookup (regex parse + servers Map get + tools.find + schema property
// inspection) runs on every MCP tool invocation but its result only changes
// when the servers/tools registry is (re)built. Cleared at every registry
// mutation point (connectServer / disconnectAll) so a stale positive or
// negative can never survive a tools-list change.
const _mcpToolFieldMemo = new Map();
let _mcpToolGeneration = 0;
function _invalidateMcpToolFieldMemo() {
  _mcpToolFieldMemo.clear();
  _mcpToolGeneration += 1;
}
/** Read-only counter bumped on every MCP tool registry mutation. */
export function getMcpToolGeneration() {
  return _mcpToolGeneration;
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
// Share key of a stdio server, or null when its connection must stay private
// to one scope: remote transports, and servers whose advertised roots follow
// their scope's cwd.
function sharedStdioKey(name, cfg) {
  if (cfg?._mixdogRootsFollowScope === true) return null;
  try {
    if (resolveMcpTransportKind(cfg) !== 'stdio') return null;
  } catch {
    return null;
  }
  return `${String(name || '')}\u0000${JSON.stringify(cfg)}`;
}
// A connection that failed a call is never handed to a later connect; scopes
// still holding it keep it until they release it themselves.
function retireSharedConnection(server) {
  const shared = server?.shared;
  if (shared && _sharedStdio.get(shared.key) === shared) _sharedStdio.delete(shared.key);
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
// OAuth tokens belong to the live connection, not to its config: a server may
// echo the request (Authorization included) into an error body or result.
function oauthSecrets(...transports) {
  return transports.flatMap((transport) => transport?.oauth?.secrets() || []);
}
function scrubMcpOAuthError(error, cfg, secrets) {
  if (secrets.length === 0) return error;
  if (!(error instanceof Error)) return new Error(scrubMcpConnectionMessage(String(error), cfg, secrets));
  error.message = scrubMcpConnectionMessage(error.message, cfg, secrets);
  if (typeof error.stack === 'string') error.stack = scrubMcpConnectionMessage(error.stack, cfg, secrets);
  // A JSON-RPC error carries the server's own payload (McpError.data).
  if (error.data !== undefined) error.data = scrubMcpSecrets(error.data, secrets);
  return error;
}

async function loadMcpSdk() {
  mcpSdkPromise ??= Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/client/sse.js'),
    import('@modelcontextprotocol/sdk/client/websocket.js'),
    import('@modelcontextprotocol/sdk/types.js'),
    import('@modelcontextprotocol/sdk/validation/ajv'),
  ]).then(([clientMod, stdioMod, httpMod, sseMod, wsMod, typesMod, ajvMod]) => ({
    Client: clientMod.Client,
    AjvJsonSchemaValidator: ajvMod.AjvJsonSchemaValidator,
    StdioClientTransport: stdioMod.StdioClientTransport,
    StreamableHTTPClientTransport: httpMod.StreamableHTTPClientTransport,
    SSEClientTransport: sseMod.SSEClientTransport,
    WebSocketClientTransport: wsMod.WebSocketClientTransport,
    JSONRPCMessageSchema: typesMod.JSONRPCMessageSchema,
    ListRootsRequestSchema: typesMod.ListRootsRequestSchema,
    ToolListChangedNotificationSchema: typesMod.ToolListChangedNotificationSchema,
  }));
  return mcpSdkPromise;
}
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
  const settled = await Promise.allSettled(
    entries.map(([name, cfg]) => connectServer(name, cfg, scopeId, genAtStart, options))
  );
  settled.forEach((res, i) => {
    if (res.status !== 'rejected') return;
    const [name, cfg] = entries[i];
    const rawMessage = res.reason instanceof Error ? res.reason.message : String(res.reason);
    const msg = scrubMcpConnectionMessage(rawMessage, cfg);
    mcpLog(`[mcp-client] Failed to connect "${name}": ${msg}\n`);
    failures.push({ name, msg, ...(res.reason?.authRequired ? { authRequired: true } : {}) });
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
    let name = providerSafeMcpToolName(serverName, leaf);
    for (let suffix = '_'; used.has(name); suffix += '_') name = providerSafeMcpToolName(serverName, leaf + suffix);
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
    connected: server.liveness?.alive !== false,
    ...(server.liveness?.alive === false
      ? {
          error: appendMcpStderrTail(
            server.liveness.lastError || `MCP server "${server.name}" closed`,
            server.stderrTail?.()
          ),
        }
      : {}),
    warnings: Array.isArray(server.warnings) ? server.warnings : [],
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
    // JSON-RPC multiplexes requests by id over one transport, so the client
    // imposes no in-flight cap of its own; a server that needs one declares
    // it (maxConcurrency) or the operator sets MIXDOG_MCP_MAX_INFLIGHT.
    activeMax:
      positiveInt(cfg.maxConcurrency ?? cfg.max_concurrency ?? process.env.MIXDOG_MCP_MAX_INFLIGHT, null) ?? Infinity,
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

// Close `current` (when registered) and connect `name` afresh with `cfg`.
// Callers run it inside the per-server reconnect lane. `genAtStart` is the
// shutdown generation captured BEFORE the caller queued/closed anything: a
// disconnectAll() landing during the close (or the connect) bumps it, and the
// replacement must then never register (no resurrection after shutdown).
async function replaceServerConnection(scopeId, name, current, cfg, genAtStart, options = {}) {
  const registryKey = mcpServerRegistryKey(scopeId, name);
  if (current) {
    await _closeServer(current);
    if (servers.get(registryKey) === current) servers.delete(registryKey);
    _invalidateMcpToolFieldMemo();
  }
  if (genAtStart !== currentConnectAbortGeneration(scopeId)) {
    throw new Error(`MCP server "${name}" connect aborted by shutdown`);
  }
  try {
    // connectServer re-checks the same generation after loading the SDK and
    // again right before registering, so a shutdown mid-handshake also aborts.
    await connectServer(name, cfg, scopeId, genAtStart, options);
  } catch (reason) {
    const rawMessage = reason instanceof Error ? reason.message : String(reason);
    const error = new Error(scrubMcpConnectionMessage(rawMessage, cfg));
    if (reason?.authRequired) error.authRequired = true;
    throw error;
  }
}

// Explicit single-server operations (connect/reconnect/disconnect) never join
// a failure-driven reconnect that is already in flight — its config may be
// stale — they queue behind it on the same lane instead, so at most one
// connect per server is ever running (no doubly registered transports).
async function runExclusiveServerOp(registryKey, task) {
  for (let pending = reconnects.wait(registryKey); pending; pending = reconnects.wait(registryKey)) {
    // Only waiting for the reconnect to settle; its failure belongs to its caller.
    await pending.catch(() => {});
  }
  return reconnects.run(registryKey, task);
}

async function reconnectMcpServer(scopeId, serverName, failedServer) {
  const registryKey = mcpServerRegistryKey(scopeId, serverName);
  // The generation the failed server was registered under, NOT the current
  // one: when disconnectAll() itself caused the failure it has already bumped
  // the generation (and still holds the entry while awaiting the close), so a
  // freshly captured value would bless a post-shutdown reconnect.
  const genAtStart = failedServer.generation ?? currentConnectAbortGeneration(scopeId);
  await reconnects.run(registryKey, async () => {
    const current = servers.get(registryKey);
    // A peer already completed the replacement while this failed call was
    // unwinding. Reuse it immediately instead of closing a fresh transport.
    if (current && current !== failedServer) return;
    // Unregistered meanwhile (explicit disconnect / shutdown), shut down since
    // it was registered, or being deliberately closed right now: a failed call
    // must not resurrect a server someone deliberately removed.
    if (!current || genAtStart !== currentConnectAbortGeneration(scopeId) || current.liveness?.closing) {
      throw new Error(`MCP server "${serverName}" was disconnected`);
    }
    retireSharedConnection(current);
    await replaceServerConnection(scopeId, serverName, current, failedServer.cfg, genAtStart);
  });
  const replacement = servers.get(registryKey);
  if (!replacement) {
    throw new Error(`reconnect succeeded but server "${serverName}" entry is missing from registry`);
  }
  return replacement;
}

/**
 * Connect, or reconnect, ONE named MCP server in `scopeId` without touching
 * any other server. A registered instance is closed first; `cfg` defaults to
 * the registered config. `cfg.enabled === false` only disconnects. Resolves
 * true when the server is connected afterwards, false when it was disabled;
 * rejects (credential-scrubbed message) when the connect fails, leaving the
 * server unregistered.
 */
export async function reconnectSingleMcpServer(scopeId, name, cfg = undefined, options = {}) {
  const normalized = normalizeMcpScopeId(scopeId);
  _knownMcpScopes.add(normalized);
  const registryKey = mcpServerRegistryKey(normalized, name);
  // Captured before queuing: a shutdown while this op waits or closes wins.
  const genAtStart = currentConnectAbortGeneration(normalized);
  return runExclusiveServerOp(registryKey, async () => {
    const current = servers.get(registryKey);
    const nextCfg = cfg ?? current?.cfg;
    if (!nextCfg) throw new Error(`MCP server "${name}" has no config to connect with`);
    if (nextCfg.enabled === false) {
      if (current) {
        await _closeServer(current);
        if (servers.get(registryKey) === current) servers.delete(registryKey);
        _invalidateMcpToolFieldMemo();
      }
      closeCallAdmission(normalized, name, `MCP ${name} disabled`);
      return false;
    }
    await replaceServerConnection(normalized, name, current, nextCfg, genAtStart, options);
    return true;
  });
}

/**
 * Execute an MCP tool call.
 * Name format: `mcp__{serverName}__{toolName}`
 */
export async function executeMcpTool(name, args, options = {}) {
  const match = name.match(MCP_TOOL_NAME_RE);
  if (!match) throw new Error(`Not an MCP tool name: ${name}`);
  const scopeId = normalizeMcpScopeId(options);
  const target = resolveMcpToolTarget(scopeId, name);
  if (!target) throw new Error(`MCP server "${match[1]}" not connected`);
  const { server, definition } = target;
  const serverName = server.name;
  const toolName = definition?.mcpToolName || match[2];
  const callSignal = options?.signal || null;
  const dispatch = (target) =>
    definition?.mcpOperation
      ? _callMcpFeatureWithTimeout(target, definition.mcpOperation, args, callSignal)
      : _callToolWithTimeout(target, toolName, args, callSignal);
  let retryServer = null;
  const secrets = () => oauthSecrets(server.transport, retryServer?.transport);
  const gate = callAdmissionFor(server);
  return gate
    .run(
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
          const serverDead = server.liveness?.alive === false;
          if (!serverDead && isMcpServerResponseError(firstErr)) {
            // The server answered (JSON-RPC error): it is alive — nothing to
            // reconnect, and the call already ran its course.
            throw firstErr;
          }
          // Only a failure that proves the request never left this process
          // may be replayed; anything else may already have run server-side.
          const undelivered = isMcpUndeliveredError(firstErr);
          const deadTail = serverDead ? server.stderrTail?.() : '';
          mcpLog(`[mcp-client] Tool call failed, attempting shared reconnect...\n`);
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
            throw new Error(
              appendMcpStderrTail(`Tool call failed: ${firstMsg}; reconnect also failed: ${reconnectMsg}`, deadTail)
            );
          }
          if (!undelivered) {
            throw new Error(
              appendMcpStderrTail(
                `Tool call failed: ${firstMsg}; MCP server "${serverName}" was reconnected for the next call, but this call was not replayed because the request may already have reached the server`,
                deadTail
              )
            );
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
        const normalized = normalizeToolEnvelope(await normalizeMcpToolResult(scrubMcpSecrets(result, secrets())));
        const text = capMcpResult(normalized.result);
        return normalized.explicitSuccess ? makeToolEnvelope(text, [], { explicitSuccess: true }) : text;
      },
      {
        signal: callSignal,
      }
    )
    .catch((error) => {
      throw scrubMcpOAuthError(error, server.cfg, secrets());
    });
}

const MCP_FEATURE_REQUESTS = {
  'list-resources': (client, args, options) => client.listResources(mcpCursorParams(args), options),
  'list-resource-templates': (client, args, options) => client.listResourceTemplates(mcpCursorParams(args), options),
  'read-resource': (client, args, options) => client.readResource({ uri: String(args?.uri || '') }, options),
  'list-prompts': (client, args, options) => client.listPrompts(mcpCursorParams(args), options),
  'get-prompt': (client, args, options) =>
    client.getPrompt(
      {
        name: String(args?.name || ''),
        arguments:
          args?.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments) ? args.arguments : {},
      },
      options
    ),
};

function mcpCursorParams(args) {
  return typeof args?.cursor === 'string' && args.cursor ? { cursor: args.cursor } : {};
}

async function _callMcpFeatureWithTimeout(server, operation, args, signal = null) {
  const issue = MCP_FEATURE_REQUESTS[operation];
  if (!issue) throw new Error(`Unsupported MCP feature operation: ${operation}`);
  const result = await runMcpRequest(server, signal, (options) => issue(server.client, args, options), {
    abortMessage: `MCP feature call aborted (server="${server?.name}", operation="${operation}")`,
    timeoutMessage: (ms) =>
      `MCP feature call timed out after ${ms}ms without progress (server="${server.name}", operation="${operation}")`,
    errorFields: { serverName: server.name, operation },
  });
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    isError: false,
  };
}

// Our per-call deadline. It is reset by every progress notification, but never
// beyond maxTotalTimeoutMs from the start. On expiry the call rejects with
// EMCPTOOLTIMEOUT and `cancelRequest` cancels ONLY this request (the SDK then
// sends notifications/cancelled); the server and its other in-flight calls
// are untouched. The caller clears the timer once its own race settles.
function mcpCallTimeout({ callTimeoutMs, maxTotalTimeoutMs }, message, errorFields, cancelRequest) {
  const startedAt = Date.now();
  let timer = null;
  let rejectTimeout;
  const promise = new Promise((_, reject) => {
    rejectTimeout = reject;
  });
  const fire = () => {
    timer = null;
    const error = Object.assign(new Error(message), { code: 'EMCPTOOLTIMEOUT', ...errorFields });
    rejectTimeout(error);
    cancelRequest(error);
  };
  const arm = (ms) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, ms);
    if (timer.unref) timer.unref();
  };
  arm(callTimeoutMs);
  return {
    promise,
    clear: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
    progress: () => {
      if (!timer) return;
      const remainingTotal = maxTotalTimeoutMs ? maxTotalTimeoutMs - (Date.now() - startedAt) : Infinity;
      if (remainingTotal > 0) arm(Math.min(callTimeoutMs, remainingTotal));
    },
  };
}

/**
 * Issue one SDK request under the per-call limits. The request gets its OWN
 * abort signal (linked to the caller's), our timeout as the SDK `timeout`
 * (or the largest timer when disabled, so the SDK's 60s default never
 * applies), and progress handling: each progress report resets both the SDK
 * timeout and ours, capped by `maxTotalTimeout`.
 */
async function runMcpRequest(server, signal, issue, { abortMessage, timeoutMessage, errorFields }) {
  const timeouts = resolveMcpRequestTimeouts(server?.cfg);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal.reason);
  if (signal) {
    allowConcurrentAbortListeners(signal);
    if (signal.aborted) forwardAbort();
    else signal.addEventListener('abort', forwardAbort, { once: true });
  }
  const timeout =
    timeouts.callTimeoutMs > 0
      ? mcpCallTimeout(
          timeouts,
          timeoutMessage(timeouts.callTimeoutMs),
          { ...errorFields, timeoutMs: timeouts.callTimeoutMs },
          (error) => controller.abort(error)
        )
      : null;
  const requestOptions = {
    signal: controller.signal,
    timeout: timeouts.sdkTimeoutMs,
    resetTimeoutOnProgress: true,
    onprogress: () => timeout?.progress(),
    ...(timeouts.maxTotalTimeoutMs ? { maxTotalTimeout: timeouts.maxTotalTimeoutMs } : {}),
  };
  try {
    const request = issue(requestOptions);
    return await raceMcpAbort(timeout ? Promise.race([request, timeout.promise]) : request, signal, abortMessage);
  } finally {
    timeout?.clear();
    signal?.removeEventListener?.('abort', forwardAbort);
  }
}

function mcpResourceFilename(uri) {
  const tail = String(uri || '')
    .split(/[?#]/)[0]
    .split('/')
    .filter(Boolean)
    .pop();
  let name = tail || 'resource';
  try {
    name = decodeURIComponent(name);
  } catch {
    /* keep the raw segment */
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips control characters and separators from a server-supplied name
  name = name.replace(/[\u0000-\u001f/\\]/g, '_').slice(0, 255);
  return name || 'resource';
}

// Canonical base64 (decode → re-encode) so the attachment store accepts the
// payload and live/saved forms lower identically. Returns null when empty.
function mcpCanonicalBase64(data, maxBytes) {
  // Reject by encoded length before decoding so huge payloads are never copied.
  if (data.length > Math.ceil((maxBytes * 4) / 3) * 2) return { tooLarge: true };
  const buffer = Buffer.from(data, 'base64');
  if (buffer.length === 0) return null;
  if (buffer.length > maxBytes) return { tooLarge: true };
  return { data: buffer.toString('base64'), buffer };
}

const mcpMiB = (bytes) => `${bytes / 1024 / 1024} MiB`;

function mcpImagePart(data, rawMime) {
  const mimeType =
    String(rawMime || 'image/png')
      .split(';')[0]
      .trim()
      .toLowerCase() || 'image/png';
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    return { type: 'text', text: `[MCP image omitted: ${mimeType} is not a supported image type]` };
  }
  const canon = mcpCanonicalBase64(data, MAX_IMAGE_BYTES);
  if (!canon) return { type: 'text', text: '[MCP image omitted: empty image data]' };
  if (canon.tooLarge) {
    return {
      type: 'text',
      text: `[MCP image omitted: ${mimeType} image exceeds the ${mcpMiB(MAX_IMAGE_BYTES)} limit]`,
    };
  }
  return { type: 'image', data: canon.data, mimeType };
}

// Media with no inline form is written once, named by its content hash, next
// to the oversized-text spill so the model can open it from disk with read.
function spillMcpBinary(buffer, extension) {
  const hash = createHash('sha256').update(buffer).digest('hex');
  const dir = join(tmpdir(), 'mixdog-mcp-output');
  const path = join(dir, `mcp-${hash}.${extension}`);
  try {
    mkdirSync(dir, { recursive: true });
    // Named by its content hash: whole-file create-if-absent (a crash never
    // leaves a torn file under the name that would be trusted as the content).
    writeFileAtomicSync(path, buffer, { createOnly: true });
  } catch {
    return null;
  }
  return path;
}

const mcpExtension = (name) => /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase() || 'bin';

async function mcpFilePart(data, rawMime, uri) {
  const mimeType = String(rawMime || 'application/octet-stream').trim() || 'application/octet-stream';
  const filename = mcpResourceFilename(uri);
  const canon = mcpCanonicalBase64(data, MAX_ATTACHMENT_BLOB_BYTES);
  if (!canon) return { type: 'text', text: `[MCP resource omitted: ${filename} has no data]` };
  if (canon.tooLarge) {
    return {
      type: 'text',
      text: `[MCP resource omitted: ${filename} (${mimeType}) exceeds the ${mcpMiB(MAX_ATTACHMENT_BLOB_BYTES)} limit]`,
    };
  }
  // The bytes decide the kind; the declared MIME type only labels the part.
  const kind = inlineFileKind(mimeType, canon.data, filename);
  if (kind === 'pdf') {
    if (canon.buffer.length > MAX_PDF_BYTES) {
      return {
        type: 'text',
        text: `[MCP resource omitted: ${filename} (${mimeType}) exceeds the ${mcpMiB(MAX_PDF_BYTES)} PDF limit]`,
      };
    }
    let pageCount;
    try {
      ({ pageCount } = await inspectPdfBuffer(canon.buffer, { maxPages: Infinity }));
    } catch {
      return { type: 'text', text: `[MCP resource omitted: ${filename} is password-protected or not a valid PDF]` };
    }
    if (pageCount > MAX_PDF_PAGES) {
      return {
        type: 'text',
        text: `[MCP resource omitted: ${filename} has ${pageCount} pages, too many to attach (max ${MAX_PDF_PAGES})]`,
      };
    }
  } else if (kind === 'binary') {
    const path = spillMcpBinary(canon.buffer, mcpExtension(filename));
    return {
      type: 'text',
      text: path
        ? `[MCP resource ${filename} (${mimeType}, ${canon.buffer.length} bytes) saved to ${path}; open it from disk with read.]`
        : `[MCP resource omitted: ${filename} (${mimeType}, ${canon.buffer.length} bytes) could not be saved]`,
    };
  }
  return { type: 'file', data: canon.data, mimeType, filename };
}

function mcpAudioPart(data, rawMime) {
  const mimeType = String(rawMime || 'audio').trim() || 'audio';
  const canon = typeof data === 'string' && data ? mcpCanonicalBase64(data, MAX_ATTACHMENT_BLOB_BYTES) : null;
  if (!canon) return { type: 'text', text: `[MCP audio content: ${mimeType}]` };
  if (canon.tooLarge) {
    return {
      type: 'text',
      text: `[MCP audio omitted: ${mimeType} exceeds the ${mcpMiB(MAX_ATTACHMENT_BLOB_BYTES)} limit]`,
    };
  }
  const subtype = mimeType.split(';')[0].split('/')[1] || '';
  const path = spillMcpBinary(
    canon.buffer,
    subtype
      .replace(/[^a-z0-9]/gi, '')
      .slice(0, 8)
      .toLowerCase() || 'bin'
  );
  return {
    type: 'text',
    text: path
      ? `[MCP audio content: ${mimeType} (${canon.buffer.length} bytes) saved to ${path}; open it from disk with read.]`
      : `[MCP audio content: ${mimeType}]`,
  };
}

// Deterministic mapping of one MCP content item to a runtime part. Binary data
// stays in structured media parts (never in a text string); the shared media
// lowering decides how each provider receives it.
async function mcpContentPart(c) {
  if (!c || typeof c !== 'object') return { type: 'text', text: String(c ?? '') };
  if (c.type === 'text') return { type: 'text', text: c.text || '' };
  if (c.type === 'image' && typeof c.data === 'string' && c.data) {
    return mcpImagePart(c.data, c.mimeType);
  }
  if (c.type === 'audio') return mcpAudioPart(c.data, c.mimeType);
  if (c.type === 'resource' && c.resource && typeof c.resource === 'object') {
    const r = c.resource;
    if (typeof r.text === 'string') return { type: 'text', text: r.text };
    if (typeof r.blob === 'string' && r.blob) {
      if (/^image\//i.test(String(r.mimeType || '').trim())) return mcpImagePart(r.blob, r.mimeType);
      return await mcpFilePart(r.blob, r.mimeType, r.uri);
    }
  }
  return { type: 'text', text: JSON.stringify(c) };
}

const isMcpMediaPart = (p) => p.type === 'image' || p.type === 'file';

// Preserve MCP failure metadata across the object→string boundary. The
// session loop classifies the canonical Error: prefix as toolKind:error.
export async function normalizeMcpToolResult(result) {
  const content = result.content;
  let parts = null;
  let text;
  if (Array.isArray(content)) {
    parts = await Promise.all(content.map(mcpContentPart));
    text = parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    if (!parts.some(isMcpMediaPart)) parts = null;
  } else {
    text = typeof content === 'string' ? content : JSON.stringify(content);
  }
  if (result.isError === true) {
    if (!parts) return text.startsWith('Error:') ? text : `Error: ${text}`;
    const first = parts[0];
    if (first.type !== 'text') return { content: [{ type: 'text', text: 'Error:' }, ...parts] };
    if (first.text.startsWith('Error:')) return { content: parts };
    return { content: [{ ...first, text: `Error: ${first.text}` }, ...parts.slice(1)] };
  }
  if (result.isError === false && classifyResultKind(text) === 'error') {
    return makeToolEnvelope(parts ? { content: parts } : text, [], { explicitSuccess: true });
  }
  return parts ? { content: parts } : text;
}

// JSON-RPC codes the SDK uses for client-side failures (McpError).
const MCP_CONNECTION_CLOSED_CODE = -32000;
const MCP_REQUEST_TIMEOUT_CODE = -32001;

// Our own deadline, or the SDK's (McpError RequestTimeout, incl. the
// progress maxTotalTimeout).
function isMcpToolCallTimeoutError(err) {
  return err?.code === 'EMCPTOOLTIMEOUT' || err?.code === MCP_REQUEST_TIMEOUT_CODE;
}

// The server answered with a JSON-RPC error: proof it is alive.
function isMcpServerResponseError(err) {
  return (
    typeof err?.code === 'number' && err.code !== MCP_CONNECTION_CLOSED_CODE && err.code !== MCP_REQUEST_TIMEOUT_CODE
  );
}

// Connection-level failures that prove the request was never delivered: the
// SDK/transport had no live connection to send on, or the socket was refused
// before anything was written. ECONNRESET etc. are excluded — the request may
// have been read before the reset.
const MCP_UNDELIVERED_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH']);
function isMcpUndeliveredError(err) {
  if (!err) return false;
  if (/^Not connected$/i.test(String(err.message || '').trim())) return true;
  return MCP_UNDELIVERED_CODES.has(String(err.code || err.cause?.code || ''));
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

// One turn signal is shared by every parallel MCP call of that turn, and each
// in-flight call holds two abort listeners on it (this race and the SDK
// request), both removed when the call settles. Node's default of 50 warned at
// ~25 parallel calls (`MaxListenersExceededWarning: 51 abort listeners`) although
// nothing accumulated. The ceiling is high enough for real fan-out and still
// warns on a genuine leak.
const MCP_ABORT_LISTENER_CEILING = 1024;
const abortCeilingRaised = new WeakSet();

function allowConcurrentAbortListeners(signal) {
  if (abortCeilingRaised.has(signal)) return;
  abortCeilingRaised.add(signal);
  try {
    setMaxListeners(MCP_ABORT_LISTENER_CEILING, signal);
  } catch {
    /* not an EventTarget (test doubles) */
  }
}

/** Settle as soon as `signal` aborts. Promise.race keeps a later rejection of
 *  `promise` handled, so the abandoned call cannot surface as an unhandled
 *  rejection. */
export function raceMcpAbort(promise, signal, message) {
  if (!signal) return promise;
  allowConcurrentAbortListeners(signal);
  if (signal.aborted) {
    // The abort wins; the abandoned promise's late rejection must not go unhandled.
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
  // The request's signal goes INTO the SDK: an aborted caller (or our own
  // timeout) cancels the live JSON-RPC request (notifications/cancelled)
  // instead of merely walking away from it. The abort race additionally frees
  // the admission slot at once. With the timeout disabled the caller's signal
  // is the ONLY bound.
  return runMcpRequest(
    server,
    signal,
    (options) => server.client.callTool({ name: toolName, arguments: args }, undefined, options),
    {
      abortMessage: `MCP tool call aborted (server="${server?.name}", tool="${toolName}")`,
      timeoutMessage: (ms) =>
        `MCP tool call timed out after ${ms}ms without progress (server="${server.name}", tool="${toolName}")`,
      errorFields: { serverName: server.name, toolName },
    }
  );
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

// Structured results cap the TOTAL text across parts (one budget, as for a
// plain string); media parts pass through intact and every part keeps its
// position. The joined text is truncated exactly like a plain string (head
// lines, one marker, tail lines); each text part keeps only the slice of its
// own text that survives, and the marker plus spill note land on the part
// where the elision starts. Cuts are on line boundaries of the joined text.
export function capMcpResult(result) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.content)) return capMcpOutput(result);
  const joined = result.content
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
  const capped = capMcpOutputParts(joined);
  if (!capped.truncated) return result;
  const headEnd = capped.head.length;
  const tailStart = joined.length - capped.tail.length;
  const textParts = result.content.filter((p) => p.type === 'text');
  let offset = 0;
  const spans = new Map();
  for (const p of textParts) {
    spans.set(p, offset);
    offset += p.text.length + 1;
  }
  const owner = textParts.filter((p) => spans.get(p) <= headEnd).pop();
  return {
    ...result,
    content: result.content.flatMap((p) => {
      if (p.type !== 'text') return [p];
      const start = spans.get(p);
      const end = start + p.text.length;
      if (p === owner) {
        const pre = p.text.slice(0, Math.max(0, headEnd - start));
        const suf = end > tailStart ? p.text.slice(Math.max(0, tailStart - start)) : '';
        const text = `${pre}\n${capped.marker}${suf ? `\n${suf}` : ''}${capped.spillNote}`;
        return [{ ...p, text }];
      }
      if (end <= headEnd || start >= tailStart) return [p];
      if (start < headEnd) return [{ ...p, text: p.text.slice(0, headEnd - start) }];
      if (end > tailStart) return [{ ...p, text: p.text.slice(tailStart - start) }];
      return [];
    }),
  };
}
function capMcpOutput(content) {
  const { text, spillNote } = capMcpOutputParts(content);
  return `${text}${spillNote}`;
}

function capMcpOutputParts(content) {
  const s = typeof content === 'string' ? content : String(content ?? '');
  const bodyBytes = Buffer.byteLength(s, 'utf8');
  const bodyLines = countTextLines(s);
  const { text, truncated, marker } = smartReadTruncate(s, bodyLines, bodyBytes);
  if (!truncated) return { text, spillNote: '', truncated: false };
  // Spill the full body to a tmp file so the caller can recover content
  // elided by the head/tail cap.
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
  const split = text.indexOf(`\n${marker}\n`);
  return {
    text,
    spillNote,
    truncated: true,
    marker,
    head: text.slice(0, split),
    tail: text.slice(split + marker.length + 2),
  };
}
/**
 * Check if a tool name is an MCP tool.
 */
export function isMcpTool(name) {
  return name.startsWith('mcp__');
}
/** True when the prefixed name exists on a connected MCP server. */
export function isRegisteredMcpTool(name, scopeId = DEFAULT_MCP_SCOPE_ID) {
  return Boolean(resolveMcpToolTarget(scopeId, name)?.definition);
}
/** True when the prefixed name is `read_email` of a server whose every
 *  endpoint Mixdog answers in-process (the Gmail app-password connector,
 *  alone or behind the multi-account server): its result is a mail as the
 *  mailbox holds it, never another server's text (browser-bridge/mail-links.mjs). */
export function isBuiltinMailRead(name, scopeId = DEFAULT_MCP_SCOPE_ID) {
  const target = resolveMcpToolTarget(normalizeMcpScopeId(scopeId), name);
  if (!target || (target.definition?.mcpToolName || MCP_TOOL_NAME_RE.exec(name)?.[2]) !== 'read_email') return false;
  const accounts = connectorAccountServers(target.server.cfg);
  return (accounts.length ? accounts : [target.server.cfg]).every((cfg) => {
    try {
      const url = resolveMcpOAuthUrl(cfg);
      return Boolean(gmailAppPasswordService(url) || googleMcpService(url));
    } catch {
      return false;
    }
  });
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
  const tool = resolveMcpToolTarget(normalizedScopeId, name)?.definition;
  const props = tool?.inputSchema?.properties;
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
      entry.transport.oauth?.close();
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
  // An exclusive reconnect may currently be waiting for human authorization.
  // Cancel before queueing the disconnect behind that operation.
  cancelMcpLogin(name, options);
  return runExclusiveServerOp(registryKey, async () => {
    const server = servers.get(registryKey);
    if (!server) return false;
    try {
      await _closeServer(server);
    } catch {
      /* ignore */
    }
    if (servers.get(registryKey) === server) servers.delete(registryKey);
    closeCallAdmission(scopeId, name, `MCP ${name} disconnected`);
    _invalidateMcpToolFieldMemo();
    return true;
  });
}
/**
 * Cancel the interactive OAuth login of a connect of `name` still in its
 * handshake; that connect then fails. Callers that queue behind the connect
 * (disable, remove) call this first so they never wait out the login.
 */
export function cancelMcpLogin(name, options = {}) {
  const scopeId = normalizeMcpScopeId(options);
  for (const entry of _pendingConnects) {
    if (entry.scopeId === scopeId && entry.name === name) entry.transport.oauth?.close();
  }
}
/**
 * Answer the interactive OAuth login of a connect of `name` still in its
 * handshake with the redirect URL pasted from the browser (remote / headless
 * sign-in); that connect then proceeds as after the loopback callback. Throws
 * a fixed message, never the pasted URL, for an invalid paste (the login stays
 * pending) or when no login is waiting.
 */
export function completeMcpLogin(name, callbackUrl, options = {}) {
  const scopeId = normalizeMcpScopeId(options);
  for (const entry of _pendingConnects) {
    if (entry.scopeId === scopeId && entry.name === name && entry.transport.oauth?.loginStarted) {
      entry.transport.oauth.completeCallback(callbackUrl);
      return;
    }
  }
  throw new Error(MCP_OAUTH_CALLBACK_NOT_PENDING);
}
/** Whether a connect of `name` still in its handshake is waiting for an
 *  interactive (browser) OAuth login. */
export function isMcpLoginPending(name, options = {}) {
  const scopeId = normalizeMcpScopeId(options);
  for (const entry of _pendingConnects) {
    if (entry.scopeId === scopeId && entry.name === name && entry.transport.oauth?.loginStarted) return true;
  }
  return false;
}
/**
 * Stored OAuth sign-in state of an HTTP/SSE server without configured
 * authentication: `{ signedIn }` (tokens stored for its exact URL), or null
 * for servers that never use MCP OAuth.
 */
export function getMcpServerOAuthState(cfg) {
  let url;
  try {
    url = resolveMcpOAuthUrl(cfg);
  } catch {
    return null;
  }
  if (!url || hasConfiguredMcpAuth(cfg)) return null;
  const signedIn = hasStoredMcpOAuthTokens(url);
  if (!signedIn) return { signedIn };
  // Who it is signed in as (never guessed: empty when the server named nobody)
  // and whether 계정 바꾸기 can make the provider show its account choice.
  const who = storedMcpOAuthIdentity(url);
  return {
    signedIn,
    account: typeof who?.account === 'string' ? who.account : '',
    workspace: typeof who?.workspace === 'string' ? who.workspace : '',
    forcedAccountChoice: who?.forcedChoice === true,
  };
}
/** 계정 바꾸기 of an HTTP/SSE server: a browser sign-in beside the stored one
 *  (oauth.mjs startMcpOAuthSwitch); `launch` opens the authorization URL. */
export function startMcpServerOAuthSwitch(cfg, launch, serverName) {
  const url = resolveMcpOAuthUrl(cfg);
  if (!url) throw new Error(`MCP server "${serverName}" does not use OAuth sign-in`);
  return startMcpOAuthSwitch({
    url,
    launch,
    serverName: mcpOAuthDisplayName(cfg, serverName),
    oauthClient: mcpOAuthClientFor(cfg, url),
    ...(googleMcpService(url) ? { fetchImpl: withGoogleMcp() } : {}),
  });
}
/** Store a switch's sign-in for the server's URL; resolves its rollback. */
export function commitMcpServerOAuthSwitch(cfg, signIn) {
  return commitMcpOAuthSwitch({ url: resolveMcpOAuthUrl(cfg), signIn });
}
/**
 * Log out of an HTTP/SSE server URL: delete the OAuth tokens and client
 * registration stored for it, shared by every server configured with that
 * exact URL, and drop them from live connections. `options.revoke` also
 * revokes the grant where the authorization server documents how; resolves
 * `{ revoked }`.
 */
export async function clearMcpServerOAuth(cfg, options = {}) {
  let url;
  try {
    url = resolveMcpOAuthUrl(cfg);
  } catch {
    // A config without a valid remote URL never connected, so never logged in.
    return { revoked: false };
  }
  if (url) return clearMcpOAuth({ url, revoke: options.revoke === true });
  return { revoked: false };
}
/**
 * Close a single server: for stdio transports first shut down the full child
 * process tree (close stdin -> grace -> tree kill) so wrapper chains such as
 * uvx/npx/uv never orphan grandchildren, then release the SDK client. The
 * tree teardown runs before client.close() because the SDK's own close()
 * only kills the direct child and discards the pid we need to walk the tree.
 */
async function _closeServer(server) {
  // A shared stdio connection closes only when its last scope releases it.
  const shared = server?.shared;
  if (shared) {
    shared.users.delete(server.registryKey);
    if (shared.users.size > 0) return;
    retireSharedConnection(server);
  }
  // A deliberate close is not a crash: suppress the unexpected-close report.
  if (server?.liveness) server.liveness.closing = true;
  const transport = server?.transport;
  transport?.oauth?.close();
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
// Register `name` in `scopeId` on the live shared connection for `shareKey`,
// when there is one. Returns whether it did.
function adoptSharedConnection(shareKey, name, cfg, scopeId, genAtStart) {
  const shared = shareKey ? _sharedStdio.get(shareKey) : null;
  if (!shared || shared.liveness.alive === false || shared.liveness.closing) return false;
  const registryKey = mcpServerRegistryKey(scopeId, name);
  const { key: _key, users, ...connection } = shared;
  users.add(registryKey);
  rememberServerConnector(name, cfg);
  servers.set(registryKey, { scopeId, registryKey, name, ...connection, cfg, shared, generation: genAtStart });
  _invalidateMcpToolFieldMemo();
  return true;
}
// Connects whose handshake has not finished yet: disconnectAll() must be able
// to see (and tear down) their transports, because `servers` only lists fully
// handshaken entries. Generation token aborts a connect that outlives a
// disconnectAll() issued mid-handshake (runtime close during boot connect).
async function connectServer(
  name,
  cfg,
  scopeId = DEFAULT_MCP_SCOPE_ID,
  genAtStart = currentConnectAbortGeneration(scopeId),
  options = {}
) {
  scopeId = normalizeMcpScopeId(scopeId);
  _knownMcpScopes.add(scopeId);
  const sdk = await loadMcpSdk();
  if (genAtStart !== currentConnectAbortGeneration(scopeId)) {
    // disconnectAll() ran while the SDK was loading: nothing spawned yet —
    // abort before creating a transport/child at all.
    throw new Error(`MCP server "${name}" connect aborted by shutdown`);
  }
  const shareKey = sharedStdioKey(name, cfg);
  if (adoptSharedConnection(shareKey, name, cfg, scopeId, genAtStart)) return;
  const client = createMcpClient(sdk, name, cfg, scopeId);
  const { transport, autoDetectAdvert, stderrTail, warnings } = createMcpTransport({
    name,
    cfg,
    sdk,
    log: mcpLog,
    strictEnv: cfg?._mixdogStrictEnv === true,
    // Only an explicit sign-in (beginMcpOAuthLogin) is interactive; it may
    // supply its own browser launcher to capture the authorization URL.
    oauthOptions: {
      interactive: options.interactive === true,
      ...(typeof options.openBrowser === 'function' ? { openBrowser: options.openBrowser } : {}),
    },
  });
  const liveness = trackMcpLiveness(client, name, cfg, stderrTail, transport);
  const pending = { scopeId, name, client, transport };
  _pendingConnects.add(pending);
  try {
    const { instructions, toolsResult, capabilities } = await runBoundedHandshake({
      name,
      cfg,
      client,
      transport,
      autoDetectAdvert,
      closeServer: (target) => _closeServer({ ...target, liveness }),
      stderrTail,
    });
    if (!toolsResult || !Array.isArray(toolsResult.tools)) {
      try {
        await _closeServer({ client, transport, liveness });
      } catch {
        /* ignore */
      }
      throw new Error(`[mcp-client] ListTools returned invalid shape for "${name}": missing or non-array tools field`);
    }
    if (genAtStart !== currentConnectAbortGeneration(scopeId)) {
      // disconnectAll() ran mid-handshake: never register — tear down.
      try {
        await _closeServer({ client, transport, liveness });
      } catch {
        /* ignore */
      }
      throw new Error(`MCP server "${name}" connect aborted by shutdown`);
    }
    // Another scope finished connecting the same server meanwhile: use its
    // process and release this one.
    if (adoptSharedConnection(shareKey, name, cfg, scopeId, genAtStart)) {
      await _closeServer({ client, transport, liveness });
      return;
    }
    const tools = mcpServerTools(name, capabilities, toolsResult.tools, cfg);
    const registryKey = mcpServerRegistryKey(scopeId, name);
    const connection = {
      client,
      transport,
      tools,
      instructions,
      capabilities,
      liveness,
      stderrTail,
      warnings: warnings || [],
    };
    const shared = shareKey ? { ...connection, key: shareKey, users: new Set([registryKey]) } : null;
    if (shared) _sharedStdio.set(shareKey, shared);
    rememberServerConnector(name, cfg);
    servers.set(registryKey, {
      scopeId,
      registryKey,
      name,
      ...connection,
      cfg,
      shared,
      generation: genAtStart,
    });
    if (capabilities?.tools?.listChanged && sdk.ToolListChangedNotificationSchema) {
      // A shared connection refreshes the tools of every scope using it.
      client.setNotificationHandler(sdk.ToolListChangedNotificationSchema, () =>
        Promise.all(
          [...(shared?.users ?? [registryKey])].map((key) => refreshServerTools(key, client, name, cfg, capabilities))
        )
      );
    }
    _invalidateMcpToolFieldMemo();
    mcpLog(`[mcp] connected: ${tools.length} tools — ${tools.map((t) => t.name).join(', ')}\n`);
  } catch (error) {
    await _closeServer({ client, transport, liveness });
    const scrubbed = scrubMcpOAuthError(error, cfg, oauthSecrets(transport));
    // A server that only needs an OAuth sign-in is not a broken server: the
    // sign-in was required, or an explicit one did not complete (cancelled,
    // denied, timed out or a failed exchange after it started, or cancelled
    // before it could). A failure after the sign-in obtained tokens is real.
    // A sign-in Google (or another provider) answered without a requested
    // scope is reported as its own error: the status row carries the message.
    const signInIncomplete =
      transport.oauth &&
      !isMcpOAuthScopeNotGranted(error) &&
      (isMcpOAuthReauthenticationRequired(error) ||
        (transport.oauth.loginStarted && !transport.oauth.loginCompleted) ||
        (transport.oauth.interactive && error?.code === MCP_CONNECT_CANCELLED));
    if (signInIncomplete && scrubbed && typeof scrubbed === 'object') {
      scrubbed.authRequired = true;
    }
    throw scrubbed;
  } finally {
    _pendingConnects.delete(pending);
  }
}

/**
 * Liveness of one server connection. The SDK calls client.onclose whenever
 * the transport closes (child exit, socket drop, our own close) — the server
 * is then dead and getMcpServerStatus reports it disconnected. onerror only
 * records the last error (parse/send hiccups do not mean the server died).
 * Handlers already installed on the client are chained, not replaced.
 */
function trackMcpLiveness(client, name, cfg, stderrTail, transport) {
  const liveness = { alive: true, closing: false, closedAt: 0, lastError: '' };
  const priorClose = client.onclose;
  const priorError = client.onerror;
  client.onclose = (...args) => {
    const unexpected = liveness.alive && !liveness.closing;
    liveness.alive = false;
    liveness.closedAt = Date.now();
    if (unexpected) {
      mcpLog(`${appendMcpStderrTail(`[mcp-client] MCP server "${name}" closed unexpectedly`, stderrTail())}\n`);
    }
    if (typeof priorClose === 'function') priorClose.apply(client, args);
  };
  client.onerror = (error, ...rest) => {
    liveness.lastError = scrubMcpConnectionMessage(
      error instanceof Error ? error.message : String(error),
      cfg,
      oauthSecrets(transport)
    );
    if (typeof priorError === 'function') priorError.call(client, error, ...rest);
  };
  return liveness;
}

/** The SDK client for one server, advertising the project root when known.
 *  A config marked `_mixdogRootsFollowScope` advertises its scope's current
 *  root (setMcpScopeRoot) and is told when it changes. */
function createMcpClient(sdk, name, cfg, scopeId = DEFAULT_MCP_SCOPE_ID) {
  const followScope = cfg?._mixdogRootsFollowScope === true;
  const fixedRoot = String(cfg?._mixdogProjectRoot || cfg?.cwd || '').trim();
  const currentRoot = () => (followScope ? _scopeRoots.get(normalizeMcpScopeId(scopeId)) || fixedRoot : fixedRoot);
  const client = new sdk.Client(
    { name: `mixdog-agent/${name}`, version: '1.0.0' },
    {
      capabilities: followScope || fixedRoot ? { roots: { listChanged: followScope } } : {},
      jsonSchemaValidator: createLazyOutputValidator(sdk.AjvJsonSchemaValidator),
    }
  );
  if ((followScope || fixedRoot) && sdk.ListRootsRequestSchema) {
    client.setRequestHandler(sdk.ListRootsRequestSchema, async () => {
      const root = currentRoot();
      if (!root) return { roots: [] };
      const rootPath = resolve(root);
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

/**
 * Set the root advertised by `scopeId`'s scope-following servers (plugin
 * servers, whose roots track the session cwd) and notify the connected ones
 * when it changed. No reconnect: the connection and its tools stay as they are.
 */
export function setMcpScopeRoot(scopeId, root) {
  const normalized = normalizeMcpScopeId(scopeId);
  const next = String(root || '').trim();
  if ((_scopeRoots.get(normalized) || '') === next) return;
  if (next) _scopeRoots.set(normalized, next);
  else _scopeRoots.delete(normalized);
  for (const [, server] of scopedServerEntries(normalized)) {
    if (server.cfg?._mixdogRootsFollowScope !== true) continue;
    Promise.resolve()
      .then(() => server.client?.sendRootsListChanged?.())
      // A server that rejects the roots notification keeps its previous roots.
      .catch(() => {});
  }
}

/** The connected server and tool definition a prefixed tool name refers to.
 *  The name's server part finds it directly; a name shortened to fit provider
 *  limits is found by scanning this scope's servers. A known server without
 *  the tool still resolves (definition null) so the call reaches the server. */
function resolveMcpToolTarget(scopeId, name) {
  const match = MCP_TOOL_NAME_RE.exec(String(name || ''));
  if (!match) return null;
  const direct = scopedServer(scopeId, match[1]);
  const directTool = direct?.tools?.find((tool) => tool.name === name);
  if (directTool) return { server: direct, definition: directTool };
  for (const [, server] of scopedServerEntries(scopeId)) {
    const definition = server.tools?.find((tool) => tool.name === name);
    if (definition) return { server, definition };
  }
  return direct ? { server: direct, definition: null } : null;
}

/** Protocol tools under the `mcp__<server>__` prefix plus the feature tools.
 *  Names that would exceed provider limits are shortened deterministically
 *  (`providerSafeMcpToolName`); a tool whose name was shortened carries the
 *  server's own tool name as `mcpToolName` and its server as `mcpServerName`.
 *  A plugin-declared server's tools carry its owner as `mcpPluginId`, so
 *  scope filtering never has to infer ownership from the server name. */
function mcpServerTools(name, capabilities, rawTools, cfg) {
  const protocolTools = (rawTools || []).map((t) => {
    const safeName = providerSafeMcpToolName(name, t.name);
    return {
      name: safeName,
      ...(safeName === `mcp__${name}__${t.name}` ? {} : { mcpToolName: t.name, mcpServerName: name }),
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
      ...(t.annotations && typeof t.annotations === 'object' ? { annotations: t.annotations } : {}),
    };
  });
  const tools = [...protocolTools, ...mcpFeatureTools(name, capabilities, protocolTools)];
  const pluginId = String(cfg?._mixdogPlugin?.id || '').trim();
  return pluginId ? tools.map((tool) => ({ ...tool, mcpPluginId: pluginId })) : tools;
}

// tools/list_changed refreshes run one at a time per server connection, so an
// older listing can never land after a newer one.
function refreshServerTools(registryKey, client, name, cfg, capabilities) {
  const live = servers.get(registryKey);
  if (!live || live.client !== client) return Promise.resolve();
  live.refreshTail = (live.refreshTail || Promise.resolve()).then(() =>
    runToolRefresh(registryKey, live, name, cfg, capabilities)
  );
  return live.refreshTail;
}

async function runToolRefresh(registryKey, live, name, cfg, capabilities) {
  if (servers.get(registryKey) !== live) return;
  try {
    const { sdkTimeoutMs } = resolveMcpRequestTimeouts(cfg);
    const refreshed = await listAllMcpTools(live.client, { timeout: sdkTimeoutMs });
    if (!refreshed || !Array.isArray(refreshed.tools)) {
      throw new Error('ListTools returned invalid shape: missing or non-array tools field');
    }
    if (servers.get(registryKey) !== live) return;
    live.tools = mcpServerTools(name, capabilities, refreshed.tools, cfg);
    // A scope adopting the connection later starts from the current listing.
    if (live.shared) live.shared.tools = live.tools;
    _invalidateMcpToolFieldMemo();
  } catch (error) {
    mcpLog(
      `[mcp-client] Failed to refresh tools for "${name}": ${scrubMcpConnectionMessage(error?.message || error, cfg, oauthSecrets(live.transport))}\n`
    );
  }
}

// Test seam for registry scoping without launching an MCP transport.
export function _registerMcpServerForTest(scopeId, name, rawTools = [], options = {}) {
  const normalizedScopeId = normalizeMcpScopeId(scopeId);
  const registryKey = mcpServerRegistryKey(normalizedScopeId, name);
  const tools = rawTools.map((tool) => {
    const prefixed = String(tool?.name || '').startsWith('mcp__');
    const leaf = String(tool?.name || '');
    const safeName = prefixed ? leaf : providerSafeMcpToolName(name, leaf);
    const shortened = !prefixed && safeName !== `mcp__${name}__${leaf}`;
    return {
      ...tool,
      name: safeName,
      ...(shortened ? { mcpToolName: leaf, mcpServerName: name } : {}),
      inputSchema: tool?.inputSchema || { type: 'object', properties: {} },
    };
  });
  const capabilities = options.capabilities || {};
  const pluginId = String(options.cfg?._mixdogPlugin?.id || '').trim();
  const server = {
    scopeId: normalizedScopeId,
    registryKey,
    name,
    tools: [...tools, ...mcpFeatureTools(name, capabilities, tools)].map((tool) =>
      pluginId ? { ...tool, mcpPluginId: pluginId } : tool
    ),
    warnings: options.warnings || [],
    cfg: options.cfg || {},
    instructions: options.instructions || '',
    capabilities,
    liveness: { alive: true, closing: false, closedAt: 0, lastError: '' },
    stderrTail: typeof options.stderrTail === 'function' ? options.stderrTail : () => '',
    transport: options.transport || null,
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
  rememberServerConnector(name, server.cfg);
  servers.set(registryKey, server);
  _invalidateMcpToolFieldMemo();
  return server;
}
