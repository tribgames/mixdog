#!/usr/bin/env node
// WP-AI-OTHER recordings of today's Node product for the two P0-BENCH gaps that
// the shared intercept hub cannot express (its HTTP leg records request bodies
// as utf-8 text and its h2 leg answers only after the request stream ended):
//   - devin-oauth: success framing (gzip Connect frames + end-stream trailer),
//     stream/trailer errors and truncation, protobuf bodies kept as base64;
//   - cursor-api: the bidirectional Agent Run stream, answered frame by frame:
//     text, MCP tool call, end-stream errors, resets, EOF and partial frames.
// The shared hub still provides the module stand-ins (`node:http2`, fetch
// redirect) and determinism logging; this script only swaps its two loopback
// ports for servers of its own. No real host is contacted.
//
//   node benchmarks/rust-core/recorders/record-providers-ai-other.mjs --tree T [--patch <file>[,<file>...]] [--only devin-oauth|cursor-api]
// The Cursor scenarios are recorded from b6f10295a with node-patches/node-fix-cursor-end-frame-error.patch (a Connect end frame carrying an error
// reaches the bridge as that error, not as the `aborted` its own cancel raises), and node-fix-scrub-echoed-credential.patch beside it.
import http from 'node:http';
import http2 from 'node:http2';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { FIXTURES_ROOT, commitStage, nodeTreeIdentity, stageSet, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';
import { cleanHeaders } from './lib/headers.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const args = parseArgs();
const tree = resolveTree(args);
const only = args.get('only');
const dataDir = mkdtempSync(join(tmpdir(), 'bench-ai-other-data-'));
process.env.MIXDOG_DATA_DIR = dataDir;
process.env.MIXDOG_HOME = join(dataDir, 'home');
process.env.HOME = process.env.USERPROFILE = join(dataDir, 'home');
for (const k of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET/.test(k) && !/^MIXDOG_/.test(k)) delete process.env[k];
// Retry waits only; request bytes and frame order do not depend on them.
Object.assign(process.env, { MIXDOG_CURSOR_STREAM_RETRY_BASE_MS: '5', MIXDOG_CURSOR_STREAM_RETRY_MAX_MS: '10' });

const { install } = await import(pathToFileURL(join(import.meta.dirname, 'lib/intercept.mjs')).href);
const hub = await install(tree);
const P = (f) => import(pathToFileURL(join(tree, 'src/runtime/agent/orchestrator/providers', f)).href);
const cursorPb = await P('cursor-wire-protobuf.mjs');
const devinPb = await P('devin-wire-protobuf.mjs');

const FAR = Date.now() + 10 * 365 * 24 * 3600 * 1000;
const cred = (name, doc) => writeFileSync(join(dataDir, name), JSON.stringify(doc));
const j = JSON.stringify;
const TOOLS = [{ name: 'lookup', description: 'Read a value', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }];
const MSG = [{ role: 'system', content: 'You are a fixture assistant.' }, { role: 'user', content: 'Look up the answer.' }];
const b64 = (buf) => Buffer.from(buf).toString('base64');
const frame = (payload, flags = 0) => {
  const out = Buffer.alloc(5 + payload.length);
  out[0] = flags;
  out.writeUInt32BE(payload.length, 1);
  Buffer.from(payload).copy(out, 5);
  return out;
};
const endStream = (body = {}) => frame(Buffer.from(j(body)), 2);

// ---- own loopback servers, wired in place of the hub's -------------------------------
const textLike = (headers) => /json|text|xml|urlencoded/.test(headers['content-type'] ?? '');
const httpServer = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const origin = req.headers['x-bench-origin'] ?? null;
  const rec = { transport: 'http', origin, method: req.method, path: req.url, headers: cleanHeaders(req.headers, origin), bodyBase64: b64(body), ...(textLike(req.headers) ? { bodyText: body.toString('utf8') } : {}) };
  hub.records.push(rec);
  const reply = hub.script.http(rec, hub.records.filter((r) => r.transport === 'http').length);
  rec.served = { status: reply.status ?? 200, contentType: reply.contentType, bodyBase64: b64(reply.body ?? '') };
  res.writeHead(reply.status ?? 200, { 'content-type': reply.contentType ?? 'application/json' });
  if (reply.truncate) {
    res.write(reply.body);
    setTimeout(() => res.destroy(), 20);
  } else res.end(reply.body);
});
await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
hub.httpPort = httpServer.address().port;

