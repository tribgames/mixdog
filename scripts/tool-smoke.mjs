#!/usr/bin/env node
import './native-spawn-test-runtime.mjs';
// Deterministic tool contracts use injected managers/providers and no network.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { __applyStandaloneToolDefaultsForTest, __renderToolSearchForTest, compactToolSearchDescription, defaultDeferredToolNames, SKILL_TOOL, TOOL_SEARCH_TOOL } from '../src/mixdog-session-runtime.mjs';
import { applyInitialDeferredToolManifestToBp2, buildDeferredToolManifest } from '../src/runtime/agent/orchestrator/context/collect.mjs';
import { refreshSessionBp3Environment, resetSessionBp3Environment } from '../src/runtime/agent/orchestrator/session/manager/prompt-utils.mjs';
import { AGENT_TOOL, createStandaloneAgent } from '../src/standalone/agent-tool.mjs';
import { parseHeadlessExecCommand } from '../src/app.mjs';
import { createStandaloneChannelWorker } from '../src/standalone/channel-worker.mjs';
import { OpenAIOAuthProvider, buildRequestBody, sendViaHttpSse } from '../src/runtime/agent/orchestrator/providers/openai-oauth.mjs';
import { _test as _anthropicOAuthTest } from '../src/runtime/agent/orchestrator/providers/anthropic-oauth.mjs';
import { _logicalResponseItemMatch } from '../src/runtime/agent/orchestrator/providers/openai-oauth-ws.mjs';
import { _mergePendingMessageEntries, applyAskTerminalUsageTotals, closeSession, createSession, drainPendingMessages, enqueuePendingMessage, resumeSession } from '../src/runtime/agent/orchestrator/session/manager.mjs';
import {
  contentHasImage,
  normalizeContentForAnthropic,
  normalizeContentForGeminiParts,
  normalizeContentForOpenAIChat,
  normalizeContentForOpenAIResponses,
  sanitizeContentForStoredHistory,
} from '../src/runtime/agent/orchestrator/providers/media-normalization.mjs';
import { initProviders } from '../src/runtime/agent/orchestrator/providers/registry.mjs';
import {
  cacheCapabilityForProvider,
  resolveCacheStrategy,
  shouldMarkWarmForProvider,
  shouldRecordObservedForProvider,
} from '../src/runtime/agent/orchestrator/agent-runtime/cache-strategy.mjs';
import { executeBuiltinTool } from '../src/runtime/agent/orchestrator/tools/builtin.mjs';
import { executeFuzzyFindTool } from '../src/runtime/agent/orchestrator/tools/builtin/list-tool.mjs';
import { applyGrepContextLeadPolicy, GREP_CONTEXT_MAX, validateBuiltinArgs } from '../src/runtime/agent/orchestrator/tools/builtin/arg-guard.mjs';
import { normaliseReadLineWindowArgs } from '../src/runtime/agent/orchestrator/tools/builtin/read-args.mjs';
import { BUILTIN_TOOLS } from '../src/runtime/agent/orchestrator/tools/builtin/builtin-tools.mjs';
import {
  invalidateBuiltinResultCache,
  runRawContentInFlight,
  runReadOnlyStatInFlight,
  runResultCacheInFlight,
} from '../src/runtime/agent/orchestrator/tools/builtin/cache-layers.mjs';
import { executeCodeGraphTool } from '../src/runtime/agent/orchestrator/tools/code-graph.mjs';
import { CODE_GRAPH_TOOL_DEFS } from '../src/runtime/agent/orchestrator/tools/code-graph-tool-defs.mjs';
import { executePatchTool } from '../src/runtime/agent/orchestrator/tools/patch.mjs';
import { PATCH_TOOL_DEFS } from '../src/runtime/agent/orchestrator/tools/patch-tool-defs.mjs';
import { TOOL_DEFS as MEMORY_TOOL_DEFS } from '../src/runtime/memory/tool-defs.mjs';
import { mergeSessionRowsIntoGlobal } from '../src/runtime/memory/lib/memory-session-merge.mjs';
import { TOOL_DEFS as SEARCH_TOOL_DEFS } from '../src/runtime/search/tool-defs.mjs';
import { TOOL_DEFS as CHANNEL_TOOL_DEFS } from '../src/runtime/channels/tool-defs.mjs';
import { AGENT_OWNER } from '../src/runtime/agent/orchestrator/agent-owner.mjs';
import {
  applyDeferredToolSurface,
  reconcileDeferredMcpToolCatalog,
} from '../src/session-runtime/tool-catalog.mjs';
import { prepareDeferredToolCallThrough } from '../src/runtime/agent/orchestrator/session/loop/deferred-call-through.mjs';
import { composeSystemPrompt } from '../src/runtime/agent/orchestrator/context/collect.mjs';
import { setInternalToolsProvider } from '../src/runtime/agent/orchestrator/internal-tools.mjs';
import { prepareAgentSession } from '../src/runtime/agent/orchestrator/agent-runtime/session-builder.mjs';
import { resolveHiddenRoleSchemaAllowedTools } from '../src/runtime/agent/orchestrator/agent-runtime/agent-dispatch.mjs';
import { assertCodeGraphDescriptionContract } from './code-graph-description-contract.mjs';
import { getHiddenAgent, resolveAgentSessionPermission } from '../src/runtime/agent/orchestrator/internal-agents.mjs';
import { normalizeToolEnvelope } from '../src/runtime/agent/orchestrator/session/tool-envelope.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localGraphBin = join(
  root,
  'native',
  'mixdog-graph',
  'target',
  'debug',
  process.platform === 'win32' ? 'mixdog-graph.exe' : 'mixdog-graph',
);
if (!process.env.MIXDOG_GRAPH_BIN && existsSync(localGraphBin)) {
  process.env.MIXDOG_GRAPH_BIN = localGraphBin;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertOk(name, result, pattern = null) {
  const text = String(result || '');
  if (!text || /^Error[\s:[]/.test(text)) {
    throw new Error(`${name} failed:\n${text}`);
  }
  if (pattern && !pattern.test(text)) {
    throw new Error(`${name} returned unexpected output:\n${text.slice(0, 1000)}`);
  }
  return text;
}

{
  const session = { provider: 'openai-oauth' };
  applyAskTerminalUsageTotals(session, {
    usage: { inputTokens: 100_000, outputTokens: 10, cachedTokens: 98_000, cacheWriteTokens: 0 },
  });
  assert(session.lastInputTokens === 100_000, `inclusive last input should retain provider total: ${JSON.stringify(session)}`);
  assert(session.lastUncachedInputTokens === 2_000, `inclusive last uncached input should subtract cache reads: ${JSON.stringify(session)}`);
  assert(session.totalUncachedInputTokens === 2_000, `inclusive total uncached input should be tracked: ${JSON.stringify(session)}`);
}

{
  const session = { provider: 'anthropic-oauth' };
  applyAskTerminalUsageTotals(session, {
    usage: { inputTokens: 2_000, outputTokens: 10, cachedTokens: 90_000, cacheWriteTokens: 8_000 },
  });
  assert(session.lastInputTokens === 2_000, `additive last input should retain provider input field: ${JSON.stringify(session)}`);
  assert(session.lastUncachedInputTokens === 10_000, `additive uncached input should include cache writes: ${JSON.stringify(session)}`);
  assert(session.lastContextTokens === 100_000, `additive context should include input+cache read+cache write: ${JSON.stringify(session)}`);
  assert(session.totalUncachedInputTokens === 10_000, `additive total uncached input should include cache writes: ${JSON.stringify(session)}`);
}

{
  const sid = `tool-smoke-rich-pending-${process.pid}-${Date.now()}`.replace(/[^A-Za-z0-9_-]/g, '_');
  const richContent = [
    { type: 'text', text: 'look at this' },
    { type: 'image', data: 'abc', mimeType: 'image/png' },
  ];
  const depth = enqueuePendingMessage(sid, { text: 'look at this\n[Image]', content: richContent });
  assert(depth >= 1, `rich pending enqueue should return queue depth, got ${depth}`);
  const drained = drainPendingMessages(sid);
  assert(drained.length === 1, `rich pending drain should dedupe memory+persisted entries, got ${drained.length}`);
  assert(Array.isArray(drained[0]?.content), `rich pending drain should preserve content array: ${JSON.stringify(drained)}`);
  assert(drained[0].content.some((part) => part?.type === 'image' && part?.data === 'abc'), `rich pending drain lost image part: ${JSON.stringify(drained)}`);
  const merged = _mergePendingMessageEntries([...drained, 'plain follow-up']);
  assert(Array.isArray(merged?.content), `rich pending merge should preserve structured content: ${JSON.stringify(merged)}`);
  assert(merged.content.some((part) => part?.type === 'image' && part?.data === 'abc'), `rich pending merge lost image part: ${JSON.stringify(merged)}`);
  assert(
    merged.content.some((part) => part?.type === 'text' && /plain follow-up/.test(part.text || '')),
    `rich pending merge should keep later text follow-up: ${JSON.stringify(merged)}`,
  );
  assert(drainPendingMessages(sid).length === 0, 'rich pending drain should remove persisted fallback after first drain');
  await new Promise((resolve) => setImmediate(resolve));
  assert(drainPendingMessages(sid).length === 0, 'rich pending async mirror must not resurrect an already-drained message');
}

{
  const sid = `tool-smoke-async-pending-${process.pid}-${Date.now()}`.replace(/[^A-Za-z0-9_-]/g, '_');
  enqueuePendingMessage(sid, 'persisted pending text');
  await new Promise((resolve) => setImmediate(resolve));
  const drained = drainPendingMessages(sid);
  assert(
    drained.length === 1
      && drained[0]?.text === 'persisted pending text'
      && drained[0]?.content === 'persisted pending text',
    `async pending mirror should persist fallback text: ${JSON.stringify(drained)}`,
  );
}

{
  let computes = 0;
  const key = `tool-smoke-inflight-${Date.now()}-${Math.random()}`;
  const [a, b] = await Promise.all([
    runResultCacheInFlight(key, async () => {
      computes += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return 'shared-result';
    }),
    runResultCacheInFlight(key, async () => {
      computes += 1;
      return 'duplicate-result';
    }),
  ]);
  assert(computes === 1, `in-flight result cache should compute once, computed ${computes}`);
  assert(a === 'shared-result' && b === 'shared-result', 'in-flight result cache should share the first result');
}

{
  const virtualPath = join(tmpdir(), `tool-smoke-stat-inflight-${process.pid}-${Date.now()}`);
  let computes = 0;
  const values = await Promise.all(Array.from({ length: 8 }, () => runReadOnlyStatInFlight(
    virtualPath,
    async () => {
      computes += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { size: 7 };
    },
  )));
  assert(computes === 1, `cross-call stat single-flight should compute once, computed ${computes}`);
  assert(values.every((value) => value.size === 7), 'cross-call stat single-flight should share the result');
}

{
  const virtualPath = join(tmpdir(), `tool-smoke-read-inflight-${process.pid}-${Date.now()}`);
  let computes = 0;
  const values = await Promise.all(Array.from({ length: 8 }, () => runRawContentInFlight(
    virtualPath,
    async () => {
      computes += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Buffer.from('shared-read');
    },
  )));
  assert(computes === 1, `cross-call read single-flight should compute once, computed ${computes}`);
  assert(values.every((value) => value.toString() === 'shared-read'), 'cross-call read single-flight should share bytes');
  invalidateBuiltinResultCache([virtualPath]);
  await runRawContentInFlight(virtualPath, async () => {
    computes += 1;
    return Buffer.from('fresh-read');
  });
  assert(computes === 2, 'path invalidation should start a fresh read generation');
}

{
  const originalFunctionCall = {
    type: 'function_call',
    call_id: 'call_tool_1',
    name: 'shell',
    arguments: JSON.stringify({ command: 'Get-Content -Path src/runtime/agent/orchestrator/session/loop.mjs' }),
  };
  const compactedReplayFunctionCall = {
    type: 'function_call',
    call_id: 'call_tool_1',
    name: 'shell',
    arguments: JSON.stringify({ command: '[mixdog compacted 74 bytes]' }),
  };
  assert(
    _logicalResponseItemMatch(compactedReplayFunctionCall, originalFunctionCall),
    'function_call replay should match by call_id/name even when history compacts arguments',
  );
  assert(
    !_logicalResponseItemMatch({ ...compactedReplayFunctionCall, call_id: 'call_tool_2' }, originalFunctionCall),
    'function_call replay must not match a different call_id',
  );
  const originalCustomCall = {
    type: 'custom_tool_call',
    call_id: 'call_patch_1',
    name: 'apply_patch',
    input: '*** Begin Patch\n*** Add File: a.txt\n+ok\n*** End Patch\n',
  };
  assert(
    _logicalResponseItemMatch({ ...originalCustomCall, input: '[mixdog compacted patch]' }, originalCustomCall),
    'custom_tool_call replay should match by call_id/name even when history compacts patch input',
  );
  assert(
    !_logicalResponseItemMatch({ ...originalCustomCall, call_id: 'call_patch_2' }, originalCustomCall),
    'custom_tool_call replay must not match a different call_id',
  );
}

{
  const publicStrategy = resolveCacheStrategy('worker');
  assert(publicStrategy.tools === 'none', `Anthropic tools must not spend a cache_control BP: ${JSON.stringify(publicStrategy)}`);
  // BP1~3 and the volatile message tail stay 1h; see resolveCacheStrategy.
  assert(publicStrategy.system === '1h' && publicStrategy.tier3 === '1h' && publicStrategy.messages === '1h', `public cache tiers changed unexpectedly: ${JSON.stringify(publicStrategy)}`);
  assert(cacheCapabilityForProvider('anthropic-oauth') === 'explicit-breakpoint', 'Anthropic OAuth should remain explicit-breakpoint');
  assert(cacheCapabilityForProvider('openai-oauth') === 'key-prefix', 'OpenAI OAuth should remain key-prefix');
  assert(cacheCapabilityForProvider('xai') === 'key-prefix', 'xAI should remain key-prefix');
  assert(cacheCapabilityForProvider('grok-oauth') === 'key-prefix', 'Grok OAuth should remain key-prefix');
  assert(cacheCapabilityForProvider('gemini') === 'managed-explicit', 'Gemini should be provider-managed explicit cachedContents');
  assert(shouldMarkWarmForProvider('gemini') === true, 'Gemini provider-managed cache should count as warmable');
  assert(shouldRecordObservedForProvider('gemini') === false, 'Gemini is no longer implicit-observed only');
  assert(shouldRecordObservedForProvider('deepseek') === true, 'DeepSeek should remain observed-only');
}

{
  const prevTraceDisable = process.env.MIXDOG_AGENT_TRACE_DISABLE;
  const prevOaiTransport = process.env.MIXDOG_OAI_TRANSPORT;
  process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
  // This smoke intentionally verifies the pinned WS-only escape hatch. Default
  // transport is now refs-style auto (WS-first with HTTP fallback), so
  // forceHttpFallback would legitimately call fakeHttp unless we pin ws-delta.
  process.env.MIXDOG_OAI_TRANSPORT = 'ws-delta';
  try {
    const provider = new OpenAIOAuthProvider({});
    provider.ensureAuth = async () => ({ access_token: 'fake-token' });
    const calls = [];
    const fakeWs = async () => {
      calls.push('ws');
      return { content: 'ws-ok' };
    };
    const fakeHttp = async () => {
      calls.push('http');
      return { content: 'http-ok' };
    };
    const imageTurnContent = [
      { type: 'text', text: 'look' },
      { type: 'image', data: 'abc', mimeType: 'image/png' },
    ];
    await provider.send(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: imageTurnContent },
      ],
      'gpt-5.5',
      [],
      { _sendViaWebSocketFn: fakeWs, _sendViaHttpSseFn: fakeHttp, sessionId: 'tool-smoke-image-ws' },
    );
    if (provider._forceHttpFallback) {
      throw new Error('image WS send must not poison future OpenAI OAuth sends');
    }
    const storedImageTurnContent = sanitizeContentForStoredHistory(imageTurnContent);
    if (contentHasImage(storedImageTurnContent)) {
      throw new Error(`stored image history must not retain provider-visible image parts: ${JSON.stringify(storedImageTurnContent)}`);
    }
    await provider.send(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: storedImageTurnContent },
        { role: 'assistant', content: 'image received' },
        { role: 'user', content: 'plain ping text, no image' },
      ],
      'gpt-5.5',
      [],
      { _sendViaWebSocketFn: fakeWs, _sendViaHttpSseFn: fakeHttp, sessionId: 'tool-smoke-plain-after-image' },
    );
    await provider.send(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'forced HTTP fallback probe' },
      ],
      'gpt-5.5',
      [],
      { _sendViaWebSocketFn: fakeWs, _sendViaHttpSseFn: fakeHttp, forceHttpFallback: true, sessionId: 'tool-smoke-forced-http-fallback' },
    );
    if (calls.join(',') !== 'ws,ws,ws') {
      throw new Error(`image and forced-fallback probes should keep WS under the pinned transport policy: ${calls.join(',')}`);
    }
  } finally {
    if (prevTraceDisable == null) delete process.env.MIXDOG_AGENT_TRACE_DISABLE;
    else process.env.MIXDOG_AGENT_TRACE_DISABLE = prevTraceDisable;
    if (prevOaiTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
    else process.env.MIXDOG_OAI_TRANSPORT = prevOaiTransport;
  }
}

