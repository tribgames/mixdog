// What an attached file becomes on the wire in Node b6f10295a (the 1.4.5 release): one table, per provider family and
// capability combination (the instance's own `nativePdf` / `nativeDocuments`) × attachment kind (a stored image, PDF,
// text file, Office document, unknown binary, and blobs that are gone) → what the request carries.
//
//   node benchmarks/rust-core/recorders/record-media-wire.mjs --tree <exact export of b6f10295a>
//
// Each row is the whole request body of the provider's own `send` on the messages, from Node's real modules: every
// HTTP provider is sent to with `fetch` replaced by a capture that answers 400, so the body is the one its transport was
// handed (Messages, Chat, the compat Responses wire, Gemini, the managed local model's own `send`); the built-in
// Responses wire's `buildRequestBody` (its socket send serialises it), Devin's `buildDevinChatRequest` encoded as
// `GetChatMessageRequest`, and Cursor's `parseMessages` result (its frame is built from it). The attachments are stored in
// Node's real attachment store, which every lowering reads them back from (`readAttachmentBase64`).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, nodeTreeIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-media-wire.mjs';
const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const args = parseArgs();
const tree = resolveTree(args);
const identity = nodeTreeIdentity(args, tree, NODE_COMMIT);
const load = (path) => import(pathToFileURL(join(tree, path)).href);
const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-media-wire-'));
process.env.MIXDOG_DATA_DIR = dataDir;
process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';
process.on('exit', () => rmSync(dataDir, { recursive: true, force: true }));

const PROVIDERS = 'src/runtime/agent/orchestrator/providers/';
const store = await load('src/runtime/attachments/store.mjs');
const media = await load(`${PROVIDERS}media-normalization.mjs`);
const { buildRequestBody } = await load(`${PROVIDERS}openai-responses-payload.mjs`);
const { __cursorModelInternals: { toCursorMessages } } = await load(`${PROVIDERS}cursor.mjs`);
const { parseMessages } = await load(`${PROVIDERS}cursor-wire-request.mjs`);
const JSZip = (await import(pathToFileURL(join(tree, 'node_modules/jszip/lib/index.js')).href)).default;

