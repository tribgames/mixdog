#!/usr/bin/env node
/**
 * sync-runtime.mjs — re-vendor the mixdog brain into mixdog.
 *
 * mixdog treats the mixdog source like a vendored dependency (option B in
 * the port-plan discussion): 137 of 141 ported files are PURE copies of
 * mixdog/src, so we re-copy the whole agentLoop closure from upstream and then
 * re-apply a tiny set of standalone patches on top.
 *
 * Run after pulling mixdog changes:
 *     node scripts/sync-runtime.mjs            # copy + patch
 *     node scripts/sync-runtime.mjs --check    # report drift only, no writes
 *
 * The closure is recomputed live from the entry modules, so new upstream files
 * are picked up automatically. Standalone patches are anchor-based and
 * idempotent: if an anchor is missing (upstream moved it) the script FAILS LOUD
 * rather than silently shipping an unpatched file.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..');
const MIXDOG = join(CLI, '..', 'mixdog');
const MIXDOG_SRC = join(MIXDOG, 'src');
const RUNTIME = join(CLI, 'src', 'runtime');
const STATUS_VENDOR = join(CLI, 'src', 'vendor', 'statusline');
const SEARCH_RUNTIME = join(RUNTIME, 'search');
const MEMORY_RUNTIME = join(RUNTIME, 'memory');
const CHANNELS_RUNTIME = join(RUNTIME, 'channels');

const CHECK = process.argv.includes('--check');
const WRITE_ENABLED = process.env.MIXDOG_ENABLE_RUNTIME_SYNC === '1';

if (!CHECK && !WRITE_ENABLED) {
  console.error([
    '[sync] write mode is disabled.',
    '',
    'This script rewrites sync-managed runtime files from ../mixdog/src and can clobber local work.',
    'Use `node scripts/sync-runtime.mjs --check` to inspect drift without writing.',
    '',
    'To intentionally re-vendor after coordinating ownership, run:',
    '  MIXDOG_ENABLE_RUNTIME_SYNC=1 node scripts/sync-runtime.mjs',
  ].join('\n'));
  process.exit(2);
}

// Entry modules whose import closure defines the ported runtime.
const ENTRIES = [
  'agent/orchestrator/session/loop.mjs',
  'agent/orchestrator/session/manager.mjs',
  'agent/orchestrator/session/compact.mjs',
  'agent/orchestrator/session/context-utils.mjs',
  // Worker-thread modules referenced via new URL(...) are invisible to the
  // static import closure, so keep them as explicit sync roots.
  'agent/orchestrator/session/save-session-worker.mjs',
  'agent/orchestrator/providers/registry.mjs',
  'agent/orchestrator/smart-bridge/session-builder.mjs',
  'channels/index.mjs',
];

// ---------------------------------------------------------------------------
// 1. Compute the import closure from mixdog/src
// ---------------------------------------------------------------------------
const IMPORT_RE = /(?:from\s+['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\))/g;

function closure(entries, baseDir) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = join(baseDir, rel);
    if (!existsSync(abs)) continue;
    const src = readFileSync(abs, 'utf8');
    let m;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(src))) {
      const spec = m[1] || m[2];
      if (spec && spec.startsWith('.')) {
        const tgt = normalizeRel(join(dirname(rel), spec));
        queue.push(tgt);
      }
    }
  }
  return [...seen].filter((rel) => existsSync(join(baseDir, rel)));
}

function normalizeRel(p) {
  return relative(MIXDOG_SRC, join(MIXDOG_SRC, p)).split('\\').join('/');
}

// ---------------------------------------------------------------------------
// 2. Standalone patches — anchor-based, idempotent, fail-loud
// ---------------------------------------------------------------------------
const PATCHES = [
  {
    file: join(RUNTIME, 'shared', 'llm', 'http-agent.mjs'),
    name: 'undici global dispatcher (D7)',
    apply: patchHttpAgent,
  },
  {
    file: join(RUNTIME, 'shared', 'plugin-paths.mjs'),
    name: 'standalone data dir fallback (D12, mjs)',
    apply: (s) => patchPluginPaths(s, 'mjs'),
  },
  {
    file: join(CLI, 'src', 'lib', 'plugin-paths.cjs'),
    name: 'standalone data dir fallback (D12, cjs)',
    apply: (s) => patchPluginPaths(s, 'cjs'),
  },
  // D14 — providers write catalog-refresh diagnostics straight to stderr, which
  // tears through the full-screen TUI. Gate them behind an env var that the TUI
  // sets, so interactive runs stay clean while --plain/debug keep logs.
  {
    file: join(RUNTIME, 'agent', 'orchestrator', 'providers', 'anthropic-oauth.mjs'),
    name: 'anthropic-oauth standalone provider patches',
    apply: patchAnthropicOAuthStandalone,
  },
  {
    file: join(RUNTIME, 'agent', 'orchestrator', 'providers', 'anthropic.mjs'),
    name: 'anthropic 1h message cache fallback',
    apply: patchAnthropicMessageCacheFallback,
  },
  {
    file: join(RUNTIME, 'agent', 'orchestrator', 'providers', 'grok-oauth.mjs'),
    name: 'quiet provider stderr (D14, grok-oauth)',
    apply: (s) => patchProviderLog(s, 'grok-oauth'),
  },
  {
    file: join(RUNTIME, 'agent', 'orchestrator', 'providers', 'gemini.mjs'),
    name: 'quiet provider stderr (D14, gemini)',
    apply: (s) => patchProviderLog(s, 'gemini'),
  },
  {
    file: join(RUNTIME, 'agent', 'orchestrator', 'providers', 'openai-oauth.mjs'),
    name: 'quiet provider stderr (D14, openai-oauth)',
    apply: patchOpenAIOAuth,
  },
  {
    file: join(RUNTIME, 'agent', 'orchestrator', 'providers', 'openai-compat.mjs'),
    name: 'OpenAI-compatible image HTTP fallback',
    apply: patchOpenAICompatImageHttpFallback,
  },
  {
    file: join(RUNTIME, 'agent', 'orchestrator', 'mcp', 'client.mjs'),
    name: 'standalone MCP status metadata',
    apply: patchMcpClientStatusMetadata,
  },
  // D15 — standalone CLI consumes mixdog's session manager as the runtime
  // boundary. askSession still owns persistence/compaction/tool lifecycle, but
  // the TUI needs streamed text/usage/stage callbacks to render like an app.
  {
    file: join(RUNTIME, 'agent', 'orchestrator', 'session', 'manager.mjs'),
    name: 'session-manager UI callbacks (D15)',
    apply: patchSessionManagerUiCallbacks,
  },
  {
    file: join(RUNTIME, 'agent', 'orchestrator', 'context', 'collect.mjs'),
    name: 'lead skips bridge role catalog',
    apply: patchCollectLeadRoleCatalog,
  },
  {
    file: join(RUNTIME, 'agent', 'orchestrator', 'providers', 'media-normalization.mjs'),
    name: 'media normalization unwraps MCP content envelopes',
    apply: patchMediaNormalizationEnvelope,
  },
  {
    file: join(RUNTIME, 'agent', 'orchestrator', 'session', 'loop.mjs'),
    name: 'usage delta includes prompt tokens',
    apply: patchLoopUsageDeltaPrompt,
  },
  {
    file: join(CLI, 'src', 'rules', 'lead', '00-tool-lead.md'),
    name: 'standalone lead tool_search wording',
    apply: patchLeadToolSearchRule,
  },
  {
    file: join(CLI, 'src', 'rules', 'lead', '01-general.md'),
    name: 'standalone lead output wording',
    apply: patchLeadGeneralRule,
  },
  {
    file: join(CLI, 'src', 'rules', 'lead', '02-channels.md'),
    name: 'standalone lead channel wording',
    apply: patchLeadChannelsRule,
  },
  {
    file: join(CLI, 'src', 'rules', 'lead', '04-workflow.md'),
    name: 'standalone lead workflow wording',
    apply: patchLeadWorkflowRule,
  },
  {
    file: join(CLI, 'src', 'rules', 'lead', '03-team.md'),
    name: 'standalone lead team wording',
    apply: patchLeadTeamRule,
  },
  {
    file: join(CLI, 'src', 'rules', 'shared', '01-tool.md'),
    name: 'standalone shared tool wording',
    apply: patchSharedToolRule,
  },
  {
    file: join(CHANNELS_RUNTIME, 'index.mjs'),
    name: 'standalone channels local memory-client import',
    apply: patchChannelsStandalonePaths,
  },
  // Statusline vendor — route-meta.mjs upstream lives next to claude-current in
  // mixdog/src/gateway and pulls sibling runtime modules via ../shared/** and
  // ../agent/**. Vendored under src/vendor/statusline/src/gateway, those
  // relatives must re-point into the synced runtime tree (src/runtime/**).
  {
    file: join(STATUS_VENDOR, 'src', 'gateway', 'route-meta.mjs'),
    name: 'statusline route-meta runtime imports (vendor re-point)',
    apply: patchStatuslineGatewayRuntimeImports,
  },
  {
    file: join(STATUS_VENDOR, 'src', 'gateway', 'session-routes.mjs'),
    name: 'statusline session-routes runtime imports (vendor re-point)',
    apply: patchStatuslineGatewayRuntimeImports,
  },
  {
    file: join(STATUS_VENDOR, 'bin', 'statusline-lib.mjs'),
    name: 'statusline standalone skips gateway override',
    apply: patchStatuslineLibStandalone,
  },
  {
    file: join(STATUS_VENDOR, 'bin', 'statusline-route.mjs'),
    name: 'statusline route standalone data dir',
    apply: patchStatuslineRouteStandalone,
  },
  {
    file: join(STATUS_VENDOR, 'src', 'gateway', 'claude-current.mjs'),
    name: 'statusline claude-current standalone data dir',
    apply: (s) => patchStatuslineStandaloneDataDir(s, "'..', '..', '..', '..', '..'"),
  },
];

/**
 * D14 — wrap provider catalog-refresh stderr writes in an env gate so the TUI
 * can silence them. Idempotent (skips if already gated) and fail-loud (throws
 * if neither anchor line is present, so an upstream rename is surfaced).
 *
 * Targets both `[provider] catalog refreshed (...)` and `... refresh failed`.
 */
