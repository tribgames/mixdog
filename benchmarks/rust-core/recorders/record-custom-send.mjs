#!/usr/bin/env node
// Node's custom-provider connection test as a real send (testCustomProvider in
// provider-admin.mjs, through the account pool's key rotation and the provider's own retry)
// against a scripted loopback endpoint: every key refused with a 429 quota error, a 503 then
// success, and a refusal on the primary key that the additional key serves. Each scenario
// records the result or the exact thrown text and which key sent each chat request.
//   node benchmarks/rust-core/recorders/record-custom-send.mjs [--tree <dir>]
//
// Output: native/core/fixtures/custom-send/golden.json.
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { FIXTURES_ROOT, commitStage, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

// mock.module needs the flag; run again with it when started without.
if (!process.execArgv.includes('--experimental-test-module-mocks')) {
  const run = spawnSync(process.execPath, ['--experimental-test-module-mocks', ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'custom-send');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-custom-send.mjs';
const href = (path) => pathToFileURL(join(tree, path)).href;
process.env.CS_ENV = 'sk-env';
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'custom-send-'));
mock.module(href('src/runtime/shared/file-permissions.mjs'), {
  namedExports: { enforceOwnerOnlyAclWin32() {}, async enforceOwnerOnlyAclWin32Async() {} },
});
const secrets = new Map();
// readCustomProviderKey reads the keychain module (CommonJS) directly: serve it from the same map.
import { createRequire } from 'node:module';
createRequire(import.meta.url)(join(tree, 'src/lib/keychain-cjs.cjs')).getSecret = (account) => secrets.get(account) ?? null;
const original = await import(href('src/runtime/shared/config.mjs'));
mock.module(href('src/runtime/shared/config.mjs'), {
  namedExports: {
    ...original,
    saveSecret: (account, value) => secrets.set(account, value),
    saveSecretAsync: async (account, value) => {
      secrets.set(account, value);
    },
    deleteSecretAsync: async (account) => {
      secrets.delete(account);
    },
    hasStoredSecret: (account) => secrets.has(account),
    getAgentApiKey: (id) => secrets.get(`agent.${id}.apiKey`) || null,
  },
});
const admin = await import(href('src/session-runtime/services/provider-admin.mjs'));

const seen = [];
let script = { refused: [], flaky: 0 };
let failed = 0;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    const path = req.url.replace(/^\/v1/, '');
    const authorization = req.headers.authorization ?? '';
    seen.push({ path, authorization });
    const send = (status, type, text) => {
      res.writeHead(status, { 'content-type': type });
      res.end(text);
    };
    if (path === '/models') return send(200, 'application/json', JSON.stringify({ data: [{ id: 'm-a' }] }));
    if (failed++ < script.flaky) return send(503, 'application/json', JSON.stringify({ error: { message: 'overloaded', type: 'server_error' } }));
    if (script.refused.includes(authorization)) {
      return send(429, 'application/json', JSON.stringify({ error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } }));
    }
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'c1', model: 'm-a', choices: [{ index: 0, delta, finish_reason: finish }], usage: finish ? { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } : null })}\n\n`;
    send(200, 'text/event-stream', chunk({ role: 'assistant', content: 'OK' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/v1`;

let config = { providers: {}, modelSettings: {} };
const cfg = {
  loadConfig: () => structuredClone(config),
  saveConfig: (next) => {
    config = structuredClone(next);
  },
};
const SCENARIOS = [
  { name: 'every key refused with a quota error', keys: ['sk-primary', 'sk-extra'], refused: ['Bearer sk-primary', 'Bearer sk-extra'], flaky: 0 },
  { name: 'the primary key refused and the additional key serves', keys: ['sk-primary', 'sk-extra'], refused: ['Bearer sk-primary'], flaky: 0 },
  { name: 'the only key refused with a quota error', keys: ['sk-only'], refused: ['Bearer sk-only'], flaky: 0 },
  { name: 'a 503 then success', keys: ['sk-only'], refused: [], flaky: 1 },
  // Unsaved settings of the test decide who sends: no saved additional key is used.
  { name: 'a keyless test of a provider with saved additional keys', keys: ['sk-primary', 'sk-extra'], refused: ['Bearer sk-primary', 'Bearer sk-extra'], flaky: 0, probe: { auth: 'none' } },
  { name: 'an environment key test of a provider with saved additional keys', keys: ['sk-primary', 'sk-extra'], refused: ['Bearer sk-env'], flaky: 0, probe: { apiKeyEnv: 'CS_ENV' } },
];
const out = [];
for (const scenario of SCENARIOS) {
  const [primary, ...extra] = scenario.keys;
  const saved = await admin.saveCustomProvider(cfg, {
    name: scenario.name,
    protocol: 'openai-chat',
    baseURL: base,
    apiKey: primary,
    ...(extra.length ? { extraApiKeys: extra.map((apiKey) => ({ apiKey })) } : {}),
  });
  script = { refused: scenario.refused, flaky: scenario.flaky };
  failed = 0;
  seen.length = 0;
  let result = null;
  let error = null;
  const started = Date.now();
  try {
    result = await admin.testCustomProvider(cfg, { id: saved.id, schemaVersion: 2, name: scenario.name, protocol: 'openai-chat', baseURL: base, ...scenario.probe });
  } catch (thrown) {
    error = thrown.message;
  }
  const label = (value) => value.replace('Bearer ', '');
  out.push({
    name: scenario.name,
    keys: scenario.keys,
    refused: scenario.refused,
    flaky: scenario.flaky,
    probe: scenario.probe ?? null,
    result: result === null ? null : JSON.parse(JSON.stringify(result).replace(saved.extraApiKeys?.[0]?.id ?? '\0', '<key1>')),
    error,
    chats: seen.filter((s) => s.path === '/chat/completions').map((s) => label(s.authorization)),
    discoveries: seen.filter((s) => s.path === '/models').length,
    seconds: Math.round((Date.now() - started) / 1000),
  });
}
server.close();
writeJson(join(stage, 'golden.json'), { scenarios: out });
writeSetManifest(stage, { set: 'custom-send', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
process.exit(0);