// ---- the attachments ----

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function pdfBytes(text) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${text.length + 31} >>\nstream\nBT /F1 12 Tf 40 100 Td (${text}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

const zip = new JSZip();
zip.file('word/document.xml', `<w:document xmlns:w="${WORD_NS}"><w:body><w:p><w:r><w:t>Quarterly plan alpha</w:t></w:r></w:p></w:body></w:document>`);
const docx = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE', date: new Date(0) });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// `gone`: a reference whose blob this store never held.
const GONE = 'c'.repeat(64);
const kinds = [
  { name: 'image', type: 'image', bytes: PNG, mimeType: 'image/png', filename: 'shot.png' },
  { name: 'pdf', type: 'file', bytes: pdfBytes('Quarterly numbers'), mimeType: 'application/pdf', filename: 'report.pdf' },
  { name: 'pdf-unreadable', type: 'file', bytes: Buffer.from('%PDF-1.4 this is not a document'), mimeType: 'application/pdf', filename: 'broken.pdf' },
  { name: 'text', type: 'file', bytes: Buffer.from('alpha\nbeta é 🙂\n', 'utf8'), mimeType: 'text/plain', filename: 'notes.txt' },
  { name: 'json', type: 'file', bytes: Buffer.from('{"a":1}', 'utf8'), mimeType: 'application/json', filename: 'data.json' },
  { name: 'office', type: 'file', bytes: docx, mimeType: DOCX, filename: 'plan.docx' },
  { name: 'office-unreadable', type: 'file', bytes: Buffer.from('PK not a zip'), mimeType: DOCX, filename: 'damaged.docx' },
  { name: 'binary', type: 'file', bytes: Buffer.from([0, 1, 2, 255]), mimeType: 'application/octet-stream', filename: 'blob.bin' },
  { name: 'gone-file', type: 'file', ref: GONE, mimeType: 'application/pdf', filename: 'C:\\old\\gone.pdf' },
  { name: 'gone-image', type: 'image', ref: GONE, mimeType: 'image/png', filename: 'gone.png' },
];

const blobs = {};
const partOf = (kind) => {
  let attachmentRef = kind.ref;
  let sizeBytes = 1;
  if (!attachmentRef) {
    ({ attachmentRef, sizeBytes } = store.storeAttachmentBuffer(kind.bytes));
    blobs[attachmentRef] = kind.bytes.toString('base64');
  }
  return { type: kind.type, attachmentRef, mimeType: kind.mimeType, filename: kind.filename, sizeBytes };
};
const parts = Object.fromEntries(kinds.map((kind) => [kind.name, partOf(kind)]));
// A turn with the attachment, its answer and the turn after it: the attachment is history for the request.
const messagesOf = (name) => [
  { role: 'user', content: [{ type: 'text', text: 'look at this' }, structuredClone(parts[name])] },
  { role: 'assistant', content: 'seen' },
  { role: 'user', content: 'and now?' },
];

// What the extension host's extraction gave for the same bytes (the core replays these through its DocumentText seam):
// the text after the label line of Node's own lowering of the file as text.
const afterLabel = (text) => (/^--- [^\n]* ---\n/.test(text) ? text.replace(/^--- [^\n]* ---\n/, '') : null);
const extraction = { pdf: {}, office: {} };
for (const kind of kinds.filter((k) => k.bytes && k.type === 'file')) {
  const data = kind.bytes.toString('base64');
  const part = parts[kind.name];
  if (kind.mimeType === 'application/pdf') {
    const prepared = await media.preparePdfTextForProvider(messagesOf(kind.name), { nativePdf: false });
    extraction.pdf[data] = afterLabel(prepared[0].content[1].text);
    if (extraction.pdf[data] === null) throw new Error(`no extraction for ${kind.name}`);
  } else if (kind.mimeType === DOCX) {
    extraction.office[`${data}\0${kind.filename}`] = afterLabel(media.normalizeContentForAnthropic([part])[0].text);
  }
}

// ---- the families, each with the instances (capability combinations) Node has for it ----

const cfg = { baseURL: 'http://127.0.0.1:1', apiKey: 'k', preconnect: false };
const { AnthropicProvider } = await load(`${PROVIDERS}anthropic.mjs`);
const { DeepSeekProvider } = await load(`${PROVIDERS}deepseek.mjs`);
const { OpenRouterProvider } = await load(`${PROVIDERS}openrouter.mjs`);
const { OpenCodeGoProvider } = await load(`${PROVIDERS}opencode-go.mjs`);
const { createCustomProvider } = await load(`${PROVIDERS}custom-provider.mjs`);
const { OpenAICompatProvider } = await load(`${PROVIDERS}openai-compat.mjs`);
const { OpenAIDirectProvider } = await load(`${PROVIDERS}openai-ws.mjs`);
const { GeminiProvider } = await load(`${PROVIDERS}gemini.mjs`);
const { CursorApiProvider } = await load(`${PROVIDERS}cursor.mjs`);
const { MixdogLocalProvider } = await load(`${PROVIDERS}mixdog-local.mjs`);
const { DevinOAuthProvider } = await load(`${PROVIDERS}devin.mjs`);

// Every provider that sends over HTTP is sent to for real: its own `send` runs on the messages, down to the request the
// transport is handed, and the body that `fetch` receives is the row's. The transport answers 400 at once, so nothing
// leaves the machine and the send ends on that error (a send that fails before it reaches `fetch` is the row's error).
const sent = [];
globalThis.fetch = async (url, init) => {
  sent.push({ url: String(url?.url ?? url), body: init?.body === undefined ? null : String(init.body) });
  return new Response('{"error":{"message":"stop"}}', { status: 400, headers: { 'content-type': 'application/json' } });
};
const MODEL = 'model-under-test';
async function sendOnce(instance, messages, model) {
  sent.length = 0;
  try {
    await instance.send(messages, model, [], {});
  } catch (error) {
    if (sent.length === 0) throw error;
  }
  if (sent.length !== 1) throw new Error(`${sent.length} requests for one send`);
  return JSON.parse(sent[0].body);
}
const viaSend = (model = MODEL) => (instance, messages) => sendOnce(instance, messages, model);
// NORMALISED (one field, declared in the manifest): the Messages send resizes every image it carries
// (`prepareAnthropicImages`, sharp) and annotates a resized one with a text block; the table's 1x1 PNG is enlarged to
// 200x200. The recorded body keeps the stored bytes and drops the annotation, so everything else of the request is compared.
const viaMessages = async (instance, messages) => {
  const body = await sendOnce(instance, messages, MODEL);
  for (const message of body.messages) {
    if (!Array.isArray(message.content)) continue;
    message.content = message.content.filter((part) => !(part.type === 'text' && /^\[Image: [^\]]*\] These display dimensions supersede/.test(part.text)));
    for (const part of message.content) {
      if (part.type === 'image' && part.source?.type === 'base64') part.source = { ...part.source, data: PNG.toString('base64'), media_type: 'image/png' };
    }
  }
  return body;
};