{
  const anthropicImages = normalizeContentForAnthropic([
    { type: 'input_image', image_url: 'data:image/png;base64,abc' },
    { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    { type: 'input_image', file_id: 'file_123' },
    { type: 'input_text', text: 'look' },
  ]);
  assert(
    anthropicImages[0]?.type === 'image'
      && anthropicImages[0]?.source?.type === 'base64'
      && anthropicImages[0]?.source?.media_type === 'image/png'
      && anthropicImages[0]?.source?.data === 'abc',
    `Anthropic data-url image normalization failed: ${JSON.stringify(anthropicImages[0])}`,
  );
  assert(
    anthropicImages[1]?.type === 'image'
      && anthropicImages[1]?.source?.type === 'url'
      && anthropicImages[1]?.source?.url === 'https://example.com/a.png',
    `Anthropic URL image normalization failed: ${JSON.stringify(anthropicImages[1])}`,
  );
  assert(
    anthropicImages[2]?.type === 'image'
      && anthropicImages[2]?.source?.type === 'file'
      && anthropicImages[2]?.source?.file_id === 'file_123',
    `Anthropic file image normalization failed: ${JSON.stringify(anthropicImages[2])}`,
  );
  const storedFileImage = sanitizeContentForStoredHistory([{ type: 'input_image', file_id: 'file_123' }]);
  assert(!contentHasImage(storedFileImage), `stored file image history must be sanitized: ${JSON.stringify(storedFileImage)}`);
}

{
  const geminiImages = normalizeContentForGeminiParts([
    { type: 'input_image', image_url: 'data:image/png;base64,abc' },
    { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    { fileData: { mimeType: 'image/jpeg', fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/abc' } },
    { type: 'input_image', file_id: 'file_123' },
  ]);
  assert(
    geminiImages[0]?.inlineData?.mimeType === 'image/png'
      && geminiImages[0]?.inlineData?.data === 'abc',
    `Gemini data-url image normalization failed: ${JSON.stringify(geminiImages[0])}`,
  );
  assert(
    geminiImages[1]?.fileData?.fileUri === 'https://example.com/a.png',
    `Gemini URL image normalization failed: ${JSON.stringify(geminiImages[1])}`,
  );
  assert(
    geminiImages[2]?.fileData?.mimeType === 'image/jpeg'
      && geminiImages[2]?.fileData?.fileUri === 'https://generativelanguage.googleapis.com/v1beta/files/abc',
    `Gemini fileData image normalization failed: ${JSON.stringify(geminiImages[2])}`,
  );
  assert(
    /unsupported image file_id for Gemini/.test(geminiImages[3]?.text || ''),
    `Gemini incompatible file_id must be explicit text, got: ${JSON.stringify(geminiImages[3])}`,
  );
}

{
  const grokChatImages = normalizeContentForOpenAIChat([
    { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    { type: 'input_image', file_id: 'file_123' },
  ]);
  assert(
    grokChatImages[0]?.type === 'image_url'
      && grokChatImages[0]?.image_url?.url === 'https://example.com/a.png',
    `OpenAI-compatible URL image normalization failed: ${JSON.stringify(grokChatImages[0])}`,
  );
  assert(
    /unsupported image file_id for OpenAI Chat-compatible/.test(grokChatImages[1]?.text || ''),
    `OpenAI-compatible chat file_id must be explicit text, got: ${JSON.stringify(grokChatImages[1])}`,
  );
  const grokResponsesImages = normalizeContentForOpenAIResponses([
    { type: 'input_image', file_id: 'file_123' },
  ]);
  assert(
    grokResponsesImages[0]?.type === 'input_image' && grokResponsesImages[0]?.file_id === 'file_123',
    `OpenAI-compatible Responses file_id normalization failed: ${JSON.stringify(grokResponsesImages[0])}`,
  );
}

const listOut = await executeBuiltinTool('list', { path: 'scripts', head_limit: 20 }, root);
assertOk('list', listOut, /smoke\.mjs/);
const listArrayErr = validateBuiltinArgs('list', { path: ['scripts'] });
if (!/must be string/.test(String(listArrayErr))) {
  throw new Error(`list path array must be rejected: ${listArrayErr}`);
}

// list meta: opt-in stat columns (size bytes, UTC mtime, octal mode) close
// the `ls -la` metadata gap while the default contract stays path + type.
const listMetaOut = await executeBuiltinTool('list', { path: 'scripts', head_limit: 0, meta: true }, root);
assertOk('list meta', listMetaOut, /smoke\.mjs\tfile\t\d+\t\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\t[0-7]{3,4}/);
const listFileMetaOut = await executeBuiltinTool('list', { path: 'package.json', meta: true }, root);
assertOk('list file meta', listFileMetaOut, /package\.json\tfile\t\d+\t\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\t[0-7]{3,4}/);

// list hidden: dotfiles are opt-in via the exposed `hidden` flag (`ls -a`
// parity); default listings keep them filtered.
const listHiddenOut = await executeBuiltinTool('list', { path: '.', hidden: true, head_limit: 0 }, root);
assertOk('list hidden', listHiddenOut, /\.gitignore\tfile/);
const listRootDefaultOut = await executeBuiltinTool('list', { path: '.', head_limit: 0 }, root);
if (/\.gitignore\tfile/.test(listRootDefaultOut)) {
  throw new Error('default list must keep dotfiles filtered (hidden defaults false)');
}

const grepOut = await executeBuiltinTool('grep', {
  pattern: 'standalone mixdog CLI/TUI coding agent|smoke passed',
  path: 'scripts',
  glob: '*.mjs',
  output_mode: 'content_with_context',
  head_limit: 10,
}, root);
assertOk('grep', grepOut, /smoke\.mjs/);

const grepRedirectOut = await executeBuiltinTool('grep', {
  pattern: 'assertOk',
  path: 'bogus/wrong/prefix/scripts/tool-smoke.mjs',
  head_limit: 3,
}, root);
if (!/^\[redirected from/.test(grepRedirectOut) || !/assertOk/.test(grepRedirectOut)) {
  throw new Error(`grep ENOENT should auto-redirect on unique suffix hit:\n${grepRedirectOut.slice(0, 800)}`);
}

const redundantAllFilesGlobGrepOut = await executeBuiltinTool('grep', {
  pattern: 'standalone mixdog CLI/TUI coding agent',
  glob: '**/*',
  head_limit: 10,
}, root);
assertOk('grep redundant all-files glob', redundantAllFilesGlobGrepOut, /scripts[\\/](?:boot-smoke|tool-smoke|smoke)\.mjs|src[\\/]help\.mjs/);

const implicitRefsGlobOut = await executeBuiltinTool('glob', {
  pattern: '**/agent-session.ts',
  head_limit: 20,
}, root);
if (/refs[\\/]/i.test(String(implicitRefsGlobOut))) {
  throw new Error(`glob default search must exclude refs unless explicitly targeted:\n${implicitRefsGlobOut}`);
}

const explicitSrcGlobOut = await executeBuiltinTool('glob', {
  pattern: '**/runner.mjs',
  path: 'src',
  head_limit: 20,
}, root);
assertOk('glob explicit src', explicitSrcGlobOut, /src[\\/].*runner\.mjs/i);

for (const [key, value] of [['pattern', ['*.mjs']], ['path', ['src']]]) {
  const args = key === 'pattern' ? { pattern: value } : { pattern: '*.mjs', path: value };
  const err = validateBuiltinArgs('glob', args);
  if (!/must be string/.test(String(err))) {
    throw new Error(`glob ${key} array must be rejected: ${err}`);
  }
}

const globPathOnlyOut = await executeBuiltinTool('glob', {
  path: 'scripts',
  // scripts/ holds well over 200 entries and glob ordering tracks mtime, so a
  // tight cap makes membership of any one file boundary-flaky. 0 = unlimited.
  head_limit: 0,
}, root);
assertOk('glob path-only default *', globPathOnlyOut, /tool-smoke\.mjs/i);

const grepNoPatternGlobOut = await executeBuiltinTool('grep', {
  path: 'scripts',
  glob: 'tool-smoke.mjs',
  head_limit: 5,
}, root);
assertOk('grep without pattern routes to glob', grepNoPatternGlobOut, /tool-smoke\.mjs/i);

function grepCountTotalMatches(body) {
  const m = String(body).match(/\[total (\d+) match/i);
  return m ? Number(m[1]) : null;
}

const grepCountSingleOut = await executeBuiltinTool('grep', {
  pattern: 'assertOk',
  path: 'scripts/tool-smoke.mjs',
  output_mode: 'count',
}, root);
const singleCountTotal = grepCountTotalMatches(grepCountSingleOut);
if (singleCountTotal == null || singleCountTotal < 1) {
  throw new Error(`grep count baseline failed:\n${grepCountSingleOut.slice(0, 400)}`);
}

const grepChunkContextOut = await executeBuiltinTool('grep', {
  pattern: 'grepCountTotalMatches',
  path: 'scripts',
  glob: 'tool-smoke.mjs',
  '-C': 1,
  head_limit: 30,
}, root);
if (!/^# scripts\/tool-smoke\.mjs:\d+ \[lines \d+-\d+\]$/m.test(String(grepChunkContextOut))) {
  throw new Error(`scalar -C must emit patch-ready range headers:\n${grepChunkContextOut.slice(0, 800)}`);
}
const prefixedChunkContextLines = String(grepChunkContextOut)
  .split(/\r?\n/)
  .filter((line) => /^scripts\/tool-smoke\.mjs(?::\d+:|-\d+-)/.test(line));
if (prefixedChunkContextLines.some((line) => !/\[lines \d+-\d+\]$/.test(line))) {
  throw new Error(`scalar -C must strip rg prefixes except compact anchors with neutral ranges:\n${grepChunkContextOut.slice(0, 800)}`);
}
const ctxBodyLines = String(grepChunkContextOut).split('\n').filter((l) => l && !/^\[/.test(l) && !/^\(no matches\)/.test(l));
const orphanLineOnlyContext = ctxBodyLines.some((l) => /^\d+-/.test(l));
if (orphanLineOnlyContext) {
  throw new Error(`scalar -C must not leave line-only context orphans:\n${grepChunkContextOut.slice(0, 800)}`);
}
if (!/function grepCountTotalMatches/.test(String(grepChunkContextOut))) {
  throw new Error(`scalar -C should include match span:\n${grepChunkContextOut.slice(0, 800)}`);
}

const findOut = await executeBuiltinTool('find', {
  query: 'tool smoke',
  path: '.',
  head_limit: 10,
}, root);
assertOk('find', findOut, /scripts[\\/]tool-smoke\.mjs/i);

const findQueryArrayErr = validateBuiltinArgs('find', { query: ['tool smoke', 'smoke'], path: '.' });
if (!/non-empty string/.test(String(findQueryArrayErr))) {
  throw new Error(`find query array must be rejected: ${findQueryArrayErr}`);
}
const findPathArrayErr = validateBuiltinArgs('find', { query: 'tool smoke', path: ['.'] });
if (!/must be a string/.test(String(findPathArrayErr))) {
  throw new Error(`find path array must be rejected: ${findPathArrayErr}`);
}

{
  let broadEnumerationCalls = 0;
  const timeout = Object.assign(
    new Error('native fuzzy search timed out after 20000ms. Fuzzy ranking requires a complete file inventory; narrow cwd or set max depth.'),
    { code: 'NATIVE_SEARCH_TIMEOUT' },
  );
  const out = await executeFuzzyFindTool(
    { query: 'tool-smoke-timeout', path: '.', head_limit: 5 },
    root,
    {
      __tryServeFuzzySearch: async () => { throw timeout; },
      __runRg: async () => {
        broadEnumerationCalls += 1;
        return 'scripts/tool-smoke.mjs\n';
      },
    },
  );
  if (broadEnumerationCalls !== 0 || !/complete file inventory/.test(String(out))) {
    throw new Error(`find fuzzy timeout must not repeat the same broad inventory walk:\n${out}`);
  }
}

// Exercise the test-only rg seam directly so this verifies the in-flight
// single-flight rather than merely observing cached output from the real tree.
// TTL=0 rules out persistent broad-enumeration cache reuse; the delayed listing
// keeps both exact-name workers concurrent while the first sweep is in flight.
{
  const previousFindEnumCacheTtl = process.env.MIXDOG_FIND_ENUM_CACHE_TTL_MS;
  const firstQuery = 'tool-smoke-single-flight-first.mjs';
  const secondQuery = 'tool-smoke-single-flight-second.mjs';
  const firstPath = `fixtures/${firstQuery}`;
  const secondPath = `fixtures/${secondQuery}`;
  let broadEnumerationCalls = 0;
  process.env.MIXDOG_FIND_ENUM_CACHE_TTL_MS = '0';
  try {
    const runRg = async () => {
        broadEnumerationCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return `${firstPath}\n${secondPath}\n`;
      };
    const [firstOut, secondOut] = await Promise.all([
      executeFuzzyFindTool({ query: firstQuery, path: 'scripts/fixtures', head_limit: 5 }, root, { __runRg: runRg }),
      executeFuzzyFindTool({ query: secondQuery, path: 'scripts/fixtures', head_limit: 5 }, root, { __runRg: runRg }),
    ]);
    if (broadEnumerationCalls !== 1) {
      throw new Error(`parallel scalar find calls must share exactly one broad enumeration, got ${broadEnumerationCalls}`);
    }
    if (!String(firstOut).includes(firstPath) || !String(secondOut).includes(secondPath)) {
      throw new Error(`parallel scalar find calls must retain both exact-name bodies:\n${firstOut}\n${secondOut}`);
    }
  } finally {
    if (previousFindEnumCacheTtl === undefined) delete process.env.MIXDOG_FIND_ENUM_CACHE_TTL_MS;
    else process.env.MIXDOG_FIND_ENUM_CACHE_TTL_MS = previousFindEnumCacheTtl;
  }
}

// Shared exploration fixture: CC/Grok parity boundaries across all six local
// retrieval tools. It intentionally combines exact-file operands, glob/type
// filters, hidden/noise handling, Unicode + spaces, windows, and no-match/ENOENT.
{
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'mixdog-exploration-tools-'));
  try {
    mkdirSync(join(fixtureRoot, 'src', '공백 폴더'), { recursive: true });
    mkdirSync(join(fixtureRoot, 'node_modules', 'noise'), { recursive: true });
    writeFileSync(join(fixtureRoot, 'package.json'), '{"type":"module"}\n', 'utf8');
    writeFileSync(
      join(fixtureRoot, 'src', 'alpha.mjs'),
      'export const needleAlpha = 1;\nsecond line\n',
      'utf8',
    );
    writeFileSync(
      join(fixtureRoot, 'src', '공백 폴더', '한글 파일.mjs'),
      'export const unicodeNeedle = 2;\n',
      'utf8',
    );
    writeFileSync(
      join(fixtureRoot, 'src', '.hidden.mjs'),
      'export const hiddenNeedle = 3;\n',
      'utf8',
    );
    writeFileSync(
      join(fixtureRoot, 'node_modules', 'noise', 'noise.mjs'),
      'export const noiseNeedle = 4;\n',
      'utf8',
    );

    const defaultList = await executeBuiltinTool('list', {
      path: join(fixtureRoot, 'src'),
      hidden: false,
      head_limit: 0,
    }, fixtureRoot);
    if (/\.hidden\.mjs/.test(String(defaultList)) || !/alpha\.mjs/.test(String(defaultList))) {
      throw new Error(`list hidden=false contract failed:\n${defaultList}`);
    }
    const hiddenList = await executeBuiltinTool('list', {
      path: join(fixtureRoot, 'src'),
      hidden: true,
      head_limit: 0,
    }, fixtureRoot);
    assertOk('list hidden fixture', hiddenList, /\.hidden\.mjs/);

    const unicodeGlob = await executeBuiltinTool('glob', {
      pattern: '**/한글 파일.mjs',
      path: fixtureRoot,
      head_limit: 10,
    }, fixtureRoot);
    assertOk('glob unicode + space', unicodeGlob, /공백 폴더[\\/]한글 파일\.mjs/);
    const noiseGlob = await executeBuiltinTool('glob', {
      pattern: '**/noise.mjs',
      path: fixtureRoot,
      head_limit: 10,
    }, fixtureRoot);
    assertOk(
      'glob explicit pattern overrides dependency noise exclusion',
      noiseGlob,
      /node_modules[\\/]noise[\\/]noise\.mjs/,
    );

    const exactFile = join(fixtureRoot, 'src', 'alpha.mjs');
    const exactGlobGrep = await executeBuiltinTool('grep', {
      pattern: 'needleAlpha',
      path: exactFile,
      glob: '*.mjs',
      output_mode: 'content',
      head_limit: 10,
    }, fixtureRoot);
    assertOk('grep exact file + glob', exactGlobGrep, /needleAlpha/);
    const exactTypeGrep = await executeBuiltinTool('grep', {
      pattern: 'needleAlpha',
      path: exactFile,
      type: 'js',
      output_mode: 'content',
      head_limit: 10,
    }, fixtureRoot);
    assertOk('grep exact file + type', exactTypeGrep, /needleAlpha/);
    const noMatchGrep = await executeBuiltinTool('grep', {
      pattern: 'definitelyAbsentNeedle',
      path: exactFile,
      glob: '*.mjs',
      output_mode: 'content',
      head_limit: 10,
    }, fixtureRoot);
    if (!/^\(no matches\)/.test(String(noMatchGrep)) || /^Error/.test(String(noMatchGrep))) {
      throw new Error(`grep no-match must remain a successful empty result:\n${noMatchGrep}`);
    }
    const invalidRegexFallback = await executeBuiltinTool('grep', {
      pattern: '(',
      path: exactFile,
      output_mode: 'content',
      head_limit: 10,
    }, fixtureRoot);
    if (!/^\[regex parse fallback: fixed-string terms\]\n\(no matches\)/.test(String(invalidRegexFallback))) {
      throw new Error(`grep invalid-regex fallback must retain its no-match body:\n${invalidRegexFallback}`);
    }

    const unicodeFind = await executeBuiltinTool('find', {
      query: '한글 파일',
      path: fixtureRoot,
      head_limit: 10,
    }, fixtureRoot);
    assertOk('find unicode + space', unicodeFind, /공백 폴더[\\/]한글 파일\.mjs/);
    const quietNoiseFind = await executeBuiltinTool('find', {
      query: 'noise.mjs',
      path: fixtureRoot,
      include_noise: false,
      head_limit: 10,
    }, fixtureRoot);
    if (/node_modules[\\/]noise[\\/]noise\.mjs/.test(String(quietNoiseFind))) {
      throw new Error(`find include_noise=false leaked dependency noise:\n${quietNoiseFind}`);
    }
    const noisyFind = await executeBuiltinTool('find', {
      query: 'noise.mjs',
      path: fixtureRoot,
      include_noise: true,
      head_limit: 10,
    }, fixtureRoot);
    assertOk('find include_noise=true', noisyFind, /node_modules[\\/]noise[\\/]noise\.mjs/);

    const readWindow = await executeBuiltinTool('read', {
      path: exactFile,
      offset: 0,
      limit: 1,
    }, fixtureRoot);
    if (!/^1→export const needleAlpha/m.test(String(readWindow))
      || /second line/.test(String(readWindow))) {
      throw new Error(`read line window contract failed:\n${readWindow}`);
    }
    const missingRead = await executeBuiltinTool('read', {
      path: join(fixtureRoot, 'missing.mjs'),
    }, fixtureRoot);
    if (!/^Error/.test(String(missingRead)) || !/ENOENT|does not exist|not found/i.test(String(missingRead))) {
      throw new Error(`read ENOENT contract failed:\n${missingRead}`);
    }

    const graphUnicode = await executeCodeGraphTool('code_graph', {
      mode: 'find_symbol',
      files: ['src/공백 폴더/한글 파일.mjs'],
      symbols: ['unicodeNeedle'],
    }, fixtureRoot);
    assertOk('code_graph unicode path', graphUnicode, /unicodeNeedle/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

const readOut = await executeBuiltinTool('read', {
  path: 'scripts/smoke.mjs',
  offset: 0,
  limit: 4,
}, root);
assertOk('read', readOut, /spawnSync/);

const readDirOut = await executeBuiltinTool('read', {
  path: 'scripts',
}, root);
if (!/^Error[\s:[]/.test(String(readDirOut)) || !/read expects a file/i.test(String(readDirOut))) {
  throw new Error(`read directory must be classified as Error:\n${readDirOut}`);
}

{
  const imageBatchTmp = mkdtempSync(join(tmpdir(), 'mixdog-read-image-batch-'));
  try {
    const firstImage = join(imageBatchTmp, 'first.png');
    const secondImage = join(imageBatchTmp, 'second.png');
    const textFile = join(imageBatchTmp, 'note.txt');
    const binaryFile = join(imageBatchTmp, 'sample.bin');
    const missingImage = join(imageBatchTmp, 'missing.png');
    const onePixelPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl8Y5sAAAAASUVORK5CYII=',
      'base64',
    );
    writeFileSync(firstImage, onePixelPng);
    writeFileSync(secondImage, onePixelPng);
    writeFileSync(textFile, 'batch text body\n', 'utf8');
    writeFileSync(binaryFile, Buffer.from([0x41, 0x00, 0x42, 0x43]));

    const binaryRead = await executeBuiltinTool('read', { path: binaryFile }, root);
    if (!/binary, 4 bytes/.test(String(binaryRead)) || !/41 00 42 43/.test(String(binaryRead))) {
      throw new Error(`binary read must retain async-probe hex preview contract: ${binaryRead}`);
    }

    const twoImageBatch = await executeBuiltinTool('read', {
      path: [firstImage, secondImage],
    }, root);
    const twoImageParts = Array.isArray(twoImageBatch?.content) ? twoImageBatch.content : [];
    const rawImageCount = twoImageParts.filter((part) => part?.type === 'image').length;
    const renderedText = twoImageParts
      .filter((part) => part?.type === 'text')
      .map((part) => part.text)
      .join('\n');
    if (!contentHasImage(twoImageBatch) || rawImageCount !== 2 || /read_hex|89504e47/i.test(renderedText)) {
      throw new Error(`read path[] must retain two visual image blocks instead of binary hex: ${JSON.stringify(twoImageBatch)}`);
    }
    const providerImageCounts = {
      anthropic: normalizeContentForAnthropic(twoImageBatch).filter((part) => part?.type === 'image').length,
      openaiChat: normalizeContentForOpenAIChat(twoImageBatch).filter((part) => part?.type === 'image_url').length,
      openaiResponses: normalizeContentForOpenAIResponses(twoImageBatch).filter((part) => part?.type === 'input_image').length,
      gemini: normalizeContentForGeminiParts(twoImageBatch).filter((part) => part?.inlineData?.mimeType?.startsWith('image/')).length,
    };
    if (Object.values(providerImageCounts).some((count) => count !== 2)) {
      throw new Error(`read path[] image blocks must survive every provider normalizer: ${JSON.stringify(providerImageCounts)}`);
    }

    const mixedBatch = await executeBuiltinTool('read', {
      path: [firstImage, textFile, missingImage, firstImage],
    }, root);
    const mixedParts = Array.isArray(mixedBatch?.content) ? mixedBatch.content : [];
    const mixedText = mixedParts
      .filter((part) => part?.type === 'text')
      .map((part) => part.text)
      .join('\n');
    if (mixedParts.filter((part) => part?.type === 'image').length !== 1
      || !/batch text body/.test(mixedText)
      || !/missing\.png \[error\]/.test(mixedText)
      || !/\[= entry #1, identical result omitted\]/.test(mixedText)) {
      throw new Error(`mixed read batch must preserve text, per-entry errors, and rich duplicate elision: ${JSON.stringify(mixedBatch)}`);
    }
    const rejectedMixedBatch = await executeBuiltinTool('read', {
      path: [firstImage, missingImage],
      reject_partial: true,
    }, root);
    if (!/^Error: batch read rejected \(1 of 2 failed; reject_partial:true\)/.test(String(rejectedMixedBatch))) {
      throw new Error(`rich read batch reject_partial contract failed: ${rejectedMixedBatch}`);
    }
  } finally {
    rmSync(imageBatchTmp, { recursive: true, force: true });
  }
}

const readRegionBatchOut = await executeBuiltinTool('read', {
  path: [
    { path: 'scripts/smoke.mjs', offset: 0, limit: 2 },
    { path: 'scripts/smoke.mjs', offset: 2, limit: 2 },
  ],
}, root);
if (!/^read 2\b/m.test(String(readRegionBatchOut))
  || (String(readRegionBatchOut).match(/scripts\/smoke\.mjs \[ok\]/g) || []).length < 2
  || !/1→import \{ spawnSync \}/.test(String(readRegionBatchOut))
  || !/3→import \{ fileURLToPath \}/.test(String(readRegionBatchOut))
  || !/(pass offset:2 to continue|ONE window: offset:2,? limit:\d+)/.test(String(readRegionBatchOut))
  || !/(pass offset:4 to continue|ONE window: offset:4,? limit:\d+)/.test(String(readRegionBatchOut))) {
  throw new Error(`read region batch must preserve both requested spans:\n${readRegionBatchOut}`);
}

const readStringifiedRegionArgs = {
  path: JSON.stringify([{ path: 'scripts/smoke.mjs', offset: 0, limit: 2 }]),
};
const readStringifiedRegionErr = validateBuiltinArgs('read', readStringifiedRegionArgs);
if (readStringifiedRegionErr || !Array.isArray(readStringifiedRegionArgs.path)) {
  throw new Error(`read guard must losslessly coerce stringified path arrays: err=${readStringifiedRegionErr} args=${JSON.stringify(readStringifiedRegionArgs)}`);
}
const readStringifiedRegionOut = await executeBuiltinTool('read', {
  path: JSON.stringify([{ path: 'scripts/smoke.mjs', offset: 0, limit: 2 }]),
}, root);
if (!/^read 1\b/m.test(String(readStringifiedRegionOut)) || !/scripts\/smoke\.mjs \[ok\]/.test(String(readStringifiedRegionOut)) || !/1→import \{ spawnSync \}/.test(String(readStringifiedRegionOut))) {
  throw new Error(`read stringified region batch must execute after guard coercion:\n${readStringifiedRegionOut}`);
}
const readStringifiedLineArgs = {
  path: JSON.stringify([{ path: 'scripts/smoke.mjs', line: 10, context: 2 }]),
};
const readStringifiedLineErr = validateBuiltinArgs('read', readStringifiedLineArgs);
if (readStringifiedLineErr || readStringifiedLineArgs.path[0].offset !== 7 || readStringifiedLineArgs.path[0].limit !== 5) {
  throw new Error(`read guard must losslessly convert legacy line/context inside stringified arrays to offset/limit: err=${readStringifiedLineErr} args=${JSON.stringify(readStringifiedLineArgs)}`);
}

// Absorb shape 1: region array + top-level offset/limit → top-level becomes
// the default window for regions that lack their own; no hard error.
const readRegionPlusTopLevelArgs = {
  path: [{ path: 'scripts/smoke.mjs', offset: 3, limit: 4 }, { path: 'scripts/smoke.mjs' }],
  offset: 0,
  limit: 2,
};
const readRegionPlusTopLevelErr = validateBuiltinArgs('read', readRegionPlusTopLevelArgs);
if (readRegionPlusTopLevelErr
  || 'offset' in readRegionPlusTopLevelArgs || 'limit' in readRegionPlusTopLevelArgs
  || readRegionPlusTopLevelArgs.path[0].offset !== 3 || readRegionPlusTopLevelArgs.path[0].limit !== 4
  || readRegionPlusTopLevelArgs.path[1].offset !== 0 || readRegionPlusTopLevelArgs.path[1].limit !== 2) {
  throw new Error(`read guard must absorb region-array + top-level offset/limit: err=${readRegionPlusTopLevelErr} args=${JSON.stringify(readRegionPlusTopLevelArgs)}`);
}

// Absorb shape 2: parallel offset/limit as JSON-stringified arrays with path[]
// → zipped into per-file region objects (pairwise recovery), no int error.
const readZipWindowArgs = {
  path: ['scripts/smoke.mjs', 'scripts/smoke.mjs'],
  offset: '[0, 5]',
  limit: '[2, 3]',
};
const readZipWindowErr = validateBuiltinArgs('read', readZipWindowArgs);
if (readZipWindowErr || !Array.isArray(readZipWindowArgs.path)
  || readZipWindowArgs.path[0].offset !== 0 || readZipWindowArgs.path[0].limit !== 2
  || readZipWindowArgs.path[1].offset !== 5 || readZipWindowArgs.path[1].limit !== 3
  || 'offset' in readZipWindowArgs || 'limit' in readZipWindowArgs) {
  throw new Error(`read guard must zip stringified offset/limit arrays onto path[]: err=${readZipWindowErr} args=${JSON.stringify(readZipWindowArgs)}`);
}

// Absorb shape 3: code_graph file/files as a JSON-stringified array → parsed to
// a real array before lookup (dispatched into files[]).
const cgStringifiedFileArgs = { mode: 'symbols', file: JSON.stringify(['a.mjs', 'b.mjs']) };
const cgStringifiedFileErr = validateBuiltinArgs('code_graph', cgStringifiedFileArgs);
if (cgStringifiedFileErr || 'file' in cgStringifiedFileArgs
  || !Array.isArray(cgStringifiedFileArgs.files)
  || cgStringifiedFileArgs.files[0] !== 'a.mjs' || cgStringifiedFileArgs.files[1] !== 'b.mjs') {
  throw new Error(`code_graph guard must parse JSON-stringified file array: err=${cgStringifiedFileErr} args=${JSON.stringify(cgStringifiedFileArgs)}`);
}
const cgFilteredOutlineArgs = { mode: 'symbols', files: ['a.mjs'], symbols: ['guard'] };
const cgFilteredOutlineErr = validateBuiltinArgs('code_graph', cgFilteredOutlineArgs);
if (cgFilteredOutlineErr || cgFilteredOutlineArgs.mode !== 'symbols'
  || cgFilteredOutlineArgs.symbols?.[0] !== 'guard') {
  throw new Error(`code_graph guard must preserve symbols[] file-outline filters: err=${cgFilteredOutlineErr} args=${JSON.stringify(cgFilteredOutlineArgs)}`);
}

const graphOut = await executeCodeGraphTool('code_graph', {
  mode: 'symbols',
  file: 'scripts/smoke.mjs',
}, root);
assertOk('code_graph', graphOut, /binding|spawnSync|symbol/i);
const graphFilteredOut = await executeCodeGraphTool('code_graph', {
  mode: 'symbols',
  file: 'scripts/tool-smoke.mjs',
  symbols: ['validateBuiltinArgs'],
}, root);
const graphFilteredLines = String(graphFilteredOut).split('\n').filter(Boolean);
if (!graphFilteredLines.length
  || graphFilteredLines.some((line) => !/validateBuiltinArgs/i.test(line))) {
  throw new Error(`code_graph symbols[] file-outline filtering failed:\n${graphFilteredOut}`);
}
const graphNamePathOut = await executeCodeGraphTool('code_graph', {
  mode: 'find_symbol',
  file: 'src/runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs',
  symbol: 'AgentStallAbortError/constructor',
  body: false,
}, root);
if (!/path=AgentStallAbortError\/constructor/.test(String(graphNamePathOut))) {
  throw new Error(`code_graph find_symbol name-path lookup failed:\n${graphNamePathOut}`);
}
const graphHierarchyOut = await executeCodeGraphTool('code_graph', {
  mode: 'overview',
  file: 'src/runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs',
  depth: 1,
}, root);
if (!/outline:/.test(String(graphHierarchyOut))
  || !/\n  method constructor\b/.test(String(graphHierarchyOut))) {
  throw new Error(`code_graph hierarchical overview failed:\n${graphHierarchyOut}`);
}
const graphOwnedReferenceOut = await executeCodeGraphTool('code_graph', {
  mode: 'references',
  file: 'src/runtime/agent/orchestrator/tools/code-graph/dispatch.mjs',
  symbol: '_filterSymbolOutline',
  limit: 20,
}, root);
if (!/owner=codeGraph/.test(String(graphOwnedReferenceOut))) {
  throw new Error(`code_graph reference owner lookup failed:\n${graphOwnedReferenceOut}`);
}
if (!/^# declaration$/m.test(String(graphOwnedReferenceOut))
  || !/dispatch\.mjs:\d+/.test(String(graphOwnedReferenceOut))
  || (String(graphOwnedReferenceOut).match(/^# references$/gm) || []).length !== 1) {
  throw new Error(`code_graph reference declaration contract failed:\n${graphOwnedReferenceOut}`);
}
const graphStringSymbolOut = await executeCodeGraphTool('code_graph', {
  mode: 'symbols',
  symbols: 'executeBuiltinTool',
}, root);
assertOk('code_graph string symbols', graphStringSymbolOut, /executeBuiltinTool|symbol_search/i);
const graphRootAnchorOut = await executeCodeGraphTool('code_graph', {
  mode: 'symbol_search',
  symbol: 'executeBuiltinTool',
  file: root,
}, root);
if (/file not found|outside cwd|arbitrary tree/i.test(String(graphRootAnchorOut))) {
  throw new Error(`code_graph redundant root anchor was not normalized:\n${graphRootAnchorOut}`);
}

const graphSymbolBatchOut = await executeCodeGraphTool('code_graph', {
  mode: 'symbol_search',
  symbols: ['executeBuiltinTool', 'validateBuiltinArgs'],
  limit: 2,
}, root);
if (!/# symbol_search executeBuiltinTool\b/.test(String(graphSymbolBatchOut)) || !/# symbol_search validateBuiltinArgs\b/.test(String(graphSymbolBatchOut))) {
  throw new Error(`code_graph symbol_search symbols[] batch execution failed:\n${graphSymbolBatchOut}`);
}

// Absorb shape 3 (real dispatch): file as a JSON-stringified array batches per
// file instead of hitting "file not found: [...]".
const graphStringifiedFileOut = await executeCodeGraphTool('code_graph', {
  mode: 'symbols',
  file: JSON.stringify(['scripts/smoke.mjs']),
}, root);
if (/file not found/.test(String(graphStringifiedFileOut))
  || !/binding|spawnSync|symbol/i.test(String(graphStringifiedFileOut))) {
  throw new Error(`code_graph must parse JSON-stringified file array before lookup:\n${graphStringifiedFileOut}`);
}

const graphMissingFileOut = await executeCodeGraphTool('code_graph', {
  mode: 'symbols',
  file: 'src/runtime/loop.mjs',
}, root);
if (!/^Error: code_graph: file not found: src\/runtime\/loop\.mjs/.test(String(graphMissingFileOut))) {
  throw new Error(`code_graph missing-file fast path failed:\n${graphMissingFileOut}`);
}

const graphDotDirOut = await executeCodeGraphTool('code_graph', {
  mode: 'overview',
  file: '.',
}, root);
assertOk('code_graph dot directory anchor', graphDotDirOut, /files\s+\d+|edges\s+\d+/i);

const patchOut = await executePatchTool('apply_patch', {
  base_path: root,
  dry_run: true,
  fuzzy: false,
  patch: `*** Begin Patch
*** Update File: scripts/smoke.mjs
@@
-process.stdout.write('smoke passed ✓\\n');
+process.stdout.write('smoke passed ok\\n');
*** End Patch
`,
}, root);
assertOk('apply_patch dry_run', patchOut, /checked|validated|dry|OK/i);

const stalePatchOut = await executePatchTool('apply_patch', {
  base_path: root,
  dry_run: true,
  fuzzy: false,
  patch: `*** Begin Patch
*** Update File: scripts/smoke.mjs
@@
-definitely-not-current-smoke-line
+definitely-not-current-smoke-line-2
*** End Patch
`,
}, root);
if (!/^Error[\s:[]/.test(String(stalePatchOut)) || !/apply_patch/i.test(String(stalePatchOut))) {
  throw new Error(`apply_patch stale context must return an Error result, not throw or pass:\n${stalePatchOut}`);
}

// Malformed-but-unambiguous patch openings must be absorbed (dry-run, so no
// write). Each targets the same known-good smoke.mjs line the cases above use.
const smokeBody = `@@
-process.stdout.write('smoke passed ✓\\n');
+process.stdout.write('smoke passed ok\\n');
*** End Patch
`;
const absorbCases = [
  ['leading blank lines', `\n\n*** Begin Patch\n*** Update File: scripts/smoke.mjs\n${smokeBody}`],
  ['decorated begin header', `*** Begin Patch (V4A) ***\n*** Update File: scripts/smoke.mjs\n${smokeBody}`],
  ['bare file path opening', `*** Begin Patch\nscripts/smoke.mjs\n${smokeBody}`],
  ['File: prefixed opening', `*** Begin Patch\nFile: scripts/smoke.mjs\n${smokeBody}`],
  ['unified body in envelope', `*** Begin Patch\n--- scripts/smoke.mjs\n+++ scripts/smoke.mjs\n${smokeBody}`],
];
for (const [label, patch] of absorbCases) {
  const out = await executePatchTool('apply_patch', { base_path: root, dry_run: true, fuzzy: false, patch }, root);
  assertOk(`apply_patch absorbs ${label}`, out, /checked|validated|dry|OK/i);
}

const ambiguousPatchOut = await executePatchTool('apply_patch', {
  base_path: root,
  dry_run: true,
  fuzzy: false,
  patch: `*** Begin Patch\nthis line is not a valid opening\n${smokeBody}`,
}, root);
if (!/^Error[\s:[]/.test(String(ambiguousPatchOut)) || !/before a file header|V4A/i.test(String(ambiguousPatchOut))) {
  throw new Error(`apply_patch must keep erroring on genuinely ambiguous openings:\n${ambiguousPatchOut}`);
}

// Unified-looking first body line but real V4A file sections appear later: the
// envelope must NOT be stripped to unified — it stays ambiguous and errors.
const mixedPatchOut = await executePatchTool('apply_patch', {
  base_path: root,
  dry_run: true,
  fuzzy: false,
  patch: `*** Begin Patch\n--- scripts/smoke.mjs\n*** Update File: scripts/smoke.mjs\n${smokeBody}`,
}, root);
if (!/^Error[\s:[]/.test(String(mixedPatchOut)) || !/before a file header|V4A/i.test(String(mixedPatchOut))) {
  throw new Error(`apply_patch must keep erroring on mixed unified/V4A openings:\n${mixedPatchOut}`);
}

// Compacted-history placeholder guard: EVERY [mixdog compacted …] variant must
// be rejected with the corrective message BEFORE format dispatch/salvage, both
// as the first line and standalone mid-body (after a *** Begin Patch header).
const compactedGuardCases = [
  ['legacy key: prefix', '[mixdog compacted patch: 4096 chars, sha256:deadbeefdeadbeef]\n*** Begin Patch\n*** Update File: a.txt\n+x\n*** End Patch\n'],
  ['variant key form', '[mixdog compacted patch v4a, sha256:deadbeefdeadbeef]\n*** Begin Patch\n*** Update File: a.txt\n+x\n*** End Patch\n'],
  ['no chars/sha detail', '[mixdog compacted old_string]\n'],
  ['mid-body standalone', '*** Begin Patch\n*** Update File: a.txt\n[mixdog compacted patch v4a, sha256:deadbeefdeadbeef]\n*** End Patch\n'],
];
for (const [label, patch] of compactedGuardCases) {
  const out = await executePatchTool('apply_patch', { base_path: root, dry_run: true, fuzzy: false, patch }, root);
  if (!/^Error[\s:[]/.test(String(out))
      || !/compacted-history placeholder/i.test(String(out))
      || !/re-read the current target file contents now/i.test(String(out))
      || !/fresh full patch/i.test(String(out))) {
    throw new Error(`apply_patch must reject compacted placeholder (${label}):\n${out}`);
  }
}
// A legit unified edit whose body content mentions the literal text on a diff
// line (+/-/space) must still parse — the guard only trips on non-diff lines.
const compactedFalsePositiveOut = await executePatchTool('apply_patch', {
  base_path: root,
  dry_run: true,
  fuzzy: false,
  patch: `*** Begin Patch\n*** Add File: compacted-note.txt\n+[mixdog compacted patch: 10 chars, sha256:abc]\n*** End Patch\n`,
}, root);
assertOk('apply_patch keeps diff-line placeholder text', compactedFalsePositiveOut, /checked|validated|dry|OK/i);

const shellOutPromise = executeBuiltinTool('shell', {
  command: 'node --version',
  timeout_ms: 30_000,
}, root);

const shellFailOutPromise = executeBuiltinTool('shell', {
  command: 'node -e "console.error(\'tool-smoke-bash-fail\'); process.exit(7)"',
  timeout_ms: 30_000,
}, root);

const shellTool = BUILTIN_TOOLS.find((tool) => tool.name === 'shell');
const shellDescription = shellTool?.description || '';
if (!/Run programs and runtime\/state operations/i.test(shellDescription)
    || !/perform calculations, transform data, generate computed files/i.test(shellDescription)
    || !/ordinary file-content inspection/i.test(shellDescription)
    || !/Tracked sync\/async commands belong to the current run/i.test(shellDescription)
    || !/service explicitly required after the run exits.*nohup/i.test(shellDescription)) {
  throw new Error(`shell description must use ordinary execution/computation/file-role concepts: ${shellDescription}`);
}
const shellProps = shellTool?.inputSchema?.properties || {};
if (JSON.stringify(Object.keys(shellProps)) !== JSON.stringify(['command', 'timeout_ms', 'run_in_background'])) {
  throw new Error(`shell schema must expose only command, timeout_ms, and run_in_background: ${JSON.stringify(shellProps)}`);
}
for (const retired of ['timeout', 'cwd', 'workdir', 'mode', 'shell', 'persistent', 'session_id', 'merge_stderr']) {
  const err = validateBuiltinArgs('shell', { command: 'node --version', [retired]: retired === 'mode' ? 'async' : true });
  if (!/unsupported.*command, timeout_ms, and run_in_background/i.test(err || '')) {
    throw new Error(`shell retired arg must be rejected (${retired}): ${err}`);
  }
}
const shellTimeoutDescription = shellTool?.inputSchema?.properties?.timeout_ms?.description || '';
if (shellTimeoutDescription !== 'Optional total deadline.') {
  throw new Error(`shell timeout_ms contract must use the approved optional deadline description: ${shellTimeoutDescription}`);
}
if (shellTool?.inputSchema?.properties?.timeout_ms?.minimum !== undefined) {
  throw new Error('shell timeout_ms must follow CC by treating 0 as omitted instead of advertising a positive minimum');
}
const shellZeroTimeoutErr = validateBuiltinArgs('shell', { command: 'node --version', timeout_ms: 0 });
const shellNegativeTimeoutErr = validateBuiltinArgs('shell', { command: 'node --version', timeout_ms: -1 });
if (shellZeroTimeoutErr || !/non-negative number/.test(String(shellNegativeTimeoutErr))) {
  throw new Error(`shell timeout_ms must absorb 0 and reject negatives: zero=${shellZeroTimeoutErr} negative=${shellNegativeTimeoutErr}`);
}
const publicTaskTool = BUILTIN_TOOLS.find((tool) => tool.name === 'task');
const publicTaskProps = publicTaskTool?.inputSchema?.properties || {};
if (publicTaskProps.action?.enum?.includes('wait') || publicTaskProps.timeout_ms || publicTaskProps.poll_ms) {
  throw new Error('task schema must not expose the retired synchronous wait contract');
}
const taskWaitOut = await executeBuiltinTool('task', {
  action: 'wait',
  task_id: 'task_hidden_wait_smoke',
  timeout_ms: 1,
}, root);
if (!/^Error[\s:[]/.test(String(taskWaitOut)) || !/list\|status\|read\|check_after\|cancel/i.test(String(taskWaitOut))) {
  throw new Error(`task wait must be rejected by the runtime contract:\n${taskWaitOut}`);
}

const shellProjectCwdSession = `tool-smoke-project-cwd-${process.pid}`;
const shellLocalCdOut = await executeBuiltinTool('shell', {
  command: process.platform === 'win32'
    ? 'Set-Location scripts; Get-Location | Select-Object -ExpandProperty Path'
    : 'cd scripts && pwd',
  timeout_ms: 30_000,
}, root, { sessionId: shellProjectCwdSession });
const shellLocalCdPath = String(normalizeToolEnvelope(shellLocalCdOut).result).trim();
if (resolve(shellLocalCdPath) !== resolve(root, 'scripts')) {
  throw new Error(`shell command-local cd did not enter scripts: ${shellLocalCdOut}`);
}
const shellProjectResetOut = await executeBuiltinTool('shell', {
  command: process.platform === 'win32'
    ? 'Get-Location | Select-Object -ExpandProperty Path'
    : 'pwd',
  timeout_ms: 30_000,
}, root, { sessionId: shellProjectCwdSession });
const shellProjectResetPath = String(normalizeToolEnvelope(shellProjectResetOut).result).trim();
if (resolve(shellProjectResetPath) !== root) {
  throw new Error(`one-shot shell leaked command-local cwd instead of returning to the Project root: ${shellProjectResetOut}`);
}

const shellOut = await shellOutPromise;
assertOk('shell default runtime', shellOut, /v\d+\.\d+\.\d+/);

const shellFailOut = await shellFailOutPromise;
const normalizedShellFailOut = normalizeToolEnvelope(shellFailOut);
const shellFailText = String(normalizedShellFailOut.result);
if (
  normalizedShellFailOut.explicitSuccess !== true
  || /^Error[\s:[]/.test(shellFailText)
  || /\[shell-run-failed\]/.test(shellFailText)
  || !/\[exit code: 7\]/.test(shellFailText)
  || !/\[completed: shell executed the command\b/.test(shellFailText)
) {
  throw new Error(`bash non-zero exit must be a completed command-result envelope:\n${shellFailText}`);
}

// Keep the deadline probe isolated from the concurrent shell-pool smoke above:
// it verifies timeout semantics, not admission/pool scheduling under fan-out.
const shellTimeoutOut = await executeBuiltinTool('shell', {
  command: 'node -e "setTimeout(() => console.log(\'tool-smoke-timeout-missed\'), 1500)"',
  timeout_ms: 500,
}, root);
if (!/^Error[\s:[]/.test(String(shellTimeoutOut)) || !/\[shell-run-failed\]/.test(String(shellTimeoutOut)) || !/\[timeout: 500ms\b/.test(String(shellTimeoutOut))) {
  throw new Error(`bash timeout must be milliseconds and classified as shell-run-failed Error:\n${shellTimeoutOut}`);
}

const shellArgFailOut = await executeBuiltinTool('shell', {
  command: '',
}, root);
if (!/^Error[\s:[]/.test(String(shellArgFailOut)) || !/\[shell-tool-failed\]/.test(String(shellArgFailOut))) {
  throw new Error(`shell tool/preflight failures must be classified as shell-tool-failed Error:\n${shellArgFailOut}`);
}

function shellTaskId(text) {
  return (/task_id:\s*(\S+)/i.exec(String(text)) || [])[1] || '';
}
function shellNotifyOptions(events, suffix) {
  const sessionId = `sess_shell_notify_${suffix}_${Date.now()}`;
  return {
    sessionId,
    callerSessionId: sessionId,
    routingSessionId: sessionId,
    notifyFn: (text, meta) => {
      events.push({ text: String(text), meta });
      return true;
    },
  };
}
function assertBackgroundStart(label, output) {
  const text = String(output);
  const taskId = shellTaskId(text);
  if (!taskId || !/You will be notified when it completes; do not poll\./i.test(text)) {
    throw new Error(`${label} must return task_id plus the completion-notification contract:\n${text}`);
  }
  return taskId;
}
async function assertSingleShellCompletion(events, taskId, label) {
  await waitForSmoke(
    () => events.some((event) => event.text.includes(taskId) && event.meta?.type !== 'shell_task_progress'),
    `${label} completion notification`,
    5000,
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  const matches = events.filter((event) => event.text.includes(taskId) && event.meta?.type !== 'shell_task_progress');
  if (matches.length !== 1) {
    throw new Error(`${label} must notify exactly once, got ${matches.length}: ${JSON.stringify(events)}`);
  }
}

// Explicit async starts detached and notifies exactly once.
const shellExplicitNotifyEvents = [];
const shellExplicitNotifyOptions = shellNotifyOptions(shellExplicitNotifyEvents, 'explicit');
const shellExplicitAsyncOut = await executeBuiltinTool('shell', {
  command: 'node -e "setTimeout(() => console.log(\'tool-smoke-explicit-done\'), 300)"',
  run_in_background: true,
  timeout_ms: 5000,
}, root, shellExplicitNotifyOptions);
const shellExplicitTaskId = assertBackgroundStart('shell explicit async', shellExplicitAsyncOut);
await assertSingleShellCompletion(shellExplicitNotifyEvents, shellExplicitTaskId, 'shell explicit async');

// A one-shot check_after returns immediately, pushes one progress snapshot,
// and leaves the normal completion notification armed.
const shellCheckEvents = [];
const shellCheckOptions = shellNotifyOptions(shellCheckEvents, 'check_after');
const shellCheckOut = await executeBuiltinTool('shell', {
  command: 'node -e "console.log(\'tool-smoke-check-after-progress\'); setTimeout(() => console.log(\'tool-smoke-check-after-done\'), 600)"',
  run_in_background: true,
  timeout_ms: 5000,
}, root, shellCheckOptions);
const shellCheckTaskId = assertBackgroundStart('shell check-after start', shellCheckOut);
const shellImplicitStatus = await executeBuiltinTool('task', {
  task_id: shellCheckTaskId,
}, root, shellCheckOptions);
if (!/status:\s*running/i.test(String(shellImplicitStatus))) {
  throw new Error(`task_id alone must default to non-blocking status:\n${shellImplicitStatus}`);
}
const shellMissingAfterMs = await executeBuiltinTool('task', {
  action: 'check_after',
  task_id: shellCheckTaskId,
}, root, shellCheckOptions);
if (!/^Error[\s:[]/.test(String(shellMissingAfterMs)) || !/requires explicit "after_ms"/i.test(String(shellMissingAfterMs))) {
  throw new Error(`task check_after without after_ms must fail explicitly:\n${shellMissingAfterMs}`);
}
const shellCheckScheduled = await executeBuiltinTool('task', {
  action: 'check_after',
  task_id: shellCheckTaskId,
  after_ms: 50,
}, root, shellCheckOptions);
if (!/progress_check_scheduled:\s*true/i.test(String(shellCheckScheduled))) {
  throw new Error(`task check_after must schedule without blocking:\n${shellCheckScheduled}`);
}
await waitForSmoke(
  () => shellCheckEvents.some((event) => event.meta?.type === 'shell_task_progress' && event.text.includes(shellCheckTaskId)),
  'shell check-after progress notification',
  3000,
);
const progressEvent = shellCheckEvents.find((event) => event.meta?.type === 'shell_task_progress' && event.text.includes(shellCheckTaskId));
if (!/tool-smoke-check-after-progress/.test(String(progressEvent?.text))) {
  throw new Error(`task check_after progress must include current shell output:\n${JSON.stringify(shellCheckEvents)}`);
}
await assertSingleShellCompletion(shellCheckEvents, shellCheckTaskId, 'shell check-after completion');
const progressMatches = shellCheckEvents.filter((event) => event.meta?.type === 'shell_task_progress' && event.text.includes(shellCheckTaskId));
if (progressMatches.length !== 1) {
  throw new Error(`task check_after must notify progress exactly once, got ${progressMatches.length}: ${JSON.stringify(shellCheckEvents)}`);
}

// Completion before the reserved time cancels the pending progress snapshot.
const shellEarlyDoneEvents = [];
const shellEarlyDoneOptions = shellNotifyOptions(shellEarlyDoneEvents, 'check_after_early_done');
const shellEarlyDoneOut = await executeBuiltinTool('shell', {
  command: 'node -e "setTimeout(() => console.log(\'tool-smoke-check-after-early-done\'), 50)"',
  run_in_background: true,
  timeout_ms: 5000,
}, root, shellEarlyDoneOptions);
const shellEarlyDoneTaskId = assertBackgroundStart('shell check-after early completion', shellEarlyDoneOut);
await executeBuiltinTool('task', {
  action: 'check_after',
  task_id: shellEarlyDoneTaskId,
  after_ms: 3000,
}, root, shellEarlyDoneOptions);
await assertSingleShellCompletion(shellEarlyDoneEvents, shellEarlyDoneTaskId, 'shell check-after early completion');
await new Promise((resolveWait) => setTimeout(resolveWait, 3050));
if (shellEarlyDoneEvents.some((event) => event.meta?.type === 'shell_task_progress' && event.text.includes(shellEarlyDoneTaskId))) {
  throw new Error(`completed task must cancel its pending progress check: ${JSON.stringify(shellEarlyDoneEvents)}`);
}

// Auto-promotion: a sync foreground command still running past the soft budget
// returns the same notification contract as explicit async.
const _priorAutoBgBudget = process.env.MIXDOG_SHELL_AUTO_BACKGROUND_MS;
process.env.MIXDOG_SHELL_AUTO_BACKGROUND_MS = '50';
const shellAutoNotifyEvents = [];
const shellAutoNotifyOptions = shellNotifyOptions(shellAutoNotifyEvents, 'auto');
let shellAutoPromoteOut;
try {
  shellAutoPromoteOut = await executeBuiltinTool('shell', {
    command: 'node -e "setTimeout(() => console.log(\'tool-smoke-autopromote-done\'), 600)"',
    timeout_ms: 5000,
  }, root, shellAutoNotifyOptions);
} finally {
  if (_priorAutoBgBudget === undefined) delete process.env.MIXDOG_SHELL_AUTO_BACKGROUND_MS;
  else process.env.MIXDOG_SHELL_AUTO_BACKGROUND_MS = _priorAutoBgBudget;
}
if (!/auto-backgrounded/i.test(String(shellAutoPromoteOut))) {
  throw new Error(`shell auto-promotion must return a background task envelope (task_id + auto-backgrounded):\n${shellAutoPromoteOut}`);
}
const shellAutoPromoteTaskId = assertBackgroundStart('shell auto-promotion', shellAutoPromoteOut);
await assertSingleShellCompletion(shellAutoNotifyEvents, shellAutoPromoteTaskId, 'shell auto-promotion');

const legacyEscapedAlternationErr = validateBuiltinArgs('grep', { pattern: 'state\\.items\\.map\\|items\\.map', path: root });
if (legacyEscapedAlternationErr) {
  throw new Error(`grep legacy \\| alternation should be accepted: ${legacyEscapedAlternationErr}`);
}
const legacyEscapedAlternationOut = await executeBuiltinTool('grep', {
  pattern: 'standalone mixdog CLI/TUI coding agent\\|smoke passed',
  path: 'scripts',
  glob: '*.mjs',
  head_limit: 10,
}, root);
assertOk('grep legacy \\| alternation', legacyEscapedAlternationOut, /smoke\.mjs/);
const literalBackslashPipeArray = validateBuiltinArgs('grep', {
  pattern: ['contains \\\\|', 'conflicting window args'],
  path: root,
});
if (!/must be string/.test(String(literalBackslashPipeArray))) {
  throw new Error(`grep pattern array must be rejected: ${literalBackslashPipeArray}`);
}
for (const [key, value] of [['path', [root]], ['glob', ['*.mjs']]]) {
  const args = { pattern: 'smoke', [key]: value };
  const err = validateBuiltinArgs('grep', args);
  if (!/must be string/.test(String(err))) {
    throw new Error(`grep ${key} array must be rejected: ${err}`);
  }
}

const grepContextPolicyArgs = { pattern: 'smoke', path: root, context: GREP_CONTEXT_MAX + 999 };
applyGrepContextLeadPolicy(grepContextPolicyArgs);
if (grepContextPolicyArgs.context !== GREP_CONTEXT_MAX || Object.prototype.hasOwnProperty.call(grepContextPolicyArgs, '-C')) {
  throw new Error(`grep context policy must canonicalize and clamp explicit context: ${JSON.stringify(grepContextPolicyArgs)}`);
}

const multiGrepPathArgs = {
  pattern: 'providerStatus',
  path: 'C:\\Project\\mixdog\\src\\tui C:\\Project\\mixdog\\src\\mixdog-session-runtime.mjs',
};
const multiGrepPathErr = validateBuiltinArgs('grep', multiGrepPathArgs);
if (!/contains multiple absolute paths/.test(String(multiGrepPathErr)) || typeof multiGrepPathArgs.path !== 'string') {
  throw new Error(`grep packed multi-path string must be rejected without array coercion: err=${multiGrepPathErr} path=${JSON.stringify(multiGrepPathArgs.path)}`);
}

// Lookaround/backrefs are no longer rejected at validation time: search-tool
// routes them to rg --pcre2 at runtime (arg-guard.mjs comment near globKeys).
const lookaroundGrepErr = validateBuiltinArgs('grep', {
  pattern: 'C:\\\\Project(?!\\\\mixdog)',
  path: root,
});
if (lookaroundGrepErr) {
  throw new Error(`grep lookaround pattern should pass validation (PCRE2 runtime routing): ${lookaroundGrepErr}`);
}

const offsetReadWindow = {
  path: 'scripts/smoke.mjs',
  offset: 0,
  limit: 20,
};
const readWindowErr = validateBuiltinArgs('read', offsetReadWindow);
if (readWindowErr) {
  throw new Error(`read offset/limit window guard failed: err=${readWindowErr} args=${JSON.stringify(offsetReadWindow)}`);
}
const readLineArgs = { path: 'scripts/smoke.mjs', line: 10, context: 2 };
const readLineErr = validateBuiltinArgs('read', readLineArgs);
if (readLineErr || readLineArgs.offset !== 7 || readLineArgs.limit !== 5 || 'line' in readLineArgs || 'context' in readLineArgs) {
  throw new Error(`read guard must losslessly convert top-level legacy line/context args to offset/limit: err=${readLineErr} args=${JSON.stringify(readLineArgs)}`);
}
const batchedReadLineArgs = { path: [{ path: 'scripts/smoke.mjs', line: 10, context: 2 }] };
const batchedReadLineErr = validateBuiltinArgs('read', batchedReadLineArgs);
if (batchedReadLineErr || batchedReadLineArgs.path[0].offset !== 7 || batchedReadLineArgs.path[0].limit !== 5) {
  throw new Error(`read guard must losslessly convert batched legacy line/context args to offset/limit: err=${batchedReadLineErr} args=${JSON.stringify(batchedReadLineArgs)}`);
}
const negativeReadOffsetArgs = { path: 'scripts/smoke.mjs', offset: -80 };
const negativeReadOffsetErr = validateBuiltinArgs('read', negativeReadOffsetArgs);
if (negativeReadOffsetErr || negativeReadOffsetArgs.mode !== 'tail' || negativeReadOffsetArgs.n !== 80 || 'offset' in negativeReadOffsetArgs) {
  throw new Error(`read guard must absorb negative offset as tail: err=${negativeReadOffsetErr} args=${JSON.stringify(negativeReadOffsetArgs)}`);
}
const negativeReadRegionArgs = { path: [{ path: 'scripts/smoke.mjs', offset: -80 }] };
const negativeReadRegionErr = validateBuiltinArgs('read', negativeReadRegionArgs);
if (negativeReadRegionErr || negativeReadRegionArgs.path[0].mode !== 'tail' || negativeReadRegionArgs.path[0].n !== 80 || 'offset' in negativeReadRegionArgs.path[0]) {
  throw new Error(`read guard must absorb region negative offset as tail: err=${negativeReadRegionErr} args=${JSON.stringify(negativeReadRegionArgs)}`);
}
const pathLineWithLimit = normaliseReadLineWindowArgs({ path: 'scripts/smoke.mjs#L10', limit: 5 }, root);
if (pathLineWithLimit.offset !== 9 || pathLineWithLimit.limit !== 5) {
  throw new Error(`read path#line compatibility must anchor offset when limit is explicit: ${JSON.stringify(pathLineWithLimit)}`);
}

function assertHas(set, name) {
  if (!set.has(name)) throw new Error(`default tool surface missing ${name}: ${[...set].join(', ')}`);
}

function assertLacks(set, name) {
  if (set.has(name)) throw new Error(`default tool surface should not include ${name}: ${[...set].join(', ')}`);
}

const smokeCatalog = [
  ...BUILTIN_TOOLS,
  ...CODE_GRAPH_TOOL_DEFS,
  ...PATCH_TOOL_DEFS,
  ...MEMORY_TOOL_DEFS,
  ...SEARCH_TOOL_DEFS,
  ...CHANNEL_TOOL_DEFS,
  AGENT_TOOL,
  SKILL_TOOL,
  TOOL_SEARCH_TOOL,
].filter(Boolean);

const fullDefaults = defaultDeferredToolNames(smokeCatalog, 'full');
if (fullDefaults.size !== 9) {
  throw new Error(`full default surface should stay 9 tools, got ${fullDefaults.size}: ${[...fullDefaults].join(', ')}`);
}
for (const name of ['read', 'code_graph', 'grep', 'find', 'glob', 'list', 'apply_patch', 'Skill', 'load_tool']) {
  assertHas(fullDefaults, name);
}
for (const name of ['shell', 'task', 'agent', 'recall', 'search', 'web_fetch', 'cwd']) {
  assertLacks(fullDefaults, name);
}

const leadDefaults = defaultDeferredToolNames(smokeCatalog, 'lead');
if (leadDefaults.size !== 14) {
  throw new Error(`lead default surface should stay 14 tools for this static catalog, got ${leadDefaults.size}: ${[...leadDefaults].join(', ')}`);
}
for (const name of ['read', 'code_graph', 'grep', 'find', 'glob', 'list', 'shell', 'task', 'apply_patch', 'agent', 'recall', 'search', 'Skill', 'load_tool']) {
  assertHas(leadDefaults, name);
}
for (const name of ['web_fetch', 'cwd', 'session_manage']) {
  assertLacks(leadDefaults, name);
}
if (TOOL_SEARCH_TOOL.annotations?.agentHidden !== true) {
  throw new Error('tool_search must stay Lead-only / standalone-only; agent sessions keep fixed schemas without deferred loading');
}
function toolSchemaSize(tool) {
  const desc = String(tool?.description || '');
  const schema = JSON.stringify(tool?.input_schema || tool?.inputSchema || {});
  return desc.length + schema.length;
}

const surfaceSize = [...fullDefaults].reduce((sum, name) => {
  const tool = smokeCatalog.find((item) => item?.name === name);
  return sum + toolSchemaSize(tool);
}, 0);
if (surfaceSize > 17000) {
  throw new Error(`full default tool surface too large: ${surfaceSize} chars (cap 17000)`);
}
for (const [name, cap] of [
  ['apply_patch', 1300],
  ['code_graph', 1550],
  ['agent', 2500],
  ['recall', 2400],
  ['search', 3200],
  ['web_fetch', 900],
  ['load_tool', 900],
]) {
  const tool = smokeCatalog.find((item) => item?.name === name);
  const size = toolSchemaSize(tool);
  if (size > cap) throw new Error(`${name} schema/description too large: ${size} chars (cap ${cap})`);
}

const readonlyDefaults = defaultDeferredToolNames(smokeCatalog, 'readonly');
if (readonlyDefaults.size !== 8) {
  throw new Error(`readonly default surface should stay 8 tools, got ${readonlyDefaults.size}: ${[...readonlyDefaults].join(', ')}`);
}
for (const name of ['read', 'code_graph', 'grep', 'find', 'glob', 'list', 'Skill', 'load_tool']) {
  assertHas(readonlyDefaults, name);
}
for (const name of ['apply_patch', 'agent', 'shell']) {
  assertLacks(readonlyDefaults, name);
}

const agentProps = AGENT_TOOL.inputSchema?.properties || {};
if (agentProps.mode || agentProps.wait) throw new Error('agent schema should not expose execution mode controls');
if (AGENT_TOOL.inputSchema?.additionalProperties !== false) {
  throw new Error('agent schema must reject hidden or misspelled fields');
}
{
  const heavyPrompt = composeSystemPrompt({
    agent: 'heavy-worker',
    provider: 'anthropic-oauth',
    agentRules: '# Tool Use',
    skillManifest: '',
  });
  if (!heavyPrompt.sessionMarker.includes('## heavy-worker')) {
    throw new Error(`heavy-worker AGENT.md must be included in BP3 scoped role instructions: ${heavyPrompt.sessionMarker}`);
  }
  const workerPrompt = composeSystemPrompt({
    agent: 'worker',
    provider: 'anthropic-oauth',
    agentRules: '# Tool Use',
    skillManifest: '',
  });
  if (!workerPrompt.sessionMarker.includes('## worker')) {
    throw new Error(`worker AGENT.md must be included in BP3 scoped role instructions: ${workerPrompt.sessionMarker}`);
  }
}
{
  const layeredPrompt = composeSystemPrompt({
    skipRoleCatalog: true,
    agentRules: 'BP1_TOOL_POLICY',
    metaContext: 'BP2_PROFILE',
    skillManifest: 'BP2_SKILLS',
    deferredToolManifest: 'BP2_DEFERRED_MCP',
    workflowContext: 'BP3_WORKFLOW',
    roleRules: 'BP3_ROLE',
    userPrompt: 'BP3_SYSTEM',
    coreMemoryContext: 'BP3_MEMORY',
    sessionStartContext: 'BP3_SESSION',
    projectInstructionsContext: 'BP3_PROJECT',
    environmentContext: 'BP3_ENVIRONMENT',
  });
  if (layeredPrompt.baseRules !== 'BP1_TOOL_POLICY') {
    throw new Error(`BP1 must contain only shared tool policy: ${layeredPrompt.baseRules}`);
  }
  if (!layeredPrompt.stableSystemContext.includes('BP2_PROFILE')
    || !layeredPrompt.stableSystemContext.includes('BP2_SKILLS')
    || !layeredPrompt.stableSystemContext.includes('BP2_DEFERRED_MCP')
    || /BP3_/.test(layeredPrompt.stableSystemContext)) {
    throw new Error(`BP2 must contain profile, skills, and deferred/MCP only: ${layeredPrompt.stableSystemContext}`);
  }
  const bp3Order = ['BP3_WORKFLOW', 'BP3_ROLE', 'BP3_SYSTEM', 'BP3_MEMORY', 'BP3_SESSION', 'BP3_PROJECT', 'BP3_ENVIRONMENT']
    .map((value) => layeredPrompt.sessionMarker.indexOf(value));
  if (bp3Order.some((index) => index < 0) || bp3Order.some((index, i) => i > 0 && index <= bp3Order[i - 1])) {
    throw new Error(`BP3 workflow/role and environment order is invalid: ${layeredPrompt.sessionMarker}`);
  }
  if (layeredPrompt.sessionMarkerCore.includes('BP3_SESSION')
    || layeredPrompt.sessionMarkerCore.includes('BP3_PROJECT')
    || layeredPrompt.sessionMarkerCore.includes('BP3_ENVIRONMENT')) {
    throw new Error(`BP3 core must exclude the refreshable session/project/environment suffix: ${layeredPrompt.sessionMarkerCore}`);
  }
  const refreshableSession = {
    owner: 'cli',
    model: 'tool-smoke-model',
    effort: 'high',
    fast: true,
    workflow: { name: 'Solo' },
    bp3CoreContext: 'BP3_CORE',
    bp3EnvironmentContext: 'BP3_EXISTING_ENVIRONMENT',
    messages: [
      { role: 'system', content: 'BP1' },
      { role: 'system', content: 'BP2' },
      { role: 'system', content: 'BP3_CORE\n\n---\n\nBP3_EXISTING_ENVIRONMENT', cacheTier: 'tier3' },
    ],
  };
  if (!refreshSessionBp3Environment(refreshableSession, 'C:\\BP3_CURRENT_CWD')) {
    throw new Error('BP3 first-turn environment refresh must update the tier3 system block');
  }
  const refreshedBp3 = refreshableSession.messages[2].content;
  if (!/Cwd: C:\\BP3_CURRENT_CWD/.test(refreshedBp3)
    || refreshedBp3.indexOf('# Session') > refreshedBp3.indexOf('BP3_EXISTING_ENVIRONMENT')
    || refreshableSession.sessionStartMetaInjected !== true) {
    throw new Error(`BP3 first-turn environment refresh is invalid: ${refreshedBp3}`);
  }
  resetSessionBp3Environment(refreshableSession);
  if (refreshableSession.messages[2].content !== 'BP3_CORE\n\n---\n\nBP3_EXISTING_ENVIRONMENT'
    || refreshableSession.sessionStartMetaInjected !== false) {
    throw new Error(`BP3 clear reset must restore the refreshable suffix: ${refreshableSession.messages[2].content}`);
  }
}
{
  const command = parseHeadlessExecCommand([
    'exec', '--provider', 'openai-oauth', '--model', 'gpt-test', 'check', 'this',
  ]);
  if (command?.message !== 'check this') {
    throw new Error(`headless exec command parse failed: ${JSON.stringify(command)}`);
  }
  const missing = parseHeadlessExecCommand(['exec']);
  if (!missing?.error || !/mixdog exec/.test(missing.error)) {
    throw new Error(`headless exec without a message must be rejected: ${JSON.stringify(missing)}`);
  }
  const tuiDefault = parseHeadlessExecCommand([]);
  if (tuiDefault !== null) {
    throw new Error(`empty argv must keep TUI default: ${JSON.stringify(tuiDefault)}`);
  }
  const legacyRole = parseHeadlessExecCommand(['reviewer', 'check', 'this']);
  if (legacyRole !== null) {
    throw new Error(`legacy role shorthand must not enter headless exec: ${JSON.stringify(legacyRole)}`);
  }
}
if (!/always start background tasks/i.test(AGENT_TOOL.description || '') || !/distinct tags?/i.test(AGENT_TOOL.description || '') || !/same scope/i.test(AGENT_TOOL.description || '') || !/send/i.test(AGENT_TOOL.description || '') || !/completion notification/i.test(AGENT_TOOL.description || '') || !/do not (?:call|poll) status\/read/i.test(AGENT_TOOL.description || '')) {
  throw new Error('agent description must preserve async tagged delegation contract');
}
const agentSmoke = createStandaloneAgent({
  cfgMod: {
    loadConfig: () => ({ providers: {}, presets: [] }),
    resolveRuntimeSpec: () => { throw new Error('agent smoke should not resolve runtime for read/list errors'); },
  },
  reg: { initProviders: async () => {} },
  mgr: {
    getSession: () => null,
    listSessions: () => [],
    closeSession: () => false,
  },
  dataDir: root,
  cwd: root,
  defaultMode: 'async',
});
const agentMissingJob = await agentSmoke.execute({ type: 'read', task_id: 'task_missing_smoke' }, { invocationSource: 'model-tool', cwd: root });
if (!/^Error[\s:[]/.test(String(agentMissingJob)) || !/task_missing_smoke/.test(String(agentMissingJob))) {
  throw new Error(`agent missing task must return Error result:\n${agentMissingJob}`);
}
const agentBadType = await agentSmoke.execute({ type: 'definitely_bad_type' }, { invocationSource: 'model-tool', cwd: root });
if (!/^Error[\s:[]/.test(String(agentBadType)) || !/unknown type/i.test(String(agentBadType))) {
  throw new Error(`agent unknown type must return Error result:\n${agentBadType}`);
}

async function waitForSmoke(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const channelWorkerTmp = mkdtempSync(join(tmpdir(), 'mixdog-channel-worker-env-'));
let channelEnvWorker = null;
const prevDaemonHost = process.env.MIXDOG_DAEMON_HOST;
const prevRuntimeRoot = process.env.MIXDOG_RUNTIME_ROOT;
const prevEnvOut = process.env.SMOKE_CHANNEL_ENV_OUT;
const prevDaemonEntry = process.env.MIXDOG_DAEMON_ENTRY;
const prevSupervisorPid = process.env.MIXDOG_SUPERVISOR_PID;
try {
  // Daemon-mode worker env coverage: start() spawn-or-attaches the machine
  // -global daemon (the stub daemon entry — no Discord token) instead of
  // Assert the flags on the spawned daemon's environment.
  const stubEntry = join(root, 'scripts', 'daemon-stub.mjs');
  const dataDir = join(channelWorkerTmp, 'data');
  const runtimeDir = join(channelWorkerTmp, 'runtime');
  const envOut = join(channelWorkerTmp, 'env.json');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  process.env.MIXDOG_DAEMON_HOST = '1';
  process.env.MIXDOG_RUNTIME_ROOT = runtimeDir;
  process.env.SMOKE_CHANNEL_ENV_OUT = envOut;
  process.env.MIXDOG_DAEMON_ENTRY = stubEntry;
  process.env.MIXDOG_SUPERVISOR_PID = '2147483647';
  channelEnvWorker = createStandaloneChannelWorker({
    rootDir: root,
    dataDir,
    cwd: root,
    leadPid: process.pid,
  });
  await channelEnvWorker.start();
  const childEnv = JSON.parse(readFileSync(envOut, 'utf8'));
  if (childEnv.host !== '1') {
    throw new Error(`channel service smoke expected host=1, got ${childEnv.host}`);
  }
  if (childEnv.cliOwned !== '0') {
    throw new Error(`channel service must advertise owner HTTP (MIXDOG_CLI_OWNED=0), got ${childEnv.cliOwned}`);
  }
  if (Number(childEnv.supervisorPid) !== process.pid) {
    throw new Error(`channel service must replace a stale inherited supervisor PID with its live runtime PID, got ${childEnv.supervisorPid}`);
  }
  const identityProbe = await channelEnvWorker.execute('reload_config', {});
  if (Number(identityProbe?.leadPid) !== process.pid) {
    throw new Error(`channel client must register its live runtime PID, got ${identityProbe?.leadPid}`);
  }
} finally {
  try { await channelEnvWorker?.stop?.('channel-worker-env-smoke', { force: true }); } catch {}
  if (prevDaemonHost == null) delete process.env.MIXDOG_DAEMON_HOST;
  else process.env.MIXDOG_DAEMON_HOST = prevDaemonHost;
  if (prevRuntimeRoot == null) delete process.env.MIXDOG_RUNTIME_ROOT;
  else process.env.MIXDOG_RUNTIME_ROOT = prevRuntimeRoot;
  if (prevEnvOut == null) delete process.env.SMOKE_CHANNEL_ENV_OUT;
  else process.env.SMOKE_CHANNEL_ENV_OUT = prevEnvOut;
  if (prevDaemonEntry == null) delete process.env.MIXDOG_DAEMON_ENTRY;
  else process.env.MIXDOG_DAEMON_ENTRY = prevDaemonEntry;
  if (prevSupervisorPid == null) delete process.env.MIXDOG_SUPERVISOR_PID;
  else process.env.MIXDOG_SUPERVISOR_PID = prevSupervisorPid;
  // Detach only ends OUR attachment; the stub daemon self-shuts after its
  // client-grace window. Give it that window before deleting its tmp root.
  await new Promise((resolveWait) => setTimeout(resolveWait, 700));
  rmSync(channelWorkerTmp, { recursive: true, force: true });
}

const agentNotifyTmp = mkdtempSync(join(tmpdir(), 'mixdog-agent-notify-'));
try {
  const ownerNotifications = [];
  const workerQueued = [];
  const agentNotifySmoke = createStandaloneAgent({
    cfgMod: {
      loadConfig: () => ({
        default: 'sonnet-high',
        providers: { 'openai-oauth': { enabled: true } },
        presets: [
          { id: 'sonnet-high', name: 'sonnet-high', provider: 'openai-oauth', model: 'smoke-model', type: 'agent', tools: 'full' },
          { id: 'haiku', name: 'HAIKU', provider: 'openai-oauth', model: 'smoke-haiku', type: 'agent', tools: 'full' },
        ],
      }),
      resolveRuntimeSpec: () => ({ scopeKey: 'smoke-notify', lane: 'agent' }),
    },
    reg: { initProviders },
    mgr: {
      askSession: async (sessionId, _prompt, _context, _onToolCall, _cwdOverride, _prefetch, askOpts = {}) => {
        const nestedText = `background task\ntask_id: task_shell_notify_smoke\nsurface: shell\noperation: shell\nstatus: completed\nstarted: 2026-01-01T00:00:00.000Z\nfinished: 2026-01-01T00:00:01.000Z\n\nnested background done for ${sessionId}`;
        askOpts.notifyFn?.(nestedText, {
          type: 'shell_task_result',
          execution_surface: 'shell',
          execution_id: 'task_shell_notify_smoke',
          status: 'completed',
        });
        askOpts.onTerminalResult?.({ content: 'worker completed' }, { sessionId, beforeSave: true });
        return { content: 'worker completed' };
      },
      enqueuePendingMessage: (sessionId, message) => {
        workerQueued.push({ sessionId, message });
        return 1;
      },
      getSession: () => null,
      listSessions: () => [],
      closeSession: () => false,
      hideSessionFromList: () => false,
    },
    dataDir: agentNotifyTmp,
    cwd: root,
    defaultMode: 'async',
  });
  const notifyContext = {
    invocationSource: 'model-tool',
    callerCwd: root,
    callerSessionId: 'sess_owner_notify_smoke',
    clientHostPid: 424242,
    notifyFn: (text, meta) => {
      ownerNotifications.push({ text, meta });
      return true;
    },
  };
  const notifyStart = await agentNotifySmoke.execute({ type: 'spawn', agent: 'worker', tag: 'notify-smoke', prompt: 'notify smoke' }, notifyContext);
  if (!/agent task:/i.test(String(notifyStart)) || !/status: running/i.test(String(notifyStart))) {
    throw new Error(`agent async notify smoke did not start task:\n${notifyStart}`);
  }
  await waitForSmoke(
    () => ownerNotifications.some((event) => /task_shell_notify_smoke/.test(event.text))
      && workerQueued.some((event) => /task_shell_notify_smoke/.test(String(event.message?.text || event.message?.content || event.message))),
    'agent child background completion routing',
  );
  await waitForSmoke(
    () => ownerNotifications.some((event) => /worker completed/.test(event.text)),
    'agent early completion routing',
  );
  const agentCompletionCount = ownerNotifications.filter((event) => /worker completed/.test(event.text)).length;
  if (agentCompletionCount !== 1) {
    throw new Error(`agent early completion should suppress duplicate final notify, got ${agentCompletionCount}: ${JSON.stringify(ownerNotifications)}`);
  }
  await agentNotifySmoke.execute({ type: 'cleanup', force: true }, notifyContext);
} finally {
  rmSync(agentNotifyTmp, { recursive: true, force: true });
}
{
  const runtimeSearchTool = __applyStandaloneToolDefaultsForTest(SEARCH_TOOL_DEFS.find((tool) => tool?.name === 'search'));
  if (runtimeSearchTool?.annotations?.agentHidden === true) {
    throw new Error('production search tool must stay visible to agent sessions');
  }
  if (TOOL_SEARCH_TOOL.annotations?.agentHidden !== true) {
    throw new Error('deferred tool_search wrapper must stay hidden from agent sessions');
  }
}
setInternalToolsProvider({
  executor: async () => 'tool-smoke internal tool',
  tools: [
    { name: 'memory', description: 'Destructive memory surface.', inputSchema: { type: 'object', properties: {} }, annotations: { destructiveHint: true } },
    { name: 'recall', description: 'Memory recall surface.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
    { name: 'search', description: 'Web search surface.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, openWorldHint: true } },
    { name: 'reply', description: 'Channel reply surface.', inputSchema: { type: 'object', properties: {} }, annotations: { destructiveHint: true } },
    { name: 'web_fetch', description: 'Web fetch surface.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, openWorldHint: true } },
  ],
});
{
  await initProviders({ 'openai-oauth': { enabled: true } });
  const skillManifestTmp = mkdtempSync(join(tmpdir(), 'mixdog-skill-manifest-'));
  try {
    const skillDir = join(skillManifestTmp, '.mixdog', 'skills', 'demo-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), [
      '---',
      'name: demo-skill',
      'description: Use when validating compact skill manifest matching.',
      '---',
      '',
      '# Demo Skill',
      '',
      'Use this skill for manifest smoke tests.',
      '',
    ].join('\n'));
    const skillSession = createSession({
      provider: 'openai-oauth',
      model: 'tool-smoke-model',
      owner: 'cli',
      agent: 'lead',
      cwd: skillManifestTmp,
      permission: 'read-write',
    });
    try {
      const visible = (skillSession.messages || []).map((m) => String(m.content || '')).join('\n');
      if (!/available-skills/i.test(visible) || !/demo-skill/i.test(visible) || !/Skill\(\{"name":"<skill-name>"\}\)/.test(visible)) {
        throw new Error(`lead skill manifest missing compact skill listing: ${visible.slice(0, 1200)}`);
      }
      if ((visible.match(/(^|\n)- Shell: /g) || []).length !== 1
        || (visible.match(/Shell startup environment/g) || []).length !== 1
        || /(^|\n)# Environment\n/i.test(visible)) {
        throw new Error(`Lead BP3 must relocate each existing shell payload exactly once without a new heading: ${visible.slice(0, 1200)}`);
      }
      const skillToolNames = (skillSession.tools || []).map((tool) => tool?.name).filter(Boolean);
      if (!skillToolNames.includes('Skill')) {
        throw new Error(`lead skill manifest session must expose Skill loader: ${skillToolNames.join(', ')}`);
      }
    } finally {
      closeSession(skillSession.id, 'tool-smoke');
    }
    const agentSkillSession = createSession({
      provider: 'openai-oauth',
      model: 'tool-smoke-model',
      owner: AGENT_OWNER,
      agent: 'worker',
      cwd: skillManifestTmp,
      permission: 'read-write',
    });
    try {
      const systemLayers = (agentSkillSession.messages || []).filter((m) => m?.role === 'system');
      const systemVisible = systemLayers
        .map((m) => String(m.content || ''))
        .join('\n');
      // Agent (Pool B/C) sessions FREEZE the Skill meta-tool into the schema
      // unconditionally so the tool bytes stay bit-identical across roles/cwds
      // (provider cache shard stability). The BP2 manifest rides alongside it
      // so the model knows which Skill names exist — a loader without the
      // manifest cannot be targeted. Both must be present together.
      if (!/available-skills/i.test(systemVisible) || !/demo-skill/i.test(systemVisible) || !/Skill\(\{"name":"<skill-name>"\}\)/.test(systemVisible)) {
        throw new Error(`agent BP2 must carry the compact skill manifest alongside the frozen Skill tool: ${systemVisible.slice(0, 1200)}`);
      }
      if (!/# Tool Use/i.test(systemVisible) || !/# Agent Constraints/i.test(systemVisible)) {
        throw new Error(`agent system layers must carry BP1 tool policy and BP3 role rules: ${systemVisible.slice(0, 1200)}`);
      }
      if (!/# Tool Use/i.test(systemLayers[0]?.content || '')
        || /available-skills/i.test(systemLayers[0]?.content || '')
        || !/available-skills/i.test(systemLayers[1]?.content || '')
        || !/# Agent Constraints/i.test(systemLayers[2]?.content || '')) {
        throw new Error(`agent prompt layers must place tool policy in BP1, skills in BP2, and role in BP3: ${JSON.stringify(systemLayers)}`);
      }
      const agentSkillTool = (agentSkillSession.tools || []).find((tool) => tool?.name === 'Skill');
      const agentSkillToolNames = (agentSkillSession.tools || []).map((tool) => tool?.name).filter(Boolean);
      if (!agentSkillToolNames.includes('Skill')) {
        throw new Error(`read-write agent schema must expose Skill loader with the manifest: ${agentSkillToolNames.join(', ')}`);
      }
      if (agentSkillTool?.title !== SKILL_TOOL.title
        || JSON.stringify(agentSkillTool?.annotations) !== JSON.stringify(SKILL_TOOL.annotations)) {
        throw new Error(`agent Skill metadata must match the session Skill contract: ${JSON.stringify(agentSkillTool)}`);
      }
    } finally {
      closeSession(agentSkillSession.id, 'tool-smoke');
    }
  } finally {
    rmSync(skillManifestTmp, { recursive: true, force: true });
  }
  const workerSession = createSession({
    provider: 'openai-oauth',
    model: 'tool-smoke-model',
    owner: AGENT_OWNER,
    agent: 'worker',
    cwd: root,
    permission: 'read-write',
    taskBrief: 'Implement a scoped smoke check.',
  });
  try {
    const visible = (workerSession.messages || []).map((m) => String(m.content || '')).join('\n');
    const userReminderVisible = (workerSession.messages || [])
      .filter((m) => m?.role === 'user')
      .map((m) => String(m.content || ''))
      .join('\n');
    if (/(^|\n)# role\n/i.test(visible) || /(^|\n)permission:/i.test(visible)) {
      throw new Error(`agent context must not repeat raw role/permission labels: ${visible.slice(0, 1200)}`);
    }
    if (/# role-identity/i.test(visible)) {
      throw new Error(`agent context must not repeat role identity: ${visible.slice(0, 1200)}`);
    }
    if (/# task-brief/i.test(visible)) {
      throw new Error(`agent context must not repeat task brief: ${visible.slice(0, 1200)}`);
    }
    if (/available-skills/i.test(userReminderVisible)) {
      throw new Error(`agent skill manifest must stay in system BP2, not user reminders: ${userReminderVisible.slice(0, 1200)}`);
    }
    if (!/Shell startup environment/i.test(visible) || /(^|\n)# environment/i.test(visible)) {
      throw new Error(`agent BP3 must relocate the existing startup payload without adding an Environment heading: ${visible.slice(0, 1200)}`);
    }
    if (/(^|\n)- Shell: /i.test(visible)) {
      throw new Error(`agent BP3 must not add the Lead-only shell preference: ${visible.slice(0, 1200)}`);
    }
    const workerToolNames = (workerSession.tools || []).map((tool) => tool?.name).filter(Boolean);
    if (workerToolNames.includes('load_tool')) {
      throw new Error(`agent session schema must not expose deferred load_tool: ${workerToolNames.join(', ')}`);
    }
    for (const name of ['shell', 'task']) {
      if (!workerToolNames.includes(name)) {
        throw new Error(`read-write agent session schema must expose ${name} for self-verification: ${workerToolNames.join(', ')}`);
      }
    }
    for (const name of ['skills_list', 'skill_view', 'skill_execute']) {
      if (workerToolNames.includes(name)) {
        throw new Error(`agent session schema must not expose legacy skill tool ${name}: ${workerToolNames.join(', ')}`);
      }
    }
  } finally {
    closeSession(workerSession.id, 'tool-smoke');
  }
  const readAgentSession = createSession({
    provider: 'openai-oauth',
    model: 'tool-smoke-model',
    owner: AGENT_OWNER,
    agent: 'worker',
    cwd: root,
    permission: 'read',
  });
  const writeAgentSession = createSession({
    provider: 'openai-oauth',
    model: 'tool-smoke-model',
    owner: AGENT_OWNER,
    agent: 'worker',
    cwd: root,
    permission: 'read-write',
  });
  const fullAgentSession = createSession({
    provider: 'openai-oauth',
    model: 'tool-smoke-model',
    owner: AGENT_OWNER,
    agent: 'worker',
    cwd: root,
    permission: 'full',
  });
  try {
    const readTools = (readAgentSession.tools || []).map((tool) => tool?.name).filter(Boolean);
    const writeTools = (writeAgentSession.tools || []).map((tool) => tool?.name).filter(Boolean);
    const fullTools = (fullAgentSession.tools || []).map((tool) => tool?.name).filter(Boolean);
    // Read-role AGENT sessions carry shell/task so review/debug agents can run
    // their own verification (build/test).
    // No terminal-action tool is registered: a no-tool assistant message ends
    // the turn, so the schema carries capabilities only.
    const expectedReadTools = ['find', 'glob', 'list', 'grep', 'code_graph', 'read', 'shell', 'task', 'search', 'web_fetch', 'Skill'];
    const expectedWriteTools = ['find', 'glob', 'list', 'grep', 'code_graph', 'read', 'apply_patch', 'shell', 'task', 'search', 'web_fetch', 'Skill'];
    if (JSON.stringify(readTools) !== JSON.stringify(expectedReadTools)) {
      throw new Error(`read agent schema must be fixed allow-list: expected=${expectedReadTools.join(', ')} actual=${readTools.join(', ')}`);
    }
    if (JSON.stringify(writeTools) !== JSON.stringify(expectedWriteTools)) {
      throw new Error(`read-write agent schema must be fixed allow-list: expected=${expectedWriteTools.join(', ')} actual=${writeTools.join(', ')}`);
    }
    if (readTools.includes('load_tool') || writeTools.includes('load_tool')) {
      throw new Error(`agent session fixed schemas must omit load_tool: read=${readTools.join(', ')} write=${writeTools.join(', ')}`);
    }
    if (readTools.includes('apply_patch')) {
      throw new Error(`read agent schema must omit apply_patch: read=${readTools.join(', ')}`);
    }
    for (const name of ['shell', 'task']) {
      if (!readTools.includes(name)) {
        throw new Error(`read agent schema must carry verification tool ${name}: read=${readTools.join(', ')}`);
      }
    }
    for (const name of ['apply_patch', 'shell', 'task']) {
      if (!writeTools.includes(name)) {
        throw new Error(`read-write agent schema must preserve ${name}: write=${writeTools.join(', ')}`);
      }
    }
    for (const name of ['memory', 'recall', 'reply']) {
      if (readTools.includes(name) || writeTools.includes(name)) {
        throw new Error(`read/read-write agent schema must not expose full-runtime internal tool ${name}: read=${readTools.join(', ')} write=${writeTools.join(', ')}`);
      }
    }
    if (!fullTools.includes('shell')) {
      throw new Error(`full agent schema must retain shell: full=${fullTools.join(', ')}`);
    }
  } finally {
    closeSession(readAgentSession.id, 'tool-smoke');
    closeSession(writeAgentSession.id, 'tool-smoke');
    closeSession(fullAgentSession.id, 'tool-smoke');
  }
  const resumeAgentSession = createSession({
    provider: 'openai-oauth',
    model: 'tool-smoke-model',
    owner: AGENT_OWNER,
    agent: 'worker',
    cwd: root,
    permission: 'read-write',
  });
  try {
    const resumed = await resumeSession(resumeAgentSession.id, 'full');
    const resumedTools = (resumed?.tools || []).map((tool) => tool?.name).filter(Boolean);
    const expectedWriteTools = ['find', 'glob', 'list', 'grep', 'code_graph', 'read', 'apply_patch', 'shell', 'task', 'search', 'web_fetch', 'Skill'];
    if (JSON.stringify(resumedTools) !== JSON.stringify(expectedWriteTools)) {
      throw new Error(`resumed read-write agent schema must keep fixed allow-list: expected=${expectedWriteTools.join(', ')} actual=${resumedTools.join(', ')}`);
    }
  } finally {
    closeSession(resumeAgentSession.id, 'tool-smoke');
  }
  const noneAgentSession = createSession({
    provider: 'openai-oauth',
    model: 'tool-smoke-model',
    owner: AGENT_OWNER,
    agent: 'worker',
    cwd: root,
    permission: 'none',
  });
  try {
    const resumedNone = await resumeSession(noneAgentSession.id, 'full');
    const noneTools = (resumedNone?.tools || []).map((tool) => tool?.name).filter(Boolean);
    if (noneTools.length !== 0) {
      throw new Error(`resumed permission=none agent schema must stay empty: actual=${noneTools.join(', ')}`);
    }
  } finally {
    closeSession(noneAgentSession.id, 'tool-smoke');
  }
  const objectPermissionSession = createSession({
    provider: 'openai-oauth',
    model: 'tool-smoke-model',
    owner: AGENT_OWNER,
    agent: 'worker',
    cwd: root,
    permission: { allow: ['read', 'grep'], deny: ['grep'] },
  });
  try {
    const resumedObject = await resumeSession(objectPermissionSession.id, 'full');
    const objectTools = (resumedObject?.tools || []).map((tool) => tool?.name).filter(Boolean);
    if (JSON.stringify(objectTools) !== JSON.stringify(['read'])) {
      throw new Error(`resumed object-permission agent schema must reapply allow/deny and agent filters: actual=${objectTools.join(', ')}`);
    }
  } finally {
    closeSession(objectPermissionSession.id, 'tool-smoke');
  }
  const hiddenAgents = JSON.parse(readFileSync(join(root, 'src', 'defaults', 'agents.json'), 'utf8')).agents || [];
  const hiddenPreset = { id: 'hidden-smoke', name: 'hidden-smoke', type: 'agent', provider: 'openai-oauth', model: 'tool-smoke-model', tools: 'full' };
  const hiddenRuntimeSpec = { scopeKey: 'hidden-role-smoke', lane: 'agent' };
  const hiddenBadTools = new Set(['shell', 'task', 'Skill', 'memory', 'reply', 'recall']);
  const expectedForHiddenAgent = (permission, schemaAllowedTools) => {
    if (Array.isArray(schemaAllowedTools)) return schemaAllowedTools.slice();
    if (permission === 'none') return [];
    if (permission === 'read') return ['code_graph', 'find', 'glob', 'list', 'grep', 'read', 'search', 'web_fetch'];
    if (permission === 'read-write') return ['code_graph', 'find', 'glob', 'list', 'grep', 'read', 'apply_patch', 'search', 'web_fetch'];
    return null;
  };
  for (const entry of hiddenAgents) {
    const agent = String(entry?.agent || '').trim();
    if (!agent) continue;
    const hidden = getHiddenAgent(agent);
    const permission = resolveAgentSessionPermission(agent, hidden?.permission || null);
    const schemaAllowedTools = resolveHiddenRoleSchemaAllowedTools(hidden);
    const { session } = prepareAgentSession({
      agent,
      presetName: 'hidden-smoke',
      preset: hiddenPreset,
      runtimeSpec: hiddenRuntimeSpec,
      permission,
      cwd: root,
      sourceType: 'hidden-role-smoke',
      sourceName: agent,
      schemaAllowedTools,
    });
    try {
      const tools = (session.tools || []).map((tool) => tool?.name).filter(Boolean);
      const resumed = await resumeSession(session.id, 'full');
      const resumedTools = (resumed?.tools || []).map((tool) => tool?.name).filter(Boolean);
      const expected = expectedForHiddenAgent(permission, schemaAllowedTools);
      // Order-insensitive: the session tool surface follows catalog order, while
      // schemaAllowedTools declares an allow-set; only set equality is contractual.
      const asSet = (list) => JSON.stringify(list.slice().sort());
      if (expected && (asSet(tools) !== asSet(expected) || asSet(resumedTools) !== asSet(expected))) {
        throw new Error(`hidden agent ${agent} schema mismatch: expected=${expected.join(', ')} tools=${tools.join(', ')} resumed=${resumedTools.join(', ')}`);
      }
      const leaked = tools.filter((name) => hiddenBadTools.has(name) && !(expected || []).includes(name));
      if (leaked.length) {
        throw new Error(`hidden agent ${agent} leaked forbidden full-runtime tools: ${leaked.join(', ')} from ${tools.join(', ')}`);
      }
      const systemVisible = (session.messages || [])
        .filter((m) => m?.role === 'system')
        .map((m) => String(m.content || ''))
        .join('\n');
      if (/available-skills|Skill\(/i.test(systemVisible)) {
        throw new Error(`hidden agent ${agent} must not carry Skill manifest without Skill tool`);
      }
      if (/effective-cwd|Override cwd|# task-brief/i.test(systemVisible)) {
        throw new Error(`hidden agent ${agent} must not carry legacy cwd/task-brief injection`);
      }
      if (/(^|\n)# Environment\n/i.test(systemVisible)) {
        throw new Error(`hidden agent ${agent} BP3 must not add an Environment heading`);
      }
    } finally {
      closeSession(session.id, 'tool-smoke');
    }
  }
}
const patchTool = PATCH_TOOL_DEFS[0];
const patchDescription = patchTool?.inputSchema?.properties?.patch?.description || '';
// The JSON schema is the fallback for providers that cannot carry a custom
// freeform tool. It exposes the patch plus an explicit base for callers whose
// provider cannot carry the grammar's inline Root directive.
if (!/V4A patch/i.test(patchDescription)) {
  throw new Error('apply_patch JSON fallback must describe the OAI V4A patch string');
}
if (Object.keys(patchTool?.inputSchema?.properties || {}).join(',') !== 'patch,root'
    || JSON.stringify(patchTool?.inputSchema?.required || []) !== '["patch"]') {
  throw new Error(`apply_patch JSON fallback must expose patch and optional root: ${JSON.stringify(patchTool?.inputSchema)}`);
}
if (!/optional \*\*\* Root: <path>/i.test(patchTool?.description || '')) {
  throw new Error(`apply_patch must expose the inline out-of-session Root contract: ${patchTool?.description}`);
}
if (!/Each section starts with exactly one:.*Add File.*Delete File.*Update File/s.test(patchTool?.description || '')
    || !/V4A patch/i.test(patchDescription)) {
  throw new Error(`apply_patch JSON fallback must expose its multi-file/hunk shape: ${JSON.stringify(patchTool)}`);
}
if (/followed by a shell|post-patch verification|same response/i.test(patchTool?.description || '')) {
  throw new Error(`apply_patch JSON fallback must not duplicate cross-tool batching policy: ${JSON.stringify(patchTool)}`);
}
if (/exact current context|roll ?back/i.test(JSON.stringify(patchTool))) {
  throw new Error(`apply_patch contract must not carry context/rollback model guidance: ${JSON.stringify(patchTool)}`);
}
const OAI_V4A_APPLY_PATCH_FREEFORM_DESCRIPTION =
  'OAI V4A patch: *** Begin Patch, Add/Delete/Update File sections, *** End Patch. Add File creates parents. FREEFORM input; no JSON.';
if (patchTool?.freeformDescription !== OAI_V4A_APPLY_PATCH_FREEFORM_DESCRIPTION
    || patchTool?.freeform?.type !== 'grammar'
    || patchTool?.freeform?.syntax !== 'lark') {
  throw new Error(`apply_patch must expose freeform grammar metadata: ${JSON.stringify(patchTool)}`);
}
for (const requiredGrammarLine of [
  'start: begin_patch root_line? hunk+ end_patch',
  'begin_patch: "*** Begin Patch" LF',
  'add_hunk: "*** Add File: " filename LF add_line+',
  'change_move: "*** Move to: " filename LF',
  'end_patch: "*** End Patch" LF?',
  '%import common.LF',
]) {
  if (!patchTool.freeform.definition.includes(requiredGrammarLine)) {
    throw new Error(`apply_patch freeform grammar missing required line: ${requiredGrammarLine}`);
  }
}
{
  const rawPatch = '*** Begin Patch\n*** Add File: custom-wire.txt\n+ok\n*** End Patch\n';
  const body = buildRequestBody(
    [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'patch please' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_patch_1', name: 'apply_patch', arguments: { patch: rawPatch }, nativeType: 'custom_tool_call' }],
      },
      { role: 'tool', toolCallId: 'call_patch_1', content: 'OK' },
    ],
    'gpt-5.5',
    PATCH_TOOL_DEFS,
    {},
  );
  const wirePatchTool = body.tools?.find((tool) => tool.name === 'apply_patch');
  if (wirePatchTool?.type !== 'custom' || wirePatchTool?.format?.syntax !== 'lark') {
    throw new Error(`OpenAI Responses apply_patch must serialize as a custom grammar tool: ${JSON.stringify(wirePatchTool)}`);
  }
  if (wirePatchTool.description !== OAI_V4A_APPLY_PATCH_FREEFORM_DESCRIPTION) {
    throw new Error(`OpenAI Responses apply_patch must use freeform description: ${JSON.stringify(wirePatchTool)}`);
  }
  const customCall = body.input?.find((item) => item.type === 'custom_tool_call');
  const customOutput = body.input?.find((item) => item.type === 'custom_tool_call_output');
  if (customCall?.input !== rawPatch || customCall?.call_id !== 'call_patch_1') {
    throw new Error(`custom apply_patch replay must keep raw patch input: ${JSON.stringify(body.input)}`);
  }
  if (customOutput?.call_id !== 'call_patch_1' || customOutput?.output !== 'OK') {
    throw new Error(`custom apply_patch output must replay as custom_tool_call_output: ${JSON.stringify(body.input)}`);
  }
}
{
  const rawPatch = '*** Begin Patch\n*** Add File: custom-parser.txt\n+ok\n*** End Patch\n';
  const encoder = new TextEncoder();
  const frames = [
    { type: 'response.created', response: { id: 'resp_custom_patch', model: 'gpt-5.5' } },
    { type: 'response.custom_tool_call_input.delta', delta: rawPatch.slice(0, 16) },
    { type: 'response.output_item.done', item: { type: 'custom_tool_call', call_id: 'call_patch_sse', name: 'apply_patch', input: rawPatch } },
    { type: 'response.completed', response: { id: 'resp_custom_patch', model: 'gpt-5.5', usage: { input_tokens: 1, output_tokens: 1 }, output: [] } },
  ];
  const bodyText = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
  let emitted = null;
  const response = await sendViaHttpSse({
    auth: { access_token: 'fake-token', account_id: '' },
    body: { model: 'gpt-5.5', input: [], stream: true },
    opts: {},
    onToolCall: (call) => { emitted = call; },
    externalSignal: null,
    poolKey: 'tool-smoke-custom-patch',
    cacheKey: 'tool-smoke-custom-patch',
    iteration: 1,
    useModel: 'gpt-5.5',
    fetchFn: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(bodyText));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  });
  const call = response.toolCalls?.[0];
  if (call?.nativeType !== 'custom_tool_call' || call?.name !== 'apply_patch' || call?.arguments?.patch !== rawPatch) {
    throw new Error(`custom apply_patch SSE parser must produce internal patch args: ${JSON.stringify(response.toolCalls)}`);
  }
  if (emitted?.arguments?.patch !== rawPatch) {
    throw new Error(`custom apply_patch SSE parser must eager-emit patch args: ${JSON.stringify(emitted)}`);
  }
}
const readTool = BUILTIN_TOOLS.find((tool) => tool.name === 'read');
const readDescription = readTool?.description || '';
const readSchema = readTool?.inputSchema || {};
const readProps = readSchema.properties || {};
if (!/not director/i.test(readDescription)) {
  throw new Error('read description must keep directory-vs-file guidance');
}
if (/line\+context/i.test(readDescription) || !/Known-file contents or line ranges/i.test(readDescription)) {
  throw new Error('read description must stay compact and file-oriented');
}
if (readProps.file_path?.type !== 'string'
  || readProps.file_path?.anyOf
  || readProps.file_path?.description !== 'Known file path.'
  || readProps.path
  || JSON.stringify(readSchema.required) !== JSON.stringify(['file_path'])) {
  throw new Error('read schema must expose only the canonical scalar file_path');
}
if (readProps.offset?.type !== 'integer'
  || readProps.offset?.minimum !== 0
  || readProps.offset?.description !== '1-based start line; default 1.'
  || readProps.limit?.type !== 'integer'
  || readProps.limit?.minimum !== 1
  || readProps.limit?.description !== 'Maximum lines to return; default 800.') {
  throw new Error('read range args must use the CC scalar integer contract with Mixdog descriptions');
}
if (Object.keys(readProps).some((key) => !['file_path', 'offset', 'limit'].includes(key))
  || readSchema.additionalProperties !== false) {
  throw new Error('read schema must not expose legacy or batch arguments');
}
{
  const benchRunSrc = readFileSync(resolve(root, 'scripts/bench-run.mjs'), 'utf8');
  if (!/task_complete:\s*results\.length > 0 && completed === results\.length/.test(benchRunSrc)) {
    throw new Error('bench-run must require every task to complete before saving a round');
  }
  if (!/score_complete:\s*results\.length > 0 && taskErrors\.length === 0 && scoreErrors\.length === 0 && \(score\?\.cards\?\.length \|\| 0\) === results\.length/.test(benchRunSrc)) {
    throw new Error('bench-run must require a scorecard for every task before saving a round');
  }
  if (!/not saving incomplete round/.test(benchRunSrc) || !/process\.exit\(1\)/.test(benchRunSrc)) {
    throw new Error('bench-run must not save incomplete rounds and must exit non-zero');
  }
  const taskBenchSrc = readFileSync(resolve(root, 'scripts/task-bench.mjs'), 'utf8');
  if (!/const allowPartial = hasFlag\('--allow-partial'\)/.test(taskBenchSrc) || !/skipped\.length && !allowPartial/.test(taskBenchSrc) || !/process\.exit\(1\)/.test(taskBenchSrc)) {
    throw new Error('task-bench must fail partial scoring unless --allow-partial is explicit');
  }
}
{
  // setRoute must default to "next session only": a bare
  // runtime.setRoute({model}) call (no options) must NOT rewrite a live
  // session's provider/model in place, or a mid-conversation model/provider
  // switch silently forces a full prompt-cache rewrite (seen as a
  // promptΔ spike + cache_ratio=0% turn in session-bench).
  // God-file splits move implementation into module dirs; scan facade + all
  // split modules so these source-text guards survive refactors.
  const readMjsSources = (rel) => {
    const abs = resolve(root, rel);
    if (rel.endsWith('.mjs')) return readFileSync(abs, 'utf8');
    return readdirSync(abs, { recursive: true })
      .filter((f) => String(f).endsWith('.mjs'))
      .map((f) => readFileSync(resolve(abs, String(f)), 'utf8'))
      .join('\n');
  };
  const runtimeSrc = [readMjsSources('src/mixdog-session-runtime.mjs'), readMjsSources('src/session-runtime')].join('\n');
  const setRouteBlock = runtimeSrc.match(/async setRoute\(next, options = \{\}\) \{[\s\S]*?\n    \},\n/)?.[0] || '';
  if (!/applyToCurrentSession = options\?\.applyToCurrentSession === true/.test(setRouteBlock)) {
    throw new Error('setRoute must default applyToCurrentSession to false (model changes apply to the next session only)');
  }
  if (!/const applyLive = applyToCurrentSession \|\| currentSessionEmpty/.test(setRouteBlock)
    || !/if \(!applyLive\)/.test(setRouteBlock)
    || !/return getRoute\(\);/.test(setRouteBlock)) {
    throw new Error('setRoute must early-return before touching a non-empty live session when applyToCurrentSession is false');
  }
  // Empty current session must apply live so /model before the first chat
  // updates route + statusline at once, but compact summary anchors are route
  // history and must keep a compacted session next-session-only. Seeded system
  // or synthetic assistant/tool rows alone must NOT make the session non-empty.
  if (!/!hasRouteHistoryMessage\(session\.messages\)/.test(setRouteBlock)
    || !/!hasRouteHistoryMessage\(session\.liveTurnMessages\)/.test(setRouteBlock)
    || !/SUMMARY_PREFIX/.test(runtimeSrc)
    || !/hasUserConversationMessage\(list\) \|\| list\.some\(isSummaryAnchorMessage\)/.test(runtimeSrc)
    || !/function hasRouteHistoryMessage/.test(runtimeSrc)) {
    throw new Error('setRoute must apply live only to route-empty sessions and must treat compact summary anchors as non-empty route history');
  }
  if (!/createCurrentSession\('model-switch-empty'\)/.test(setRouteBlock)
    || !/createCurrentSession\('model-switch-empty-drain'\)/.test(setRouteBlock)
    || !/const emptySession = getSession\(\)/.test(setRouteBlock)
    || !/cli-model-switch-empty/.test(setRouteBlock)
    || !/pushTranscriptRebind\?\.\(\)/.test(setRouteBlock)
    || !/invalidatePreSessionToolSurface\?\.\(\)/.test(setRouteBlock)) {
    throw new Error('setRoute must drain in-flight create then recreate/rebind empty live sessions so provider-specific BP1/tool surface is rebuilt for /model before first chat');
  }
  const sessionLifecycleSrc = readMjsSources('src/runtime/agent/orchestrator/session/manager/session-lifecycle.mjs');
  const updateSessionRouteBlock = sessionLifecycleSrc.match(/export function updateSessionRoute\(id, route = \{\}\) \{[\s\S]*?\n\}/)?.[0] || '';
  if (!/session\.promptCacheKey = providerCacheKey\(session\.provider\)/.test(updateSessionRouteBlock)
    || !/session\.providerCacheOpts = buildSessionProviderCacheOpts\(session\.provider, session\.id, session\.agent\) \|\| null/.test(updateSessionRouteBlock)) {
    throw new Error('updateSessionRoute must refresh provider-scoped prompt cache fields when an empty live session changes provider/model');
  }
  const sessionSrc = [
    readMjsSources('src/tui/session.mjs'),
    readMjsSources('src/tui/session-local.mjs'),
    readMjsSources('src/tui/session'),
  ].join('\n');
  if (/setRoute\(\{ model: m \}, \{ applyToCurrentSession: true \}\)/.test(sessionSrc)) {
    throw new Error('TUI setModel must not force applyToCurrentSession:true (model changes must apply to the next session only)');
  }
  if (!/routeOpts\.applyToCurrentSession === true/.test(sessionSrc)) {
    throw new Error('TUI setRoute wrapper must default applyToCurrentSession to false');
  }
}
const codeGraphDescription = CODE_GRAPH_TOOL_DEFS[0]?.description || '';
const codeGraphProps = CODE_GRAPH_TOOL_DEFS[0]?.inputSchema?.properties || {};
const codeGraphSymbolSearchErr = validateBuiltinArgs('code_graph', { mode: 'symbol_search', symbols: ['hook', 'deny'], limit: 5 });
if (codeGraphSymbolSearchErr) {
  throw new Error(`code_graph guard must accept symbol_search with symbols[] batching: ${codeGraphSymbolSearchErr}`);
}
// code_graph description stays structure-oriented and must actively route
// symbol/definition/caller lookups AWAY from repeated grep (the grep_retry +
// find_symbol_noscope anti-patterns). It is allowed to be verbose enough to
// enumerate modes, but must not drift into web-search territory.
if (!/Source-file structure/i.test(codeGraphDescription)
  || !['find_symbol', 'symbol_search', 'references', 'callers', 'callees'].every((mode) => codeGraphDescription.includes(mode))) {
  throw new Error('code_graph description must stay structure-oriented and name its symbol modes');
}
if (!/File modes use files\[\]/i.test(codeGraphDescription) || !/symbol modes use symbols\[\]/i.test(codeGraphDescription)) {
  throw new Error('code_graph description must keep its per-mode files[]/symbols[] target contract');
}
if (!/files\[\]/i.test(codeGraphProps.mode?.description || '') || !/project-relative source file path/i.test(codeGraphProps.files?.description || '')) {
  throw new Error('code_graph schema must keep compact, repo-local field descriptions');
}
if (!/Explicit root outside the project/i.test(codeGraphProps.cwd?.description || '') || !/omit for project root/i.test(codeGraphProps.cwd?.description || '')) {
  throw new Error('code_graph schema must expose its explicit outside-cwd root');
}
const recallTool = MEMORY_TOOL_DEFS.find((tool) => tool.name === 'recall');
const recallProps = recallTool?.inputSchema?.properties || {};
if (!/prior work/i.test(recallTool?.description || '') || !recallProps.id?.anyOf || !/Do not invent ids/i.test(recallProps.id?.description || '')) {
  throw new Error('recall schema must preserve scoped prior-context guidance and id lookup shape');
}
if (!/independent fan-out/i.test(recallProps.query?.description || '') || !/pool/i.test(recallProps.projectScope?.description || '')) {
  throw new Error('recall schema must explain fan-out query and project scope filters');
}
// Cross-session / raw recall surface: includeMembers stays a chunk-member
// output knob, includeRaw exposes unchunked raw/episode turns, and sessionOnly
// is the explicit opt-in that restores the old single-session hard scope.
if (!/chunk members/i.test(recallProps.includeMembers?.description || '')) {
  throw new Error('recall includeMembers must stay scoped to chunk-member output only');
}
if (!recallProps.includeRaw || !/raw\/episode/i.test(recallProps.includeRaw?.description || '')) {
  throw new Error('recall schema must expose includeRaw for unchunked raw/episode turns');
}
if (!recallProps.sessionOnly || !/session only/i.test(recallProps.sessionOnly?.description || '')) {
  throw new Error('recall schema must expose sessionOnly as the explicit single-session opt-in');
}
// Behaviour-level checks for the cross-session merge contract. These exercise
// the pure mergeSessionRowsIntoGlobal() helper (no DB) so the starve-prevention
// + dedupe + includeRaw-parity invariants are guarded, not just the schema.
{
  // 1) Starve prevention: a flood of session rows must NOT push global hybrid
  //    hits off the first page. Global rows carry a real retrievalScore; the
  //    session rows (score 0) must sort AFTER them under importance.
  const globalHits = [
    { id: 1, retrievalScore: 0.9, ts: 100 },
    { id: 2, retrievalScore: 0.8, ts: 110 },
  ];
  const sessionFlood = Array.from({ length: 20 }, (_, i) => ({ id: 1000 + i, retrievalScore: 0, ts: 200 + i }));
  const mergedImportance = mergeSessionRowsIntoGlobal(globalHits, sessionFlood, { sort: 'importance' });
  if (mergedImportance.slice(0, 2).map((r) => r.id).join(',') !== '1,2') {
    throw new Error(`session merge must not starve global first page under importance: ${JSON.stringify(mergedImportance.slice(0, 3))}`);
  }
  if (mergedImportance.length !== globalHits.length + sessionFlood.length) {
    throw new Error('session merge must append all non-duplicate session rows');
  }
  // 2) Dedupe by id AND by global root member id (member/leaf double-output).
  const globalWithMembers = [{ id: 5, retrievalScore: 0.7, ts: 100, members: [{ id: 51 }, { id: 52 }] }];
  const sessionDupes = [
    { id: 5, retrievalScore: 0, ts: 300 }, // dup root id
    { id: 51, retrievalScore: 0, ts: 301 }, // dup member id
    { id: 99, retrievalScore: 0, ts: 302 }, // genuinely new
  ];
  const mergedDedupe = mergeSessionRowsIntoGlobal(globalWithMembers, sessionDupes, { sort: 'importance' });
  const dedupeIds = mergedDedupe.map((r) => Number(r.id)).sort((a, b) => a - b);
  if (dedupeIds.join(',') !== '5,99') {
    throw new Error(`session merge must dedupe root+member ids, leaving only new rows: ${JSON.stringify(dedupeIds)}`);
  }
  // 3) date sort keeps newest-first across the merged set.
  const mergedDate = mergeSessionRowsIntoGlobal(
    [{ id: 1, retrievalScore: 0.9, ts: 100 }],
    [{ id: 2, retrievalScore: 0, ts: 999 }],
    { sort: 'date' },
  );
  if (Number(mergedDate[0].id) !== 2) {
    throw new Error(`session merge under date sort must order by ts desc: ${JSON.stringify(mergedDate)}`);
  }
  // 4) Empty session rows is a no-op passthrough (no crash, same array).
  const passthrough = mergeSessionRowsIntoGlobal(globalHits, [], { sort: 'importance' });
  if (passthrough.length !== globalHits.length) {
    throw new Error('session merge with no session rows must be a passthrough');
  }
}
const memoryTool = MEMORY_TOOL_DEFS.find((tool) => tool.name === 'memory');
const memoryProps = memoryTool?.inputSchema?.properties || {};
if (!/mutation/i.test(memoryTool?.description || '') || !/Exact confirmation phrase/i.test(memoryProps.confirm?.description || '')) {
  throw new Error('memory schema must preserve mutation/destructive confirmation guidance');
}
if (memoryProps.category || /category/i.test(memoryTool?.description || '')) {
  throw new Error('memory mutation schema must not expose category');
}
const searchTool = SEARCH_TOOL_DEFS.find((tool) => tool.name === 'search');
const searchProps = searchTool?.inputSchema?.properties || {};
if (!/Runs synchronously/i.test(searchTool?.description || '')
  || searchProps.mode
  || searchProps.action
  || searchProps.task_id
  || !searchProps.query?.anyOf
  || !/array for lossless fan-out/i.test(searchProps.query?.description || '')
  || !searchTool?.inputSchema?.required?.includes('query')) {
  throw new Error('search schema must preserve sync execution guidance and string/array query shape');
}
if (!/Default web/i.test(searchProps.type?.description || '') || !/locale hint/i.test(searchProps.locale?.description || '') || !/Default low/i.test(searchProps.contextSize?.description || '')) {
  throw new Error('search schema must describe type, locale, and contextSize defaults');
}
const webFetchTool = SEARCH_TOOL_DEFS.find((tool) => tool.name === 'web_fetch');
const webFetchProps = webFetchTool?.inputSchema?.properties || {};
if (!/^Fetch page\/docs body from URL\.$/i.test(webFetchTool?.description || '') || !webFetchProps.url?.anyOf || !/array of URLs/i.test(webFetchProps.url?.description || '')) {
  throw new Error('web_fetch schema must preserve body-fetch capability and string/array url shape');
}
if (!/offset/i.test(webFetchProps.startIndex?.description || '') || !/Maximum characters/i.test(webFetchProps.maxLength?.description || '')) {
  throw new Error('web_fetch schema must describe paging window fields');
}
const toolSearchNamesSchema = TOOL_SEARCH_TOOL.inputSchema?.properties?.names;
const toolSearchNamesArraySchema = toolSearchNamesSchema?.anyOf?.find((entry) => entry?.type === 'array');
if (!/deferred-tool/i.test(TOOL_SEARCH_TOOL.description || '')
  || !toolSearchNamesSchema
  || toolSearchNamesArraySchema?.minItems !== 1
  || TOOL_SEARCH_TOOL.inputSchema?.properties?.select
  || TOOL_SEARCH_TOOL.inputSchema?.additionalProperties !== false) {
  throw new Error('load_tool schema must require non-empty names[] as the only loader field (legacy select stays retired)');
}
const toolSearchSession = {
  tools: smokeCatalog.filter((tool) => fullDefaults.has(tool?.name)),
  deferredToolCatalog: smokeCatalog.slice(),
  deferredSelectedTools: [...fullDefaults],
};
// load_tool is a pure loader: a free-text query is NOT a search. It loads
// nothing, returns an error steering to names[], and never activates tools.
const listQueryResult = JSON.parse(__renderToolSearchForTest({ query: 'shell' }, toolSearchSession, 'full'));
if (listQueryResult.selected || (Array.isArray(listQueryResult.loaded) && listQueryResult.loaded.length)) {
  throw new Error(`load_tool free-text query must not load: ${JSON.stringify(listQueryResult)}`);
}
if (!listQueryResult.error || !/names/i.test(listQueryResult.error)) {
  throw new Error(`load_tool free-text query must steer to names[]: ${JSON.stringify(listQueryResult)}`);
}
if (listQueryResult.activeTools.includes('shell') || (Array.isArray(listQueryResult.discoveredTools) && listQueryResult.discoveredTools.includes('shell'))) {
  throw new Error(`load_tool free-text query must not activate/discover tools: ${JSON.stringify(listQueryResult)}`);
}
// names[] is the primary loader input (aliases expand, tools activate).
const namesLoadResult = JSON.parse(__renderToolSearchForTest({ names: ['shell', 'recall'] }, {
  tools: smokeCatalog.filter((tool) => fullDefaults.has(tool?.name)),
  deferredToolCatalog: smokeCatalog.slice(),
  deferredSelectedTools: [...fullDefaults],
}, 'full'));
for (const name of ['shell', 'recall']) {
  if (!namesLoadResult.activeTools.includes(name) || !namesLoadResult.loaded.includes(name)) {
    throw new Error(`load_tool names[] must load ${name}: ${JSON.stringify(namesLoadResult)}`);
  }
}
// query "select:a,b" is the explicit query-side loader (aliases expand).
const bulkSelectResult = JSON.parse(__renderToolSearchForTest({ query: 'select:shell,recall' }, toolSearchSession, 'full'));
if (bulkSelectResult.selected?.mode !== 'select') {
  throw new Error(`tool_search query-select must report select mode: ${JSON.stringify(bulkSelectResult.selected)}`);
}
for (const name of ['shell', 'task', 'recall']) {
  if (!bulkSelectResult.activeTools.includes(name)) {
    throw new Error(`tool_search bulk select missing ${name}: ${JSON.stringify(bulkSelectResult)}`);
  }
}
const prefixedSelectSession = {
  tools: smokeCatalog.filter((tool) => fullDefaults.has(tool?.name)),
  deferredToolCatalog: smokeCatalog.slice(),
  deferredSelectedTools: [...fullDefaults],
};
const prefixedSelectResult = JSON.parse(__renderToolSearchForTest({ select: 'select:shell,recall' }, prefixedSelectSession, 'full'));
if (!prefixedSelectResult.activeTools.includes('shell') || !prefixedSelectResult.activeTools.includes('recall')) {
  throw new Error(`tool_search select field should accept select: prefix: ${JSON.stringify(prefixedSelectResult)}`);
}
if (!Array.isArray(toolSearchSession.deferredDiscoveredTools) || !toolSearchSession.deferredDiscoveredTools.includes('shell')) {
  throw new Error('tool_search must persist discovered tool state on the session');
}
const nativeToolSearchSession = {
  provider: 'openai-oauth',
  tools: smokeCatalog.filter((tool) => fullDefaults.has(tool?.name)),
  deferredToolCatalog: smokeCatalog.slice(),
  deferredSelectedTools: [...fullDefaults],
  deferredDiscoveredTools: [],
  deferredProviderMode: 'native',
  deferredNativeTools: true,
};
nativeToolSearchSession.deferredCallableTools = nativeToolSearchSession.tools.map((tool) => tool.name);
const nativeBaseToolsJson = JSON.stringify(nativeToolSearchSession.tools);
const nativeBaseRequest = buildRequestBody(
  [{ role: 'user', content: 'load shell' }],
  'gpt-5.4',
  nativeToolSearchSession.tools,
  { sessionId: 'deferred-stability', session: nativeToolSearchSession },
);
const nativeSelectResult = JSON.parse(__renderToolSearchForTest({ select: 'shell,recall' }, nativeToolSearchSession, 'full'));
for (const name of ['shell', 'task', 'recall']) {
  if (!nativeSelectResult.activeTools.includes(name)) {
    throw new Error(`native load_tool must register ${name} as callable: ${JSON.stringify(nativeSelectResult)}`);
  }
}
if (JSON.stringify(nativeToolSearchSession.tools) !== nativeBaseToolsJson
  || nativeToolSearchSession.tools.some((tool) => tool?.name === 'shell')) {
  throw new Error(`native load_tool must keep the base tools array byte-stable: ${JSON.stringify(nativeToolSearchSession.tools)}`);
}
if (!nativeSelectResult.nativeToolSearch?.openaiTools?.some((tool) => tool?.name === 'shell' && tool?.defer_loading === true)) {
  throw new Error(`native tool_search must return OpenAI loadable deferred tools: ${JSON.stringify(nativeSelectResult.nativeToolSearch)}`);
}
if (!nativeSelectResult.nativeToolSearch?.toolReferences?.includes('shell')) {
  throw new Error(`native tool_search must return Anthropic tool references: ${JSON.stringify(nativeSelectResult.nativeToolSearch)}`);
}
const nativeToolCountAfterFirstLoad = nativeToolSearchSession.tools.length;
const nativeRepeatResult = JSON.parse(__renderToolSearchForTest({ select: 'shell,recall' }, nativeToolSearchSession, 'full'));
if (nativeRepeatResult.loaded.length
  || !['shell', 'task', 'recall'].every((name) => nativeRepeatResult.alreadyActive.includes(name))
  || nativeRepeatResult.nativeToolSearch?.toolReferences?.length
  || nativeRepeatResult.nativeToolSearch?.openaiTools?.length
  || nativeToolSearchSession.tools.length !== nativeToolCountAfterFirstLoad) {
  throw new Error(`repeated native load_tool must report already-active without reinjection: ${JSON.stringify(nativeRepeatResult)}`);
}
const nativeHistory = [
  { role: 'user', content: 'load shell' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'search-1', name: 'load_tool', arguments: { names: ['shell'] }, nativeType: 'tool_search_call' }],
  },
  {
    role: 'tool',
    toolCallId: 'search-1',
    content: nativeSelectResult.nativeToolSearch.summary,
    nativeToolSearch: nativeSelectResult.nativeToolSearch,
  },
];
const nativeFollowupRequest = buildRequestBody(
  nativeHistory,
  'gpt-5.4',
  nativeToolSearchSession.tools,
  { sessionId: 'deferred-stability', session: nativeToolSearchSession },
);
if (JSON.stringify(nativeFollowupRequest.tools) !== JSON.stringify(nativeBaseRequest.tools)
  || nativeFollowupRequest.prompt_cache_key !== nativeBaseRequest.prompt_cache_key) {
  throw new Error('OpenAI native loading must not change tools or prompt_cache_key');
}
const nativeOutput = nativeFollowupRequest.input.find((item) => item?.type === 'tool_search_output');
if (!nativeOutput?.tools?.some((tool) => tool?.name === 'shell')
  || nativeFollowupRequest.tools.some((tool) => tool?.name === 'shell')) {
  throw new Error(`OpenAI loaded schemas must exist only in tool_search_output history: ${JSON.stringify(nativeFollowupRequest)}`);
}
const directMcpSession = {
  provider: 'openai-oauth',
  toolSpec: 'full',
  tools: [{ name: 'load_tool', inputSchema: { type: 'object', properties: {} } }],
  deferredToolCatalog: [
    { name: 'load_tool', inputSchema: { type: 'object', properties: {} } },
    { name: 'mcp__demo__ping', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} } },
  ],
  deferredCallableTools: ['load_tool', 'mcp__demo__ping'],
  deferredProviderMode: 'native',
  deferredNativeTools: true,
};
prepareDeferredToolCallThrough(directMcpSession, 'mcp__demo__ping', {});
if (directMcpSession.tools.some((tool) => tool?.name === 'mcp__demo__ping')
  || !directMcpSession.deferredCallableTools.includes('mcp__demo__ping')) {
  throw new Error('subsequent native MCP calls must use the callable registry without session.tools promotion');
}
const readonlyReportingSession = {
  tools: [TOOL_SEARCH_TOOL],
  deferredToolCatalog: smokeCatalog.slice(),
  deferredSelectedTools: ['load_tool'],
};
const readonlyReportingResult = JSON.parse(__renderToolSearchForTest(
  { names: ['shell', 'definitely_missing_tool'] },
  readonlyReportingSession,
  'readonly',
  {
    mcpStatus: () => ({
      servers: [
        { name: 'connecting-mcp', status: 'disconnected' },
        { name: 'failed-mcp', status: 'failed' },
      ],
    }),
  },
));
if (!readonlyReportingResult.blocked?.some((entry) => entry?.name === 'shell' && entry?.reason === 'readonly mode')
  || !readonlyReportingResult.missing.includes('definitely_missing_tool')
  || !readonlyReportingResult.pendingMcpServers?.includes('connecting-mcp')
  || !readonlyReportingResult.failedMcpServers?.includes('failed-mcp')
  || !/retry next turn/i.test(readonlyReportingResult.note || '')
  || !/unavailable/i.test(readonlyReportingResult.note || '')) {
  throw new Error(`load_tool must preserve readonly and MCP status reporting: ${JSON.stringify(readonlyReportingResult)}`);
}
const nativePatchSearchSession = {
  provider: 'openai-oauth',
  tools: smokeCatalog.filter((tool) => fullDefaults.has(tool?.name) && tool?.name !== 'apply_patch'),
  deferredToolCatalog: smokeCatalog.slice(),
  deferredSelectedTools: [...fullDefaults].filter((name) => name !== 'apply_patch'),
  deferredDiscoveredTools: [],
  deferredProviderMode: 'native',
  deferredNativeTools: true,
};
const nativePatchSelectResult = JSON.parse(__renderToolSearchForTest({ select: 'apply_patch' }, nativePatchSearchSession, 'full'));
const nativePatchTool = nativePatchSelectResult.nativeToolSearch?.openaiTools?.find((tool) => tool?.name === 'apply_patch');
if (nativePatchTool?.type !== 'custom' || nativePatchTool?.format?.syntax !== 'lark') {
  throw new Error(`native tool_search must preserve apply_patch as OpenAI custom freeform: ${JSON.stringify(nativePatchSelectResult.nativeToolSearch)}`);
}
if (nativePatchTool.defer_loading === true || nativePatchTool.parameters) {
  throw new Error(`native tool_search custom apply_patch must not be downgraded to deferred function schema: ${JSON.stringify(nativePatchTool)}`);
}
const grokCanonicalSession = { provider: 'grok-oauth', tools: [], messages: [] };
applyDeferredToolSurface(grokCanonicalSession, 'full', smokeCatalog, { provider: 'grok-oauth' });
const grokCanonicalJson = JSON.stringify(grokCanonicalSession.tools);
const grokLoadResult = JSON.parse(__renderToolSearchForTest({ names: ['apply_patch'] }, grokCanonicalSession, 'full'));
if (grokCanonicalSession.deferredNativeTools
  || grokLoadResult.nativeToolSearch
  || JSON.stringify(grokCanonicalSession.tools) !== grokCanonicalJson
  || !grokLoadResult.alreadyActive.includes('apply_patch')) {
  throw new Error(`Grok must use a fixed canonical ordinary-function surface: ${JSON.stringify(grokLoadResult)}`);
}
// Native query-select explicitly loads onto the active surface; aliases expand.
const nativeSelectQuerySession = {
  tools: smokeCatalog.filter((tool) => fullDefaults.has(tool?.name)),
  deferredToolCatalog: smokeCatalog.slice(),
  deferredSelectedTools: [...fullDefaults],
  deferredDiscoveredTools: [],
  deferredProviderMode: 'native',
  deferredNativeTools: true,
};
const nativeSelectQueryResult = JSON.parse(__renderToolSearchForTest({ query: 'select:search' }, nativeSelectQuerySession, 'full'));
for (const name of ['search', 'web_fetch']) {
  if (!nativeSelectQueryResult.activeTools.includes(name)) {
    throw new Error(`native tool_search query-select should load ${name}: ${JSON.stringify(nativeSelectQueryResult)}`);
  }
}
if (!nativeSelectQueryResult.nativeToolSearch?.toolReferences?.includes('search')) {
  throw new Error(`native query-select must return nativeToolSearch payload: ${JSON.stringify(nativeSelectQueryResult.nativeToolSearch)}`);
}
// Native late-MCP selections must resolve against the boot+late catalog union,
// otherwise the load result says "loaded" but omits the provider payload.
const nativeLateMcpSearchSession = {
  provider: 'openai-oauth',
  tools: [],
  deferredToolCatalog: [{ name: 'load_tool', description: 'Loader.', inputSchema: { type: 'object', properties: {} } }],
  deferredLateToolCatalog: [{ name: 'mcp__late__ping', description: 'Late MCP tool.', inputSchema: { type: 'object', properties: {} } }],
  deferredDiscoveredTools: [],
  deferredProviderMode: 'native',
  deferredNativeTools: true,
};
const nativeLateMcpSelectResult = JSON.parse(__renderToolSearchForTest({ names: ['mcp__late__ping'] }, nativeLateMcpSearchSession, 'full'));
if (nativeLateMcpSearchSession.tools.some((tool) => tool?.name === 'mcp__late__ping')) {
  throw new Error(`native late MCP load must not promote its schema onto session.tools: ${JSON.stringify(nativeLateMcpSearchSession.tools)}`);
}
if (!nativeLateMcpSelectResult.nativeToolSearch?.toolReferences?.includes('mcp__late__ping')) {
  throw new Error(`native late MCP load must include nativeToolSearch payload: ${JSON.stringify(nativeLateMcpSelectResult)}`);
}
if (!nativeLateMcpSelectResult.nativeToolSearch?.openaiTools?.some((tool) => tool?.name === 'mcp__late__ping' && tool?.defer_loading === true)) {
  throw new Error(`native late MCP load must include OpenAI loadable tool spec: ${JSON.stringify(nativeLateMcpSelectResult.nativeToolSearch)}`);
}
// A plain query never auto-loads/discovers, even on native providers.
const nativePlainQuerySession = {
  tools: smokeCatalog.filter((tool) => fullDefaults.has(tool?.name)),
  deferredToolCatalog: smokeCatalog.slice(),
  deferredSelectedTools: [...fullDefaults],
  deferredDiscoveredTools: [],
  deferredProviderMode: 'native',
  deferredNativeTools: true,
};
for (const q of ['run tests', 'web docs', 'memory previous', 'status']) {
  const r = JSON.parse(__renderToolSearchForTest({ query: q }, nativePlainQuerySession, 'full'));
  if (r.selected || r.discoveredTools.length) {
    throw new Error(`native tool_search plain query "${q}" must not auto-load/discover: ${JSON.stringify(r)}`);
  }
}
const geminiManifestSession = { provider: 'gemini', tools: [], messages: [] };
const manifestBase = [
  { name: 'load_tool', inputSchema: { type: 'object', properties: {} } },
  { name: 'read', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} } },
];
applyDeferredToolSurface(geminiManifestSession, 'full', manifestBase, { provider: 'gemini' });
const geminiTurnManifest = JSON.stringify(geminiManifestSession.tools);
const geminiLate = { name: 'mcp__gemini__late', inputSchema: { type: 'object', properties: {} } };
// Continuations use the same array; only the next user-turn reconciliation may replace it.
if (JSON.stringify(geminiManifestSession.tools) !== geminiTurnManifest) {
  throw new Error('Gemini manifest changed within a user turn');
}
reconcileDeferredMcpToolCatalog(geminiManifestSession, [geminiLate]);
if (!geminiManifestSession.tools.some((tool) => tool.name === 'mcp__gemini__late')) {
  throw new Error('Gemini must adopt the complete ordered live manifest at the next user turn');
}
// Skill-style deferred manifest: `- name: description` lines, `<`/`>` sanitized,
// bare names allowed, header instructs direct calls, empty pool → ''.
const manifestText = buildDeferredToolManifest([
  { name: 'shell', description: 'Run commands.' },
  { name: 'search', description: 'Web <search> now.' },
  'recall',
]);
if (!/<available-deferred-tools>/.test(manifestText) || !/- shell: Run commands\./.test(manifestText)) {
  throw new Error(`deferred manifest must render "- name: description" lines: ${manifestText}`);
}
if (!/call any tool listed below directly/i.test(manifestText)) {
  throw new Error(`deferred manifest must tell the model it can call listed tools directly: ${manifestText}`);
}
if (!/^- recall$/m.test(manifestText)) {
  throw new Error(`deferred manifest must allow bare names without descriptions: ${manifestText}`);
}
if (/[<>]/.test(manifestText.replace(/<\/?available-deferred-tools>/g, ''))) {
  throw new Error(`deferred manifest must sanitize angle brackets in descriptions: ${manifestText}`);
}
if (buildDeferredToolManifest([]) !== '') {
  throw new Error('empty deferred pool must yield an empty manifest');
}
const bp2ManifestSession = {
  messages: [
    { role: 'system', content: 'BP1 BASE' },
    { role: 'system', content: 'BP2 PROFILE' },
    { role: 'system', content: 'BP3 SESSION', cacheTier: 'tier3' },
  ],
  deferredToolCatalog: [
    { name: 'shell', description: 'Run commands.' },
    { name: 'recall', description: 'Recall prior work.' },
  ],
};
applyInitialDeferredToolManifestToBp2(bp2ManifestSession, ['shell', 'recall']);
const bp2ManifestText = bp2ManifestSession.messages[1].content;
if (!/- shell: Run commands\./.test(bp2ManifestText) || !/- recall: Recall prior work\./.test(bp2ManifestText)) {
  throw new Error(`BP2 deferred manifest must carry catalog descriptions: ${bp2ManifestText}`);
}
if (bp2ManifestSession.messages[0].content !== 'BP1 BASE'
  || bp2ManifestSession.messages[2].content !== 'BP3 SESSION'
  || bp2ManifestSession.deferredToolBp2Applied !== true) {
  throw new Error(`BP2 deferred manifest injection must preserve BP1/BP3: ${JSON.stringify(bp2ManifestSession.messages)}`);
}
if (CHANNEL_TOOL_DEFS.some((tool) => tool.name === 'reply' || tool.name === 'fetch')) {
  throw new Error('channel reply/fetch must stay removed from the model-facing surface');
}
const grepTool = BUILTIN_TOOLS.find((tool) => tool.name === 'grep');
const grepPatternDescription = grepTool?.inputSchema?.properties?.pattern?.description || '';
const grepPathDescription = grepTool?.inputSchema?.properties?.path?.description || '';
const grepGlobDescription = grepTool?.inputSchema?.properties?.glob?.description || '';
const grepModeDescription = grepTool?.inputSchema?.properties?.mode?.description || '';
const grepLimitDescription = grepTool?.inputSchema?.properties?.limit?.description || '';
const grepContextDescription = grepTool?.inputSchema?.properties?.context?.description || '';
if (grepTool?.inputSchema?.properties?.pattern?.type !== 'string'
    || grepTool?.inputSchema?.properties?.pattern?.anyOf
    || grepTool?.inputSchema?.properties?.path?.type !== 'string'
    || grepTool?.inputSchema?.properties?.path?.anyOf
    || grepTool?.inputSchema?.properties?.glob?.type !== 'string'
    || grepTool?.inputSchema?.properties?.glob?.anyOf
    || !/Text\/regex/i.test(grepPatternDescription)
    || !/File\/dir scope/i.test(grepPathDescription)) {
  throw new Error('grep schema must expose scalar pattern/path/glob guidance');
}
if (!/\bSearch file contents for literal or regex matches\b/i.test(grepTool?.description || '')
    || !/read only omitted lines/i.test(grepTool?.description || '')) {
  throw new Error('grep description must state its scoped discovery and returned-span reuse contract');
}
if (!/Glob filter/i.test(grepGlobDescription)) {
  throw new Error('grep glob schema must describe scope narrowing');
}
if (!/files lists matching paths/i.test(grepModeDescription)
    || !/count totals all patterns together per file/i.test(grepModeDescription)
    || !/content/i.test(grepModeDescription)) {
  throw new Error('grep mode schema must name its compact output shapes and count aggregation');
}
if (grepTool?.inputSchema?.properties?.limit?.minimum !== 0 || !/Max results/i.test(grepLimitDescription)) {
  throw new Error('grep limit schema must keep locator caps explicit');
}
if (grepTool?.inputSchema?.properties?.['-C'] || !/automatic context/i.test(grepContextDescription) || !/0 for matches only/i.test(grepContextDescription)) {
  throw new Error('grep schema must expose one context field and keep ripgrep aliases internal');
}
if (grepTool?.inputSchema?.properties?.type) {
  throw new Error('grep type schema must stay hidden; prefer glob for extension narrowing');
}
const globTool = BUILTIN_TOOLS.find((tool) => tool.name === 'glob');
const findTool = BUILTIN_TOOLS.find((tool) => tool.name === 'find');
const listTool = BUILTIN_TOOLS.find((tool) => tool.name === 'list');
const findLimitDescription = findTool?.inputSchema?.properties?.limit?.description || '';
if (!/wildcard-matching paths under a known base/i.test(globTool?.description || '')
    || !/when those paths are needed/i.test(globTool?.description || '')) {
  throw new Error('glob description must state its known-base wildcard path contract');
}
if (globTool?.inputSchema?.properties?.pattern?.type !== 'string'
    || globTool?.inputSchema?.properties?.pattern?.anyOf
    || globTool?.inputSchema?.properties?.path?.type !== 'string'
    || globTool?.inputSchema?.properties?.path?.anyOf) {
  throw new Error('glob schema must expose scalar pattern and path');
}
// Contract-only description: guessed-fragment/verified-root routing policy
// lives in src/rules/shared/01-tool.md.
if (!/Fuzzy filename\/directory path lookup when the location itself is unknown/i.test(findTool?.description || '') || !/returns paths only/i.test(findTool?.description || '')) {
  throw new Error('find description must state its fuzzy path-lookup contract');
}
if (!/default 25/i.test(findLimitDescription) || !/0 unlimited/i.test(findLimitDescription)) {
  throw new Error('find limit must state default 25 and the 0-unlimited sentinel');
}
if (!/known directory's immediate entries/i.test(listTool?.description || '')
    || !/entry list itself is needed/i.test(listTool?.description || '')
    || !/not a prerequisite for another tool/i.test(listTool?.description || '')
    || !/no wildcard/i.test(listTool?.description || '')
    || listTool?.inputSchema?.properties?.path?.type !== 'string'
    || listTool?.inputSchema?.properties?.path?.anyOf) {
  throw new Error('list description must state its known-directory immediate-entry contract');
}
if (findTool?.inputSchema?.properties?.query?.type !== 'string'
    || findTool?.inputSchema?.properties?.query?.anyOf) {
  throw new Error('find schema must expose scalar query');
}
const codeGraphModeDescription = codeGraphProps.mode?.description || '';
const codeGraphSymbolsDescription = codeGraphProps.symbols?.description || '';
const codeGraphBodyDescription = codeGraphProps.body?.description || '';
if (!/find_symbol returns declaration\/body/i.test(codeGraphDescription)
    || !/references returns declaration\/usages plus optional body.*no grep/i.test(codeGraphDescription)
    || !/callers\/callees return locations/i.test(codeGraphDescription)
    || !/find_symbol defaults true/i.test(codeGraphBodyDescription)
    || !/references is opt-in/i.test(codeGraphBodyDescription)) {
  throw new Error('code_graph descriptions must distinguish declarations, usages, and relation locations');
}
assertCodeGraphDescriptionContract({
  description: codeGraphDescription,
  modeDescription: codeGraphModeDescription,
  symbolsDescription: codeGraphSymbolsDescription,
});

const longToolSearchText = compactToolSearchDescription(`${patchDescription}\n${patchDescription}`);
if (longToolSearchText.length > 220 || /\n/.test(longToolSearchText)) {
  throw new Error(`tool_search descriptions must be compact single-line snippets, got ${longToolSearchText.length} chars`);
}

{
  // Regression guard for the sonnet-5 16384 cap bug (thinking exhausted the
  // whole output budget). Both the catalog path (outputTokens=128000 → capped
  // 65536) and the catalog-miss heuristic (sonnet 5+ → 65536) must yield
  // 65536, so assert the exact value with the env override cleared.
  const _prevMaxOut = process.env.MIXDOG_ANTHROPIC_MAX_OUTPUT_TOKENS;
  delete process.env.MIXDOG_ANTHROPIC_MAX_OUTPUT_TOKENS;
  try {
    const sonnet5MaxTokens = _anthropicOAuthTest.resolveMaxTokens('claude-sonnet-5');
    if (sonnet5MaxTokens !== 65536) {
      throw new Error(`resolveMaxTokens('claude-sonnet-5') must be 65536 (catalog-capped or sonnet-5+ fallback), got ${sonnet5MaxTokens}`);
    }
    const sonnet46MaxTokens = _anthropicOAuthTest.resolveMaxTokens('claude-sonnet-4-6');
    if (!(sonnet46MaxTokens >= 16384)) {
      throw new Error(`resolveMaxTokens('claude-sonnet-4-6') must be >= 16384, got ${sonnet46MaxTokens}`);
    }
    process.env.MIXDOG_ANTHROPIC_MAX_OUTPUT_TOKENS = 'garbage';
    const garbageOverride = _anthropicOAuthTest.resolveMaxTokens('claude-sonnet-5');
    if (garbageOverride !== 65536) {
      throw new Error(`invalid MIXDOG_ANTHROPIC_MAX_OUTPUT_TOKENS must be ignored (catalog/fallback path), got ${garbageOverride}`);
    }
    process.env.MIXDOG_ANTHROPIC_MAX_OUTPUT_TOKENS = '32768';
    const validOverride = _anthropicOAuthTest.resolveMaxTokens('claude-sonnet-5');
    if (validOverride !== 32768) {
      throw new Error(`valid MIXDOG_ANTHROPIC_MAX_OUTPUT_TOKENS=32768 must win, got ${validOverride}`);
    }
  } finally {
    if (_prevMaxOut === undefined) delete process.env.MIXDOG_ANTHROPIC_MAX_OUTPUT_TOKENS;
    else process.env.MIXDOG_ANTHROPIC_MAX_OUTPUT_TOKENS = _prevMaxOut;
  }
}

process.stdout.write(`tool smoke passed surface_chars=${surfaceSize}\n`);
