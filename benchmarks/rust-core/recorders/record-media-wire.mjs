// What an attached file becomes on the wire in Node b6f10295a (the 1.4.5 release): one table, per provider family and
// capability combination (the instance's own `nativePdf` / `nativeDocuments`) × attachment kind (a stored image, PDF,
// text file, Office document, unknown binary, and blobs that are gone) → what the request carries.
//
//   node benchmarks/rust-core/recorders/record-media-wire.mjs --tree <exact export of b6f10295a>
//
// Each row is what the provider's own send does to the messages, step for step, from Node's real modules: the
// instance's flags, `preparePdfTextForProvider(messages, instance)` (the awaited pre-send step every provider that can
// take a PDF as text runs on every attempt), then the family's lowering of the prepared messages
// (anthropic-request-utils `toAnthropicMessages`, openai-compat-wire `toOpenAIMessages` / `toXaiResponsesInput`,
// openai-responses-payload `buildRequestBody`, gemini-schema `toGeminiContents`, cursor `toCursorMessages` +
// cursor-wire-request `parseMessages`, and the managed local model's `assertLocalModelInput` +
// `toLocalProviderMessages`). The attachments are stored in Node's real attachment store, which every lowering reads
// them back from (`readAttachmentBase64`).
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
const { toAnthropicMessages } = await load(`${PROVIDERS}lib/anthropic-request-utils.mjs`);
const { toOpenAIMessages, toXaiResponsesInput } = await load(`${PROVIDERS}openai-compat-wire.mjs`);
const { buildRequestBody } = await load(`${PROVIDERS}openai-responses-payload.mjs`);
const { toGeminiContents } = await load(`${PROVIDERS}gemini-schema.mjs`);
const { __cursorModelInternals: { toCursorMessages } } = await load(`${PROVIDERS}cursor.mjs`);
const { parseMessages } = await load(`${PROVIDERS}cursor-wire-request.mjs`);
const { assertLocalModelInput } = await load('src/runtime/local-provider/input-capabilities.mjs');
const { toLocalProviderMessages } = await load(`${PROVIDERS}mixdog-local-wire.mjs`);
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
const messagesOf = (name, lastTurn = false) => [
  { role: 'user', content: [{ type: 'text', text: 'look at this' }, structuredClone(parts[name])] },
  // The Devin router prompt reads the latest turn alone, so its row ends on the attachment.
  ...(lastTurn ? [] : [{ role: 'assistant', content: 'seen' }, { role: 'user', content: 'and now?' }]),
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
const { devinRouterPrompt } = await load(`${PROVIDERS}devin-wire-request.mjs`);

const anthropicWire = (prepared, provider) => toAnthropicMessages(prepared, [], provider);
const chatWire = (name) => (prepared, instance) => toOpenAIMessages(prepared, name, { nativePdf: instance.nativePdf });
const families = [
  // The Messages wire: the built-in API, a gateway engine that takes a PDF natively (OpenRouter), one that takes no PDF
  // (OpenCode Go, a custom Anthropic gateway) and one that takes no document of any kind (DeepSeek).
  { family: 'anthropic-messages', provider: 'anthropic', body: 'messages', make: () => new AnthropicProvider({ apiKey: 'k' }), lower: (p) => anthropicWire(p, 'anthropic') },
  { family: 'anthropic-messages', provider: 'openrouter', body: 'messages', make: () => new OpenRouterProvider({ apiKey: 'or', preconnect: false }).anthropic, lower: (p) => anthropicWire(p, 'openrouter') },
  { family: 'anthropic-messages', provider: 'opencode-go', body: 'messages', make: () => new OpenCodeGoProvider({ apiKey: 'k' }).anthropic, lower: (p) => anthropicWire(p, 'opencode-go') },
  { family: 'anthropic-messages', provider: 'custom-anthropic', body: 'messages', make: async () => createCustomProvider('custom-z', { name: 'z', protocol: 'anthropic', models: [{ id: 'm' }], ...cfg }), lower: (p) => anthropicWire(p, 'custom-z') },
  { family: 'anthropic-messages', provider: 'deepseek', body: 'messages', make: () => new DeepSeekProvider({ apiKey: 'ds', preconnect: false }).anthropic, lower: (p) => anthropicWire(p, 'deepseek') },
  // The Chat Completions wire (every compat class lowers a PDF to text) and the Responses wire of the compat classes.
  { family: 'openai-chat', provider: 'deepseek-chat', body: 'messages', make: () => new OpenAICompatProvider('deepseek', cfg), lower: chatWire('deepseek') },
  { family: 'openai-responses-compat', provider: 'xai', body: 'input', make: () => new OpenAICompatProvider('xai', cfg), lower: (p, i) => toXaiResponsesInput(p, null, { providerName: 'xai', nativePdf: i.nativePdf }).input },
  // The built-in Responses wire takes a PDF natively.
  { family: 'openai-responses', provider: 'openai', body: 'input', make: () => new OpenAIDirectProvider({ apiKey: 'k' }), lower: (p) => buildRequestBody(p, 'gpt-test', [], { promptCacheProvider: 'openai' }).input },
  { family: 'gemini', provider: 'gemini', body: 'contents', make: () => new GeminiProvider({ apiKey: 'k' }), lower: (p) => toGeminiContents(p, 'gemini-test') },
  {
    family: 'cursor',
    provider: 'cursor-api',
    body: 'parsed',
    make: () => new CursorApiProvider({ apiKey: 'k' }),
    lower: (p, i) => {
      const parsed = parseMessages(toCursorMessages(p, 'cursor-api', { nativePdf: i.nativePdf }));
      return {
        systems: parsed.systems,
        history: parsed.history,
        userText: parsed.userText,
        userImages: parsed.userImages.map((image) => ({ mimeType: image.mimeType, data: Buffer.from(image.data).toString('base64') })),
      };
    },
  },
  {
    // Devin (Cascade): no document block, and no vision on a text-only model; the router prompt lowers the latest turn.
    family: 'devin',
    provider: 'devin-oauth',
    body: 'prompt',
    lastTurn: true,
    make: () => new DevinOAuthProvider({}),
    lower: (p) => {
      const prompt = devinRouterPrompt(p, { vision: false });
      return { prompt: prompt.prompt, images: prompt.images };
    },
  },
  {
    // The managed local model: text-only, so a request is degraded before it is lowered (and may be refused).
    family: 'openai-chat-text-only',
    provider: 'mixdog-local',
    body: 'messages',
    make: () => new MixdogLocalProvider({}),
    lower: (p, i) => toOpenAIMessages(toLocalProviderMessages(assertLocalModelInput({ id: 'm', name: 'Local Model' }, p, [], {}, {})), 'mixdog-local', { nativePdf: i.nativePdf }),
  },
];

const exactJson = (value) => JSON.parse(JSON.stringify(value));
const rows = [];
for (const spec of families) {
  const instance = await spec.make();
  const capabilities = { nativePdf: instance.nativePdf ?? null, nativeDocuments: instance.nativeDocuments ?? null };
  for (const kind of kinds) {
    const messages = messagesOf(kind.name, spec.lastTurn === true);
    let body;
    let error = null;
    try {
      const prepared = await media.preparePdfTextForProvider(structuredClone(messages), instance);
      body = exactJson(spec.lower(prepared, instance));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    rows.push({ family: spec.family, provider: spec.provider, capabilities, kind: kind.name, messages, wire: spec.body, ...(error === null ? { body } : { error }) });
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
    values: 'plain JSON: each row is the request-body part the family builds from the messages (`wire`: messages, input, contents, or the cursor request\'s parsed history)',
    exclusions: [
      'replay, side core: the replay\'s provider declares the capabilities its row recorded (`capabilities`, the flags of the Node instance), because the run loop reads them from the adapter it is given; the flags of the core\'s own adapters are compared with the same rows by mixdog-ai registry::builder::tests::each_route_takes_the_documents_nodes_instance_declared',
      'extraction, side node: the text of a PDF (pdf.js, first 100 pages, 256 KiB, the fixed unreadable text) and of an Office file is the extension host\'s, which runs Node\'s own code; the replay\'s DocumentText answers each file of the table with what Node\'s lowering gave for the same bytes (`extraction`, the text after the label line of Node\'s own lowering). The table\'s PDFs are one page, so the page and size limits and the truncation of a long extraction are not exercised here; the unreadable PDF and the unreadable Office container are',
      'opencode-go, side core: the core\'s OpenCode Go adapter needs a stored OAuth login to be built, so its flags (no PDF, no document-less rule) are compared only through the arm that builds every Messages engine without a declaration of its own (registry/builder.rs gateway_messages_engine), shared with the custom Anthropic row; the row itself replays',
      'deepseek-chat and mixdog-local flags, side core: Node\'s OpenAICompatProvider class (Chat wire of every compat class) and MixdogLocalProvider declare nativePdf false; the core has no builder name that routes a model to a Chat engine of its own for the first (the Messages route of the same gateway is the deepseek row), and the managed local route is the text-only route the replay runs with its own wiring (TextOnlyInput), not a registered adapter',
      'devin, side core and node: Node\'s row is `devinRouterPrompt` (the latest turn lowered by `loweredContent`), the core\'s `router_prompt`; the full chat request needs a session exchange and is not recorded. Only the latest turn is compared, so the row ends on the attachment',
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