// Devin: the chat request as `buildDevinChatRequest` builds it and the transport encodes it (`GetChatMessageRequest`).
const { buildDevinChatRequest } = await load(`${PROVIDERS}devin-wire-request.mjs`);
const { devinRequestMetadata } = await load(`${PROVIDERS}devin-wire-session.mjs`);
const { encodeDevinMessage } = await load(`${PROVIDERS}devin-wire-protobuf.mjs`);
const DEVIN_OS = '<os>';
const devinChat = (instance, messages) => {
  const { request } = buildDevinChatRequest(messages, {
    model: MODEL,
    modelRow: null,
    tools: [],
    metadata: { ...devinRequestMetadata({ apiKey: 'k', userJwt: 'j', client: 'cli' }), os: DEVIN_OS },
    cascadeId: 'cascade',
    executionId: 'execution',
  });
  return { chatRequest: Buffer.from(encodeDevinMessage('GetChatMessageRequest', request)).toString('base64') };
};

const families = [
  // The Messages wire: the built-in API, a gateway engine that takes a PDF natively (OpenRouter), one that takes no PDF
  // (OpenCode Go, a custom Anthropic gateway) and one that takes no document of any kind (DeepSeek).
  { family: 'anthropic-messages', provider: 'anthropic', make: () => new AnthropicProvider({ apiKey: 'k' }), build: viaMessages },
  { family: 'anthropic-messages', provider: 'openrouter', make: () => new OpenRouterProvider({ apiKey: 'or', preconnect: false }).anthropic, build: viaMessages },
  { family: 'anthropic-messages', provider: 'opencode-go', make: () => new OpenCodeGoProvider({ apiKey: 'k' }).anthropic, build: viaMessages },
  { family: 'anthropic-messages', provider: 'custom-anthropic', make: async () => createCustomProvider('custom-z', { name: 'z', protocol: 'anthropic', models: [{ id: 'm' }], ...cfg }), build: viaMessages },
  { family: 'anthropic-messages', provider: 'deepseek', make: () => new DeepSeekProvider({ apiKey: 'ds', preconnect: false }).anthropic, build: viaMessages },
  // The Chat Completions wire (every compat class lowers a PDF to text) and the Responses wire of the compat classes.
  { family: 'openai-chat', provider: 'deepseek-chat', make: () => new OpenAICompatProvider('deepseek', cfg), build: viaSend() },
  { family: 'openai-responses-compat', provider: 'xai', make: () => new OpenAICompatProvider('xai', cfg), build: viaSend() },
  // The built-in Responses wire takes a PDF natively and sends over a WebSocket: the body is `buildRequestBody`'s, which
  // the socket send serialises (openai-ws.mjs:134).
  { family: 'openai-responses', provider: 'openai', make: () => new OpenAIDirectProvider({ apiKey: 'k' }), build: async (instance, messages) => buildRequestBody(await media.preparePdfTextForProvider(messages, instance), MODEL, [], { promptCacheProvider: 'openai' }) },
  { family: 'gemini', provider: 'gemini', make: () => new GeminiProvider({ apiKey: 'k' }), build: viaSend('gemini-test'), model: 'gemini-test' },
  {
    // Cursor sends a protobuf frame over HTTP/2 that `buildRunRequest` (not exported) assembles from `parseMessages`'s
    // result; the row is that result, which is everything an attachment changes in the frame.
    family: 'cursor',
    provider: 'cursor-api',
    make: () => new CursorApiProvider({ apiKey: 'k' }),
    build: async (instance, messages) => {
      const parsed = parseMessages(toCursorMessages(await media.preparePdfTextForProvider(messages, instance), 'cursor-api', { nativePdf: instance.nativePdf }));
      return {
        systems: parsed.systems,
        history: parsed.history,
        userText: parsed.userText,
        userImages: parsed.userImages.map((image) => ({ mimeType: image.mimeType, data: Buffer.from(image.data).toString('base64') })),
      };
    },
  },
  // Devin (Cascade): no document block, and no vision on a text-only model; the whole chat request.
  { family: 'devin', provider: 'devin-oauth', make: () => new DevinOAuthProvider({}), build: async (instance, messages) => devinChat(instance, await media.preparePdfTextForProvider(messages, instance)), vision: false },
  {
    // The managed local model: text-only, so a request is degraded before it is lowered (and may be refused). Its own
    // `send` runs; the only seams are the ones the class takes for it: the server it would start (an address nothing
    // listens on) and the queue that runs a request (run at once).
    family: 'openai-chat-text-only',
    provider: 'mixdog-local',
    make: () =>
      new MixdogLocalProvider({}, {
        ensureServer: async () => ({ baseURL: 'http://127.0.0.1:1', apiKey: 'k' }),
        runRequest: (run) => run(new AbortController().signal),
      }),
    build: viaSend(),
    vision: false,
  },
];