function patchProviderLog(src, provider) {
  const GATE = 'if (!process.env.MIXDOG_QUIET_PROVIDER_LOG) process.stderr.write(';
  if (src.includes('MIXDOG_QUIET_PROVIDER_LOG')) return { text: src, already: true };
  // Match the bare `process.stderr.write(` immediately preceding a
  // `[provider] catalog refresh` literal, regardless of refreshed/failed.
  const re = new RegExp(
    `process\\.stderr\\.write\\((\`\\[${provider}\\] catalog refresh)`,
    'g',
  );
  if (!re.test(src)) {
    throw new Error(`[sync] provider-log anchor not found in ${provider} — upstream changed the catalog-refresh log; reconcile patch manually.`);
  }
  re.lastIndex = 0;
  const text = src.replace(re, (_m, lit) => `${GATE}${lit}`);
  return { text, already: false };
}

function patchAnthropicOAuthStandalone(src) {
  let s = patchProviderLog(src, 'anthropic-oauth').text;
  const quietReplacements = [
    [
      'process.stderr.write(`[anthropic-oauth] Token ${reason}, refreshing...\\n`);',
      'if (!process.env.MIXDOG_QUIET_PROVIDER_LOG) process.stderr.write(`[anthropic-oauth] Token ${reason}, refreshing...\\n`);',
    ],
    [
      'process.stderr.write(`[anthropic-oauth] listModels fetch failed (${err.message})\\n`);',
      'if (!process.env.MIXDOG_QUIET_PROVIDER_LOG) process.stderr.write(`[anthropic-oauth] listModels fetch failed (${err.message})\\n`);',
    ],
  ];
  for (const [from, to] of quietReplacements) {
    if (s.includes(to)) continue;
    if (s.includes(from)) s = s.replace(from, to);
    else throw new Error('[sync] anthropic-oauth quiet log anchor not found — reconcile standalone wording patch manually.');
  }
  const replacements = [
    [
      'Anthropic OAuth refresh token not available. Run "claude login" to re-authenticate.',
      'Anthropic OAuth refresh token not available. Run /auth anthropic-oauth or /providers in mixdog to re-authenticate.',
    ],
    [
      'Anthropic OAuth credentials not found. Run "claude login" to authenticate.',
      'Anthropic OAuth credentials not found. Run /auth anthropic-oauth or /providers in mixdog to authenticate.',
    ],
  ];
  let changed = false;
  for (const [from, to] of replacements) {
    if (s.includes(from)) {
      s = s.replaceAll(from, to);
      changed = true;
    } else if (!s.includes(to)) {
      throw new Error('[sync] anthropic-oauth auth guidance anchor not found — reconcile standalone wording patch manually.');
    }
  }
  s = patchAnthropicMessageCacheFallback(s).text;
  return { text: s, already: src === s || (!changed && src.includes('MIXDOG_QUIET_PROVIDER_LOG')) };
}

function patchAnthropicMessageCacheFallback(src) {
  let s = src;
  const from = "messages: pick('messages', CACHE_TTL_VOLATILE),";
  const to = "messages: pick('messages', CACHE_TTL_STABLE),";
  if (s.includes(from)) {
    s = s.replace(from, to);
  } else if (!s.includes(to)) {
    throw new Error('[sync] anthropic message cache fallback anchor not found — reconcile BP4 TTL patch manually.');
  }
  if (!s.includes('const latestToolResultTailIdx = () =>')) {
    const helperAnchor = [
      '    };',
      '',
      '    // tier3 — locate the sentinel-tagged system-reminder user message.',
    ].join('\n');
    const helperReplacement = [
      '    };',
      '    const latestToolResultTailIdx = () => {',
      '        // Claude/pi refs allow cache_control on tool_result blocks. Keep this',
      '        // narrower than "last message" so a fresh user prompt or steering text',
      '        // never becomes a 1h breakpoint.',
      '        for (let i = sanitizedMessages.length - 1; i >= 0; i--) {',
      '            const msg = sanitizedMessages[i];',
      "            if (msg?.role !== 'user' || !Array.isArray(msg.content) || msg.content.length === 0) continue;",
      '            const lastBlock = msg.content[msg.content.length - 1];',
      "            if (lastBlock?.type === 'tool_result') return i;",
      '        }',
      '        return -1;',
      '    };',
      '',
      '    // tier3 — locate the sentinel-tagged system-reminder user message.',
    ].join('\n');
    if (s.includes(helperAnchor)) {
      s = s.replace(helperAnchor, helperReplacement);
    } else {
      throw new Error('[sync] anthropic message cache helper anchor not found — reconcile tool_result BP4 patch manually.');
    }
  }
  const legacyTailFrom = 'const candidates = [previousUserTextAnchorIdx(), sanitizedMessages.length - 1];';
  const previousOnlyTailFrom = 'const candidates = [previousUserTextAnchorIdx()];';
  const safeTailFirst = 'const candidates = [latestToolResultTailIdx(), previousUserTextAnchorIdx()];';
  const previousThenTail = 'const candidates = [previousUserTextAnchorIdx(), latestToolResultTailIdx()];';
  if (s.includes(legacyTailFrom)) {
    s = s.replace(legacyTailFrom, safeTailFirst);
  } else if (s.includes(previousOnlyTailFrom)) {
    s = s.replace(previousOnlyTailFrom, safeTailFirst);
  } else if (s.includes(previousThenTail)) {
    s = s.replace(previousThenTail, safeTailFirst);
  } else if (!s.includes(safeTailFirst)) {
    throw new Error('[sync] anthropic message cache anchor not found — reconcile current-turn BP4 patch manually.');
  }
  return { text: s, already: src === s };
}


function patchOpenAIOAuth(src) {
  const quieted = patchProviderLog(src, 'openai-oauth').text;
  return patchOpenAIOAuthImageHttpFallback(quieted);
}

function patchOpenAIOAuthImageHttpFallback(src) {
  if (
    src.includes('messagesHaveImageContent(messages)') &&
    src.includes("dispatchHttp(hasImageContent ? 'image_content' : 'forced')")
  ) {
    return { text: src, already: true };
  }
  let s = src;
  const importAnchor = `import {
    normalizeContentForOpenAIResponses,
    splitToolContentForOpenAIResponses,
} from './media-normalization.mjs';`;
  if (!s.includes(importAnchor)) {
    throw new Error('[sync] openai-oauth media-normalization import anchor not found — reconcile image HTTP fallback patch manually.');
  }
  s = s.replace(importAnchor, `import {
    contentHasImage,
    normalizeContentForOpenAIResponses,
    splitToolContentForOpenAIResponses,
} from './media-normalization.mjs';`);

  const helperAnchor = `    return out;
}
export function buildRequestBody(messages, model, tools, sendOpts) {`;
  if (!s.includes(helperAnchor)) {
    throw new Error('[sync] openai-oauth buildRequestBody helper anchor not found — reconcile image HTTP fallback patch manually.');
  }
  s = s.replace(helperAnchor, `    return out;
}

function messagesHaveImageContent(messages) {
    return (messages || []).some((m) => contentHasImage(m?.content));
}

export function buildRequestBody(messages, model, tools, sendOpts) {`);

  const bodyAnchor = `        const body = await _bodyP;
        // poolKey ≠ cacheKey by design`;
  if (!s.includes(bodyAnchor)) {
    throw new Error('[sync] openai-oauth body await anchor not found — reconcile image HTTP fallback patch manually.');
  }
  s = s.replace(bodyAnchor, `        const body = await _bodyP;
        const hasImageContent = messagesHaveImageContent(messages);
        // poolKey ≠ cacheKey by design`);

  const forcedAnchor = `        if (opts.forceHttpFallback === true
            || this._forceHttpFallback
            || _envFlag('MIXDOG_OPENAI_OAUTH_FORCE_HTTP_FALLBACK', false)) {
            return dispatchHttp('forced');
        }`;
  if (!s.includes(forcedAnchor)) {
    throw new Error('[sync] openai-oauth forced HTTP fallback anchor not found — reconcile image HTTP fallback patch manually.');
  }
  s = s.replace(forcedAnchor, `        if (opts.forceHttpFallback === true
            || this._forceHttpFallback
            || hasImageContent
            || _envFlag('MIXDOG_OPENAI_OAUTH_FORCE_HTTP_FALLBACK', false)) {
            return dispatchHttp(hasImageContent ? 'image_content' : 'forced');
        }`);
  return { text: s, already: false };
}

function patchOpenAICompatImageHttpFallback(src) {
  if (
    src.includes('messagesHaveImageContent(messages)') &&
    src.includes('useXaiResponsesWebSocket(opts, this.config) && !messagesHaveImageContent(messages)')
  ) {
    return { text: src, already: true };
  }
  let s = src;
  const importAnchor = `import {
    normalizeContentForOpenAIChat,
    normalizeContentForOpenAIResponses,
    splitToolContentForOpenAIChat,
    splitToolContentForOpenAIResponses,
} from './media-normalization.mjs';`;
  if (!s.includes(importAnchor)) {
    throw new Error('[sync] openai-compat media-normalization import anchor not found — reconcile image HTTP fallback patch manually.');
  }
  s = s.replace(importAnchor, `import {
    contentHasImage,
    normalizeContentForOpenAIChat,
    normalizeContentForOpenAIResponses,
    splitToolContentForOpenAIChat,
    splitToolContentForOpenAIResponses,
} from './media-normalization.mjs';`);

  const helperAnchor = `    return out;
}
function toOpenAITools(tools) {`;
  if (!s.includes(helperAnchor)) {
    throw new Error('[sync] openai-compat toOpenAIMessages helper anchor not found — reconcile image HTTP fallback patch manually.');
  }
  s = s.replace(helperAnchor, `    return out;
}

function messagesHaveImageContent(messages) {
    return (messages || []).some((m) => contentHasImage(m?.content));
}

function toOpenAITools(tools) {`);

  const wsAnchor = `            if (useXaiResponsesWebSocket(opts, this.config)) {
                return await this._doSendXaiResponsesWebSocket(messages, useModel, tools, opts);
            }`;
  if (!s.includes(wsAnchor)) {
    throw new Error('[sync] openai-compat xai websocket selection anchor not found — reconcile image HTTP fallback patch manually.');
  }
  s = s.replace(wsAnchor, `            if (useXaiResponsesWebSocket(opts, this.config) && !messagesHaveImageContent(messages)) {
                return await this._doSendXaiResponsesWebSocket(messages, useModel, tools, opts);
            }`);
  return { text: s, already: false };
}

