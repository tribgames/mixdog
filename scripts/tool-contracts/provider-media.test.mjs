// Provider wire behaviors: replay matching, WS transport pinning, image
// normalization per provider, and Anthropic output-token resolution.
import './_env.mjs';
import test from 'node:test';
import { assert } from './_helpers.mjs';
import { OpenAIOAuthProvider } from '../../src/runtime/agent/orchestrator/providers/openai-oauth.mjs';
import { _test as _anthropicOAuthTest } from '../../src/runtime/agent/orchestrator/providers/anthropic-oauth.mjs';
import { _logicalResponseItemMatch } from '../../src/runtime/agent/orchestrator/providers/openai-oauth-ws.mjs';
import {
  contentHasImage,
  normalizeContentForAnthropic,
  normalizeContentForGeminiParts,
  normalizeContentForOpenAIChat,
  normalizeContentForOpenAIResponses,
  sanitizeContentForStoredHistory,
} from '../../src/runtime/agent/orchestrator/providers/media-normalization.mjs';

test('logical response replay matches by call_id/name across compaction', () => {
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
});

test('image turns keep the pinned WS transport healthy', async () => {
  const prevTraceDisable = process.env.MIXDOG_AGENT_TRACE_DISABLE;
  const prevOaiTransport = process.env.MIXDOG_OAI_TRANSPORT;
  process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
  // This test intentionally verifies the pinned WS-only escape hatch. Default
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
      { _sendViaWebSocketFn: fakeWs, _sendViaHttpSseFn: fakeHttp, sessionId: 'tool-contracts-image-ws' },
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
      { _sendViaWebSocketFn: fakeWs, _sendViaHttpSseFn: fakeHttp, sessionId: 'tool-contracts-plain-after-image' },
    );
    await provider.send(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'forced HTTP fallback probe' },
      ],
      'gpt-5.5',
      [],
      { _sendViaWebSocketFn: fakeWs, _sendViaHttpSseFn: fakeHttp, forceHttpFallback: true, sessionId: 'tool-contracts-forced-http-fallback' },
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
});

test('Anthropic image normalization covers data-url, URL, and file ids', () => {
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
});

test('Gemini image normalization keeps inline data and flags foreign file ids', () => {
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
});

test('OpenAI-compatible chat/Responses image normalization', () => {
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
});

test('Anthropic max output tokens resolve through catalog, fallback, and env override', () => {
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
});
