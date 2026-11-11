#!/usr/bin/env node
// custom-provider-keys.test.mjs: 6 tests. Recorded here: the single-key provider case (:138: a single-key send reads no key roster,
// refuses on quota, and a key added / removed while live rebuilds the provider with / without the key pool), through the real registry
// (`initProviders` + `getProvider`) over the scripted loopback endpoint.
// Already covered by provider-gateways (o1, recorder record-provider-gateways.mjs, same registry path and scripts): :99 two keys, first
// refuses on quota (custom-keys-switch), :121 every key exhausted (custom-keys-exhausted), :190 output already emitted never replayed
// (custom-keys-after-output / -reasoning-then-quota), :212 a key's history keeps its reasoning (custom-keys-reasoning).
// Not recorded: :171 (a single-key pool hands the primary the very request object: createCustomKeyPoolProvider over stub engines, JS object
// identity with no wire or Rust counterpart).
//   node benchmarks/rust-core/recorders/record-custom-provider-keys.mjs --tree <exact export of b6f10295a>
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sseBody, startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-custom-provider-keys',
  entry: 'providers/registry.mjs initProviders / getProvider, shared/provider-accounts.mjs newProviderAccountId / readProviderAccountPool / setCustomProviderKeyIds over a custom openai-chat provider on https://keys.example.com/v1 (fetch redirected to the scripted endpoint; additional keys come from the stubbed keychain map). Not run: the multi-key cases (covered by provider-gateways) and the stub-engine pool wrapper.',
  replay: 'mixdog-ai registry builder.rs:902-911 and providers.rs:226-242 (single-key custom send): compare the `sends` (result/error, requests with the Authorization key in order) and `rosterFileExistsAfter...` flags and `pool.accounts`. NOTE the Rust builder uses the primary key only (K1 gap G5): the after-add send is expected to differ until that gap is closed.',
});
const { newProviderAccountId, readProviderAccountPool, setCustomProviderKeyIds } = await rec.P('shared/provider-accounts.mjs');
const { initProviders, getProvider } = await rec.P('agent/orchestrator/providers/registry.mjs');
const SRC = 'src/runtime/agent/orchestrator/providers/custom-provider-keys.test.mjs';
const custom = (apiKey) => ({ type: 'custom', name: 'Keys', protocol: 'openai-chat', baseURL: 'https://keys.example.com/v1', enabled: true, apiKey, preconnect: false, models: [{ id: 'm1' }] });
const prompt = [{ role: 'user', content: 'hello' }];
const answer = (text) => ({ status: 200, contentType: 'text/event-stream', body: `${sseBody([{ id: 'c1', model: 'm1', choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] }])}data: [DONE]\n\n` });
const quota = () => ({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: { message: 'You exceeded your current quota.', type: 'insufficient_quota', code: 'insufficient_quota' } }) });
const keyOf = (r) => String(r.headers.authorization || '').replace(/^Bearer /, '');
const attempt = async (promise) => {
  try {
    return { result: await promise };
  } catch (error) {
    return { error };
  }
};

await rec.run('single-key-provider-sends-as-before-no-roster', `${SRC}:138`, { id: 'custom-keys-single', primary: 'sk-solo', added: 'sk-added' }, async ({ net }) => {
  const id = 'custom-keys-single';
  const rosterFile = join(rec.dataDir, 'provider-accounts.json');
  const sends = [];
  const send = async (label, reply) => {
    net.records = [];
    net.reply = reply;
    const out = await attempt(getProvider(id).send(prompt, 'm1', [], {}));
    sends.push({ label, ...out, keys: net.records.map(keyOf), requests: net.records.map((r) => rec.view(r)) });
  };
  await initProviders({ [id]: custom('sk-solo') });
  await send('answers', () => answer('solo'));
  const rosterAfterAnswer = existsSync(rosterFile);
  await send('quota refusal', () => quota());
  const poolAfterQuota = readProviderAccountPool(id).accounts;
  const keyId = newProviderAccountId();
  rec.secrets[`agent.${id}.apiKey.${keyId}`] = 'sk-added';
  await setCustomProviderKeyIds(id, [keyId]);
  await initProviders({ [id]: custom('sk-solo') });
  await send('key added while live', (r) => (keyOf(r) === 'sk-solo' ? quota() : answer('added')));
  await setCustomProviderKeyIds(id, []);
  await initProviders({ [id]: custom('sk-solo') });
  await send('key removed again', () => quota());
  return { sends, rosterFileExistsAfterFirstSend: rosterAfterAnswer, poolAccountsAfterQuota: poolAfterQuota };
});
await rec.finish();