// Connect frames in a byte stream, as they complete.
const frameSplitter = (onFrame) => {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 5) {
      const len = pending.readUInt32BE(1);
      if (pending.length < 5 + len) return;
      onFrame(pending[0], pending.subarray(5, 5 + len));
      pending = pending.subarray(5 + len);
    }
  };
};
const h2Server = http2.createServer();
h2Server.on('stream', (stream, headers) => {
  stream.on('error', () => {});
  stream.session?.on('error', () => {});
  const rec = { transport: 'h2', origin: hub.lastH2Origin ?? null, method: headers[':method'], path: headers[':path'], headers: cleanHeaders(headers, hub.lastH2Origin ?? null), frames: [] };
  hub.records.push(rec);
  const unary = headers['content-type'] === 'application/proto';
  if (unary) {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      rec.bodyBase64 = b64(Buffer.concat(chunks));
      const body = hub.script.h2Unary?.[headers[':path']]?.() ?? Buffer.alloc(0);
      rec.served = { status: 200, bodyBase64: b64(body) };
      stream.respond({ ':status': 200, 'content-type': 'application/proto' });
      stream.end(body);
    });
    return;
  }
  // Bidi Run: record every client frame and answer from the first one (the run request).
  const out = {
    respond: (status = 200) => { rec.status = status; stream.respond({ ':status': status, 'content-type': 'application/connect+proto' }); },
    write: (buf) => { rec.frames.push({ dir: 'out', flags: buf[0], base64: b64(buf.subarray(5)) }); stream.write(buf); },
    writeRaw: (buf) => { rec.frames.push({ dir: 'out-raw', base64: b64(buf) }); stream.write(buf); },
    end: () => stream.end(),
    reset: () => stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR),
  };
  let answered = false;
  stream.on('data', frameSplitter((flags, payload) => {
    rec.frames.push({ dir: 'in', flags, base64: b64(payload) });
    if (!answered) {
      answered = true;
      hub.script.h2Run(out, rec);
    }
  }));
  stream.on('end', () => { rec.clientEnded = true; });
});
await new Promise((r) => h2Server.listen(0, '127.0.0.1', r));
hub.h2Port = h2Server.address().port;