function patchMcpClientStatusMetadata(src) {
  let s = src;
  let changed = false;
  if (!s.includes('function mcpLog(line)')) {
    const memoAnchor = `function _invalidateMcpToolFieldMemo() {
    _mcpToolFieldMemo.clear();
}`;
    if (!s.includes(memoAnchor)) {
      throw new Error('[sync] mcp client log helper anchor not found — reconcile MCP status patch manually.');
    }
    s = s.replace(memoAnchor, `${memoAnchor}
function mcpLog(line) {
    if (process.env.MIXDOG_QUIET_MCP_LOG) return;
    process.stderr.write(line);
}`);
    changed = true;
  }
  if (s.includes('process.stderr.write(')) {
    s = s.replaceAll('process.stderr.write(', 'mcpLog(');
    s = s.replace(`function mcpLog(line) {
    if (process.env.MIXDOG_QUIET_MCP_LOG) return;
    mcpLog(line);
}`, `function mcpLog(line) {
    if (process.env.MIXDOG_QUIET_MCP_LOG) return;
    process.stderr.write(line);
}`);
    changed = true;
  }
  const throwAnchor = '        throw new Error(`[mcp-client] ${failures.length} MCP server(s) failed to connect — ${detail}`);';
  const throwReplacement = `        const err = new Error(\`[mcp-client] \${failures.length} MCP server(s) failed to connect — \${detail}\`);
        err.failures = failures;
        throw err;`;
  if (s.includes(throwAnchor)) {
    s = s.replace(throwAnchor, throwReplacement);
    changed = true;
  } else if (!s.includes('err.failures = failures;')) {
    throw new Error('[sync] mcp client failure metadata anchor not found — reconcile MCP status patch manually.');
  }

  if (!s.includes('export function getMcpServerStatus()')) {
    const toolsAnchor = `export function getMcpTools() {
    const tools = [];
    for (const server of servers.values()) {
        tools.push(...server.tools);
    }
    return tools;
}`;
    if (!s.includes(toolsAnchor)) {
      throw new Error('[sync] mcp client getMcpTools anchor not found — reconcile MCP status patch manually.');
    }
    s = s.replace(toolsAnchor, `${toolsAnchor}
export function getMcpServerStatus() {
    return [...servers.values()].map((server) => ({
        name: server.name,
        connected: true,
        toolCount: Array.isArray(server.tools) ? server.tools.length : 0,
        tools: (server.tools || []).map((tool) => ({
            name: tool.name,
            description: tool.description || '',
        })),
        transport: server.cfg?.pluginCache
            ? 'pluginCache'
            : server.cfg?.autoDetect
                ? 'autoDetect'
                : server.cfg?.transport === 'http' || server.cfg?.url
                    ? 'http'
                    : 'stdio',
    }));
}`);
    changed = true;
  }
  return { text: s, already: !changed };
}

