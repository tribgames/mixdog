#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { __renderToolSearchForTest, compactToolSearchDescription, defaultDeferredToolNames, SKILL_TOOL, TOOL_SEARCH_TOOL } from '../src/mixdog-session-runtime.mjs';
import { buildExplorerPrompt, EXPLORE_TOOL, MAX_FANOUT_QUERIES, normalizeExploreQueries } from '../src/standalone/explore-tool.mjs';
import { AGENT_TOOL, createStandaloneAgent } from '../src/standalone/agent-tool.mjs';
import { createStandaloneChannelWorker } from '../src/standalone/channel-worker.mjs';
import { OpenAIOAuthProvider, buildRequestBody, sendViaHttpSse } from '../src/runtime/agent/orchestrator/providers/openai-oauth.mjs';
import { _logicalResponseItemMatch, _resolveOpenAiPromptCacheRatePolicy } from '../src/runtime/agent/orchestrator/providers/openai-oauth-ws.mjs';
import { _mergePendingMessageEntries, closeSession, createSession, drainPendingMessages, enqueuePendingMessage } from '../src/runtime/agent/orchestrator/session/manager.mjs';
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
import { validateBuiltinArgs } from '../src/runtime/agent/orchestrator/tools/builtin/arg-guard.mjs';
import { BUILTIN_TOOLS } from '../src/runtime/agent/orchestrator/tools/builtin/builtin-tools.mjs';
import { runResultCacheInFlight } from '../src/runtime/agent/orchestrator/tools/builtin/cache-layers.mjs';
import { executeCodeGraphTool } from '../src/runtime/agent/orchestrator/tools/code-graph.mjs';
import { CODE_GRAPH_TOOL_DEFS } from '../src/runtime/agent/orchestrator/tools/code-graph-tool-defs.mjs';
import { executePatchTool } from '../src/runtime/agent/orchestrator/tools/patch.mjs';
import { PATCH_TOOL_DEFS } from '../src/runtime/agent/orchestrator/tools/patch-tool-defs.mjs';
import { TOOL_DEFS as MEMORY_TOOL_DEFS } from '../src/runtime/memory/tool-defs.mjs';
import { TOOL_DEFS as SEARCH_TOOL_DEFS } from '../src/runtime/search/tool-defs.mjs';
import { TOOL_DEFS as CHANNEL_TOOL_DEFS } from '../src/runtime/channels/tool-defs.mjs';
import { AGENT_OWNER } from '../src/runtime/agent/orchestrator/agent-owner.mjs';

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
  const fullPolicy = _resolveOpenAiPromptCacheRatePolicy({}, {
    mode: 'full',
    frameInputItems: 40,
    deltaTokens: 9000,
    hasPreviousResponseId: false,
  });
  assert(fullPolicy.policy === 'full_guard' && fullPolicy.limitPerMin === 12, `full cache lane should keep 12rpm guard: ${JSON.stringify(fullPolicy)}`);

  const deltaPolicy = _resolveOpenAiPromptCacheRatePolicy({}, {
    mode: 'delta',
    frameInputItems: 1,
    deltaTokens: 9000,
    hasPreviousResponseId: true,
  });
  assert(deltaPolicy.policy === 'delta_relaxed' && deltaPolicy.limitPerMin === 60, `small delta should use relaxed cache lane rpm: ${JSON.stringify(deltaPolicy)}`);

  const largeDeltaPolicy = _resolveOpenAiPromptCacheRatePolicy({}, {
    mode: 'delta',
    frameInputItems: 20,
    deltaTokens: 9000,
    hasPreviousResponseId: true,
  });
  assert(largeDeltaPolicy.policy === 'delta_guarded' && largeDeltaPolicy.limitPerMin === 12, `large delta should fall back to full guard: ${JSON.stringify(largeDeltaPolicy)}`);

  const customDeltaPolicy = _resolveOpenAiPromptCacheRatePolicy({ openaiCacheLaneDeltaRateLimitPerMin: 90 }, {
    mode: 'delta',
    frameInputItems: 1,
    deltaTokens: 9000,
    hasPreviousResponseId: true,
  });
  assert(customDeltaPolicy.limitPerMin === 90, `custom delta rpm should be honored: ${JSON.stringify(customDeltaPolicy)}`);

  const unlimitedDeltaPolicy = _resolveOpenAiPromptCacheRatePolicy({ openaiCacheLaneDeltaRateLimitPerMin: 0 }, {
    mode: 'delta',
    frameInputItems: 1,
    deltaTokens: 9000,
    hasPreviousResponseId: true,
  });
  assert(unlimitedDeltaPolicy.policy === 'delta_unlimited' && unlimitedDeltaPolicy.limitPerMin === 0, `delta rpm=0 should disable delta rate wait: ${JSON.stringify(unlimitedDeltaPolicy)}`);

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
  process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
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
    if (calls.join(',') !== 'ws,ws,http') {
      throw new Error(`image should use WS first while forced fallback still uses HTTP: ${calls.join(',')}`);
    }
  } finally {
    if (prevTraceDisable == null) delete process.env.MIXDOG_AGENT_TRACE_DISABLE;
    else process.env.MIXDOG_AGENT_TRACE_DISABLE = prevTraceDisable;
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
  head_limit: 10,
}, root);
assertOk('grep', grepOut, /smoke\.mjs/);

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

