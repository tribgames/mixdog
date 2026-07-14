#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { __applyStandaloneToolDefaultsForTest, __renderToolSearchForTest, compactToolSearchDescription, defaultDeferredToolNames, SKILL_TOOL, TOOL_SEARCH_TOOL } from '../src/mixdog-session-runtime.mjs';
import { applyInitialDeferredToolManifestToBp1, buildDeferredToolManifest } from '../src/runtime/agent/orchestrator/context/collect.mjs';
import { buildExplorerPrompt, EXPLORE_TOOL, MAX_FANOUT_QUERIES, normalizeExploreQueries } from '../src/standalone/explore-tool.mjs';
import { AGENT_TOOL, createStandaloneAgent } from '../src/standalone/agent-tool.mjs';
import { parseHeadlessRoleCommand } from '../src/app.mjs';
import { buildHeadlessSpawnArgs } from '../src/headless-role.mjs';
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
import { applyGrepContextLeadPolicy, GREP_CONTEXT_MAX, validateBuiltinArgs } from '../src/runtime/agent/orchestrator/tools/builtin/arg-guard.mjs';
import { normaliseReadLineWindowArgs } from '../src/runtime/agent/orchestrator/tools/builtin/read-args.mjs';
import { BUILTIN_TOOLS } from '../src/runtime/agent/orchestrator/tools/builtin/builtin-tools.mjs';
import { runResultCacheInFlight } from '../src/runtime/agent/orchestrator/tools/builtin/cache-layers.mjs';
import { executeCodeGraphTool } from '../src/runtime/agent/orchestrator/tools/code-graph.mjs';
import { CODE_GRAPH_TOOL_DEFS } from '../src/runtime/agent/orchestrator/tools/code-graph-tool-defs.mjs';
import { executePatchTool } from '../src/runtime/agent/orchestrator/tools/patch.mjs';
import { PATCH_TOOL_DEFS } from '../src/runtime/agent/orchestrator/tools/patch-tool-defs.mjs';
import { TOOL_DEFS as MEMORY_TOOL_DEFS } from '../src/runtime/memory/tool-defs.mjs';
import { mergeSessionRowsIntoGlobal } from '../src/runtime/memory/lib/memory-session-merge.mjs';
import { TOOL_DEFS as SEARCH_TOOL_DEFS } from '../src/runtime/search/tool-defs.mjs';
import { TOOL_DEFS as CHANNEL_TOOL_DEFS } from '../src/runtime/channels/tool-defs.mjs';
import { AGENT_OWNER } from '../src/runtime/agent/orchestrator/agent-owner.mjs';
import { recursiveWrapperToolNameForPublicAgent } from '../src/runtime/agent/orchestrator/session/manager/tool-resolution.mjs';
import { composeSystemPrompt } from '../src/runtime/agent/orchestrator/context/collect.mjs';
import { setInternalToolsProvider } from '../src/runtime/agent/orchestrator/internal-tools.mjs';
import { prepareAgentSession } from '../src/runtime/agent/orchestrator/agent-runtime/session-builder.mjs';
import { resolveHiddenRoleSchemaAllowedTools } from '../src/runtime/agent/orchestrator/agent-runtime/agent-dispatch.mjs';
import { getHiddenAgent, resolveAgentSessionPermission } from '../src/runtime/agent/orchestrator/internal-agents.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
  assert(drained.length === 1 && drained[0] === 'persisted pending text', `async pending mirror should persist fallback text: ${JSON.stringify(drained)}`);
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
  // BP1~3 stay 1h (pool-stable prefix); volatile message tail is 5m for all
  // sessions — see resolveCacheStrategy docs (trace p99 gap ≈ 4.5min).
  assert(publicStrategy.system === '1h' && publicStrategy.tier3 === '1h' && publicStrategy.messages === '5m', `public cache tiers changed unexpectedly: ${JSON.stringify(publicStrategy)}`);
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

const grepOut = await executeBuiltinTool('grep', {
  pattern: ['standalone mixdog CLI/TUI coding agent', 'smoke passed'],
  path: 'scripts',
  glob: '*.mjs',
  output_mode: 'content_with_context',
  head_limit: 10,
}, root);
assertOk('grep', grepOut, /smoke\.mjs/);

const grepBracketPathOut = await executeBuiltinTool('grep', {
  pattern: 'tool-smoke',
  path: '[]',
  glob: '*.mjs',
  head_limit: 5,
}, root);
assertOk('grep path [] coerces to cwd', grepBracketPathOut, /tool-smoke\.mjs/);

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
  pattern: '**/engine.mjs',
  path: 'src',
  head_limit: 20,
}, root);
assertOk('glob explicit src', explicitSrcGlobOut, /src[\\/].*engine\.mjs/i);

const globPathOnlyOut = await executeBuiltinTool('glob', {
  path: 'scripts',
  head_limit: 200,
}, root);
assertOk('glob path-only default *', globPathOnlyOut, /tool-smoke\.mjs/i);

const grepNoPatternGlobOut = await executeBuiltinTool('grep', {
  path: 'scripts',
  glob: 'tool-smoke.mjs',
  head_limit: 5,
}, root);
assertOk('grep without pattern routes to glob', grepNoPatternGlobOut, /tool-smoke\.mjs/i);

const grepManyPatterns = [
  'tool-smoke',
  ...Array.from({ length: 20 }, (_, i) => `__tool_smoke_miss_${i}__`),
];
const grepManyPatternsOut = await executeBuiltinTool('grep', {
  pattern: grepManyPatterns,
  path: 'scripts',
  glob: '*.mjs',
  head_limit: 5,
}, root);
if (/exceeds the \d+-pattern cap/i.test(String(grepManyPatternsOut))) {
  throw new Error(`grep should truncate oversized pattern[] instead of error:\n${grepManyPatternsOut.slice(0, 400)}`);
}
assertOk('grep >10 pattern cap keeps first patterns', grepManyPatternsOut, /tool-smoke\.mjs/i);
if (!/\[capped at 10 of 21 patterns\]/.test(String(grepManyPatternsOut))) {
  throw new Error(`grep >10 patterns should emit cap note:\n${grepManyPatternsOut.slice(0, 400)}`);
}

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