const rows = [];
for (const spec of families) {
  const instance = await spec.make();
  const capabilities = { nativePdf: instance.nativePdf ?? null, nativeDocuments: instance.nativeDocuments ?? null, vision: spec.vision ?? true };
  for (const kind of kinds) {
    const messages = messagesOf(kind.name);
    let body;
    let error = null;
    try {
      body = JSON.parse(JSON.stringify(await spec.build(instance, structuredClone(messages))));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    rows.push({ family: spec.family, provider: spec.provider, model: spec.model ?? MODEL, capabilities, kind: kind.name, messages, ...(error === null ? { body } : { error }) });
  }
}

const finalDir = join(FIXTURES_ROOT, 'media-wire');
const outDir = stageSet(finalDir);
writeJson(join(outDir, 'table.json'), { blobs, extraction, rows });
writeSetManifest(outDir, {
  set: 'media-wire',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of b6f10295a>`,
  extra: {
    values: 'plain JSON: each row is the whole request body of the provider\'s own send (the JSON its transport was handed, captured at `fetch` with every provider\'s real `send`; the built-in Responses wire\'s `buildRequestBody`, which its socket send serialises; Devin\'s `GetChatMessageRequest` bytes as base64; the managed local model through its own `send`); only Cursor\'s row is a part of its request (below)',
    normalised: [
      'anthropic-messages rows, field messages[].content[] (image parts): the Messages send resizes every image (`prepareAnthropicImages`, sharp: the table\'s 1x1 PNG is enlarged to 200x200) and puts an annotation text block before a resized one. The recorder drops the annotation and writes the stored PNG bytes back, so the rest of the request is compared. The core\'s Messages send does not resize: an open difference, named in the report, not a declared equality',
      'devin row, field metadata.os of the request (the host\'s OS name): the recorder writes `<os>` and the replay sets the same value',
    ],
    exclusions: [
      'replay, side core: the replay\'s provider declares the capabilities its row recorded (`capabilities`, the flags of the Node instance), because the run loop reads them from the adapter it is given; the flags of the core\'s own adapters are compared with the same rows by mixdog-ai registry::builder::tests::each_route_takes_the_documents_nodes_instance_declared',
      'extraction, side node: the text of a PDF (pdf.js, first 100 pages, 256 KiB, the fixed unreadable text) and of an Office file is the extension host\'s, which runs Node\'s own code; the replay\'s DocumentText answers each file of the table with what Node\'s lowering gave for the same bytes (`extraction`, the text after the label line of Node\'s own lowering). The table\'s PDFs are one page, so the page and size limits and the truncation of a long extraction are compared by the media-text set instead (`fixtures/tools/media-text/pdf.json`: 105 pages, 300 KB of text; replayed by mixdog-exthost tests/it/pool.rs); the unreadable PDF and the unreadable Office container are exercised here',
      'opencode-go and deepseek-chat flags, side core: both are now built by the product\'s builder (`opencode-go-oauth` on a model its routing sends to Messages, `deepseek` on the one-shot Chat route) and their flags compared with these rows by mixdog-ai registry::builder::tests::each_route_takes_the_documents_nodes_instance_declared',
      'mixdog-local flags, side core: the registry never builds the managed local route (`builder.rs`: "built per turn from the managed runtime\'s endpoint"); the product builds its media layer per turn (`ManagedLocalModels::media`: `MediaLowering::new(.., LOCAL_PROVIDER_ID)`, the text-only route), which is what the replay runs (`TextOnlyInput`). That route lowers every PDF to text and every image to the omitted text whatever flags an adapter declares, so `nativePdf` / `vision` of the Node instance are not read from a core adapter',
      'cursor row, side node and core: Cursor sends a protobuf frame over HTTP/2 that `buildRunRequest` (not exported) assembles from `parseMessages`\'s result; the core\'s `CursorCodec::encode` frames the run it was built with. The row is `parseMessages`\'s result (systems, history, user text, user images), which is everything an attachment changes in the frame, not the frame',
      'families not in the table, side node: anthropic-oauth, openai-oauth, vertex-ai and antigravity-oauth share the builder of the row that names their wire (anthropic, openai, gemini) and declare the same flags (provider-native-pdf.test.mjs); grok-oauth, cursor-oauth and the other compat classes share the xai / cursor-api / deepseek-chat rows\' lowering with nativePdf false; opencode-go\'s and command-code\'s Gemini and Responses engines take the rows of their families',
      'refused requests, side node: no row of the table is refused by Node (every request carries text beside its attachment), so the core\'s refusal of a media-only turn on the text-only route is compared by the text-only goldens (fixtures/agent/text_only) and not here',
      'anthropic-messages rows, side node: citations, context and cache_control a caller puts on a document block are not part of a stored file reference and are not recorded',
    ],
    ...recorderProvenance(import.meta.url),
  },
  identity,
});
commitStage(outDir, finalDir);
console.log(`recorded ${rows.length} rows`);
process.exit(0);