function patchSessionManagerUiCallbacks(src) {
  src = src
    .replace(
      "import { fetchOAuthUsageSnapshot } from '../../../gateway/oauth-usage.mjs';",
      "import { fetchOAuthUsageSnapshot } from '../providers/oauth-usage.mjs';",
    )
    .replace(
      "} from '../../../gateway/route-meta.mjs';",
      "} from '../../../../vendor/statusline/src/gateway/route-meta.mjs';",
    )
    .replace("messages.push({ role: 'assistant', content: 'Session context noted.' });", "messages.push({ role: 'assistant', content: '.' });")
    .replace("messages.push({ role: 'assistant', content: 'Understood.' });", "messages.push({ role: 'assistant', content: '.' });")
    .replace("messages.push({ role: 'assistant', content: 'Understood. I have the files in context.' });", "messages.push({ role: 'assistant', content: '.' });");
  if (
    src.includes('askOpts = {}') &&
    src.includes('askOpts?.onTextDelta') &&
    src.includes('askOpts?.onReasoningDelta') &&
    src.includes('compactSessionMessages') &&
    src.includes('_buildLeadRules()') &&
    src.includes('skipRoleCatalog: opts.owner !== \'bridge\'') &&
    src.includes("Object.prototype.hasOwnProperty.call(opts, 'effort')") &&
    src.includes('MIXDOG_QUIET_SESSION_LOG') &&
    src.includes('opts.skipSkills ? []')
  ) {
    return { text: src, already: true };
  }
  let s = src;
  const importAnchor = "import { agentLoop } from './loop.mjs';";
  if (!s.includes(importAnchor)) {
    throw new Error('[sync] session-manager compact import anchor not found — reconcile compact patch manually.');
  }
  s = s.replace(
    importAnchor,
    `${importAnchor}
import { compactActiveTurn, compactMessages } from './compact.mjs';
import { estimateMessagesTokens, estimateRequestReserveTokens } from './context-utils.mjs';`,
  );

  const sig = 'export async function askSession(sessionId, prompt, context, onToolCall, cwdOverride, explicitPrefetch) {';
  if (!s.includes(sig)) {
    throw new Error('[sync] session-manager askSession signature anchor not found — reconcile UI callback patch manually.');
  }
  s = s.replace(
    sig,
    'export async function askSession(sessionId, prompt, context, onToolCall, cwdOverride, explicitPrefetch, askOpts = {}) {',
  );

  const usageAnchor = '                    onUsageDelta: (d) => persistIterationMetrics(d).catch(() => {}),';
  if (!s.includes(usageAnchor)) {
    throw new Error('[sync] session-manager onUsageDelta anchor not found — reconcile UI callback patch manually.');
  }
  s = s.replace(
    usageAnchor,
    `                    onTextDelta: typeof askOpts?.onTextDelta === 'function' ? askOpts.onTextDelta : undefined,
                    onReasoningDelta: typeof askOpts?.onReasoningDelta === 'function' ? askOpts.onReasoningDelta : undefined,
                    onUsageDelta: (d) => {
                        persistIterationMetrics(d).catch(() => {});
                        try { askOpts?.onUsageDelta?.(d); } catch {}
                    },`,
  );

  const stageAnchor = `                    onStageChange: (stage) => updateSessionStage(sessionId, stage),
                    onStreamDelta: () => markSessionStreamDelta(sessionId).catch(() => {}),`;
  if (!s.includes(stageAnchor)) {
    throw new Error('[sync] session-manager stage/stream anchors not found — reconcile UI callback patch manually.');
  }
  s = s.replace(
    stageAnchor,
    `                    onStageChange: (stage) => {
                        updateSessionStage(sessionId, stage);
                        try { askOpts?.onStageChange?.(stage); } catch {}
                    },
                    onStreamDelta: () => {
                        markSessionStreamDelta(sessionId).catch(() => {});
                        try { askOpts?.onStreamDelta?.(); } catch {}
                    },`,
  );

  const skillsAnchor = '    const skills = collectSkillsCached(opts.cwd);';
  if (!s.includes(skillsAnchor)) {
    throw new Error('[sync] session-manager skills anchor not found — reconcile CLI skipSkills patch manually.');
  }
  s = s.replace(skillsAnchor, '    const skills = opts.skipSkills ? [] : collectSkillsCached(opts.cwd);');

  const bridgeRulesFunctionAnchor = `function _buildBridgeRules() {
    if (!_rulesBuilder || typeof _rulesBuilder.buildBridgeInjectionContent !== 'function') return '';
    const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT
        || join(homedir(), '.claude', 'plugins', 'marketplaces', DEFAULT_MARKETPLACE, 'external_plugins', DEFAULT_PLUGIN);
    const DATA_DIR = resolvePluginData();
    const RULES_DIR = join(PLUGIN_ROOT, 'rules');
    const mtime = maxMtimeRecursive([
        join(RULES_DIR, 'shared'),
        join(RULES_DIR, 'bridge'),
        join(DATA_DIR, 'roles'),
        join(DATA_DIR, 'mixdog-config.json'),
    ]);
    if (_bridgeRulesCache !== null && mtime <= _bridgeRulesMtime) {
        return _bridgeRulesCache;
    }
    try {
        const built = _rulesBuilder.buildBridgeInjectionContent({ PLUGIN_ROOT, DATA_DIR });
        _bridgeRulesCache = built;
        _bridgeRulesMtime = mtime;
        return built;
    } catch (e) {
        throw new Error(\`[session] bridge common rules build failed: \${e.message}\`);
    }
}`;
  if (!s.includes(bridgeRulesFunctionAnchor)) {
    throw new Error('[sync] session-manager _buildBridgeRules anchor not found — reconcile lead rules patch manually.');
  }
  s = s.replace(bridgeRulesFunctionAnchor, `${bridgeRulesFunctionAnchor}

let _leadRulesCache = null;
let _leadRulesMtime = 0;
function _buildLeadRules() {
    if (!_rulesBuilder || typeof _rulesBuilder.buildInjectionContent !== 'function') return '';
    const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT
        || join(homedir(), '.claude', 'plugins', 'marketplaces', DEFAULT_MARKETPLACE, 'external_plugins', DEFAULT_PLUGIN);
    const DATA_DIR = resolvePluginData();
    const RULES_DIR = join(PLUGIN_ROOT, 'rules');
    const mtime = maxMtimeRecursive([
        join(RULES_DIR, 'shared'),
        join(RULES_DIR, 'lead'),
        join(DATA_DIR, 'history'),
        join(DATA_DIR, 'mixdog-config.json'),
        join(DATA_DIR, 'user-workflow.json'),
        join(DATA_DIR, 'user-workflow.md'),
    ]);
    if (_leadRulesCache !== null && mtime <= _leadRulesMtime) {
        return _leadRulesCache;
    }
    try {
        const built = _rulesBuilder.buildInjectionContent({ PLUGIN_ROOT, DATA_DIR });
        _leadRulesCache = built;
        _leadRulesMtime = mtime;
        return built;
    } catch (e) {
        throw new Error(\`[session] lead rules build failed: \${e.message}\`);
    }
}`);

  const bridgeRulesAnchor = `    const bridgeRulesRole = opts.role || profile?.taskType || null;
    const bridgeRules = opts.skipBridgeRules ? '' : _buildBridgeRules();
    const roleSpecific = opts.skipBridgeRules ? '' : _buildRoleSpecific(bridgeRulesRole);`;
  if (!s.includes(bridgeRulesAnchor)) {
    throw new Error('[sync] session-manager bridge rules selection anchor not found — reconcile lead rules patch manually.');
  }
  s = s.replace(bridgeRulesAnchor, `    const bridgeRulesRole = opts.role || profile?.taskType || null;
    const injectedRules = opts.skipBridgeRules ? '' : (opts.owner === 'bridge' ? _buildBridgeRules() : _buildLeadRules());
    const roleSpecific = opts.owner === 'bridge' && !opts.skipBridgeRules ? _buildRoleSpecific(bridgeRulesRole) : '';`);

  const composeRulesAnchor = `        bridgeRules: bridgeRules || undefined,
        roleSpecific: roleSpecific || undefined,`;
  if (!s.includes(composeRulesAnchor)) {
    throw new Error('[sync] session-manager compose bridgeRules anchor not found — reconcile lead rules patch manually.');
  }
  s = s.replace(composeRulesAnchor, `        bridgeRules: injectedRules || undefined,
        roleSpecific: roleSpecific || undefined,
        skipRoleCatalog: opts.owner !== 'bridge',`);

  const effortAnchor = '    const effort = presetObj?.effort || opts.effort || null;';
  if (!s.includes(effortAnchor)) {
    throw new Error('[sync] session-manager effort precedence anchor not found — reconcile effort patch manually.');
  }
  s = s.replace(effortAnchor, `    const effort = Object.prototype.hasOwnProperty.call(opts, 'effort')
        ? (opts.effort || null)
        : (presetObj?.effort || null);`);

  const quietReplacements = [
    [
      'if (tools.length !== before) {\n            process.stderr.write(`[session] schemaAllowedTools=${callerAllow.join(\',\')} kept ${tools.length}/${before} tools\\n`);\n        }',
      'if (tools.length !== before && !process.env.MIXDOG_QUIET_SESSION_LOG) {\n            process.stderr.write(`[session] schemaAllowedTools=${callerAllow.join(\',\')} kept ${tools.length}/${before} tools\\n`);\n        }',
      'schemaAllowedTools quiet-log anchor',
    ],
    [
      'if (tools.length !== before) {\n            process.stderr.write(`[session] disallowedTools=${callerDeny.join(\',\')} stripped ${before - tools.length} tools\\n`);\n        }',
      'if (tools.length !== before && !process.env.MIXDOG_QUIET_SESSION_LOG) {\n            process.stderr.write(`[session] disallowedTools=${callerDeny.join(\',\')} stripped ${before - tools.length} tools\\n`);\n        }',
      'disallowedTools quiet-log anchor',
    ],
    [
      'if (tools.length !== before) {\n            process.stderr.write(`[session] bridgeHidden stripped ${before - tools.length} tools\\n`);\n        }',
      'if (tools.length !== before && !process.env.MIXDOG_QUIET_SESSION_LOG) {\n            process.stderr.write(`[session] bridgeHidden stripped ${before - tools.length} tools\\n`);\n        }',
      'bridgeHidden quiet-log anchor',
    ],
    [
      'if (resolvedRole) {\n        process.stderr.write(`[session] role=${resolvedRole} permission=${permission || \'full\'} toolPermission=${toolPermission || \'full\'} tools=${tools.length}\\n`);\n    }',
      'if (resolvedRole && !process.env.MIXDOG_QUIET_SESSION_LOG) {\n        process.stderr.write(`[session] role=${resolvedRole} permission=${permission || \'full\'} toolPermission=${toolPermission || \'full\'} tools=${tools.length}\\n`);\n    }',
      'role quiet-log anchor',
    ],
    [
      'process.stderr.write(`[bridge-close] ${parts.join(\' \')}\\n`);',
      'if (!process.env.MIXDOG_QUIET_SESSION_LOG) process.stderr.write(`[bridge-close] ${parts.join(\' \')}\\n`);',
      'bridge-close quiet-log anchor',
    ],
  ];
  for (const [from, to, label] of quietReplacements) {
    if (!s.includes(from)) {
      throw new Error(`[sync] session-manager ${label} not found — reconcile quiet-log patch manually.`);
    }
    s = s.replace(from, to);
  }

  const compactAnchor = `export async function clearSessionMessages(sessionId) {
    const session = loadSession(sessionId);
    if (!session)
        return false;
    // Don't resurrect a closed session just to clear its messages.
    if (session.closed === true) return false;
    session.messages = (session.messages || []).filter(m => m && m.role === 'system');
    session.totalInputTokens = 0;
    session.totalOutputTokens = 0;
    session.updatedAt = Date.now();
    await saveSessionAsync(session, { expectedGeneration: session.generation });
    return true;
}
export async function updateSessionStatus(id, status) {`;
  if (!s.includes(compactAnchor)) {
    throw new Error('[sync] session-manager compact function anchor not found — reconcile compact patch manually.');
  }
  s = s.replace(compactAnchor, `export async function clearSessionMessages(sessionId) {
    const session = loadSession(sessionId);
    if (!session)
        return false;
    // Don't resurrect a closed session just to clear its messages.
    if (session.closed === true) return false;
    session.messages = (session.messages || []).filter(m => m && m.role === 'system');
    session.totalInputTokens = 0;
    session.totalOutputTokens = 0;
    session.updatedAt = Date.now();
    await saveSessionAsync(session, { expectedGeneration: session.generation });
    return true;
}
export async function compactSessionMessages(sessionId) {
    const session = loadSession(sessionId);
    if (!session) return null;
    if (session.closed === true) return null;
    const beforeMessages = Array.isArray(session.messages) ? session.messages : [];
    const beforeTokens = estimateMessagesTokens(beforeMessages);
    const nonSystem = beforeMessages.filter(m => m?.role !== 'system');
    let currentTurnStart = -1;
    for (let i = nonSystem.length - 1; i >= 0; i -= 1) {
        if (nonSystem[i]?.role === 'user') {
            currentTurnStart = i;
            break;
        }
    }
    const boundary = positiveContextWindow(session.compactBoundaryTokens)
        || positiveContextWindow(session.autoCompactTokenLimit)
        || positiveContextWindow(session.contextWindow);
    if (!boundary) {
        throw new Error('compact: no context window is available for this session');
    }
    const reserveTokens = estimateRequestReserveTokens(session.tools || []);
    if (currentTurnStart <= 0) {
        return {
            changed: false,
            reason: 'nothing to compact',
            beforeMessages: beforeMessages.length,
            afterMessages: beforeMessages.length,
            beforeTokens,
            afterTokens: beforeTokens,
            budgetTokens: boundary,
            reserveTokens,
        };
    }
    let beforeEncoded = '';
    try { beforeEncoded = JSON.stringify(beforeMessages); } catch { beforeEncoded = ''; }
    let compacted;
    try {
        compacted = compactMessages(beforeMessages, boundary, { reserveTokens, force: true });
    } catch (err) {
        try {
            process.stderr.write(\`[session] manual compact fallback (sess=\${sessionId}): \${err?.message || err}\\n\`);
        } catch { /* best-effort */ }
        compacted = compactActiveTurn(beforeMessages, boundary, { reserveTokens });
    }
    const afterTokens = estimateMessagesTokens(compacted);
    let afterEncoded = '';
    try { afterEncoded = JSON.stringify(compacted); } catch { afterEncoded = ''; }
    const changed = beforeEncoded && afterEncoded
        ? beforeEncoded !== afterEncoded
        : (compacted.length !== beforeMessages.length || afterTokens !== beforeTokens);
    session.messages = compacted;
    session.updatedAt = Date.now();
    await saveSessionAsync(session, { expectedGeneration: session.generation });
    return {
        changed,
        beforeMessages: beforeMessages.length,
        afterMessages: compacted.length,
        beforeTokens,
        afterTokens,
        budgetTokens: boundary,
        reserveTokens,
    };
}
export async function updateSessionStatus(id, status) {`);
  return { text: s, already: false };
}

function patchCollectLeadRoleCatalog(src) {
  let s = src.replace('volatileParts.push(`# cwd\\n${opts.cwd.trim()}`);', 'volatileParts.push(`cwd: ${opts.cwd.trim()}`);');
  s = s.replace(`    const permission = opts.permission || opts.roleTemplate?.permission || null;
    if (permission) {`, `    const permission = opts.permission || opts.roleTemplate?.permission || null;
    const permissionName = typeof permission === 'string'
        ? permission.trim().toLowerCase()
        : '';
    if (permission && permissionName !== 'full') {`);
  s = s.replace('volatileParts.push(`# permission\\n${permissionLabel} — ${allow}.`);', 'volatileParts.push(`permission: ${permissionLabel} — ${allow}.`);');
  if (s.includes('const roleCatalogScoped = opts.skipRoleCatalog')) {
    return { text: s, already: true };
  }
  const anchor = '    const roleCatalogScoped = loadScopedRoleCatalog(opts.role || null, opts.provider || null);';
  if (!s.includes(anchor)) {
    throw new Error('[sync] collect roleCatalog anchor not found — reconcile lead catalog patch manually.');
  }
  const text = s.replace(anchor, `    const roleCatalogScoped = opts.skipRoleCatalog
        ? ''
        : loadScopedRoleCatalog(opts.role || null, opts.provider || null);`);
  return { text, already: false };
}