// ---- shared HTTP router -------------------------------------------------------------------
const json = (body, status = 200) => ({ status, contentType: 'application/json', body: j(body) });
const cursorHttp = (rec) => {
  if (/exchange_user_api_key/.test(rec.path)) return json({ accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token' });
  return { status: 404, contentType: 'text/plain', body: '' };
};

// ---- cursor-api ---------------------------------------------------------------------------------
const srv = (m) => cursorPb.encodeMessage('AgentServerMessage', m);
const upd = (u) => frame(srv({ interactionUpdate: u }));
const textFrame = (text) => upd({ textDelta: { text } });
const turnEnded = () => upd({ turnEnded: {} });
const tokens = (n) => upd({ tokenDelta: { tokens: n } });
const mcpExec = () => frame(srv({ execServerMessage: { id: 1, execId: 'exec-1', mcpArgs: { name: 'lookup', toolName: 'lookup', providerIdentifier: 'mixdog', toolCallId: 'call_fx1', args: { key: cursorPb.encodeJsonValue('answer') } } } }));
const cursorModels = () => cursorPb.encodeMessage('GetUsableModelsResponse', { models: [{ modelId: 'cursor-fixture', displayName: 'Cursor Fixture' }] });
const cursorScript = (run) => ({
  http: cursorHttp,
  h2Unary: {
    '/aiserver.v1.AiService/AvailableModels': () => cursorPb.encodeMessage('AvailableModelsResponse', { models: [], useModelParameters: false }),
    '/agent.v1.AgentService/GetUsableModels': cursorModels,
  },
  h2Run: run,
});
const finishWith = (out, frames, tail) => { out.respond(); frames.forEach((f) => out.write(f)); tail(out); };
const cursorScenarios = {
  text: () => cursorScript((out) => finishWith(out, [textFrame('The result '), textFrame('is 42.'), tokens(8), turnEnded()], (o) => { o.write(endStream()); o.end(); })),
  'tool-call': () => cursorScript((out) => finishWith(out, [mcpExec(), turnEnded()], (o) => { o.write(endStream()); o.end(); })),
  'bidi-eof-after-turn-ended': () => cursorScript((out) => finishWith(out, [textFrame('The result is 42.'), tokens(8), turnEnded()], (o) => o.end())),
  'bidi-end-stream-invalid-argument': () => cursorScript((out) => finishWith(out, [], (o) => { o.write(endStream({ error: { code: 'invalid_argument', message: 'fixture bad request' } })); o.end(); })),
  'bidi-end-stream-unauthenticated': () => cursorScript((out) => finishWith(out, [], (o) => { o.write(endStream({ error: { code: 'unauthenticated', message: 'fixture rejected' } })); o.end(); })),
  'bidi-end-stream-resource-exhausted': () => cursorScript((out) => finishWith(out, [], (o) => { o.write(endStream({ error: { code: 'resource_exhausted', message: 'fixture quota' }, metadata: { 'retry-after': ['7'] } })); o.end(); })),
  'bidi-end-stream-unavailable': () => cursorScript((out) => finishWith(out, [], (o) => { o.write(endStream({ error: { code: 'unavailable', message: 'fixture down' } })); o.end(); })),
  'bidi-end-stream-after-text': () => cursorScript((out) => finishWith(out, [textFrame('The result ')], (o) => { o.write(endStream({ error: { code: 'internal', message: 'fixture mid-stream failure' } })); o.end(); })),
  'bidi-http-500': () => cursorScript((out) => { out.respond(500); out.end(); }),
  'bidi-truncated-reset-before-output': () => cursorScript((out) => { out.respond(); out.reset(); }),
  'bidi-truncated-reset-after-text': () => cursorScript((out) => finishWith(out, [textFrame('The result ')], (o) => setTimeout(() => o.reset(), 30))),
  'bidi-truncated-eof-no-turn-end': () => cursorScript((out) => finishWith(out, [textFrame('The result ')], (o) => o.end())),
  'bidi-truncated-mid-frame': () => cursorScript((out) => { out.respond(); out.writeRaw(Buffer.concat([textFrame('The result ').subarray(0, 9)])); out.end(); }),
};

// ---- devin-oauth ----------------------------------------------------------------------------------
const dEnc = (type, msg) => devinPb.encodeDevinMessage(type, msg);
const gz = (type, msg) => frame(gzipSync(dEnc(type, msg)), 1);
const chat = (msg) => gz('GetChatMessageResponse', msg);
const FUNCTION_CALL = 10;
const devinHttp = (chatReply) => (rec) => {
  if (rec.path.endsWith('/GetUserJwt')) return { contentType: 'application/proto', body: dEnc('GetUserJwtResponse', { userJwt: 'fixture-user-jwt' }) };
  if (rec.path.endsWith('/GetCliModelConfigs')) {
    return { contentType: 'application/proto', body: dEnc('GetCliModelConfigsResponse', { clientModelConfigs: [{ label: 'Devin Fixture', modelUid: 'devin-fixture', maxTokens: 200000, modelInfo: { maxTokens: 200000, modelUid: 'devin-fixture', displayOption: 8, modelFeatures: { supportsToolCalls: true, supportsThinking: true } } }] }) };
  }
  return chatReply(rec);
};
const connectReply = (frames, extra = {}) => ({ contentType: 'application/connect+proto', body: Buffer.concat(frames), ...extra });
const devinScenario = (chatReply) => () => ({ http: devinHttp(chatReply) });
const usage = { inputTokens: 20, outputTokens: 8, cacheReadTokens: 4, cacheWriteTokens: 2 };
const devinScenarios = {
  text: devinScenario(() => connectReply([chat({ messageId: 'msg_fx', deltaText: 'The result ' }), chat({ deltaText: 'is 42.' }), chat({ usage, stopReason: 1, creditCost: 3 }), endStream()])),
  'text-thinking': devinScenario(() => connectReply([chat({ messageId: 'msg_fx', deltaThinking: 'Considering. ', deltaSignature: 'sig-' }), chat({ deltaThinking: 'Done.', deltaSignature: 'fx', deltaSignatureType: 'fixture' }), chat({ deltaText: 'The result is 42.' }), chat({ usage, stopReason: 1 }), endStream()])),
  'tool-call': devinScenario(() => connectReply([chat({ messageId: 'msg_fx', deltaToolCalls: [{ id: 'call_fx1', name: 'lookup', argumentsJson: '{"key":' }] }), chat({ deltaToolCalls: [{ id: 'call_fx1', argumentsJson: '"answer"}' }] }), chat({ usage, stopReason: FUNCTION_CALL }), endStream()])),
  'error-trailer-resource-exhausted': devinScenario(() => connectReply([endStream({ error: { code: 'resource_exhausted', message: 'fixture quota' } })])),
  'error-trailer-after-text': devinScenario(() => connectReply([chat({ deltaText: 'The result ' }), endStream({ error: { code: 'unavailable', message: 'fixture down' } })])),
  'error-http-401': devinScenario(() => ({ status: 401, contentType: 'application/json', body: j({ code: 'unauthenticated', message: 'fixture' }) })),
  'error-http-400': devinScenario(() => ({ status: 400, contentType: 'application/json', body: j({ code: 'invalid_argument', message: 'fixture' }) })),
  'truncated-no-trailer': devinScenario(() => connectReply([chat({ deltaText: 'The result ' })])),
  'truncated-mid-frame': devinScenario(() => connectReply([chat({ deltaText: 'The result ' }), chat({ deltaText: 'is 42.' }).subarray(0, 9)])),
  'truncated-reset': devinScenario(() => connectReply([chat({ deltaText: 'The result ' })], { truncate: true })),
};

const norm = (r) => ({ content: r?.content ?? null, toolCalls: (r?.toolCalls ?? []).map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })), stopReason: r?.stopReason ?? null, reasoningContent: r?.reasoningContent ?? null, usage: r?.usage ? { inputTokens: r.usage.inputTokens ?? null, outputTokens: r.usage.outputTokens ?? null, cachedTokens: r.usage.cachedTokens ?? null, cacheWriteTokens: r.usage.cacheWriteTokens ?? null } : null });
const errorFacts = (e) => ({ name: e?.name ?? null, message: String(e?.message ?? e).slice(0, 300), status: e?.status ?? e?.httpStatus ?? null, code: e?.code ?? null, cursorCode: e?.cursorCode ?? null, connectCode: e?.connectCode ?? null, retryable: e?.retryable ?? null, retryAfterMs: e?.retryAfterMs ?? null, reauthRequired: e?.reauthRequired ?? null, truncatedStream: e?.truncatedStream ?? null, unsafeToRetry: e?.unsafeToRetry ?? null, liveTextEmitted: e?.liveTextEmitted ?? null, providerRecoveryExhausted: e?.providerRecoveryExhausted ?? null });