const findOut = await executeBuiltinTool('find', {
  query: 'tool smoke',
  path: '.',
  head_limit: 10,
}, root);
assertOk('find', findOut, /scripts[\\/]tool-smoke\.mjs/i);

const readOut = await executeBuiltinTool('read', {
  path: 'scripts/smoke.mjs',
  line: 1,
  context: 3,
}, root);
assertOk('read', readOut, /spawnSync/);

const readDirOut = await executeBuiltinTool('read', {
  path: 'scripts',
}, root);
if (!/^Error[\s:[]/.test(String(readDirOut)) || !/read expects a file/i.test(String(readDirOut))) {
  throw new Error(`read directory must be classified as Error:\n${readDirOut}`);
}

const graphOut = await executeCodeGraphTool('code_graph', {
  mode: 'symbols',
  file: 'scripts/smoke.mjs',
}, root);
assertOk('code_graph', graphOut, /binding|spawnSync|symbol/i);

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
if (!/^Error[\s:[]/.test(String(shellFailOut)) || !/\[exit code: 7\]/.test(String(shellFailOut))) {
  throw new Error(`bash non-zero exit must be classified as Error:\n${shellFailOut}`);
}

const shellTimeoutOut = await shellTimeoutOutPromise;
if (!/^Error[\s:[]/.test(String(shellTimeoutOut)) || !/\[timeout: 500ms\b/.test(String(shellTimeoutOut))) {
  throw new Error(`bash timeout must be milliseconds and classified as Error:\n${shellTimeoutOut}`);
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

const invalidGrepPath = validateBuiltinArgs('grep', {
  pattern: 'providerStatus',
  path: 'C:\\Project\\mixdog\\src\\tui C:\\Project\\mixdog\\src\\mixdog-session-runtime.mjs',
});
if (!/multiple absolute paths/i.test(invalidGrepPath || '')) {
  throw new Error(`grep multi-path guard failed: ${invalidGrepPath}`);
}

const invalidGrepLookaround = validateBuiltinArgs('grep', {
  pattern: 'C:\\\\Project(?!\\\\mixdog)',
  path: root,
});
if (!/lookaround\/backrefs/i.test(invalidGrepLookaround || '')) {
  throw new Error(`grep unsupported-regex guard failed: ${invalidGrepLookaround}`);
}

const invalidShellPath = validateBuiltinArgs('shell', {
  command: 'cd C:\\Project\\mixdog && node scripts/build-tui.mjs',
});
if (process.platform === 'win32' && !/shell:'powershell'/i.test(invalidShellPath || '')) {
  throw new Error(`shell Windows-path guard failed: ${invalidShellPath}`);
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

const mixedReadWindow = {
  path: 'scripts/smoke.mjs',
  line: 1,
  context: 3,
  offset: 1,
  limit: 20,
};
const readWindowErr = validateBuiltinArgs('read', mixedReadWindow);
if (!/exactly one window family/i.test(readWindowErr || '')) {
  throw new Error(`read mixed-window guard failed: err=${readWindowErr} args=${JSON.stringify(mixedReadWindow)}`);
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
for (const name of ['read', 'code_graph', 'grep', 'find', 'glob', 'list', 'apply_patch', 'explore', 'Skill', 'tool_search']) {
  assertHas(fullDefaults, name);
}
for (const name of ['shell', 'task', 'agent', 'recall', 'search', 'web_fetch', 'cwd']) {
  assertLacks(fullDefaults, name);
}

const leadDefaults = defaultDeferredToolNames(smokeCatalog, 'lead');
if (leadDefaults.size !== 16) {
  throw new Error(`lead default surface should stay 16 tools for this static catalog, got ${leadDefaults.size}: ${[...leadDefaults].join(', ')}`);
}
for (const name of ['read', 'code_graph', 'grep', 'find', 'glob', 'list', 'shell', 'task', 'apply_patch', 'explore', 'agent', 'recall', 'search', 'web_fetch', 'Skill', 'tool_search']) {
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
  ['tool_search', 900],
]) {
  const tool = smokeCatalog.find((item) => item?.name === name);
  const size = toolSchemaSize(tool);
  if (size > cap) throw new Error(`${name} schema/description too large: ${size} chars (cap ${cap})`);
}

const readonlyDefaults = defaultDeferredToolNames(smokeCatalog, 'readonly');
if (readonlyDefaults.size !== 9) {
  throw new Error(`readonly default surface should stay 9 tools, got ${readonlyDefaults.size}: ${[...readonlyDefaults].join(', ')}`);
}
for (const name of ['read', 'code_graph', 'grep', 'find', 'glob', 'list', 'explore', 'Skill', 'tool_search']) {
  assertHas(readonlyDefaults, name);
}
for (const name of ['apply_patch', 'agent', 'shell']) {
  assertLacks(readonlyDefaults, name);
}

const agentProps = AGENT_TOOL.inputSchema?.properties || {};
if (agentProps.mode || agentProps.wait) throw new Error('agent schema should not expose execution mode controls');
if (!/always start background tasks/i.test(AGENT_TOOL.description || '') || !/distinct tags/i.test(AGENT_TOOL.description || '') || !/completion notification/i.test(AGENT_TOOL.description || '') || !/do not (?:call|poll) status\/read/i.test(AGENT_TOOL.description || '')) {
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

async function waitForSmoke(predicate, label, timeoutMs = 1000) {
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
try {
  const entry = join(channelWorkerTmp, 'entry.mjs');
  const dataDir = join(channelWorkerTmp, 'data');
  const runtimeDir = join(channelWorkerTmp, 'runtime');
  const envOut = join(channelWorkerTmp, 'env.json');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(entry, `
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.SMOKE_CHANNEL_ENV_OUT, JSON.stringify({
  cliOwned: process.env.MIXDOG_CLI_OWNED,
  daemon: process.env.MIXDOG_CHANNEL_DAEMON,
}));
process.send?.({ type: 'ready' });
process.on('message', (msg) => {
  if (msg?.type === 'shutdown') process.exit(0);
});
setInterval(() => {}, 10000);
`);
  process.env.MIXDOG_CHANNEL_DAEMON = '1';
  process.env.MIXDOG_CHANNEL_SINGLETON = '1';
  process.env.MIXDOG_CHANNEL_WORKER_PROCESS = '1';
  process.env.MIXDOG_RUNTIME_ROOT = runtimeDir;
  process.env.SMOKE_CHANNEL_ENV_OUT = envOut;
  channelEnvWorker = createStandaloneChannelWorker({
    entry,
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
        presets: [{ id: 'sonnet-high', name: 'sonnet-high', provider: 'openai-oauth', model: 'smoke-model', type: 'agent', tools: 'full' }],
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
      && workerQueued.some((event) => /task_shell_notify_smoke/.test(event.message)),
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
const exploreProps = EXPLORE_TOOL.inputSchema?.properties || {};
if (!/Locate code anchors/i.test(EXPLORE_TOOL.description || '') || !/path:line/i.test(EXPLORE_TOOL.description || '') || (EXPLORE_TOOL.description || '').length > 90) {
  throw new Error('explore description must stay compact and anchor-oriented');
}
if (!/query array/i.test(exploreProps.query?.description || '') || !/Project\/root/i.test(exploreProps.cwd?.description || '')) {
  throw new Error('explore schema must stay compact and preserve query/cwd shape');
}
const normalizedExplore = normalizeExploreQueries('["where is model selection?","  ","which file owns agent async?"]');
if (normalizedExplore.length !== 2 || normalizedExplore[0] !== 'where is model selection?') {
  throw new Error(`explore query normalization failed: ${JSON.stringify(normalizedExplore)}`);
}
if (MAX_FANOUT_QUERIES !== 8) throw new Error(`explore fanout cap changed: ${MAX_FANOUT_QUERIES}`);
const explorerPrompt = buildExplorerPrompt('where is <agent> & status?');
if (!explorerPrompt.includes('&lt;agent&gt;') || !explorerPrompt.includes('&amp;') || /verdicts, ratings, or recommendations/.test(explorerPrompt) === false) {
  throw new Error(`explorer prompt contract failed: ${explorerPrompt}`);
}
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
      role: 'lead',
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
      role: 'worker',
      cwd: skillManifestTmp,
      permission: 'read-write',
    });
    try {
      const systemVisible = (agentSkillSession.messages || [])
        .filter((m) => m?.role === 'system')
        .map((m) => String(m.content || ''))
        .join('\n');
      if (!/available-skills/i.test(systemVisible) || !/demo-skill/i.test(systemVisible)) {
        throw new Error(`agent BP1 must carry compact skill manifest: ${systemVisible.slice(0, 1200)}`);
      }
      if (!/# Tool Use/i.test(systemVisible) || !/# Agent Constraints/i.test(systemVisible)) {
        throw new Error(`agent system layers must carry BP1 tool policy and BP2 role rules: ${systemVisible.slice(0, 1200)}`);
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
    role: 'explorer',
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
    if (!/# Role: explorer/i.test(systemVisible) || /# Role: explorer/i.test(userReminderVisible) || !/Locator only/i.test(systemVisible)) {
      throw new Error(`explorer role md must ride BP2 system, not BP3 user reminder: system=${systemVisible.slice(0, 600)} user=${userReminderVisible.slice(0, 600)}`);
    }
    const visibleBytes = Buffer.byteLength(visible, 'utf8');
    if (visibleBytes > 1800) {
      throw new Error(`explorer hidden retrieval context too large: ${visibleBytes} bytes`);
    }
  } finally {
    closeSession(explorerSession.id, 'tool-smoke');
  }
  const workerSession = createSession({
    provider: 'openai-oauth',
    model: 'tool-smoke-model',
    owner: AGENT_OWNER,
    role: 'worker',
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
    if (workerToolNames.includes('tool_search')) {
      throw new Error(`agent session schema must not expose deferred tool_search: ${workerToolNames.join(', ')}`);
    }
    if (!workerToolNames.includes('Skill')) {
      throw new Error(`agent session schema must keep fixed skill meta-tool Skill: ${workerToolNames.join(', ')}`);
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
    role: 'worker',
    cwd: root,
    permission: 'read',
  });
  const writeAgentSession = createSession({
    provider: 'openai-oauth',
    model: 'tool-smoke-model',
    owner: AGENT_OWNER,
    role: 'worker',
    cwd: root,
    permission: 'read-write',
  });
  try {
    const readTools = (readAgentSession.tools || []).map((tool) => tool?.name).filter(Boolean);
    const writeTools = (writeAgentSession.tools || []).map((tool) => tool?.name).filter(Boolean);
    if (readTools.includes('tool_search') || writeTools.includes('tool_search')) {
      throw new Error(`agent session fixed schemas must omit tool_search: read=${readTools.join(', ')} write=${writeTools.join(', ')}`);
    }
    if (JSON.stringify(readTools) !== JSON.stringify(writeTools)) {
      throw new Error(`agent session schema must not split by permission: read=${readTools.join(', ')} write=${writeTools.join(', ')}`);
    }
  } finally {
    closeSession(readAgentSession.id, 'tool-smoke');
    closeSession(writeAgentSession.id, 'tool-smoke');
  }
}
const patchTool = PATCH_TOOL_DEFS[0];
const patchDescription = patchTool?.inputSchema?.properties?.patch?.description || '';
if (!/V4A/i.test(patchDescription) || !/one (?:file )?block per target file/i.test(patchDescription) || !/exact current context/i.test(patchDescription)) {
  throw new Error('apply_patch JSON fallback schema must keep V4A, per-target block, and exact-context guidance');
}
if (!/FREEFORM tool/i.test(patchTool?.freeformDescription || '') || patchTool?.freeform?.type !== 'grammar' || patchTool?.freeform?.syntax !== 'lark') {
  throw new Error(`apply_patch must expose Codex-style freeform grammar metadata: ${JSON.stringify(patchTool)}`);
}
for (const requiredGrammarLine of [
  'start: begin_patch hunk+ end_patch',
  'add_hunk: "*** Add File: " filename LF add_line+',
  'change_move: "*** Move to: " filename LF',
  '%import common.LF',
]) {
  if (!patchTool.freeform.definition.includes(requiredGrammarLine)) {
    throw new Error(`apply_patch freeform grammar missing Codex line: ${requiredGrammarLine}`);
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
    throw new Error(`OpenAI Responses apply_patch must use Codex freeform description: ${JSON.stringify(wirePatchTool)}`);
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
const readPathDescription = BUILTIN_TOOLS.find((tool) => tool.name === 'read')?.inputSchema?.properties?.path?.description || '';
if (!/File path or array/i.test(readPathDescription) || !/Dirs use list/i.test(readPathDescription)) {
  throw new Error('read schema must keep directory-vs-file guidance');
}
const readDescription = BUILTIN_TOOLS.find((tool) => tool.name === 'read')?.description || '';
if (!/known file path\(s\)/i.test(readDescription) || !/line\+context/i.test(readDescription)) {
  throw new Error('read description must stay narrow-target oriented');
}
const codeGraphDescription = CODE_GRAPH_TOOL_DEFS[0]?.description || '';
const codeGraphProps = CODE_GRAPH_TOOL_DEFS[0]?.inputSchema?.properties || {};
if (!/Code structure/i.test(codeGraphDescription) || !/symbols/i.test(codeGraphDescription) || codeGraphDescription.length > 90) {
  throw new Error('code_graph description must stay compact and structure-oriented');
}
if (!/^Operation\.$/i.test(codeGraphProps.mode?.description || '') || !/^Source file\.$/i.test(codeGraphProps.file?.description || '')) {
  throw new Error('code_graph schema must keep compact field descriptions');
}
const recallTool = MEMORY_TOOL_DEFS.find((tool) => tool.name === 'recall');
const recallProps = recallTool?.inputSchema?.properties || {};
if (!/when in doubt, recall first/i.test(recallTool?.description || '') || !recallProps.id?.anyOf || !/Do not invent ids/i.test(recallProps.id?.description || '')) {
  throw new Error('recall schema must preserve prior-context guidance and id lookup shape');
}
if (!/array for independent fan-out/i.test(recallProps.query?.description || '') || !/Project pool selector/i.test(recallProps.projectScope?.description || '')) {
  throw new Error('recall schema must explain fan-out query and project scope filters');
}
const memoryTool = MEMORY_TOOL_DEFS.find((tool) => tool.name === 'memory');
const memoryProps = memoryTool?.inputSchema?.properties || {};
if (!/explicit mutation/i.test(memoryTool?.description || '') || !/Destructive jobs require exact confirm/i.test(memoryTool?.description || '') || !/Exact confirmation phrase/i.test(memoryProps.confirm?.description || '')) {
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
if (!/deferred tools/i.test(TOOL_SEARCH_TOOL.description || '') || !TOOL_SEARCH_TOOL.inputSchema?.properties?.select) {
  throw new Error('tool_search schema must preserve selection guidance and select field');
}
const toolSearchSession = {
  tools: smokeCatalog.filter((tool) => fullDefaults.has(tool?.name)),
  deferredToolCatalog: smokeCatalog.slice(),
  deferredSelectedTools: [...fullDefaults],
};
const searchOnlyResult = JSON.parse(__renderToolSearchForTest({ query: 'shell' }, toolSearchSession, 'full'));
for (const name of ['shell', 'task']) {
  if (!searchOnlyResult.selected?.tools?.added?.includes(name)) {
    throw new Error(`tool_search high-confidence query should auto-load ${name}: ${JSON.stringify(searchOnlyResult.selected)}`);
  }
}
if (!searchOnlyResult.activeTools.includes('shell') || !searchOnlyResult.activeTools.includes('task')) {
  throw new Error(`tool_search query should activate legacy selected tools: ${searchOnlyResult.activeTools.join(',')}`);
}
const bulkSelectResult = JSON.parse(__renderToolSearchForTest({ query: 'select:shell,recall' }, toolSearchSession, 'full'));
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
const nativeRunQuerySession = {
  tools: smokeCatalog.filter((tool) => fullDefaults.has(tool?.name)),
  deferredToolCatalog: smokeCatalog.slice(),
  deferredSelectedTools: [...fullDefaults],
  deferredDiscoveredTools: [],
  deferredProviderMode: 'native',
  deferredNativeTools: true,
};
const nativeRunQueryResult = JSON.parse(__renderToolSearchForTest({ query: 'run tests' }, nativeRunQuerySession, 'full'));
for (const name of ['shell', 'task']) {
  if (!nativeRunQueryResult.discoveredTools.includes(name)) {
    throw new Error(`native tool_search run/tests query should discover ${name}: ${JSON.stringify(nativeRunQueryResult)}`);
  }
}
if (nativeRunQueryResult.activeTools.includes('shell') || nativeRunQueryResult.activeTools.includes('task')) {
  throw new Error(`native tool_search query must not mutate active schemas: ${JSON.stringify(nativeRunQueryResult)}`);
}
const nativeWebQuerySession = {
  tools: smokeCatalog.filter((tool) => fullDefaults.has(tool?.name)),
  deferredToolCatalog: smokeCatalog.slice(),
  deferredSelectedTools: [...fullDefaults],
  deferredDiscoveredTools: [],
  deferredProviderMode: 'native',
  deferredNativeTools: true,
};
const nativeWebQueryResult = JSON.parse(__renderToolSearchForTest({ query: 'web docs' }, nativeWebQuerySession, 'full'));
for (const name of ['search', 'web_fetch']) {
  if (!nativeWebQueryResult.discoveredTools.includes(name)) {
    throw new Error(`native tool_search web/docs query should discover ${name}: ${JSON.stringify(nativeWebQueryResult)}`);
  }
}
const nativeRecallQuerySession = {
  tools: smokeCatalog.filter((tool) => fullDefaults.has(tool?.name)),
  deferredToolCatalog: smokeCatalog.slice(),
  deferredSelectedTools: [...fullDefaults],
  deferredDiscoveredTools: [],
  deferredProviderMode: 'native',
  deferredNativeTools: true,
};
const nativeRecallQueryResult = JSON.parse(__renderToolSearchForTest({ query: 'memory previous' }, nativeRecallQuerySession, 'full'));
if (!nativeRecallQueryResult.discoveredTools.includes('recall') || nativeRecallQueryResult.discoveredTools.includes('memory')) {
  throw new Error(`native tool_search memory previous should discover recall only: ${JSON.stringify(nativeRecallQueryResult)}`);
}
const ambiguousStatusSession = {
  tools: smokeCatalog.filter((tool) => fullDefaults.has(tool?.name)),
  deferredToolCatalog: smokeCatalog.slice(),
  deferredSelectedTools: [...fullDefaults],
  deferredDiscoveredTools: [],
  deferredProviderMode: 'native',
  deferredNativeTools: true,
};
const ambiguousStatusResult = JSON.parse(__renderToolSearchForTest({ query: 'status' }, ambiguousStatusSession, 'full'));
if (ambiguousStatusResult.selected || ambiguousStatusResult.discoveredTools.length) {
  throw new Error(`tool_search ambiguous status query must not auto-load: ${JSON.stringify(ambiguousStatusResult)}`);
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
if (!/Array = OR/i.test(grepPatternDescription) || !/^File or directory\.$/i.test(grepPathDescription)) {
  throw new Error('grep schema must keep compact pattern/path guidance');
}

const longToolSearchText = compactToolSearchDescription(`${patchDescription}\n${patchDescription}`);
if (longToolSearchText.length > 220 || /\n/.test(longToolSearchText)) {
  throw new Error(`tool_search descriptions must be compact single-line snippets, got ${longToolSearchText.length} chars`);
}

process.stdout.write(`tool smoke passed surface_chars=${surfaceSize}\n`);