const grepCountOverlapPatterns = [
  'assertOk',
  ...Array.from({ length: 8 }, (_, i) => `__count_overlap_a_${i}__`),
  'assertOk',
];
const grepCountOverlapOut = await executeBuiltinTool('grep', {
  pattern: grepCountOverlapPatterns,
  path: 'scripts/tool-smoke.mjs',
  output_mode: 'count',
}, root);
const overlapCountTotal = grepCountTotalMatches(grepCountOverlapOut);
if (overlapCountTotal !== singleCountTotal) {
  throw new Error(
    `multi-pattern count must not double-count overlapping lines (single=${singleCountTotal} overlap=${overlapCountTotal}):\n${grepCountOverlapOut.slice(0, 600)}`,
  );
}

const grepChunkContextPatterns = [
  'grepCountTotalMatches',
  ...Array.from({ length: 20 }, (_, i) => `__ctx_chunk_miss_${i}__`),
];
const grepChunkContextOut = await executeBuiltinTool('grep', {
  pattern: grepChunkContextPatterns,
  path: 'scripts',
  glob: 'tool-smoke.mjs',
  '-C': 1,
  head_limit: 30,
}, root);
if (!/\[capped at 10 of 21 patterns\]/.test(String(grepChunkContextOut))) {
  throw new Error(`oversized -C pattern[] should emit cap note:\n${grepChunkContextOut.slice(0, 500)}`);
}
if (!/tool-smoke\.mjs:\d+:/.test(String(grepChunkContextOut))) {
  throw new Error(`capped -C must emit path-prefixed match lines:\n${grepChunkContextOut.slice(0, 800)}`);
}
if (!/tool-smoke\.mjs-\d+-/.test(String(grepChunkContextOut))) {
  throw new Error(`capped -C must keep path-prefixed context lines:\n${grepChunkContextOut.slice(0, 800)}`);
}
const ctxBodyLines = String(grepChunkContextOut).split('\n').filter((l) => l && !/^\[/.test(l) && !/^\(no matches\)/.test(l));
const orphanLineOnlyContext = ctxBodyLines.some((l) => /^\d+-/.test(l));
if (orphanLineOnlyContext) {
  throw new Error(`capped -C must not leave line-only context orphans:\n${grepChunkContextOut.slice(0, 800)}`);
}
if (!/function grepCountTotalMatches/.test(String(grepChunkContextOut))) {
  throw new Error(`capped -C should include match span:\n${grepChunkContextOut.slice(0, 800)}`);
}

const findOut = await executeBuiltinTool('find', {
  query: 'tool smoke',
  path: '.',
  head_limit: 10,
}, root);
assertOk('find', findOut, /scripts[\\/]tool-smoke\.mjs/i);

// find query[] batch: fan-out must emit one section per query in caller order
// and share the broad enumeration sweep across queries (single-flight dedup).
const findBatchOut = await executeBuiltinTool('find', {
  query: ['tool smoke', 'smoke'],
  path: '.',
  head_limit: 5,
}, root);
{
  const s = String(findBatchOut);
  const iA = s.indexOf('# find tool smoke');
  const iB = s.indexOf('# find smoke');
  if (iA < 0 || iB < 0) {
    throw new Error(`find query[] must emit a section per query:\n${s.slice(0, 600)}`);
  }
  if (!(iA < iB)) {
    throw new Error(`find query[] must preserve caller order:\n${s.slice(0, 600)}`);
  }
  if (!/scripts[\\/]tool-smoke\.mjs/i.test(s)) {
    throw new Error(`find query[] sections must carry match bodies:\n${s.slice(0, 600)}`);
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

const readRegionBatchOut = await executeBuiltinTool('read', {
  path: [
    { path: 'scripts/smoke.mjs', offset: 0, limit: 2 },
    { path: 'scripts/smoke.mjs', offset: 2, limit: 2 },
  ],
}, root);
if (!/^read 2\b/m.test(String(readRegionBatchOut))
  || (String(readRegionBatchOut).match(/scripts\/smoke\.mjs \[full\] \[ok\]/g) || []).length < 2
  || !/1→import \{ spawnSync \}/.test(String(readRegionBatchOut))
  || !/3→import \{ fileURLToPath \}/.test(String(readRegionBatchOut))
  || !/(pass offset:2 to continue|ONE window: offset:2, limit:\d+)/.test(String(readRegionBatchOut))
  || !/(pass offset:4 to continue|ONE window: offset:4, limit:\d+)/.test(String(readRegionBatchOut))) {
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
if (!/^read 1\b/m.test(String(readStringifiedRegionOut)) || !/scripts\/smoke\.mjs \[full\] \[ok\]/.test(String(readStringifiedRegionOut)) || !/1→import \{ spawnSync \}/.test(String(readStringifiedRegionOut))) {
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

const graphOut = await executeCodeGraphTool('code_graph', {
  mode: 'symbols',
  file: 'scripts/smoke.mjs',
}, root);
assertOk('code_graph', graphOut, /binding|spawnSync|symbol/i);
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
  cwd: root,
  timeout: 30_000,
  shell: 'powershell',
}, root);

const shellFailOutPromise = executeBuiltinTool('shell', {
  command: 'Write-Error "tool-smoke-bash-fail"; exit 7',
  cwd: root,
  timeout: 30_000,
  shell: 'powershell',
}, root);

const shellTimeoutOutPromise = executeBuiltinTool('shell', {
  command: 'Start-Sleep -Seconds 2; Write-Output tool-smoke-timeout-missed',
  cwd: root,
  timeout: 500,
  shell: 'powershell',
}, root);

const shellWorkdirOutPromise = executeBuiltinTool('shell', {
  command: 'Get-Location | Select-Object -ExpandProperty Path',
  workdir: resolve(root, 'scripts'),
  timeout: 30_000,
  shell: 'powershell',
}, root);

const shellOut = await shellOutPromise;
assertOk('bash explicit shell/cwd', shellOut, /v\d+\.\d+\.\d+/);

const shellFailOut = await shellFailOutPromise;
if (!/^Error[\s:[]/.test(String(shellFailOut)) || !/\[shell-run-failed\]/.test(String(shellFailOut)) || !/\[exit code: 7\]/.test(String(shellFailOut))) {
  throw new Error(`bash non-zero exit must be classified as shell-run-failed Error:\n${shellFailOut}`);
}

const shellTimeoutOut = await shellTimeoutOutPromise;
if (!/^Error[\s:[]/.test(String(shellTimeoutOut)) || !/\[shell-run-failed\]/.test(String(shellTimeoutOut)) || !/\[timeout: 500ms\b/.test(String(shellTimeoutOut))) {
  throw new Error(`bash timeout must be milliseconds and classified as shell-run-failed Error:\n${shellTimeoutOut}`);
}

const shellArgFailOut = await executeBuiltinTool('shell', {
  command: '',
  cwd: root,
  shell: 'powershell',
}, root);
if (!/^Error[\s:[]/.test(String(shellArgFailOut)) || !/\[shell-tool-failed\]/.test(String(shellArgFailOut))) {
  throw new Error(`shell tool/preflight failures must be classified as shell-tool-failed Error:\n${shellArgFailOut}`);
}

// Auto-promotion: a sync foreground command still running past the (soft)
// promotion budget is detached into a tracked background task and returns the
// same task_id envelope as explicit async — the caller never pre-chose async.
// Shrink the budget via MIXDOG_SHELL_AUTO_BACKGROUND_MS so the smoke stays fast.
const _priorAutoBgBudget = process.env.MIXDOG_SHELL_AUTO_BACKGROUND_MS;
process.env.MIXDOG_SHELL_AUTO_BACKGROUND_MS = '800';
let shellAutoPromoteOut;
try {
  shellAutoPromoteOut = await executeBuiltinTool('shell', {
    command: 'Start-Sleep -Seconds 6; Write-Output tool-smoke-autopromote-done',
    cwd: root,
    timeout: 30_000,
    shell: 'powershell',
  }, root);
} finally {
  if (_priorAutoBgBudget === undefined) delete process.env.MIXDOG_SHELL_AUTO_BACKGROUND_MS;
  else process.env.MIXDOG_SHELL_AUTO_BACKGROUND_MS = _priorAutoBgBudget;
}
if (!/auto-backgrounded/i.test(String(shellAutoPromoteOut)) || !/task_id:\s*\S+/i.test(String(shellAutoPromoteOut))) {
  throw new Error(`shell auto-promotion must return a background task envelope (task_id + auto-backgrounded):\n${shellAutoPromoteOut}`);
}
// Clean up the promoted job so it doesn't outlive the smoke as an orphan.
const _autoPromoteTaskId = (/task_id:\s*(\S+)/i.exec(String(shellAutoPromoteOut)) || [])[1];
if (_autoPromoteTaskId) {
  try { await executeBuiltinTool('task', { action: 'cancel', task_id: _autoPromoteTaskId }, root); } catch {}
}

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
if (literalBackslashPipeArray) {
  throw new Error(`grep array literal \\| should be allowed: ${literalBackslashPipeArray}`);
}

const grepContextPolicyArgs = { pattern: 'smoke', path: root, context: GREP_CONTEXT_MAX + 999 };
applyGrepContextLeadPolicy(grepContextPolicyArgs);
if (grepContextPolicyArgs['-C'] !== GREP_CONTEXT_MAX || Object.prototype.hasOwnProperty.call(grepContextPolicyArgs, 'context')) {
  throw new Error(`grep context policy must canonicalize and clamp explicit context: ${JSON.stringify(grepContextPolicyArgs)}`);
}

// Multiple absolute paths in one string are now auto-split into a path array
// (arg-guard splitMultipleAbsoluteWindowsPaths) instead of rejected.
const multiGrepPathArgs = {
  pattern: 'providerStatus',
  path: 'C:\\Project\\mixdog\\src\\tui C:\\Project\\mixdog\\src\\mixdog-session-runtime.mjs',
};
const multiGrepPathErr = validateBuiltinArgs('grep', multiGrepPathArgs);
if (multiGrepPathErr) {
  throw new Error(`grep multi-path auto-split should pass validation: ${multiGrepPathErr}`);
}
if (!Array.isArray(multiGrepPathArgs.path) || multiGrepPathArgs.path.length !== 2) {
  throw new Error(`grep multi-path auto-split should coerce to 2-element array: ${JSON.stringify(multiGrepPathArgs.path)}`);
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

// Windows drive path + no explicit shell used to be rejected with a retry hint;
// the guard now auto-coerces to shell:'powershell' (drive paths are a definitive
// powershell signal — they can never work under Git Bash unconverted).
const shellDrivePathArgs = {
  command: 'cd C:\\Project\\mixdog && node scripts/build-tui.mjs',
};
const shellDrivePathErr = validateBuiltinArgs('shell', shellDrivePathArgs);
if (process.platform === 'win32') {
  if (shellDrivePathErr !== null) {
    throw new Error(`shell Windows-path auto-coercion failed: ${shellDrivePathErr}`);
  }
  if (shellDrivePathArgs.shell !== 'powershell') {
    throw new Error(`shell Windows-path auto-coercion did not set shell:'powershell' (got ${JSON.stringify(shellDrivePathArgs.shell)})`);
  }
}

const invalidShellCwdAliasConflict = validateBuiltinArgs('shell', {
  command: 'pwd',
  cwd: root,
  workdir: resolve(root, 'scripts'),
  shell: 'powershell',
});
if (!/cwd.*workdir.*conflict/i.test(invalidShellCwdAliasConflict || '')) {
  throw new Error(`shell cwd/workdir conflict guard failed: ${invalidShellCwdAliasConflict}`);
}

const shellWorkdirOut = await shellWorkdirOutPromise;
assertOk('shell workdir alias', shellWorkdirOut, /scripts\s*$/i);

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
  EXPLORE_TOOL,
  AGENT_TOOL,
  SKILL_TOOL,
  TOOL_SEARCH_TOOL,
].filter(Boolean);

const fullDefaults = defaultDeferredToolNames(smokeCatalog, 'full');
if (fullDefaults.size !== 10) {
  throw new Error(`full default surface should stay 10 tools, got ${fullDefaults.size}: ${[...fullDefaults].join(', ')}`);
}
for (const name of ['read', 'code_graph', 'grep', 'find', 'glob', 'list', 'apply_patch', 'explore', 'Skill', 'load_tool']) {
  assertHas(fullDefaults, name);
}
for (const name of ['shell', 'task', 'agent', 'recall', 'search', 'web_fetch', 'cwd']) {
  assertLacks(fullDefaults, name);
}

const leadDefaults = defaultDeferredToolNames(smokeCatalog, 'lead');
if (leadDefaults.size !== 16) {
  throw new Error(`lead default surface should stay 16 tools for this static catalog, got ${leadDefaults.size}: ${[...leadDefaults].join(', ')}`);
}
for (const name of ['read', 'code_graph', 'grep', 'find', 'glob', 'list', 'shell', 'task', 'apply_patch', 'explore', 'agent', 'recall', 'search', 'web_fetch', 'Skill', 'load_tool']) {
  assertHas(leadDefaults, name);
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
if (readonlyDefaults.size !== 9) {
  throw new Error(`readonly default surface should stay 9 tools, got ${readonlyDefaults.size}: ${[...readonlyDefaults].join(', ')}`);
}
for (const name of ['read', 'code_graph', 'grep', 'find', 'glob', 'list', 'explore', 'Skill', 'load_tool']) {
  assertHas(readonlyDefaults, name);
}
for (const name of ['apply_patch', 'agent', 'shell']) {
  assertLacks(readonlyDefaults, name);
}

const agentProps = AGENT_TOOL.inputSchema?.properties || {};
if (agentProps.mode || agentProps.wait) throw new Error('agent schema should not expose execution mode controls');
{
  const heavyPrompt = composeSystemPrompt({
    agent: 'heavy-worker',
    provider: 'anthropic-oauth',
    agentRules: '# Tool Use',
    skillManifest: '',
  });
  if (!heavyPrompt.stableSystemContext.includes('## heavy-worker')) {
    throw new Error(`heavy-worker AGENT.md must be included in scoped role instructions: ${heavyPrompt.stableSystemContext}`);
  }
  const workerPrompt = composeSystemPrompt({
    agent: 'worker',
    provider: 'anthropic-oauth',
    agentRules: '# Tool Use',
    skillManifest: '',
  });
  if (!workerPrompt.stableSystemContext.includes('## worker')) {
    throw new Error(`worker AGENT.md must be included in scoped role instructions: ${workerPrompt.stableSystemContext}`);
  }
}
{
  const shorthand = parseHeadlessRoleCommand(['reviewer', 'check', 'this']);
  if (shorthand?.agent !== 'reviewer' || shorthand?.message !== 'check this') {
    throw new Error(`headless shorthand command parse failed: ${JSON.stringify(shorthand)}`);
  }
  const explicit = parseHeadlessRoleCommand(['role', 'debug', 'trace', 'failure']);
  if (!explicit?.error || !/mixdog <role> <message/.test(explicit.error)) {
    throw new Error(`headless role subcommand must be rejected: ${JSON.stringify(explicit)}`);
  }
  const tuiDefault = parseHeadlessRoleCommand([]);
  if (tuiDefault !== null) {
    throw new Error(`empty argv must keep TUI default: ${JSON.stringify(tuiDefault)}`);
  }
  const modelOnlySpawn = buildHeadlessSpawnArgs({
    agent: 'reviewer',
    tag: 'headless-smoke',
    cwd: root,
    message: 'check this',
    model: 'haiku',
  });
  if (modelOnlySpawn.model !== 'haiku' || modelOnlySpawn.provider) {
    throw new Error(`headless model-only route must preserve --model without forcing provider: ${JSON.stringify(modelOnlySpawn)}`);
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
const prevChannelDaemon = process.env.MIXDOG_CHANNEL_DAEMON;
const prevChannelSingleton = process.env.MIXDOG_CHANNEL_SINGLETON;
const prevChannelWorkerProcess = process.env.MIXDOG_CHANNEL_WORKER_PROCESS;
const prevRuntimeRoot = process.env.MIXDOG_RUNTIME_ROOT;
const prevEnvOut = process.env.SMOKE_CHANNEL_ENV_OUT;
const prevDaemonEntry = process.env.MIXDOG_CHANNEL_DAEMON_ENTRY;
try {
  // Daemon-mode worker env coverage: start() spawn-or-attaches the machine
  // -global daemon (the stub daemon entry — no Discord token) instead of
  // forking `entry`, so assert the flags on the SPAWNED DAEMON's env (the stub
  // dumps them to SMOKE_CHANNEL_ENV_OUT). The old fork-path env assertion died
  // with the fork path itself; full flip/attach coverage lives in
  // scripts/channel-daemon-smoke.mjs.
  const stubEntry = join(root, 'scripts', 'channel-daemon-stub.mjs');
  const dataDir = join(channelWorkerTmp, 'data');
  const runtimeDir = join(channelWorkerTmp, 'runtime');
  const envOut = join(channelWorkerTmp, 'env.json');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  process.env.MIXDOG_CHANNEL_DAEMON = '1';
  process.env.MIXDOG_CHANNEL_SINGLETON = '1';
  process.env.MIXDOG_CHANNEL_WORKER_PROCESS = '1';
  process.env.MIXDOG_RUNTIME_ROOT = runtimeDir;
  process.env.SMOKE_CHANNEL_ENV_OUT = envOut;
  process.env.MIXDOG_CHANNEL_DAEMON_ENTRY = stubEntry;
  channelEnvWorker = createStandaloneChannelWorker({
    entry: stubEntry,
    rootDir: root,
    dataDir,
    cwd: root,
  });
  await channelEnvWorker.start();
  const childEnv = JSON.parse(readFileSync(envOut, 'utf8'));
  if (childEnv.daemon !== '1') {
    throw new Error(`channel daemon smoke expected daemon=1, got ${childEnv.daemon}`);
  }
  if (childEnv.cliOwned !== '0') {
    throw new Error(`channel daemon must advertise owner HTTP (MIXDOG_CLI_OWNED=0), got ${childEnv.cliOwned}`);
  }
} finally {
  try { await channelEnvWorker?.stop?.('channel-worker-env-smoke', { force: true }); } catch {}
  if (prevChannelDaemon == null) delete process.env.MIXDOG_CHANNEL_DAEMON;
  else process.env.MIXDOG_CHANNEL_DAEMON = prevChannelDaemon;
  if (prevChannelSingleton == null) delete process.env.MIXDOG_CHANNEL_SINGLETON;
  else process.env.MIXDOG_CHANNEL_SINGLETON = prevChannelSingleton;
  if (prevChannelWorkerProcess == null) delete process.env.MIXDOG_CHANNEL_WORKER_PROCESS;
  else process.env.MIXDOG_CHANNEL_WORKER_PROCESS = prevChannelWorkerProcess;
  if (prevRuntimeRoot == null) delete process.env.MIXDOG_RUNTIME_ROOT;
  else process.env.MIXDOG_RUNTIME_ROOT = prevRuntimeRoot;
  if (prevEnvOut == null) delete process.env.SMOKE_CHANNEL_ENV_OUT;
  else process.env.SMOKE_CHANNEL_ENV_OUT = prevEnvOut;
  if (prevDaemonEntry == null) delete process.env.MIXDOG_CHANNEL_DAEMON_ENTRY;
  else process.env.MIXDOG_CHANNEL_DAEMON_ENTRY = prevDaemonEntry;
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
if (EXPLORE_TOOL.annotations?.readOnlyHint !== true || EXPLORE_TOOL.annotations?.destructiveHint === true) {
  throw new Error('explore must stay read-only so readonly surfaces can use it');
}
if (EXPLORE_TOOL.annotations?.agentHidden === true) {
  throw new Error('explore must stay visible to agent sessions');
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
const exploreProps = EXPLORE_TOOL.inputSchema?.properties || {};
if (!/broad\/uncertain/i.test(EXPLORE_TOOL.description || '') || !/machine-wide/i.test(EXPLORE_TOOL.description || '') || !/independent targets/i.test(EXPLORE_TOOL.description || '') || (EXPLORE_TOOL.description || '').length > 600) {
  throw new Error('explore description must keep the locator + facet fan-out contract');
}
if (!/Narrow locator query/i.test(exploreProps.query?.description || '') || !/independent facets/i.test(exploreProps.query?.description || '') || !/Project\/root/i.test(exploreProps.cwd?.description || '')) {
  throw new Error('explore schema must stay compact and preserve query/cwd shape');
}
const normalizedExplore = normalizeExploreQueries('["where is model selection?","  ","which file owns agent async?"]');
if (normalizedExplore.length !== 2 || normalizedExplore[0] !== 'where is model selection?') {
  throw new Error(`explore query normalization failed: ${JSON.stringify(normalizedExplore)}`);
}
if (MAX_FANOUT_QUERIES !== 8) throw new Error(`explore fanout cap changed: ${MAX_FANOUT_QUERIES}`);
const explorerPrompt = buildExplorerPrompt('where is <agent> & status?');
if (explorerPrompt !== '<query>where is &lt;agent&gt; &amp; status?</query>') {
  throw new Error(`explorer prompt contract failed: ${explorerPrompt}`);
}
if (/Reminder:|BUDGET|STOP and answer|verdicts|ratings|recommendations|grep|code_graph|find|glob/i.test(explorerPrompt)) {
  throw new Error(`explorer prompt must not duplicate the system routing/fan-out contract: ${explorerPrompt}`);
}
setInternalToolsProvider({
  executor: async () => 'tool-smoke internal tool',
  tools: [
    EXPLORE_TOOL,
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
      const systemVisible = (agentSkillSession.messages || [])
        .filter((m) => m?.role === 'system')
        .map((m) => String(m.content || ''))
        .join('\n');
      // Agent (Pool B/C) sessions FREEZE the Skill meta-tool into the schema
      // unconditionally so the tool bytes stay bit-identical across roles/cwds
      // (provider cache shard stability). The BP1 manifest rides alongside it
      // so the model knows which Skill names exist — a loader without the
      // manifest cannot be targeted. Both must be present together.
      if (!/available-skills/i.test(systemVisible) || !/demo-skill/i.test(systemVisible) || !/Skill\(\{"name":"<skill-name>"\}\)/.test(systemVisible)) {
        throw new Error(`agent BP1 must carry the compact skill manifest alongside the frozen Skill tool: ${systemVisible.slice(0, 1200)}`);
      }
      if (!/# Tool Use/i.test(systemVisible) || !/# Agent Constraints/i.test(systemVisible)) {
        throw new Error(`agent system layers must carry BP1 tool policy and BP2 role rules: ${systemVisible.slice(0, 1200)}`);
      }
      const agentSkillToolNames = (agentSkillSession.tools || []).map((tool) => tool?.name).filter(Boolean);
      if (!agentSkillToolNames.includes('Skill')) {
        throw new Error(`read-write agent schema must expose Skill loader with the manifest: ${agentSkillToolNames.join(', ')}`);
      }
    } finally {
      closeSession(agentSkillSession.id, 'tool-smoke');
    }
  } finally {
    rmSync(skillManifestTmp, { recursive: true, force: true });
  }
  const explorerSession = createSession({
    provider: 'openai-oauth',
    model: 'tool-smoke-model',
    owner: AGENT_OWNER,
    agent: 'explorer',
    cwd: root,
    permission: 'read',
    skipSkills: true,
    schemaAllowedTools: ['code_graph', 'find', 'glob', 'list', 'grep', 'read'],
  });
  try {
    const visible = (explorerSession.messages || []).map((m) => String(m.content || '')).join('\n');
    const systemVisible = (explorerSession.messages || [])
      .filter((m) => m?.role === 'system')
      .map((m) => String(m.content || ''))
      .join('\n');
    const userReminderVisible = (explorerSession.messages || [])
      .filter((m) => m?.role === 'user')
      .map((m) => String(m.content || ''))
      .join('\n');
    if (!/Read-only retrieval role/i.test(visible) || /# environment/i.test(visible) || /git operations deferred to Lead/i.test(visible)) {
      throw new Error(`explorer hidden retrieval context should stay slim: ${visible.slice(0, 1200)}`);
    }
    if (!/# Role: explorer/i.test(systemVisible) || /# Role: explorer/i.test(userReminderVisible) || !/only WHERE/i.test(systemVisible)) {
      throw new Error(`explorer role md must ride BP2 system, not BP3 user reminder: system=${systemVisible.slice(0, 600)} user=${userReminderVisible.slice(0, 600)}`);
    }
    // System layers (BP1 tool policy + BP2 role md) are shared/frozen and sized
    // elsewhere; the slimness cap guards only the per-session injected layers
    // (BP3 user reminder etc.), so measure non-system messages only.
    const injectedVisible = (explorerSession.messages || [])
      .filter((m) => m?.role !== 'system')
      .map((m) => String(m.content || ''))
      .join('\n');
    const injectedBytes = Buffer.byteLength(injectedVisible, 'utf8');
    if (injectedBytes > 1800) {
      throw new Error(`explorer hidden retrieval context too large: ${injectedBytes} bytes (injected layers only)`);
    }
  } finally {
    closeSession(explorerSession.id, 'tool-smoke');
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
      throw new Error(`agent skill manifest must stay in system BP1, not user reminders: ${userReminderVisible.slice(0, 1200)}`);
    }
    if (/(^|\n)# environment/i.test(visible)) {
      throw new Error(`agent context must not inject environment reminder: ${visible.slice(0, 1200)}`);
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
  const publicExploreSession = createSession({
    provider: 'openai-oauth',
    model: 'tool-smoke-model',
    owner: AGENT_OWNER,
    role: 'explore',
    cwd: root,
    permission: 'read',
  });
  try {
    const readTools = (readAgentSession.tools || []).map((tool) => tool?.name).filter(Boolean);
    const writeTools = (writeAgentSession.tools || []).map((tool) => tool?.name).filter(Boolean);
    const fullTools = (fullAgentSession.tools || []).map((tool) => tool?.name).filter(Boolean);
    const publicExploreTools = (publicExploreSession.tools || []).map((tool) => tool?.name).filter(Boolean);
    // Read-role AGENT sessions carry shell/task so review/debug agents can run
    // their own verification (build/test); the plain readonly preset (public
    // explore role) still omits them.
    const expectedReadTools = ['code_graph', 'find', 'glob', 'list', 'grep', 'read', 'shell', 'task', 'explore', 'search', 'web_fetch', 'Skill'];
    const expectedPublicReadTools = ['code_graph', 'find', 'glob', 'list', 'grep', 'read', 'explore', 'search', 'web_fetch', 'Skill'];
    const expectedWriteTools = ['code_graph', 'find', 'glob', 'list', 'grep', 'read', 'apply_patch', 'shell', 'task', 'explore', 'search', 'web_fetch', 'Skill'];
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
      if (publicExploreTools.includes(name)) {
        throw new Error(`public explore role must omit ${name}: explore=${publicExploreTools.join(', ')}`);
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
    if (!readTools.includes('explore') || !writeTools.includes('explore')) {
      throw new Error(`read/read-write agent schemas must expose explore: read=${readTools.join(', ')} write=${writeTools.join(', ')}`);
    }
    if (!fullTools.includes('shell')) {
      throw new Error(`full agent schema must retain shell: full=${fullTools.join(', ')}`);
    }
    if (!fullTools.includes('explore')) {
      throw new Error(`full agent schema must expose explore: full=${fullTools.join(', ')}`);
    }
    // The explore wrapper stays IN the schema for every read role — including
    // the explore agent itself. Recursion is broken at call time in
    // pre-dispatch-deny.mjs via recursiveWrapperToolNameForPublicAgent, not by
    // schema stripping. (Read AGENT sessions add shell/task on top, so the
    // public explore bundle is its own cache group now.)
    if (JSON.stringify(publicExploreTools) !== JSON.stringify(expectedPublicReadTools)) {
      throw new Error(`public explore role must ship the readonly bundle (incl. explore): expected=${expectedPublicReadTools.join(', ')} actual=${publicExploreTools.join(', ')}`);
    }
    if (recursiveWrapperToolNameForPublicAgent('explore') !== 'explore') {
      throw new Error('call-time anti-recursion must map public explore agent to its own wrapper tool');
    }
  } finally {
    closeSession(readAgentSession.id, 'tool-smoke');
    closeSession(writeAgentSession.id, 'tool-smoke');
    closeSession(fullAgentSession.id, 'tool-smoke');
    closeSession(publicExploreSession.id, 'tool-smoke');
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
    const expectedWriteTools = ['code_graph', 'find', 'glob', 'list', 'grep', 'read', 'apply_patch', 'shell', 'task', 'explore', 'search', 'web_fetch', 'Skill'];
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
    if (permission === 'read') return ['code_graph', 'find', 'glob', 'list', 'grep', 'read', 'explore', 'search', 'web_fetch'];
    if (permission === 'read-write') return ['code_graph', 'find', 'glob', 'list', 'grep', 'read', 'apply_patch', 'explore', 'search', 'web_fetch'];
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
      if (/effective-cwd|Override cwd|# environment|# task-brief/i.test(systemVisible)) {
        throw new Error(`hidden agent ${agent} must not carry cwd/environment/task-brief injection`);
      }
    } finally {
      closeSession(session.id, 'tool-smoke');
    }
  }
}
const patchTool = PATCH_TOOL_DEFS[0];
const patchDescription = patchTool?.inputSchema?.properties?.patch?.description || '';
if (!/V4A/i.test(patchDescription) || !/one (?:file )?block per target file/i.test(patchDescription) || !/exact current context/i.test(patchDescription)) {
  throw new Error('apply_patch JSON fallback schema must keep V4A, per-target block, and exact-context guidance');
}
if (!/FREEFORM tool/i.test(patchTool?.freeformDescription || '') || patchTool?.freeform?.type !== 'grammar' || patchTool?.freeform?.syntax !== 'lark') {
  throw new Error(`apply_patch must expose freeform grammar metadata: ${JSON.stringify(patchTool)}`);
}
for (const requiredGrammarLine of [
  'start: begin_patch hunk+ end_patch',
  'add_hunk: "*** Add File: " filename LF add_line+',
  'change_move: "*** Move to: " filename LF',
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
  if (!/FREEFORM tool/i.test(wirePatchTool.description || '')) {
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
const readPathSchema = BUILTIN_TOOLS.find((tool) => tool.name === 'read')?.inputSchema?.properties?.path || {};
const readPathDescription = readPathSchema.description || '';
if (!/\{path,offset,limit\}\[\]/i.test(readPathDescription) || !/real arrays/i.test(readPathDescription)) {
  throw new Error('read schema must keep directory-vs-file guidance');
}
if (!/Not for director/i.test((BUILTIN_TOOLS.find((tool) => tool.name === 'read')?.description) || '')) {
  throw new Error('read description must keep directory-vs-file guidance');
}
const readTool = BUILTIN_TOOLS.find((tool) => tool.name === 'read');
const readDescription = readTool?.description || '';
const readProps = readTool?.inputSchema?.properties || {};
const readArraySchema = readPathSchema.anyOf?.find((entry) => entry?.type === 'array');
const readArrayItemAnyOf = readArraySchema?.items?.anyOf || [];
if (!readArrayItemAnyOf.some((entry) => entry?.type === 'object' && entry?.properties?.offset && entry?.properties?.limit)) {
  throw new Error('read schema must expose array-of-region objects for batched spans');
}
if (/line\+context/i.test(readDescription) || !/Read file contents/i.test(readDescription) || !/\{path,offset,limit\}\[\]/i.test(readDescription)) {
  throw new Error('read description must expose offset/limit as the single window form');
}
if (readProps.line || readProps.context) {
  throw new Error('read schema must not expose legacy line/context window fields');
}
if (readProps.offset?.minimum !== 0 || !/Lines to skip/i.test(readProps.offset?.description || '') || !/Max lines/i.test(readProps.limit?.description || '')) {
  throw new Error('read offset schema must describe Mixdog paging cursor semantics');
}
if (/line\/context/i.test(JSON.stringify(readTool?.inputSchema || {}))) {
  throw new Error('read schema surface must not mention legacy line/context');
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
  const engineSrc = [readMjsSources('src/tui/engine.mjs'), readMjsSources('src/tui/engine')].join('\n');
  if (/setRoute\(\{ model: m \}, \{ applyToCurrentSession: true \}\)/.test(engineSrc)) {
    throw new Error('TUI setModel must not force applyToCurrentSession:true (model changes must apply to the next session only)');
  }
  if (!/routeOpts\.applyToCurrentSession === true/.test(engineSrc)) {
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
if (!/Repo code structure/i.test(codeGraphDescription) || !/find_symbol\/symbol_search\/search\/references\/callers\/callees/i.test(codeGraphDescription)) {
  throw new Error('code_graph description must stay structure-oriented and name its symbol modes');
}
if (!/take files\[\]/i.test(codeGraphDescription) || !/Batch targets per mode/i.test(codeGraphDescription)) {
  throw new Error('code_graph description must route unknown file paths through locators first');
}
if (!/files\[\]/i.test(codeGraphProps.mode?.description || '') || !/Source file path/i.test(codeGraphProps.files?.description || '')) {
  throw new Error('code_graph schema must keep compact, repo-local field descriptions');
}
const recallTool = MEMORY_TOOL_DEFS.find((tool) => tool.name === 'recall');
const recallProps = recallTool?.inputSchema?.properties || {};
if (!/prior-work context/i.test(recallTool?.description || '') || !recallProps.id?.anyOf || !/Do not invent ids/i.test(recallProps.id?.description || '')) {
  throw new Error('recall schema must preserve scoped prior-context guidance and id lookup shape');
}
if (!/array for independent fan-out/i.test(recallProps.query?.description || '') || !/Project pool selector/i.test(recallProps.projectScope?.description || '')) {
  throw new Error('recall schema must explain fan-out query and project scope filters');
}
// Cross-session / raw recall surface: includeMembers stays a chunk-member
// output knob, includeRaw exposes unchunked raw/episode turns, and sessionOnly
// is the explicit opt-in that restores the old single-session hard scope.
if (!/chunk members/i.test(recallProps.includeMembers?.description || '') || !/does not widen the search pool/i.test(recallProps.includeMembers?.description || '')) {
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
const searchTool = SEARCH_TOOL_DEFS.find((tool) => tool.name === 'search');
const searchProps = searchTool?.inputSchema?.properties || {};
if (!/Runs synchronously/i.test(searchTool?.description || '') || searchProps.mode || searchProps.action || searchProps.task_id || !searchProps.query?.anyOf || !/array for fan-out/i.test(searchProps.query?.description || '')) {
  throw new Error('search schema must preserve sync execution guidance and string/array query shape');
}
if (!/Default web/i.test(searchProps.type?.description || '') || !/locale hint/i.test(searchProps.locale?.description || '') || !/Default low/i.test(searchProps.contextSize?.description || '')) {
  throw new Error('search schema must describe type, locale, and contextSize defaults');
}
const webFetchTool = SEARCH_TOOL_DEFS.find((tool) => tool.name === 'web_fetch');
const webFetchProps = webFetchTool?.inputSchema?.properties || {};
if (!/Use after search/i.test(webFetchTool?.description || '') || !webFetchProps.url?.anyOf || !/array of URLs/i.test(webFetchProps.url?.description || '')) {
  throw new Error('web_fetch schema must preserve after-search guidance and string/array url shape');
}
if (!/offset/i.test(webFetchProps.startIndex?.description || '') || !/Maximum characters/i.test(webFetchProps.maxLength?.description || '')) {
  throw new Error('web_fetch schema must describe paging window fields');
}
if (!/deferred tools/i.test(TOOL_SEARCH_TOOL.description || '')
  || !TOOL_SEARCH_TOOL.inputSchema?.properties?.names
  || !TOOL_SEARCH_TOOL.inputSchema?.properties?.select) {
  throw new Error('load_tool schema must preserve loader guidance plus names + legacy select fields');
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
  tools: smokeCatalog.filter((tool) => fullDefaults.has(tool?.name)),
  deferredToolCatalog: smokeCatalog.slice(),
  deferredSelectedTools: [...fullDefaults],
  deferredDiscoveredTools: [],
  deferredProviderMode: 'native',
  deferredNativeTools: true,
};
const nativeSelectResult = JSON.parse(__renderToolSearchForTest({ select: 'shell,recall' }, nativeToolSearchSession, 'full'));
if (nativeSelectResult.activeTools.includes('shell') || nativeSelectResult.activeTools.includes('recall')) {
  throw new Error(`native tool_search must not mutate active tool schemas: ${JSON.stringify(nativeSelectResult)}`);
}
for (const name of ['shell', 'task', 'recall']) {
  if (!nativeSelectResult.discoveredTools.includes(name)) {
    throw new Error(`native tool_search missing discovered ${name}: ${JSON.stringify(nativeSelectResult)}`);
  }
}
if (!nativeSelectResult.nativeToolSearch?.openaiTools?.some((tool) => tool?.name === 'shell' && tool?.defer_loading === true)) {
  throw new Error(`native tool_search must return OpenAI loadable deferred tools: ${JSON.stringify(nativeSelectResult.nativeToolSearch)}`);
}
if (!nativeSelectResult.nativeToolSearch?.toolReferences?.includes('shell')) {
  throw new Error(`native tool_search must return Anthropic tool references: ${JSON.stringify(nativeSelectResult.nativeToolSearch)}`);
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
const nativeGrokPatchSearchSession = {
  provider: 'grok-oauth',
  tools: smokeCatalog.filter((tool) => fullDefaults.has(tool?.name) && tool?.name !== 'apply_patch'),
  deferredToolCatalog: smokeCatalog.slice(),
  deferredSelectedTools: [...fullDefaults].filter((name) => name !== 'apply_patch'),
  deferredDiscoveredTools: [],
  deferredProviderMode: 'native',
  deferredNativeTools: true,
};
const nativeGrokPatchSelectResult = JSON.parse(__renderToolSearchForTest({ select: 'apply_patch' }, nativeGrokPatchSearchSession, 'full'));
const nativeGrokPatchTool = nativeGrokPatchSelectResult.nativeToolSearch?.openaiTools?.find((tool) => tool?.name === 'apply_patch');
if (nativeGrokPatchTool?.type !== 'function' || nativeGrokPatchTool?.format || nativeGrokPatchTool?.defer_loading !== true) {
  throw new Error(`Grok native tool_search apply_patch must use JSON function schema, not OpenAI custom: ${JSON.stringify(nativeGrokPatchTool)}`);
}
if (nativeGrokPatchTool.parameters?.properties?.patch?.type !== 'string') {
  throw new Error(`Grok native tool_search apply_patch must preserve patch JSON schema: ${JSON.stringify(nativeGrokPatchTool)}`);
}
// Native query-select discovers (without mutating active schemas); aliases expand.
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
  if (!nativeSelectQueryResult.discoveredTools.includes(name)) {
    throw new Error(`native tool_search query-select should discover ${name}: ${JSON.stringify(nativeSelectQueryResult)}`);
  }
}
if (nativeSelectQueryResult.activeTools.includes('search') || nativeSelectQueryResult.activeTools.includes('web_fetch')) {
  throw new Error(`native tool_search must not mutate active schemas: ${JSON.stringify(nativeSelectQueryResult)}`);
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
const bp1ManifestSession = {
  messages: [{ role: 'system', content: 'BASE PROMPT' }],
  deferredToolCatalog: [
    { name: 'shell', description: 'Run commands.' },
    { name: 'recall', description: 'Recall prior work.' },
  ],
};
applyInitialDeferredToolManifestToBp1(bp1ManifestSession, ['shell', 'recall']);
const bp1ManifestText = bp1ManifestSession.messages[0].content;
if (!/- shell: Run commands\./.test(bp1ManifestText) || !/- recall: Recall prior work\./.test(bp1ManifestText)) {
  throw new Error(`BP1 deferred manifest must carry catalog descriptions: ${bp1ManifestText}`);
}
if (bp1ManifestSession.deferredToolBp1Applied !== true) {
  throw new Error('BP1 deferred manifest injection must mark deferredToolBp1Applied');
}
const replyTool = CHANNEL_TOOL_DEFS.find((tool) => tool.name === 'reply');
if (!/configured channel/i.test(replyTool?.description || '') || !/local .*paths/i.test(replyTool?.inputSchema?.properties?.files?.description || '')) {
  throw new Error('channel reply schema must describe target channel and attachment paths');
}
const fetchTool = CHANNEL_TOOL_DEFS.find((tool) => tool.name === 'fetch');
if (!/NOT for URLs/i.test(fetchTool?.description || '') || !/web_fetch/i.test(fetchTool?.description || '')) {
  throw new Error('channel fetch schema must distinguish Discord fetch from web_fetch');
}
const grepTool = BUILTIN_TOOLS.find((tool) => tool.name === 'grep');
const grepPatternDescription = grepTool?.inputSchema?.properties?.pattern?.description || '';
const grepPathDescription = grepTool?.inputSchema?.properties?.path?.description || '';
const grepGlobDescription = grepTool?.inputSchema?.properties?.glob?.description || '';
const grepOutputModeDescription = grepTool?.inputSchema?.properties?.output_mode?.description || '';
const grepHeadLimitDescription = grepTool?.inputSchema?.properties?.head_limit?.description || '';
if (!/pattern\[\] batches variants/i.test(grepPatternDescription) || !/File\/dir scope/i.test(grepPathDescription)) {
  throw new Error('grep schema must keep compact pattern/path guidance');
}
if (!/content search/i.test(grepTool?.description || '')) {
  throw new Error('grep description must state its content-search contract');
}
if (!/Glob filter/i.test(grepGlobDescription)) {
  throw new Error('grep glob schema must describe scope narrowing');
}
if (!/files_with_matches\/count/i.test(grepOutputModeDescription) || !/content_with_context/i.test(grepOutputModeDescription)) {
  throw new Error('grep output_mode schema must name its output shapes');
}
if (grepTool?.inputSchema?.properties?.head_limit?.minimum !== 0 || !/Max results/i.test(grepHeadLimitDescription)) {
  throw new Error('grep head_limit schema must keep locator caps explicit');
}
if (grepTool?.inputSchema?.properties?.type) {
  throw new Error('grep type schema must stay hidden; prefer glob for extension narrowing');
}
const globTool = BUILTIN_TOOLS.find((tool) => tool.name === 'glob');
const findTool = BUILTIN_TOOLS.find((tool) => tool.name === 'find');
const listTool = BUILTIN_TOOLS.find((tool) => tool.name === 'list');
if (!/exact glob patterns/i.test(globTool?.description || '')) {
  throw new Error('glob description must route exact-pattern unknown paths before read/grep/list');
}
if (!/unknown partial paths\/names/i.test(findTool?.description || '') || !/verifies paths for grep\/glob/i.test(findTool?.description || '')) {
  throw new Error('find description must advertise unverified path/name lookup and verified outputs');
}
if (!/List directory entries/i.test(listTool?.description || '') || !/path\[\]/i.test(listTool?.inputSchema?.properties?.path?.description || '')) {
  throw new Error('list description must require verified directories and locator-first unknown dirs');
}
if (!/symbol modes use symbols\[\]/i.test(codeGraphProps.mode?.description || '') || !/symbols \(file outline\) use files\[\]/i.test(codeGraphProps.mode?.description || '') || !/one symbols\[\] call/i.test(codeGraphProps.symbols?.description || '')) {
  throw new Error('code_graph schema fields must stay compact and repo-local');
}

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