function patchMediaNormalizationEnvelope(src) {
  if (src.includes('function contentParts(content)')) {
    return { text: src, already: true };
  }
  let s = src;
  const insertAfter = `function stringifyFallback(value) {
    try { return JSON.stringify(value); } catch { return String(value); }
}`;
  const helper = `${insertAfter}

function contentParts(content) {
    if (Array.isArray(content)) return content;
    if (content && typeof content === 'object' && Array.isArray(content.content)) {
        return content.content;
    }
    return null;
}`;
  if (!s.includes(insertAfter)) {
    throw new Error('[sync] media-normalization stringifyFallback anchor not found — reconcile content envelope patch manually.');
  }
  s = s.replace(insertAfter, helper);
  const replacements = [
    [
      `export function contentHasImage(content) {
    if (!Array.isArray(content)) return false;
    return content.some((part) => !!imageUrlFromPart(part));
}`,
      `export function contentHasImage(content) {
    const parts = contentParts(content);
    if (!parts) return false;
    return parts.some((part) => !!imageUrlFromPart(part));
}`,
    ],
    [
      `export function contentToText(content, fallback = '') {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return content == null ? fallback : stringifyFallback(content);
    const text = content.map(jsonFallbackFromPart).filter(Boolean).join('\\n');
    return text || fallback;
}`,
      `export function contentToText(content, fallback = '') {
    if (typeof content === 'string') return content;
    const parts = contentParts(content);
    if (!parts) return content == null ? fallback : stringifyFallback(content);
    const text = parts.map(jsonFallbackFromPart).filter(Boolean).join('\\n');
    return text || fallback;
}`,
    ],
    [
      `export function normalizeContentForAnthropic(content) {
    if (!Array.isArray(content)) return content;
    return content.map((part) => {`,
      `export function normalizeContentForAnthropic(content) {
    const parts = contentParts(content);
    if (!parts) return content;
    return parts.map((part) => {`,
    ],
    [
      `export function normalizeContentForOpenAIChat(content, { role = 'user' } = {}) {
    if (!Array.isArray(content)) return content;
    const out = [];
    for (const part of content) {`,
      `export function normalizeContentForOpenAIChat(content, { role = 'user' } = {}) {
    const parts = contentParts(content);
    if (!parts) return content;
    const out = [];
    for (const part of parts) {`,
    ],
    [
      `    if (!Array.isArray(content)) {
        const text = content == null ? '' : stringifyFallback(content);
        return text ? [{ type: textType, text }] : [];
    }
    const out = [];
    for (const part of content) {`,
      `    const parts = contentParts(content);
    if (!parts) {
        const text = content == null ? '' : stringifyFallback(content);
        return text ? [{ type: textType, text }] : [];
    }
    const out = [];
    for (const part of parts) {`,
    ],
    [
      `export function normalizeContentForGeminiParts(content) {
    if (typeof content === 'string') return content ? [{ text: content }] : [];
    if (!Array.isArray(content)) {
        const text = content == null ? '' : stringifyFallback(content);
        return text ? [{ text }] : [];
    }
    const out = [];
    for (const part of content) {`,
      `export function normalizeContentForGeminiParts(content) {
    if (typeof content === 'string') return content ? [{ text: content }] : [];
    const parts = contentParts(content);
    if (!parts) {
        const text = content == null ? '' : stringifyFallback(content);
        return text ? [{ text }] : [];
    }
    const out = [];
    for (const part of parts) {`,
    ],
  ];
  for (const [from, to] of replacements) {
    if (!s.includes(from)) {
      throw new Error('[sync] media-normalization content envelope anchor not found — reconcile patch manually.');
    }
    s = s.replace(from, to);
  }
  return { text: s, already: false };
}

function patchLoopUsageDeltaPrompt(src) {
  let s = src;
  let changed = false;
  const anchor = '                    deltaOutput: response.usage.outputTokens || 0,\n';
  if (!s.includes('deltaPrompt: response.usage.promptTokens || 0')) {
    if (!s.includes(anchor)) {
      throw new Error('[sync] loop usage delta output anchor not found — reconcile prompt token delta patch manually.');
    }
    s = s.replace(anchor, `${anchor}                    deltaPrompt: response.usage.promptTokens || 0,\n`);
    changed = true;
  }
  const hookMarker = 'const beforeToolHook = typeof executeOpts.beforeToolHook';
  if (!s.includes(hookMarker)) {
    const toolOptsAnchor = `    const toolOpts = scopedCacheOutcome
        ? { ...executeOpts, scopedCacheOutcome }
        : executeOpts;
`;
    if (!s.includes(toolOptsAnchor)) {
      throw new Error('[sync] loop executeTool hook anchor not found — reconcile before-tool hook patch manually.');
    }
    s = s.replace(toolOptsAnchor, `${toolOptsAnchor}    const beforeToolHook = typeof executeOpts.beforeToolHook === 'function'
        ? executeOpts.beforeToolHook
        : sessionRef?.beforeToolHook;
    if (beforeToolHook) {
        try {
            const decision = await beforeToolHook({
                name,
                args,
                cwd,
                sessionId: callerSessionId,
                toolCallId: executeOpts.toolCallId || null,
            });
            const action = String(decision?.action || decision?.decision || '').toLowerCase();
            if (action === 'deny' || action === 'block') {
                const reason = decision?.reason ? \`: \${decision.reason}\` : '';
                return \`Error: tool "\${name}" denied by hook\${reason}\`;
            }
            if ((action === 'modify' || action === 'rewrite') && decision?.args && typeof decision.args === 'object' && !Array.isArray(decision.args)) {
                args = decision.args;
            }
        } catch {
            // Hooks are policy extensions. A broken hook must not wedge the agent loop.
        }
    }
`);
    changed = true;
  }
  return { text: s, already: !changed };
}

function patchLeadToolSearchRule(src) {
  if (
    src.includes('Lead owns orientation, routing, approvals, and final judgment.') &&
    src.includes('Use `bridge` to delegate actual scoped work')
  ) {
    return { text: src, already: true };
  }
  const compact = `# Lead Tool Use

Lead owns orientation, routing, and final judgment. Use direct tools for small
safe work; delegate bounded implementation/research to \`bridge\`.

## Active Surface

- \`read\`, \`grep\`, \`list\`, \`code_graph\`: inspect the repo.
- \`recall\`, \`search\`, \`web_fetch\`: recover memory or current external facts.
- \`cwd\`: set the repo before repo-scoped work or worker dispatch.
- \`apply_patch\`: first-class patch editor for Lead-owned changes.
- \`bridge\`: spawn/send/list/read/close workers.
- \`tool_search\`: select deferred tools only when the current surface is missing
  the needed tool.

## cwd

Before repo-anchored work, ensure \`cwd\` points at the repo root. After \`cwd set\`,
omit repeated cwd arguments unless a tool needs an override.
If the user references current/prior/session context ("지금", "아까", "방금",
"이 세션", "계속", "remember", "previous") and the needed anchor is not visible
in the current transcript, use \`recall\` once before repo/file exploration.
If the task is about Mixdog CLI/TUI/agent/bridge/workers/tool routing,
recall/search, statusline, terminal rendering, or model/settings UX, treat
the \`mixdog\` repo as the first repo anchor. Do not scan sibling repos
from a workspace super-root before anchoring there.

## Bridge

Use \`bridge\` for non-trivial write-code tasks, parallel work, or isolated
research. Do not use workers for simple read-only lookups that direct tools can
answer quickly.

Every worker brief must include:

- Goal and why.
- Mode: write-code or research-only.
- Anchor: file, symbol, command, or concrete starting path.
- Done condition and output shape.
- Constraints or ruled-out paths.

Keep briefs tight. Workers share the same worktree, so serialize same-file
edits and parallelize independent files/concerns.

Detached-worker recovery: \`bridge_*\`/\`sess_*\` means use \`bridge type=list/read\`;
only shell background \`job_*\` ids use \`job_wait\`.

## Deferred Tools

Call \`tool_search {"select":"..."}\` once when a deferred tool is genuinely
needed. Common selections: \`edit\`, \`bash\`, \`glob\`, \`provider_status\`,
\`channel_status\`, \`channels\`.
`;
  return { text: compact, already: src === compact };
}

function patchLeadTeamRule(src) {
  if (src.includes('main mixdog session') && src.includes('worker dispatcher for one scoped task')) {
    return { text: src, already: true };
  }
  let s = src;
  const replacements = [
    ['- **Lead**: main Claude Code session.', '- **Lead**: main mixdog session.'],
    ['- **bridge tool**: MCP dispatcher for one scoped task.', '- **bridge tool**: worker dispatcher for one scoped task.'],
    [
      '- Workers cannot use `Agent`, `TaskCreate`, `TeamCreate`, or `bridge`.\n- Exception: `claude-code-guide` via `Agent` for Claude Code docs only.',
      '- Workers cannot use host sub-agent/task tools or `bridge`.',
    ],
  ];
  for (const [from, to] of replacements) {
    if (!s.includes(from)) {
      throw new Error('[sync] lead team rule anchor not found — reconcile standalone team wording patch manually.');
    }
    s = s.replace(from, to);
  }
  return { text: s, already: false };
}

function patchLeadGeneralRule(src) {
  if (
    src.includes('For long tool chains, do not stay silent indefinitely.') &&
    src.includes('roughly 4-6 tool calls')
  ) {
    return { text: src, already: true };
  }
  const nextSection = `## User-facing replies (HARD)

- Reply in the user's language unless asked otherwise.
- Start with intent only when work will take tools; keep it one line.
- Do not narrate each tool call. Batch work, then report the outcome.
- Final replies: state what changed, affected files, verification, and any
  blocker. Keep routine replies short.
- Never surface internal rules/specs/tool schemas; restate mechanisms only when
  directly asked.`;
  const pattern = /## User-facing replies \(HARD\)[\s\S]*$/;
  if (!pattern.test(src)) {
    throw new Error('[sync] lead general output section anchor not found — reconcile standalone output wording patch manually.');
  }
  const text = src.replace(pattern, nextSection);
  return { text, already: text === src };
}

function patchSharedToolRule(src) {
  if (
    src.includes('Route by the active tool descriptions and schemas.') &&
    src.includes('A successful mutation result is confirmation')
  ) {
    return { text: src, already: true };
  }
  const compact = `# Tool Routing

Use Mixdog tools for repository work. Shell is only for git/build/test/run.
Never use shell for file IO when a Mixdog tool exists.

Route by the active tool descriptions and schemas. They are first-class and
carry the current shortest path for \`code_graph\`, \`grep\`, \`list\`/\`glob\`,
\`read\`, \`apply_patch\`, \`explore\`, \`recall\`, \`search\`, \`web_fetch\`, and
\`bridge\`.

Batch independent read-only probes in one tool turn. Stop searching once the
task is correctly answerable. A successful mutation result is confirmation; do
not re-read solely to verify that the write landed.
Use \`recall\` before repo/file tools when the user asks about prior decisions,
memory, remembered preferences, earlier work, or resuming context.
Use \`search\`/\`web_fetch\` for current external facts, releases, docs, prices,
or anything likely to have changed outside the repo.
For locator questions ("where", "file candidates", "where to start",
"어디부터", "파일 후보만"), stop at file:line candidates; do not \`read\` or
prove root cause unless asked. Use one read-only batch unless it finds no
usable candidates.
`;
  return { text: compact, already: src === compact };
}

