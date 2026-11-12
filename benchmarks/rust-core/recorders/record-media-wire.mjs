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
// `GetChatMessageRequest`, and Cursor's run frame as its HTTP/2 transport is handed it. The Messages wire's images are
// the resized ones, annotation included (`prepareAnthropicImages`). The attachments are stored in Node's real attachment
// store, which every lowering reads them back from (`readAttachmentBase64`).
import nodeCrypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import http2 from 'node:http2';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
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

// Images that pin `prepareAnthropicImages` (the Messages wire resizes every image it carries): one per side of each rule
// of `resizeImageBuffer` under the `anthropic` profile (edge limit 1568, patch budget 1568 of 28 px, floor 200 px on the
// short edge, 3.75 MB raw / 5 MiB base64 / token budget) and one per outcome (kept as is, re-encoded, refused).
const sharp = createRequire(join(tree, 'package.json'))('sharp');
const flat = (width, height) => sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 60 } } });
// Incompressible pixels from a fixed generator (xorshift), so the recording is the same on every run.
const noise = (width, height) => {
  const raw = Buffer.alloc(width * height * 4);
  let state = 0x2545f491;
  for (let i = 0; i < raw.length; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    raw[i] = state & 255;
  }
  return sharp(raw, { raw: { width, height, channels: 4 } });
};
const MESSAGES_ONLY = ['anthropic-messages'];
const imageKind = (name, bytes, mimeType, extra = {}) => ({ name, type: 'image', bytes, mimeType, filename: `${name}.img`, families: MESSAGES_ONLY, ...extra });
const imageKinds = [
  imageKind('image-below-minimum', await flat(100, 50).png().toBuffer(), 'image/png'),
  imageKind('image-in-range', await flat(640, 480).png().toBuffer(), 'image/png'),
  imageKind('image-wide', await flat(2000, 300).png().toBuffer(), 'image/png'),
  imageKind('image-tall', await flat(300, 2000).png().toBuffer(), 'image/png'),
  imageKind('image-patch-budget', await flat(2000, 1500).png().toBuffer(), 'image/png'),
  imageKind('image-jpeg-below-minimum', await flat(100, 100).jpeg().toBuffer(), 'image/jpeg'),
  imageKind('image-jpeg-in-range', await flat(640, 480).jpeg().toBuffer(), 'image/jpeg'),
  imageKind('image-webp-below-minimum', await flat(64, 64).webp().toBuffer(), 'image/webp'),
  imageKind('image-mislabelled', await flat(640, 480).png().toBuffer(), 'image/jpeg'),
  imageKind('image-undecodable', Buffer.from('this is not an image'), 'image/png'),
  // A system message ahead of an image the decoder refuses: the lowering removes it, so the refusal names the wire's index.
  imageKind('image-undecodable-after-system', Buffer.from('this is not an image either'), 'image/png', { providers: ['anthropic'], system: 'Be brief.' }),
  // 1090x1090 RGBA noise: inside the patch budget (39 x 39) yet 4.7 MB raw, so only the byte cap and the token budget act.
  imageKind('image-over-byte-cap', await noise(1090, 1090).png({ compressionLevel: 0 }).toBuffer(), 'image/png', { providers: ['anthropic'] }),
];

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
  ...imageKinds,
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
  ...(kinds.find((k) => k.name === name).system ? [{ role: 'system', content: kinds.find((k) => k.name === name).system }] : []),
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
const cursorRuntime = await load(`${PROVIDERS}cursor-wire.mjs`);
const { FALLBACK_MODELS, withCanonicalAutoModels } = await load(`${PROVIDERS}cursor-wire-normalization.mjs`);
const { MixdogLocalProvider } = await load(`${PROVIDERS}mixdog-local.mjs`);
const { DevinOAuthProvider } = await load(`${PROVIDERS}devin.mjs`);

