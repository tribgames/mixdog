// Records the goldens of the text-only input check (input-capabilities.mjs).
//
//   node native/core/fixtures/agent/record-text-only.mjs [--tree <node checkout with node_modules>]
//
// Each case is run through the real `assertLocalModelInput`; the messages it
// returns (or the error it throws) are written beside the input to
// `text_only/cases.json`, which `tests/text_only.rs` replays.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commitStage, parseArgs, refreshSetManifest, resolveTree, stageSet } from '../../../../benchmarks/rust-core/recorders/lib/common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const nodeRoot = resolveTree(parseArgs());
const stage = stageSet(here, ['text_only']);
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-text-only-'));
const { assertLocalModelInput } = await import(
  pathToFileURL(join(nodeRoot, 'src/runtime/local-provider/input-capabilities.mjs')).href
);

const b64 = (text) => Buffer.from(text).toString('base64');
const text = (t) => ({ type: 'text', text: t });
const image = { type: 'image', data: 'AAECAw==', mimeType: 'image/png' };
const csv = { type: 'file', data: b64('a,b\n1,2\n'), mimeType: 'text/csv', filename: 'rows.csv' };
const zip = { type: 'file', data: b64('PK\u0003\u0004zip'), mimeType: 'application/zip', filename: 'b.zip' };
const gone = { type: 'file', mimeType: 'text/plain', filename: 'dir/n.txt', attachmentRef: 'a'.repeat(64), sizeBytes: 10 };
const textDoc = { type: 'document', source: { type: 'text', data: 'doc body' }, title: 'notes' };
const user = (content) => ({ role: 'user', content });
const assistant = (content) => ({ role: 'assistant', content });

const cases = [
  { name: 'image_with_text', messages: [user([text('look'), image])] },
  { name: 'image_only_is_an_error', messages: [user([image])] },
  { name: 'zip_only_is_an_error', messages: [user([zip])] },
  { name: 'blank_text_and_image_is_an_error', messages: [user([text('  \n'), image])] },
  { name: 'history_media_degrades', messages: [user([text('first'), image]), assistant('seen'), user('now')] },
  { name: 'csv_is_text', messages: [user([text('read'), csv])] },
  { name: 'csv_only_is_usable', messages: [user([csv])] },
  { name: 'zip_is_described', messages: [user([text('hm'), zip])] },
  { name: 'gone_attachment_placeholder', messages: [user([text('hi'), gone])] },
  { name: 'text_source_document_is_omitted', messages: [user([text('hi'), textDoc])] },
  { name: 'unsent_text_with_image_is_an_error', messages: [user([text('[file not sent inline: x'), image])] },
  { name: 'string_content_untouched', messages: [user('plain')] },
  { name: 'no_user_message', messages: [assistant([text('a'), image])] },
  { name: 'tool_message_media', messages: [user('go'), { role: 'tool', toolCallId: 't1', content: [image, text('r')] }, user('next')] },
  { name: 'last_user_wins', messages: [user([text('old')]), assistant('a'), user([image])] },
  { name: 'tools_unsupported', messages: [user('hi')], tools: [{ name: 't' }], capabilities: { tools: false } },
  { name: 'capability_overrides_model', messages: [user('hi')], tools: [{ name: 't' }], model: { supportsFunctionCalling: false }, capabilities: { tools: true } },
  { name: 'model_flag_without_capability', messages: [user('hi')], tools: [{ name: 't' }], model: { supportsFunctionCalling: false } },
  { name: 'effort_is_rejected', messages: [user('hi')], options: { effort: 'low' } },
];

const out = cases.map((c) => {
  const model = { name: 'local-test', ...(c.model || {}) };
  const input = { model, messages: c.messages, tools: c.tools || [], options: c.options || {}, capabilities: c.capabilities || {} };
  try {
    const messages = assertLocalModelInput(model, c.messages, input.tools, input.options, input.capabilities);
    return { name: c.name, input, messages };
  } catch (error) {
    return { name: c.name, input, error: error.message };
  }
});

const dir = join(stage, 'text_only');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'cases.json'), `${JSON.stringify(out, null, 2)}\n`);
refreshSetManifest(stage, nodeRoot);
commitStage(stage, here);
for (const c of out) console.log(c.name, c.error ? `ERROR ${c.error.slice(0, 60)}` : 'ok');