function patchLeadChannelsRule(src) {
  let text = src
    .replace('`mcp__plugin_mixdog_mixdog__reply` is for files/embeds/components,\n  never plain text.', 'Channel reply tools are for files/embeds/components, never plain text.')
    .replace('| `dispatch_result` | Async `explore` merge; integrate into next step. |', '| `dispatch_result` | Async worker/retrieval result; integrate into next step. |')
    .replace('`skip_today` via `mcp__plugin_mixdog_mixdog__schedule_control` — never push.', '`skip_today` via `schedule_control` — never push.');
  return { text, already: text === src };
}

function patchLeadWorkflowRule(src) {
  let text = src.replace(
    '- Async handoff rule: when async work (`explore`, `bridge`, background shell)',
    '- Async handoff rule: when async work (`bridge`, retrieval, background shell)',
  );
  if (!text.includes('## Turn Contract')) {
    text = `${text.trimEnd()}

## Turn Contract

- A turn uses one snapshot of model, tools, cwd, resources, and rules. Changes
  made during a turn affect the next turn.
- Save point = assistant response and tool results are complete. Merge queued
  user input, async results, and config changes there before continuing.
- Independent tools may run together; dependency chains and same-file mutations
  stay serial.
- Tool guards run before execution; result compression/audit runs before the
  next model turn or final report.
`;
  }
  return { text, already: text === src };
}

function patchChannelsStandalonePaths(src) {
  if (
    src.includes('new URL("./lib/memory-client.mjs", import.meta.url).href') &&
    src.includes('if (process.env.MIXDOG_STANDALONE !== \'1\') {')
  ) {
    return { text: src, already: true };
  }
  let text = src;
  const memoryFrom = 'const memoryClientModulePath = pathToFileURL(path.join(PLUGIN_ROOT, "src/channels/lib/memory-client.mjs")).href;';
  const memoryTo = 'const memoryClientModulePath = new URL("./lib/memory-client.mjs", import.meta.url).href;';
  if (text.includes(memoryFrom)) {
    text = text.replace(memoryFrom, memoryTo);
  } else if (!text.includes(memoryTo)) {
    throw new Error('[sync] channels memory-client path anchor not found — reconcile standalone channels patch manually.');
  }
  const reloadFrom = `          try {
            const { reloadAgentConfig } = await import("../agent/index.mjs");
            await reloadAgentConfig("reload_config tool");
            agentReloadMsg = ", agent providers/presets/maintenance";
          } catch (err) {
            process.stderr.write(\`[reload_config] agent reload failed: \${err?.message || String(err)}\\n\`);
          }`;
  const reloadTo = `          if (process.env.MIXDOG_STANDALONE !== '1') {
            try {
              const { reloadAgentConfig } = await import("../agent/index.mjs");
              await reloadAgentConfig("reload_config tool");
              agentReloadMsg = ", agent providers/presets/maintenance";
            } catch (err) {
              process.stderr.write(\`[reload_config] agent reload failed: \${err?.message || String(err)}\\n\`);
            }
          }`;
  if (text.includes(reloadFrom)) {
    text = text.replace(reloadFrom, reloadTo);
  } else if (!text.includes("if (process.env.MIXDOG_STANDALONE !== '1') {")) {
    throw new Error('[sync] channels reload_config agent reload anchor not found — reconcile standalone channels patch manually.');
  }
  return { text, already: text === src };
}

function patchHttpAgent(src) {
  if (src.includes('_globalInstalled')) return { text: src, already: true };
  let s = src;
  s = s.replace(
    "import { Agent, getGlobalDispatcher, request as undiciRequest } from 'undici'",
    "import { Agent, getGlobalDispatcher, setGlobalDispatcher, request as undiciRequest } from 'undici'",
  );
  s = s.replace('let _agent = null', 'let _agent = null\nlet _globalInstalled = false');
  const anchor = `  if (proxyConfigured()) return undefined
  if (_agent) return _agent
  _agent = new Agent({
    keepAliveTimeout: envInt('MIXDOG_LLM_KEEPALIVE_MS', 60_000),
    // Cap the idle keep-alive bump the server may request, so a generous
    // upstream Keep-Alive header can't pin sockets open far longer than us.
    keepAliveMaxTimeout: envInt('MIXDOG_LLM_KEEPALIVE_MAX_MS', 90_000),
    connections: envInt('MIXDOG_LLM_CONNECTIONS', 16),
  })
  return _agent`;
  const replacement = `  if (proxyConfigured()) return undefined
  if (!_agent) {
    _agent = new Agent({
      keepAliveTimeout: envInt('MIXDOG_LLM_KEEPALIVE_MS', 60_000),
      keepAliveMaxTimeout: envInt('MIXDOG_LLM_KEEPALIVE_MAX_MS', 90_000),
      connections: envInt('MIXDOG_LLM_CONNECTIONS', 16),
    })
  }
  // mixdog standalone: separate undici instance from Node's fetch undici, so
  // a per-request dispatcher throws UND_ERR_INVALID_ARG. Install globally once
  // and omit the per-request dispatcher. See port-plan D7.
  if (!_globalInstalled) {
    try { setGlobalDispatcher(_agent); _globalInstalled = true } catch { /* fall back */ }
  }
  return _globalInstalled ? undefined : _agent`;
  if (!s.includes(anchor)) {
    throw new Error('[sync] http-agent anchor not found — upstream changed getLlmDispatcher(); reconcile patch manually.');
  }
  return { text: s.replace(anchor, replacement), already: false };
}

/**
 * Statusline vendor — re-point route-meta.mjs's runtime imports.
 *
 * Upstream route-meta.mjs sits in mixdog/src/gateway and reaches its sibling
 * runtime modules with `../shared/**` and `../agent/**`. Mirrored verbatim
 * under src/vendor/statusline/src/gateway, those bare relatives would resolve
 * to non-existent vendor-local paths, so they are rewritten to climb out of the
 * statusline vendor tree into the synced runtime closure (src/runtime/**).
 * `./claude-current.mjs` is left untouched — it is vendored alongside.
 * Idempotent (skips once re-pointed) and fail-loud (throws if neither import
 * root is present, surfacing an upstream move).
 */
function patchStatuslineGatewayRuntimeImports(src) {
  if (src.includes('../../../../runtime/shared/') || src.includes('../../../../runtime/agent/')) {
    return { text: src, already: true };
  }
  if (!src.includes("'../shared/") && !src.includes("'../agent/")) {
    throw new Error('[sync] route-meta import anchors not found — upstream moved gateway/route-meta runtime imports; reconcile patch manually.');
  }
  const text = src
    .split("'../shared/").join("'../../../../runtime/shared/")
    .split("'../agent/").join("'../../../../runtime/agent/");
  return { text, already: false };
}

function patchStatuslineStandaloneDataDir(src) {
  let s = src;
  let changed = false;
  if (!s.includes("import os from 'os';")) {
    const importAnchor = "import fs from 'fs';";
    if (!s.includes(importAnchor)) {
      throw new Error('[sync] statusline os import anchor not found — reconcile standalone statusline patch manually.');
    }
    s = s.replace(importAnchor, `${importAnchor}\nimport os from 'os';`);
    changed = true;
  }
  const from = "return process.env.CLAUDE_PLUGIN_DATA || path.join(claudeConfigDir(), 'plugins', 'data', 'mixdog-trib-plugin');";
  const to = "return process.env.CLAUDE_PLUGIN_DATA || process.env.MIXDOG_DATA_DIR || path.join(process.env.MIXDOG_HOME || path.join(os.homedir(), '.mixdog'), 'data');";
  if (s.includes(from)) {
    s = s.replace(from, to);
    changed = true;
  } else if (!s.includes(to)) {
    throw new Error('[sync] statusline pluginDataDir fallback anchor not found — reconcile standalone statusline patch manually.');
  }
  return { text: s, already: !changed };
}

function patchStatuslineStandaloneGatewayOverride(src) {
  let s = src;
  let changed = false;
  if (s.includes("MIXDOG_STATUSLINE_STANDALONE === '1'") && s.includes("MIXDOG_STANDALONE === '1'")) {
    return { text: s, already: true };
  }
  const anchor = `function shouldLoadGatewayStatus(currentRoute, sessionId, clientHostPid) {
  if (!isClaudeNativeModelSelection(currentRoute)) return true;`;
  if (!s.includes(anchor)) {
    throw new Error('[sync] statusline gateway override anchor not found — reconcile standalone statusline patch manually.');
  }
  s = s.replace(anchor, `function shouldLoadGatewayStatus(currentRoute, sessionId, clientHostPid) {
  if (process.env.MIXDOG_STATUSLINE_STANDALONE === '1') return false;
  if (process.env.MIXDOG_STANDALONE === '1') return true;
  if (!isClaudeNativeModelSelection(currentRoute)) return true;`),
  changed = true;
  return { text: s, already: !changed };
}

function patchStatuslineContextPercent(src) {
  if (src.includes('function contextPct(s)')) return { text: src, already: true };
  let s = src;
  const from = `  function roundPct(s) {
    const n = parseFloat(s);
    return Number.isFinite(n) ? Math.floor(n) : null;
  }

  const ctxInt    = roundPct(CC_CTX_USED);
  const rl5hInt   = roundPct(CC_RL_5H);
  const rl7dInt   = roundPct(CC_RL_7D);`;
  const to = `  function roundPct(s) {
    const n = parseFloat(s);
    return Number.isFinite(n) ? Math.floor(n) : null;
  }
  function contextPct(s) {
    const n = parseFloat(s);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
  }
  function formatContextPct(pct) {
    if (pct === null) return '';
    if (pct > 0 && pct < 1) return String(Math.round(pct * 10) / 10);
    return String(Math.floor(pct));
  }

  const ctxPct    = contextPct(CC_CTX_USED);
  const rl5hInt   = roundPct(CC_RL_5H);
  const rl7dInt   = roundPct(CC_RL_7D);`;
  if (!s.includes(from)) {
    throw new Error('[sync] statusline context percent anchor not found — reconcile standalone statusline patch manually.');
  }
  s = s.replace(from, to)
    .replaceAll('ctxInt !== null', 'ctxPct !== null')
    .replaceAll('ctxInt >= 90', 'ctxPct >= 90')
    .replaceAll('ctxInt >= 70', 'ctxPct >= 70')
    .replaceAll('makeBar(ctxInt, 14)', 'makeBar(ctxPct, 14)')
    .replaceAll('makeBar(ctxInt, 8)', 'makeBar(ctxPct, 8)')
    .replace('const fill = ctxPct >= 90 ? RED : ctxPct >= 70 ? YLW : GRN;', 'const fill = ctxPct >= 90 ? RED : ctxPct >= 70 ? YLW : GRN;\n    const ctxLabel = formatContextPct(ctxPct);')
    .replaceAll('${ctxInt}%', '${ctxLabel}%');
  return { text: s, already: false };
}

