#!/usr/bin/env node
// mimo-oauth.test.mjs (2 cases): the real MimoOAuthProvider lists models from the stored base URL (a scripted endpoint records the
// request) and refuses a send with no stored credentials.
//   node benchmarks/rust-core/recorders/record-mimo-oauth.mjs --tree <exact export of b6f10295a>
import { join } from 'node:path';
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-mimo-oauth',
  entry: 'src/runtime/agent/orchestrator/providers/mimo-oauth.mjs MimoOAuthProvider({ preconnect: false }).listModels() and .send([], "mimo-v2.6-pro", [], {}) with MIMO_OAUTH_CREDENTIALS_PATH in the data directory (credential file written by the recorder). The stored base URL is https://mimo.invalid/v1; fetch is redirected to the scripted endpoint.',
  compare: 'mixdog-ai providers::compat (listing.rs, creds.rs, login/mimo.rs): with the stored credential `input.credential`, the models request (url path, authorization, x-mimo-source) and the model ids; with none, the send error text.',
  replay: "Rust entry (pub, on o1): mixdog_ai::providers::compat::CompatAdapter (compat/adapter.rs:63) with CompatChatCodec (compat/chat/mod.rs:96) / CompatResponsesCodec (compat/responses.rs:75), body builder build_body (compat/chat/encode.rs:372), driven through mixdog_ai::broker ModelBroker::send (mixdog-ai/src/broker/send.rs:75) and ProviderAdapter::attempt (mixdog-core-api/src/domain/provider.rs:1079).",
});
process.env.MIMO_OAUTH_CREDENTIALS_PATH = join(rec.dataDir, 'mimo-oauth.json');
const { MimoOAuthProvider } = await rec.P('agent/orchestrator/providers/mimo-oauth.mjs');
const SRC = 'src/runtime/agent/orchestrator/providers/mimo-oauth.test.mjs';
const credential = { apiKey: 'sk-1', uid: 'u', baseUrl: 'https://mimo.invalid/v1' };

await rec.run('lists-models-with-bearer-and-source-header', `${SRC}:16`, { credential }, async ({ net }) => {
  net.reply = () => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'mimo-v2.6-pro' }] }) });
  rec.write('mimo-oauth.json', JSON.stringify(credential));
  const models = await new MimoOAuthProvider({ preconnect: false }).listModels();
  return { models };
});
await rec.run('send-without-credentials-asks-sign-in', `${SRC}:41`, { credential: null }, async () => {
  const { rmSync } = await import('node:fs');
  rec.own('removing the credentials file', () => rmSync(process.env.MIMO_OAUTH_CREDENTIALS_PATH, { force: true }));
  return new MimoOAuthProvider({ preconnect: false }).send([], 'mimo-v2.6-pro', [], {});
});
await rec.finish();
