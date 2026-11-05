#!/usr/bin/env node
// xAI Responses prompt-cache routing (WP-AI-COMPAT): the REAL Node
// `xaiResponsesCacheRouting` (openai-compat-xai.mjs) over the chat lowering the
// send path feeds it (`toOpenAIMessages`), one case per scope / lane setting.
// No server, no credential. The environment a case sets is applied around the call.
//
//   node benchmarks/rust-core/recorders/record-xai-cache-routing.mjs [--tree <dir>]
//
// Output: native/core/fixtures/providers/oracles/xai-cache-routing.json. It lives
// inside `providers/`, so record-providers.mjs calls `recordXaiCacheRouting` before
// its manifest write; run standalone it leaves the manifest alone.
//
// Cases are order-dependent only for the auto lane (a per-seed slot counter in the
// module); each auto case uses its own cache namespace, so the order is stable.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const P = 'src/runtime/agent/orchestrator/providers';
const MODEL = 'grok-4.5';
const TOOLS = [
  { name: 'read', description: 'read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'ls', description: '', inputSchema: { type: 'object' } },
];
const MESSAGES = [{ role: 'system', content: 'You are terse.' }, { role: 'user', content: 'hi' }];
const OTHER_SYSTEM = [{ role: 'system', content: 'You are verbose.' }, { role: 'user', content: 'hi' }];
const DEVELOPER = [{ role: 'developer', content: 'You are terse.' }, { role: 'user', content: 'hi' }];

const SHARDS = 'MIXDOG_XAI_RESPONSES_CACHE_LANE_SHARDS';
const PREFIX = { xaiResponsesCacheScope: 'prefix' };

const CASES = [
  { name: 'session_default', options: { sessionId: 's1' } },
  { name: 'session_default_other_session', options: { sessionId: 's2' } },
  { name: 'session_default_namespace', options: { sessionId: 's1', promptCacheKey: 'ns-a' } },
  { name: 'session_default_blank_session', options: { sessionId: '  ' } },
  { name: 'no_session_default', options: {} },
  { name: 'scope_none', options: { sessionId: 's1', xaiResponsesCacheScope: 'none' } },
  { name: 'scope_off', options: { sessionId: 's1', xaiResponsesCacheScope: 'off' } },
  { name: 'scope_omit_cased', options: { sessionId: 's1', xaiResponsesCacheScope: ' Omit ' } },
  { name: 'scope_prefix', options: { sessionId: 's1', ...PREFIX } },
  { name: 'scope_prefix_other_session_same_key', options: { sessionId: 's2', ...PREFIX } },
  { name: 'scope_prefix_other_system', messages: OTHER_SYSTEM, options: { sessionId: 's1', ...PREFIX } },
  { name: 'scope_prefix_developer_counts_as_system', messages: DEVELOPER, options: { sessionId: 's1', ...PREFIX } },
  { name: 'scope_prefix_no_tools', tools: [], options: { sessionId: 's1', ...PREFIX } },
  { name: 'scope_prefix_namespace', options: { sessionId: 's1', promptCacheKey: 'ns-a', ...PREFIX } },
  { name: 'shared_role', options: { sessionId: 's1', promptCacheScope: 'shared' } },
  { name: 'shared_role_no_session', options: { promptCacheScope: 'shared' } },
  { name: 'shared_role_explicit_none', options: { sessionId: 's1', promptCacheScope: 'shared', xaiResponsesCacheScope: 'none' } },
  { name: 'shared_role_explicit_session', options: { sessionId: 's1', promptCacheScope: 'shared', xaiResponsesCacheScope: 'session' } },
  { name: 'env_scope_none', env: { MIXDOG_XAI_RESPONSES_CACHE_SCOPE: 'none' }, options: { sessionId: 's1' } },
  { name: 'env_scope_prefix', env: { MIXDOG_XAI_RESPONSES_CACHE_SCOPE: 'prefix' }, options: { sessionId: 's1' } },
  { name: 'option_scope_beats_env', env: { MIXDOG_XAI_RESPONSES_CACHE_SCOPE: 'none' }, options: { sessionId: 's1', xaiResponsesCacheScope: 'session' } },
  { name: 'shared_role_beats_env', env: { MIXDOG_XAI_RESPONSES_CACHE_SCOPE: 'none' }, options: { sessionId: 's1', promptCacheScope: 'shared' } },
  { name: 'lane_shards_3_s1', env: { [SHARDS]: '3' }, options: { sessionId: 's1', ...PREFIX } },
  { name: 'lane_shards_3_s2', env: { [SHARDS]: '3' }, options: { sessionId: 's2', ...PREFIX } },
  { name: 'lane_shards_3_s3', env: { [SHARDS]: '3' }, options: { sessionId: 's3', ...PREFIX } },
  { name: 'lane_shards_3_s4', env: { [SHARDS]: '3' }, options: { sessionId: 's4', ...PREFIX } },
  { name: 'lane_shards_1_is_no_lane', env: { [SHARDS]: '1' }, options: { sessionId: 's1', ...PREFIX } },
  { name: 'lane_shards_float_floors', env: { [SHARDS]: '2.9' }, options: { sessionId: 's1', ...PREFIX } },
  { name: 'lane_shards_alias_env_grok', env: { MIXDOG_GROK_CACHE_LANE_SHARDS: '4' }, options: { sessionId: 's1', ...PREFIX } },
  { name: 'lane_shards_fallback_env_xai', env: { MIXDOG_XAI_CACHE_LANE_SHARDS: '2' }, options: { sessionId: 's1', ...PREFIX } },
  { name: 'lane_shards_fallback_env_openai', env: { MIXDOG_OPENAI_CACHE_LANE_SHARDS: '2' }, options: { sessionId: 's1', ...PREFIX } },
  { name: 'lane_shards_blank_env_wins_over_fallback', env: { [SHARDS]: '', MIXDOG_XAI_CACHE_LANE_SHARDS: '4' }, options: { sessionId: 's1', ...PREFIX } },
  { name: 'lane_shards_max_parallel_alias_ignored', env: { MIXDOG_XAI_CACHE_MAX_PARALLEL: '4' }, options: { sessionId: 's1', ...PREFIX } },
  { name: 'lane_auto_a1', env: { [SHARDS]: 'abc' }, options: { sessionId: 'a', promptCacheKey: 'ns-auto', ...PREFIX } },
  { name: 'lane_auto_b1', env: { [SHARDS]: 'abc' }, options: { sessionId: 'b', promptCacheKey: 'ns-auto', ...PREFIX } },
  { name: 'lane_auto_a2', env: { [SHARDS]: 'abc' }, options: { sessionId: 'a', promptCacheKey: 'ns-auto', ...PREFIX } },
  { name: 'lane_auto_zero', env: { [SHARDS]: '0' }, options: { sessionId: 'a', promptCacheKey: 'ns-zero', ...PREFIX } },
  { name: 'lane_auto_flag_a', env: { MIXDOG_GROK_OAUTH_CACHE_LANE_AUTO: ' Auto ' }, options: { sessionId: 'a', promptCacheKey: 'ns-flag', ...PREFIX } },
  { name: 'lane_auto_flag_b', env: { MIXDOG_GROK_OAUTH_CACHE_LANE_AUTO: ' Auto ' }, options: { sessionId: 'b', promptCacheKey: 'ns-flag', ...PREFIX } },
  { name: 'lane_auto_flag_off_value_is_not_auto', env: { MIXDOG_XAI_RESPONSES_CACHE_LANE_AUTO: 'yes', [SHARDS]: '2' }, options: { sessionId: 's1', ...PREFIX } },
];

function withEnv(env, run) {
  const saved = {};
  for (const [name, value] of Object.entries(env || {})) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  try {
    return run();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

export async function recordXaiCacheRouting(tree, outFile) {
  const { xaiResponsesCacheRouting } = await importFrom(tree, `${P}/openai-compat-xai.mjs`);
  const { toOpenAIMessages } = await importFrom(tree, `${P}/openai-compat-wire.mjs`);
  const cases = [];
  for (const spec of CASES) {
    const messages = spec.messages ?? MESSAGES;
    const tools = spec.tools ?? TOOLS;
    const routing = withEnv(spec.env, () =>
      xaiResponsesCacheRouting(spec.options, { messages: toOpenAIMessages(messages, 'xai', {}) }, tools, MODEL)
    );
    cases.push({
      name: spec.name,
      env: spec.env ?? {},
      model: MODEL,
      messages,
      tools,
      options: spec.options,
      key: routing.key,
      mode: routing.mode,
    });
  }
  writeJson(outFile, {
    _doc: 'Recorded from src/runtime/agent/orchestrator/providers/openai-compat-xai.mjs (xaiResponsesCacheRouting over toOpenAIMessages output). `key` is the prompt_cache_key Node sends (null: the field is omitted). A session-less prefix lane with shards falls back on process.pid, so it is not recorded.',
    recorder: 'benchmarks/rust-core/recorders/record-xai-cache-routing.mjs',
    cases,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tree = resolveTree(parseArgs());
  await recordXaiCacheRouting(tree, join(FIXTURES_ROOT, 'providers', 'oracles', 'xai-cache-routing.json'));
  console.log('recorded xai-cache-routing; providers/MANIFEST.json is regenerated by record-providers.mjs');
}