function patchStatuslineBashSegment(src) {
  const from = 'return `bash:${count}${overflow}${elapsed}`;';
  const to = 'return `${GREY}⚙  bash:${count}${overflow}${elapsed}${R}`;';
  if (src.includes(to)) return { text: src, already: true };
  if (!src.includes(from)) {
    throw new Error('[sync] statusline bash segment anchor not found — reconcile standalone statusline patch manually.');
  }
  return { text: src.replace(from, to), already: false };
}

function patchStatuslineLibStandalone(src) {
  let changed = false;
  let res = patchStatuslineStandaloneDataDir(src);
  let s = res.text; changed ||= !res.already;
  res = patchStatuslineStandaloneGatewayOverride(s);
  s = res.text; changed ||= !res.already;
  res = patchStatuslineContextPercent(s);
  s = res.text; changed ||= !res.already;
  res = patchStatuslineBashSegment(s);
  s = res.text; changed ||= !res.already;
  return { text: s, already: !changed };
}

function patchStatuslineRouteStandalone(src) {
  let changed = false;
  let res = patchStatuslineStandaloneDataDir(src);
  let s = res.text; changed ||= !res.already;
  const from = `  const activeStatus = {
    provider: configured?.provider || active.gateway_provider,`;
  const to = `  const activeQuotaWindows = metricsMatch && Array.isArray(active.gateway_quota_windows)
    ? active.gateway_quota_windows
    : [];
  const activeStatus = {
    provider: configured?.provider || active.gateway_provider,`;
  if (!s.includes('const activeQuotaWindows =')) {
    if (!s.includes(from)) throw new Error('[sync] statusline route quota anchor not found — reconcile standalone statusline patch manually.');
    s = s.replace(from, to);
    changed = true;
  }
  const replacements = [
    [
      'quotaWindows: metricsMatch && Array.isArray(active.gateway_quota_windows) ? active.gateway_quota_windows : [],',
      'quotaWindows: activeQuotaWindows.length ? activeQuotaWindows : (configuredStatus?.quotaWindows || []),',
    ],
    [
      "balance: metricsMatch && active.gateway_balance && typeof active.gateway_balance === 'object' ? active.gateway_balance : null,",
      "balance: metricsMatch && active.gateway_balance && typeof active.gateway_balance === 'object' ? active.gateway_balance : (configuredStatus?.balance || null),",
    ],
    [
      "routeSpend: metricsMatch && active.gateway_route_spend && typeof active.gateway_route_spend === 'object' ? active.gateway_route_spend : null,",
      "routeSpend: metricsMatch && active.gateway_route_spend && typeof active.gateway_route_spend === 'object' ? active.gateway_route_spend : (configuredStatus?.routeSpend || null),",
    ],
  ];
  for (const [a, b] of replacements) {
    if (s.includes(a)) {
      s = s.replace(a, b);
      changed = true;
    } else if (!s.includes(b)) {
      throw new Error('[sync] statusline route fallback anchor not found — reconcile standalone statusline patch manually.');
    }
  }
  return { text: s, already: !changed };
}

function patchPluginPaths(src, kind) {
  let s = src;
  let changed = false;
  const staleDoc = ` * Throws if neither env var is present — the plugin always runs under
 * Claude Code, which sets one of them. Callers must not silently fall
 * back to a hardcoded path.`;
  const standaloneDoc = ` * In standalone mixdog, falls back to MIXDOG_DATA_DIR or
 * <MIXDOG_HOME|~/.mixdog>/data when the host plugin env is absent.
 * Plugin-host runs still prefer the host-provided env vars above.`;
  if (s.includes(staleDoc)) {
    s = s.replace(staleDoc, standaloneDoc);
    changed = true;
  }
  const cleaned = s
    .replace(/\nconst STANDALONE_PROJECT_ROOT = resolve\(dirname\(fileURLToPath\(import\.meta\.url\)\), '\.\.', '\.\.', '\.\.'\);/g, '')
    .replace(/\nconst STANDALONE_PROJECT_ROOT = path\.resolve\(__dirname, '\.\.', '\.\.'\);/g, '')
    .replace("import { join, basename, dirname, resolve } from 'path';", "import { join, basename } from 'path';")
    .replace("import { readFileSync } from 'fs';\nimport { fileURLToPath } from 'url';", "import { readFileSync } from 'fs';");
  if (cleaned !== s) {
    s = cleaned;
    changed = true;
  }
  const staleMjsFallback = `// Standalone mixdog: own a project-local data dir (override with MIXDOG_DATA_DIR).
  return process.env.MIXDOG_DATA_DIR || join(STANDALONE_PROJECT_ROOT, '.mixdog', 'data');`;
  const staleCjsFallback = `// Standalone mixdog: own a project-local data dir (override with MIXDOG_DATA_DIR).
  return process.env.MIXDOG_DATA_DIR || path.join(STANDALONE_PROJECT_ROOT, '.mixdog', 'data');`;
  const fallback = `// Standalone mixdog: own user-global data under MIXDOG_HOME (~/.mixdog),
  // mirroring Claude Code's ~/.claude root.
  return process.env.MIXDOG_DATA_DIR || ${kind === 'mjs' ? "join(mixdogHome(), 'data')" : "path.join(mixdogHome(), 'data')"};`;
  if (s.includes(staleMjsFallback) || s.includes(staleCjsFallback)) {
    s = s.replace(staleMjsFallback, fallback).replace(staleCjsFallback, fallback);
    changed = true;
  }
  if (s.includes("join(mixdogHome(), 'data')") || s.includes("path.join(mixdogHome(), 'data')")) {
    return { text: s, already: !changed };
  }
  const throwLine =
    "throw new Error('[plugin-paths] CLAUDE_PLUGIN_DATA and CLAUDE_PLUGIN_ROOT are both unset — cannot resolve plugin data dir outside of Claude Code.');";
  if (!s.includes(throwLine)) {
    throw new Error(`[sync] plugin-paths(${kind}) throw anchor not found — reconcile patch manually.`);
  }
  let next = s;
  if (kind === 'mjs') {
    if (!next.includes("import { homedir } from 'os';")) {
      next = next.replace("import { join, basename } from 'path';", "import { homedir } from 'os';\nimport { join, basename } from 'path';");
    }
    if (!next.includes('export function mixdogHome()')) {
      next = next.replace(
        "export const DEFAULT_MARKETPLACE = 'trib-plugin';",
        "export const DEFAULT_MARKETPLACE = 'trib-plugin';\n\nexport function mixdogHome() {\n  return process.env.MIXDOG_HOME || join(homedir(), '.mixdog');\n}",
      );
    }
  } else {
    if (!next.includes('function mixdogHome()')) {
      next = next.replace(
        "const DEFAULT_MARKETPLACE = 'trib-plugin';",
        "const DEFAULT_MARKETPLACE = 'trib-plugin';\n\nfunction mixdogHome() {\n  return process.env.MIXDOG_HOME || path.join(os.homedir(), '.mixdog');\n}",
      );
    }
  }
  return { text: next.replace(throwLine, fallback), already: false };
}

function isMemoryRuntimeModule(to) {
  const rel = relative(MEMORY_RUNTIME, to).split('\\').join('/');
  return rel && !rel.startsWith('../') && !rel.includes(':') && rel.endsWith('.mjs');
}

function patchMemoryQuietStderr(src) {
  if (!src.includes('process.stderr.write(')) return { text: src, already: true };
  if (src.includes('__mixdogMemoryLog(')) return { text: src, already: true };

  const helper = `const __mixdogMemoryStderrWrite = process.stderr.write.bind(process.stderr);
function __mixdogMemoryLog(...args) {
  if (process.env.MIXDOG_QUIET_MEMORY_LOG) return true;
  return __mixdogMemoryStderrWrite(...args);
}

`;
  const patched = src.replaceAll('process.stderr.write(', '__mixdogMemoryLog(');
  if (patched.startsWith('#!')) {
    const nl = patched.indexOf('\n');
    if (nl === -1) return { text: `${patched}\n${helper}`, already: false };
    return { text: `${patched.slice(0, nl + 1)}${helper}${patched.slice(nl + 1)}`, already: false };
  }
  return { text: `${helper}${patched}`, already: false };
}

function patchMemoryEmbeddingWorkerOrtLog(src) {
  let text = src;
  let changed = false;

  if (!text.includes('options.logSeverityLevel = 4')) {
    const anchor = '      if (!options.graphOptimizationLevel) options.graphOptimizationLevel = GRAPH_OPT_LEVEL\n      return origCreate(pathOrBuffer, options)';
    if (!text.includes(anchor)) {
      throw new Error('[sync] embedding-worker ORT create anchor not found — reconcile log patch manually.');
    }
    text = text.replace(anchor, `      if (!options.graphOptimizationLevel) options.graphOptimizationLevel = GRAPH_OPT_LEVEL
      if (options.logSeverityLevel === undefined) options.logSeverityLevel = 4
      return origCreate(pathOrBuffer, options)`);
    changed = true;
  }

  if (!text.includes("env.backends.onnx.logLevel = 'fatal'")) {
    const anchor = "      const { pipeline, env } = await import('@huggingface/transformers')\n      env.allowLocalModels = false";
    if (!text.includes(anchor)) {
      throw new Error('[sync] embedding-worker transformers env anchor not found — reconcile log patch manually.');
    }
    text = text.replace(anchor, `      const { pipeline, env } = await import('@huggingface/transformers')
      try { env.backends.onnx.logLevel = 'fatal' } catch {}
      env.allowLocalModels = false`);
    changed = true;
  }

  return { text, already: !changed };
}