const adapters = [
  { id: 'devin-oauth', setup: () => cred('devin-oauth.json', { access_token: 'fixture-access-token', expires_at: FAR }), make: async () => new (await P('devin.mjs')).DevinOAuthProvider({}), model: 'devin-fixture', scenarios: devinScenarios },
  { id: 'cursor-api', setup: () => cred('cursor-oauth.json', { access_token: 'fixture-access-token', expires_at: FAR }), make: async () => new (await P('cursor.mjs')).CursorApiProvider({ apiKey: 'fixture-key' }), model: 'cursor-fixture', scenarios: cursorScenarios },
];

const finalDir = join(FIXTURES_ROOT, 'providers-ai-other');
// Staged and swapped in only after the whole set is written (a crash keeps the old set).
const outDir = stageSet(finalDir, only ? [only] : null);
const recorded = [];
const unrecorded = [];
for (const a of adapters) {
  if (only && a.id !== only) continue;
  rmSync(join(outDir, a.id), { recursive: true, force: true });
  for (const [name, mk] of Object.entries(a.scenarios)) {
    try {
      a.setup();
      const dispatched = [];
      let result;
      await hub.run(mk(), async () => {
        try {
          const provider = await a.make();
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(new Error('recorder: no terminal after 45s')), 45000);
          try {
            result = { ok: norm(await provider.send(MSG, a.model, TOOLS, { signal: ac.signal, onToolCall: (c) => dispatched.push({ id: c.id, name: c.name, arguments: c.arguments }) })) };
          } finally { clearTimeout(timer); }
        } catch (e) {
          result = { error: errorFacts(e), ...(/recorder: no terminal/.test(String(e?.message ?? e)) ? { abortedByRecorder: true } : {}) };
        }
      }, `${a.id}/${name}`);
      // A parked cursor run keeps its stream and heartbeat; close it before the next scenario.
      globalThis.__mixdogDrainProviderConnections?.('recorder');
      const records = hub.records.map((r) => ({ ...r }));
      if (!records.length) { unrecorded.push({ id: a.id, scenario: name, reason: 'adapter made no network call', adapterResult: result }); continue; }
      const dir = join(outDir, a.id, name);
      writeJson(join(dir, 'exchange.json'), { transports: [...new Set(records.map((r) => r.transport))], records, determinism: hub.lastDeterminism });
      writeJson(join(dir, 'result.json'), { ...result, dispatchedToolCalls: dispatched });
      recorded.push(`${a.id}/${name}`);
    } catch (e) {
      unrecorded.push({ id: a.id, scenario: name, reason: String(e?.message ?? e).slice(0, 300) });
    }
  }
}
mkdirSync(outDir, { recursive: true });
writeJson(join(outDir, 'unrecorded.json'), { note: 'Scenarios that did not produce a recording, with the reason.', unrecorded });
const patch = args.get('patch');
writeSetManifest(outDir, {
  set: 'providers-ai-other',
  recorder: 'benchmarks/rust-core/recorders/record-providers-ai-other.mjs',
  command: `node benchmarks/rust-core/recorders/record-providers-ai-other.mjs --tree <export of ${NODE_COMMIT}${patch ? ` with ${patch} applied` : ''}>${patch ? ` --patch ${patch}` : ''}`,
  identity: nodeTreeIdentity(args, tree, NODE_COMMIT),
  extra: { ...recorderProvenance(import.meta.url), scenarios: recorded.sort(), unrecordedCount: unrecorded.length },
});
await hub.close();
httpServer.closeAllConnections();
httpServer.close();
h2Server.close();
commitStage(outDir, finalDir);
rmSync(dataDir, { recursive: true, force: true });
console.log(`recorded ${recorded.length}; unrecorded ${unrecorded.length}`);
for (const u of unrecorded) console.log(` - ${u.id}/${u.scenario}: ${u.reason}`);
process.exit(0);