// Every provider that sends over HTTP is sent to for real: its own `send` runs on the messages, down to the request the
// transport is handed, and the body that `fetch` receives is the row's. The transport answers 400 at once, so nothing
// leaves the machine and the send ends on that error (a send that fails before it reaches `fetch` is the row's error).
const sent = [];
globalThis.fetch = async (url, init) => {
  sent.push({ url: String(url?.url ?? url), body: init?.body === undefined ? null : typeof init.body === 'string' ? init.body : Buffer.from(init.body) });
  return new Response('{"error":{"message":"stop"}}', { status: 400, headers: { 'content-type': 'application/json' } });
};
const MODEL = 'model-under-test';
// The Cursor row's conversation (its id derives from this scope) and the value `crypto.randomUUID` is pinned to.
const CURSOR_SCOPE = 'media-wire';
const CURSOR_UUID = '00000000-0000-4000-8000-000000000000';
async function sendOnce(instance, messages, model) {
  sent.length = 0;
  try {
    await instance.send(messages, model, [], {});
  } catch (error) {
    if (sent.length === 0) throw error;
  }
  // A body of 8 KiB or more to the official Messages URL goes out gzip-compressed, and the answer 400 sends it once more
  // plain (`sendWithCompression`): the two are the same request.
  const texts = sent.map(({ body }) => (Buffer.isBuffer(body) && body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body).toString());
  if (sent.length < 1 || sent.length > 2 || texts.some((text) => text !== texts[0])) throw new Error(`${sent.length} requests for one send`);
  return JSON.parse(texts[0]);
}
const viaSend = (model = MODEL) => (instance, messages) => sendOnce(instance, messages, model);
// The Messages send resizes every image it carries (`prepareAnthropicImages`, sharp) and annotates a resized one with a
// text block: the body recorded is the resized one, annotation included; an image it refuses is the row's error.
const viaMessages = viaSend();

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
    // Cursor's own `send` runs against the real wire runtime; the HTTP/2 connection it opens is the one captured
    // (`http2.connect` answers a session whose request records what is written to it and ends with a 400), so the row is
    // the run frame the transport was handed, whole. The two seams besides the transport: the model catalog (the runtime's
    // `getCursorModels` would ask the network; the fallback list stands in) and `crypto.randomUUID`, which names the user
    // message and each image of the frame and is pinned to one value for the call.
    family: 'cursor',
    provider: 'cursor-api',
    make: () => new CursorApiProvider({ accessToken: 'k', runtime: { ...cursorRuntime, getCursorModels: async () => Object.assign(withCanonicalAutoModels(FALLBACK_MODELS), { fallback: true }) } }),
    build: async (instance, messages) => {
      const written = [];
      const connect = http2.connect;
      const randomUUID = nodeCrypto.randomUUID;
      http2.connect = () => {
        const session = Object.assign(new EventEmitter(), { close() {}, destroy() {}, ping() {} });
        session.request = () => {
          const request = Object.assign(new EventEmitter(), { close() {}, end() {} });
          request.write = (bytes) => {
            written.push(Buffer.from(bytes));
            if (written.length === 1) queueMicrotask(() => { request.emit('response', { ':status': 400 }); request.emit('end'); });
          };
          return request;
        };
        return session;
      };
      nodeCrypto.randomUUID = () => CURSOR_UUID;
      try {
        await instance.send(messages, MODEL, [], { sessionId: CURSOR_SCOPE });
      } catch (error) {
        if (written.length === 0) throw error;
      } finally {
        http2.connect = connect;
        nodeCrypto.randomUUID = randomUUID;
      }
      if (written.length === 0) throw new Error('no frame was written');
      return { frame: written[0].toString('base64') };
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
  for (const kind of kinds.filter((k) => (k.families ?? [spec.family]).includes(spec.family) && (k.providers ?? [spec.provider]).includes(spec.provider))) {
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
    values: 'plain JSON: each row is the whole request body of the provider\'s own send (the JSON its transport was handed, captured at `fetch` with every provider\'s real `send`; the built-in Responses wire\'s `buildRequestBody`, which its socket send serialises; Devin\'s `GetChatMessageRequest` bytes as base64; the managed local model through its own `send`; Cursor\'s run frame as its HTTP/2 transport was handed it, base64); the Messages wire\'s images are the ones `prepareAnthropicImages` made (resized, annotation text included) and an image it refuses is the row\'s error',
    normalised: [
      'cursor row, the uuids of the frame: Node\'s `crypto.randomUUID` is pinned to 00000000-0000-4000-8000-000000000000 for the call (it names the user message and each image of the frame); the core draws the image uuids at random, so the replay passes the same value as the message id and writes it over every other uuid-shaped string of its frame except the conversation id (derived from the session scope on both sides, compared as is)',
      'devin row, field metadata.os of the request (the host\'s OS name): the recorder writes `<os>` and the replay sets the same value',
    ],
    exclusions: [
      'replay, side core: the replay\'s provider declares the capabilities its row recorded (`capabilities`, the flags of the Node instance), because the run loop reads them from the adapter it is given; the flags of the core\'s own adapters are compared with the same rows by mixdog-ai registry::builder::tests::each_route_takes_the_documents_nodes_instance_declared',
      'extraction, side node: the text of a PDF (pdf.js, first 100 pages, 256 KiB, the fixed unreadable text) and of an Office file is the extension host\'s, which runs Node\'s own code; the replay\'s DocumentText answers each file of the table with what Node\'s lowering gave for the same bytes (`extraction`, the text after the label line of Node\'s own lowering). The table\'s PDFs are one page, so the page and size limits and the truncation of a long extraction are compared by the media-text set instead (`fixtures/tools/media-text/pdf.json`: 105 pages, 300 KB of text; replayed by mixdog-exthost tests/it/pool.rs); the unreadable PDF and the unreadable Office container are exercised here',
      'opencode-go and deepseek-chat flags, side core: both are now built by the product\'s builder (`opencode-go-oauth` on a model its routing sends to Messages, `deepseek` on the one-shot Chat route) and their flags compared with these rows by mixdog-ai registry::builder::tests::each_route_takes_the_documents_nodes_instance_declared',
      'mixdog-local flags, side core: the registry never builds the managed local route (`builder.rs`: "built per turn from the managed runtime\'s endpoint"); the product builds its media layer per turn (`ManagedLocalModels::media`: `MediaLowering::new(.., LOCAL_PROVIDER_ID)`, the text-only route), which is what the replay runs (`TextOnlyInput`). That route lowers every PDF to text and every image to the omitted text whatever flags an adapter declares, so `nativePdf` / `vision` of the Node instance are not read from a core adapter',
      'cursor row, side node: the model catalog (`getCursorModels`, which asks the network) is the runtime\'s fallback list; every other part of Cursor\'s send runs, the HTTP/2 session being the captured transport. Side core: the replay builds the frame with `build_run` and the connect envelope `CursorCodec::encode` writes, on the model Node\'s send resolved the same name to (no catalog entry: the name itself, no parameters)',
      'anthropic-messages rows, side core: the images are fitted by the extension host\'s `sharp` (Node\'s own `resizeImageBuffer` run by the real worker, the same code that produced the recorded bytes), so no encoder differs and the bytes are compared as they are; the replay starts that worker (node and `sharp` from the repository\'s node_modules)',
      'anthropic-messages rows, kinds image-below-minimum .. image-over-byte-cap: recorded for the five Messages providers (the over-byte-cap image and the undecodable one behind a system message for the built-in API only, the first recording being 6 MB); the other families lower an image to the provider\'s own block and carry the stored bytes, which the table\'s one image row pins',
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