function patchMemoryStandaloneErrors(src, rel) {
  let text = src;
  let changed = false;
  const replacements = [
    [
      "throw new Error('CLAUDE_PLUGIN_ROOT env var required for prompt loading')",
      "throw new Error('mixdog plugin root is required for prompt loading; standalone startup should initialize plugin-root compatibility env')",
    ],
    [
      "__mixdogMemoryLog('[memory-service] CLAUDE_PLUGIN_DATA not set and no explicit data dir provided\\n')",
      "__mixdogMemoryLog('[memory-service] memory data dir not set and no explicit data dir provided\\n')",
    ],
    [
      "return { text: 'core: CLAUDE_PLUGIN_DATA unset', isError: true }",
      "return { text: 'core: memory data dir is not initialized', isError: true }",
    ],
  ];
  for (const [from, to] of replacements) {
    if (text.includes(from)) {
      text = text.replaceAll(from, to);
      changed = true;
    }
  }
  if ((rel === 'lib/memory-cycle2.mjs' || rel === 'lib/memory-cycle3.mjs')
    && text === src
    && !text.includes('mixdog plugin root is required for prompt loading')) {
    throw new Error(`[sync] ${rel} prompt-root error anchor not found — reconcile standalone memory wording patch manually.`);
  }
  return { text, already: !changed };
}

function patchGeneratedVendoredFile(src, to) {
  let text = src;
  let changed = false;
  const standaloneUserWorkflowPath = join(CLI, 'src', 'defaults', 'user-workflow.md');
  if (to === standaloneUserWorkflowPath) {
    const standaloneUserWorkflow = `Default roles:
- worker: clear, scoped implementation.
- heavy-worker: vague, broad, or multi-file implementation.
- reviewer: verify diffs, behavior, regressions, and missing checks.
- debugger: diagnose unclear bugs; return cause, evidence, and fix scope.

Delegation:
- Lead handles small edits, config, git, and final integration directly.
- Lead handles tiny one-file edits and simple verification directly.
- If a task has two or more independent files/concerns, spawn useful bridge
  workers early as one batch, then poll/read and integrate the results.
- For named independent multi-file implementation, delegate at least one
  implementation/debug lane before Lead mutates files. Verification-only
  workers do not count as implementation delegation.
- Use bridge workers for scoped implementation, review, or debugging when it
  reduces risk or parallelizes useful work.
- Do not spawn a worker only to run a simple test after a tiny Lead-owned edit.
- Review high-risk or cross-file changes before reporting done.
- If review changes the plan or scope, pause and ask the user.
`;
    return { text: standaloneUserWorkflow, already: text === standaloneUserWorkflow };
  }
  if (isMemoryRuntimeModule(to)) {
    const rel = relative(MEMORY_RUNTIME, to).split('\\').join('/');
    const quiet = patchMemoryQuietStderr(text);
    text = quiet.text;
    changed = changed || !quiet.already;
    const standaloneErrors = patchMemoryStandaloneErrors(text, rel);
    text = standaloneErrors.text;
    changed = changed || !standaloneErrors.already;
    if (rel === 'lib/embedding-worker.mjs') {
      const ort = patchMemoryEmbeddingWorkerOrtLog(text);
      text = ort.text;
      changed = changed || !ort.already;
    }
  }
  return { text, already: !changed };
}

// ---------------------------------------------------------------------------
// 3. Run
// ---------------------------------------------------------------------------

// Map a destination file path to the patch that gets re-applied on top of the
// upstream copy. In --check we must compare the *patched* upstream against the
// vendored file, otherwise the 3 standalone-patched files always read as drift
// (they differ from raw upstream by design — that's the patch, not real drift).
const PATCH_BY_DEST = new Map(PATCHES.map((p) => [p.file, p.apply]));

// Expected vendored bytes for a destination: upstream source with the matching
// standalone patch applied in-memory. Returns null if the patch anchor is gone
// (upstream moved it) so --check can surface it as a real drift to reconcile.
function expectedBytes(from, to) {
  const raw = readFileSync(from, 'utf8');
  const patch = PATCH_BY_DEST.get(to);
  let text = raw;
  try {
    if (patch) text = patch(text).text;
    return patchGeneratedVendoredFile(text, to).text;
  } catch {
    return null; // anchor missing — treat as drift, surface to the user
  }
}

function sameVendoredText(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return String(a).replace(/\r\n/g, '\n') === String(b).replace(/\r\n/g, '\n');
}

function copyInto(relFiles, srcBase, dstBase, label) {
  let copied = 0;
  for (const rel of relFiles) {
    const from = join(srcBase, rel);
    const to = join(dstBase, rel);
    if (!existsSync(from)) continue;
    if (CHECK) {
      const want = expectedBytes(from, to);
      const have = existsSync(to) ? readFileSync(to, 'utf8') : null;
      if (want === null) { console.log(`  drift (patch anchor lost): ${label}/${rel}`); copied++; continue; }
      if (!sameVendoredText(want, have)) { console.log(`  drift: ${label}/${rel}`); copied++; }
      continue;
    }
    mkdirSync(dirname(to), { recursive: true });
    const text = expectedBytes(from, to);
    if (text === null) {
      console.error(`  PATCH FAILED: ${label}/${rel}`);
      process.exit(1);
    }
    writeFileSync(to, text);
    copied++;
  }
  return copied;
}

function listFilesRecursive(base) {
  const out = [];
  function walk(dir, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }
  if (existsSync(base)) walk(base);
  return out.sort();
}

function main() {
  if (!existsSync(MIXDOG_SRC)) {
    console.error(`[sync] mixdog source not found at ${MIXDOG_SRC}`);
    process.exit(1);
  }

  console.log(CHECK ? '== sync --check (no writes) ==' : '== sync-runtime ==');

  // 3a. runtime closure
  const files = closure(ENTRIES, MIXDOG_SRC);
  const n = copyInto(files, MIXDOG_SRC, RUNTIME, 'runtime');
  console.log(`runtime closure: ${files.length} files, ${CHECK ? n + ' drifted' : n + ' copied'}`);

  // 3b. lib + hooks/lib cjs + defaults (data files & cjs siblings)
  const libFiles = listFilesRecursive(join(MIXDOG, 'lib'));
  copyInto(libFiles, join(MIXDOG, 'lib'), join(CLI, 'src', 'lib'), 'lib');
  const hookFiles = ['permission-evaluator.cjs', 'permission-rules.cjs', 'settings-loader.cjs'];
  copyInto(hookFiles, join(MIXDOG, 'hooks', 'lib'), join(CLI, 'src', 'hooks', 'lib'), 'hooks/lib');
  const defaultFiles = ['hidden-roles.json', 'user-workflow.json', 'user-workflow.md',
    'mixdog-config.template.json', 'memory-chunk-prompt.md', 'memory-promote-prompt.md',
    'cycle3-review-prompt.md'];
  copyInto(defaultFiles, join(MIXDOG, 'defaults'), join(CLI, 'src', 'defaults'), 'defaults');
  const agentFiles = listFilesRecursive(join(MIXDOG, 'agents'));
  copyInto(agentFiles, join(MIXDOG, 'agents'), join(CLI, 'src', 'agents'), 'agents');
  const ruleFiles = listFilesRecursive(join(MIXDOG, 'rules'));
  copyInto(ruleFiles, join(MIXDOG, 'rules'), join(CLI, 'src', 'rules'), 'rules');
  const searchFiles = listFilesRecursive(join(MIXDOG_SRC, 'search'));
  copyInto(searchFiles, join(MIXDOG_SRC, 'search'), SEARCH_RUNTIME, 'runtime/search');
  const memoryFiles = listFilesRecursive(join(MIXDOG_SRC, 'memory'));
  copyInto(memoryFiles, join(MIXDOG_SRC, 'memory'), MEMORY_RUNTIME, 'runtime/memory');
  copyInto(['schedules-store.mjs'], join(MIXDOG_SRC, 'shared'), join(RUNTIME, 'shared'), 'runtime/shared');
  const channelsFiles = listFilesRecursive(join(MIXDOG_SRC, 'channels'));
  copyInto(channelsFiles, join(MIXDOG_SRC, 'channels'), CHANNELS_RUNTIME, 'runtime/channels');
  const codeGraphFiles = [
    'agent/orchestrator/tools/code-graph-prewarm-worker.mjs',
    'agent/orchestrator/tools/graph-manifest.json',
  ];
  copyInto(codeGraphFiles, MIXDOG_SRC, RUNTIME, 'runtime/code-graph');
  const sharedLlmFiles = listFilesRecursive(join(MIXDOG_SRC, 'shared', 'llm'));
  copyInto(sharedLlmFiles, join(MIXDOG_SRC, 'shared', 'llm'), join(RUNTIME, 'shared', 'llm'), 'runtime/shared/llm');

  // 3b'. statusline vendor — PURE verbatim copies of the plugin's L1/L2
  // renderer + its gateway deps, mirrored under src/vendor/statusline so the
  // original relative imports (`./statusline-route.mjs`,
  // `../src/gateway/claude-current.mjs`) keep resolving unchanged. No patches.
  const statusBinFiles = ['statusline-lib.mjs', 'statusline-route.mjs'];
  copyInto(statusBinFiles, join(MIXDOG, 'bin'), join(STATUS_VENDOR, 'bin'), 'vendor/statusline/bin');
  const statusGatewayFiles = ['claude-current.mjs', 'route-meta.mjs', 'session-routes.mjs'];
  copyInto(statusGatewayFiles, join(MIXDOG, 'src', 'gateway'), join(STATUS_VENDOR, 'src', 'gateway'), 'vendor/statusline/src/gateway');
  // statusline-lib also imports `../scripts/lib/gateway-settings.mjs` (node-only,
  // self-contained — no plugin deps), mirrored under the vendor tree verbatim.
  const statusScriptLibFiles = ['gateway-settings.mjs'];
  copyInto(statusScriptLibFiles, join(MIXDOG, 'scripts', 'lib'), join(STATUS_VENDOR, 'scripts', 'lib'), 'vendor/statusline/scripts/lib');

  // 3c. re-apply standalone patches
  if (CHECK) {
    console.log('patches: (skipped in --check)');
  } else {
    for (const p of PATCHES) {
      if (!existsSync(p.file)) { console.error(`  PATCH TARGET MISSING: ${p.file}`); process.exit(1); }
      const src = readFileSync(p.file, 'utf8');
      const { text, already } = p.apply(src);
      if (already) { console.log(`  patch ok (already): ${p.name}`); continue; }
      writeFileSync(p.file, text);
      console.log(`  patch applied: ${p.name}`);
    }
  }

  console.log(CHECK ? '== check done ==' : '== sync complete ==');
}

main();
