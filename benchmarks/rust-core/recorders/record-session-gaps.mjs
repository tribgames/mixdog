// What Node b6f10295a (the 1.4.5 release) does in the session gaps the core closed (gaps-session.md, items 4, 6–11),
// one scenario per file of `native/core/fixtures/session-gaps/`, each driven through Node's own entry:
//   legacy-json-keys   `loadLegacySession` (store/legacy-session.mjs, over `readTopLevelLifecycleRecord`) on the bytes
//                      of a legacy `<id>.json`: the document 1.4.5 reads, or null for a record it cannot read.
//
//   node benchmarks/rust-core/recorders/record-session-gaps.mjs --tree <exact export of b6f10295a> [--only <scenario>]
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, nodeTreeIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';
import { exact, exactArgs } from './lib/exact.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-session-gaps.mjs';
const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const args = parseArgs();
const tree = resolveTree(args);
const only = args.get('only');
// The tree is the commit, or with `--patch` the commit with node-fix-manual-compaction-ends-with-session.patch applied
// (the cases of a manual compaction ended by a close are recorded from the patched tree).
const identity = nodeTreeIdentity(args, tree, NODE_COMMIT);
const load = (path) => import(pathToFileURL(join(tree, path)).href);
// Node's runtime writes under its data directory: a fresh one, removed when the recording ends.
const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-session-gaps-'));
process.env.MIXDOG_DATA_DIR = dataDir;
process.on('exit', () => rmSync(dataDir, { recursive: true, force: true }));
// The fresh data directory inside a recorded value (a reference path, an error's path) is written `<data>`.
const scrubData = (value) => JSON.parse(JSON.stringify(value).split(JSON.stringify(dataDir).slice(1, -1)).join('<data>'));

// ---- item 11: a legacy session json naming a top-level key twice ----

const LEGACY_ID = 'sess_dup';
const legacyTexts = [
  ['unique', '{"id":"sess_dup","title":"a","messages":[]}'],
  ['repeated-title', '{"id":"sess_dup","title":"a","messages":[],"title":"b"}'],
  ['repeated-id-same-value', '{"id":"sess_dup","title":"a","messages":[],"id":"sess_dup"}'],
  ['escaped-equivalent', '{"id":"sess_dup","title":"a","messages":[],"\\u0074itle":"b"}'],
  ['escaped-upper-hex', '{"id":"sess_dup","title":"a","messages":[],"\\u0074\\u0049tle":"b","t\\u0069tle":"c"}'],
  ['nested-repeat', '{"id":"sess_dup","title":"a","messages":[{"role":"user","content":"x","content":"y"}]}'],
  ['repeat-inside-string', '{"id":"sess_dup","title":"\\"title\\":","messages":[]}'],
  ['two-distinct-lone-surrogates', '{"id":"sess_dup","title":"a","messages":[],"\\ud800":1,"\\ud801":2}'],
  ['one-lone-surrogate-twice', '{"id":"sess_dup","title":"a","messages":[],"\\ud800":1,"\\uD800":2}'],
  ['proto-key-twice', '{"id":"sess_dup","title":"a","messages":[],"__proto__":1,"__proto__":2}'],
  ['whitespace-around-colon', '{ "id" : "sess_dup" , "title" : "a" , "messages" : [] , "title" : "b" }'],
];

async function legacyJsonKeys() {
  const { loadLegacySession } = await load('src/runtime/agent/orchestrator/session/store/legacy-session.mjs');
  return {
    sessionId: LEGACY_ID,
    // The whole document 1.4.5 read, as it read it (a lone surrogate kept: exact's utf16 tag).
    cases: legacyTexts.map(([name, text]) => ({ name, text, document: exact(loadLegacySession(text, LEGACY_ID)) })),
  };
}

// ---- item 4: an image the provider rejects, through the agent loop's `sendWithRecovery` ----
// Each case runs Node's public `agentLoop` over a transcript with a scripted provider (the errors it throws and the
// replies it gives, in order), then a text-only next turn over the transcript the first left. Every message the
// provider was sent and the transcript after each turn are recorded as the rows Node keeps.

const image = (ref, filename) => ({ type: 'image', attachmentRef: ref, mimeType: 'image/png', ...(filename ? { filename } : {}) });
const rejectedImage = { status: 400, message: 'The image data you provided does not represent a valid image. Please check your input and try again.' };
const invalidImageCode = { status: 400, code: 'invalid_image', message: 'Invalid image.' };
const imageCases = [
  {
    // confirmedImageRejection by message: the one new image is healed out of the transcript.
    name: 'one-new-image-confirmed',
    messages: [
      { role: 'user', content: [image('a'.repeat(64))] },
      { role: 'assistant', content: 'seen' },
      { role: 'user', content: [{ type: 'text', text: 'inspect' }, image('b'.repeat(64))] },
    ],
    script: [{ error: rejectedImage }, { reply: 'recovered' }],
  },
  {
    // One stored image attached twice under two names: one identity, healed from both places.
    name: 'one-image-two-filenames',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'compare' }, image('c'.repeat(64), 'left.png'), image('c'.repeat(64), 'right.png')] },
    ],
    script: [{ error: invalidImageCode }, { reply: 'recovered' }],
  },
  {
    // Two distinct new images: the rejection names neither, so the strip stays request-local.
    name: 'two-distinct-images',
    messages: [{ role: 'user', content: [image('d'.repeat(64)), image('e'.repeat(64))] }],
    script: [{ error: invalidImageCode }, { reply: 'recovered' }],
  },
  {
    // A 400 the image strip retries but that is not a confirmed rejection: request-local.
    name: 'unconfirmed-could-not-process',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, image('f'.repeat(64))] }],
    script: [{ error: { status: 400, message: 'Could not process image' } }, { reply: 'recovered' }],
  },
  {
    // An error that names no image: no strip, the error ends the turn.
    name: 'error-naming-no-image',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, image('a1'.repeat(32))] }],
    script: [{ error: { status: 400, message: 'Invalid request: the field temperature is out of range.' } }],
  },
  {
    // The stream gave 23 characters of text and three tool calls before the error: the outcome counts them.
    name: 'error-after-partial-output',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, image('a2'.repeat(32))] }],
    script: [{ error: { status: 400, message: 'Invalid request: the field temperature is out of range.' }, partial: { text: 'Let me check that file.', calls: 3 } }],
  },
  {
    // The image rides a tool result of the latest turn.
    name: 'image-in-tool-result',
    messages: [
      { role: 'user', content: 'take a screenshot' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'screenshot' }, image('b1'.repeat(32))] },
    ],
    script: [{ error: rejectedImage }, { reply: 'recovered' }],
  },
];

async function imageStrip() {
  const { agentLoop } = await load('src/runtime/agent/orchestrator/session/agent-loop.mjs');
  const tools = [{ name: 'read', description: 'read', inputSchema: { type: 'object', properties: {} } }];
  const rows = (list) => list.map((m) => structuredClone(m));
  const scripted = (script, sends) => ({
    async send(sent) {
      sends.push(exact(rows(sent)));
      const step = script[sends.length - 1];
      if (!step) throw new Error(`script exhausted at send ${sends.length}`);
      // `partial`: the stream gave the text and the tool calls before it failed, as a provider's stream tracker reports them
      // on the error (`partialContent`, `partialToolCalls`, `toolCallsDispatched`: providers/lib/stream-outcome.mjs).
      const partial = step.partial
        ? { partialContent: step.partial.text, partialToolCalls: Array.from({ length: step.partial.calls }, (_, i) => ({ id: `call_${i + 1}`, name: 'read' })), toolCallsDispatched: step.partial.calls, liveTextEmitted: true }
        : {};
      if (step.error) throw Object.assign(new Error(step.error.message), { httpStatus: step.error.status, ...(step.error.code ? { code: step.error.code } : {}), ...partial });
      return { content: step.reply, toolCalls: [], stopReason: 'end_turn' };
    },
  });
  const turn = async (session, messages, script) => {
    const sends = [];
    let result = null;
    let error = null;
    try {
      const out = await agentLoop(scripted(script, sends), messages, 'fake-model', tools, null, process.cwd(), { session, sessionId: session.id });
      result = out.content;
    } catch (e) {
      error = exact(e);
    }
    return { sends, result, error, transcript: exact(rows(messages)) };
  };
  const cases = [];
  for (const c of imageCases) {
    const session = { id: `gaps-${c.name}`, owner: 'cli', contextWindow: 200_000, rawContextWindow: 200_000, compaction: { auto: false } };
    const messages = rows(c.messages);
    const first = await turn(session, messages, c.script);
    messages.push({ role: 'user', content: 'next turn' });
    const next = await turn(session, messages, [{ reply: 'still usable' }]);
    cases.push({ name: c.name, messages: c.messages, script: c.script, first, next });
  }
  return { cases };
}

// ---- item 6: the attachment preflight of `runPreSendCompactPass` (`referenceOversizedAttachments`) ----
// Real PDFs (scanned pages: no text layer; text pages: 2,000 characters each) and a PNG go into Node's attachment
// store and through its PDF intake (`preparePromptSubmissionForProvider`, which records the page and text-layer
// counts on the part). Each case then runs the pre-send pass turn after turn over a session holding a Responses
// continuation, as the request boundary does, and records the transcript and continuation each pass leaves. The data
// directory in a reference's path is written `<data>`.

function pdfBytes(pages, textPerPage) {
  const objects = [];
  const add = (body) => objects.push(body) && objects.length;
  const catalog = add(null);
  const tree = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (let n = 0; n < pages; n += 1) {
    const text = textPerPage ? 'x'.repeat(textPerPage) : '';
    const stream = text ? `BT /F1 4 Tf 10 700 Td (${text}) Tj ET` : '';
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objects[tree - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${pages} >>`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const scanPdf = (n, pages) => ({ kind: 'pdf', filename: `scan-${n}.pdf`, pages, text: 0, seed: n });
const textPdf = (n, pages) => ({ kind: 'pdf', filename: `notes-${n}.pdf`, pages, text: 2000, seed: n });
const shot = { kind: 'png', filename: 'shot.png' };
const attachmentCases = [
  { name: 'eight-scans-500k', contextWindow: 500_000, nativePdf: true, turns: [['Summarize these contracts.', Array.from({ length: 8 }, (_, i) => scanPdf(i + 1, 37))], ['and the dates?', []]] },
  { name: 'eight-scans-900k', contextWindow: 900_000, nativePdf: true, turns: [['Summarize these contracts.', Array.from({ length: 8 }, (_, i) => scanPdf(i + 1, 37))]] },
  { name: 'under-the-budget', contextWindow: 200_000, nativePdf: true, turns: [['compare', [textPdf(1, 5), textPdf(2, 5)]], ['and the totals?', []]] },
  { name: 'oldest-first', contextWindow: 200_000, nativePdf: true, turns: [['first', [scanPdf(1, 20)]], ['second', [scanPdf(2, 20)]], ['thanks', []]] },
  { name: 'text-only-scan', contextWindow: 1_000_000, nativePdf: false, turns: [['read', [scanPdf(1, 2)]]] },
  { name: 'native-scan', contextWindow: 1_000_000, nativePdf: true, turns: [['read', [scanPdf(1, 2)]]] },
  { name: 'image-shares-the-budget', contextWindow: 500_000, nativePdf: true, turns: [['look', [shot, ...Array.from({ length: 8 }, (_, i) => scanPdf(i + 1, 37))]]] },
  { name: 'text-pages-priced', contextWindow: 200_000, nativePdf: true, turns: [['notes', [textPdf(1, 12)]], ['more notes', [textPdf(2, 12)]]] },
];

async function attachmentPreflight() {
  const store = await load('src/runtime/attachments/store.mjs');
  const { agentLoop } = await load('src/runtime/agent/orchestrator/session/agent-loop.mjs');
  const { buildRequestBody } = await load('src/runtime/agent/orchestrator/providers/openai-responses-payload.mjs');
  const blobs = {};
  const intake = async (items, nativePdf) => {
    const prompt = items.map((item) => {
      const bytes = item.kind === 'png' ? PNG : pdfBytes(item.pages, item.text);
      const { attachmentRef, sizeBytes } = store.storeAttachmentBuffer(bytes);
      blobs[attachmentRef] = bytes.toString('base64');
      return item.kind === 'png'
        ? { type: 'image', attachmentRef, mimeType: 'image/png', filename: item.filename, sizeBytes }
        : { type: 'file', attachmentRef, mimeType: 'application/pdf', filename: item.filename, sizeBytes };
    });
    return (await store.preparePromptSubmissionForProvider({ prompt }, { nativePdf })).prompt;
  };
  const scrub = scrubData;
  const { _withRegisteredProviderForTestAsync } = await load('src/runtime/agent/orchestrator/providers/registry.mjs');
  const cases = [];
  for (const c of attachmentCases) {
    // A provider that reads a PDF as text: its adapter declares `nativePdf = false`, as deepseek's does.
    const run = (fn) => (c.nativePdf ? fn() : _withRegisteredProviderForTestAsync('deepseek', { nativePdf: false }, fn));
    cases.push(await run(() => attachmentCase(c)));
  }
  return { blobs, cases };

  // Each turn runs Node's `agentLoop` (its request boundary runs `runPreSendCompactPass` before the send) over the
  // session's transcript with the Responses continuation the previous turn's reply left; the provider records what it
  // is sent (the messages and the continuation, whole) and answers with a new continuation, as the Responses adapter
  // writes `opts.providerState` back.
  async function attachmentCase(c) {
    const session = {
      id: `gaps-preflight-${c.name}`,
      provider: c.nativePdf ? 'openai' : 'deepseek',
      model: 'gpt-test',
      contextWindow: c.contextWindow,
      compaction: { auto: false },
      messages: [{ role: 'system', content: 'rules' }],
    };
    const turns = [];
    let providerState = { responseId: 'resp_0' };
    for (const [text, items] of c.turns) {
      const parts = await intake(items, c.nativePdf);
      if (session.messages.length > 1) session.messages.push({ role: 'assistant', content: 'ok' });
      session.messages.push({ role: 'user', content: parts.length ? [{ type: 'text', text }, ...parts] : text });
      const before = structuredClone(session.messages);
      const sends = [];
      const reply = { responseId: `resp_${turns.length + 1}` };
      const provider = {
        name: session.provider,
        async send(messages, _model, _tools, opts) {
          // `wire`: the request body Node's Responses provider builds from exactly these messages and continuation, as the
          // public OpenAI route sends it (`promptCacheProvider: 'openai'`); the text-only route's chat body needs the
          // extension host's PDF text and is not recorded (manifest).
          const wire = c.nativePdf ? buildRequestBody(messages, _model, [], { promptCacheProvider: 'openai', providerState: opts?.providerState }) : undefined;
          sends.push({ messages: structuredClone(messages), providerState: structuredClone(opts?.providerState), wire });
          return { content: 'ok', toolCalls: [], stopReason: 'end_turn', providerState: reply };
        },
      };
      const out = await agentLoop(provider, session.messages, session.model, [], null, process.cwd(), { session, sessionId: session.id, providerState });
      providerState = out.providerState;
      turns.push(scrub(exact({ messages: before, sends, after: session.messages, providerState: out.providerState })));
    }
    return { name: c.name, contextWindow: c.contextWindow, nativePdf: c.nativePdf, turns };
  }
}

// ---- item 7: a pasted text attachment in the compaction summary, through `runSessionCompaction` ----
// A conversation that opens with a pasted text, compacted by hand; the summary provider is the one part replaced (it
// records what it is sent and answers a fixed summary). The pasted text is stored by Node's intake; a blob that is gone
// is a session whose store lost it (its reference names bytes this store never held); a blob the store cannot read
// for now is one another process holds open with no sharing, as an editor or a scanner does.

const PASTED = Array.from({ length: 900 }, (_, i) => `pasted line ${i} ${'é'.repeat(i % 7)} 🙂`).join('\n');
// The failure cases run over the stored paste: the summary provider throws, answers an empty summary, or the session's
// abort signal is already aborted (a parent-linked agent session whose parent was cancelled). A manual compaction reads
// its signal through the session's controller (`beginManualCompaction`, runtime-liveness.mjs, from
// node-fix-manual-compaction-ends-with-session.patch: 1.4.5 gave an idle session's compaction no signal at all, so a
// close could not stop one in flight). `closed`, `deleted` and `shutdown` end a compaction whose summary send is in
// flight: `closeSession`, the session delete's close (`desktop-session-delete`, session-switch/session-delete.mjs) and the
// runtime's close (`quiesce('cli-exit')`'s `abortActiveTurns`, reaching the compaction the session ops registered). The
// summary send honours its signal, as a real provider's does.
const pastedCases = ['stored', 'gone', 'held-open', 'provider-error', 'empty-summary', 'cancelled', 'closed', 'deleted', 'shutdown'];
const endedInFlight = ['closed', 'deleted', 'shutdown'];

async function compactionPastedText() {
  const store = await load('src/runtime/attachments/store.mjs');
  // The entry a client's compact request reaches (`compactSessionMessages`, session-crud.mjs:384), over the session as
  // the store holds it and the provider the registry hands it (`getProvider(session.provider)`).
  const { compactSessionMessages } = await load('src/runtime/agent/orchestrator/session/manager/session-crud.mjs');
  const { saveSessionAsync, loadSession } = await load('src/runtime/agent/orchestrator/session/store.mjs');
  const { _withRegisteredProviderForTestAsync } = await load('src/runtime/agent/orchestrator/providers/registry.mjs');
  const { linkParentSignalToSession } = await load('src/runtime/agent/orchestrator/session/manager/runtime-liveness.mjs');
  const { closeSession } = await load('src/runtime/agent/orchestrator/session/manager/session-close.mjs');
  const { deleteSession } = await load('src/runtime/agent/orchestrator/session/store/session-delete.mjs');
  const { SessionClosedError } = await load('src/runtime/agent/orchestrator/session/manager/session-errors.mjs');
  const { createSessionOps } = await load('src/session-runtime/turn/session-ops.mjs');
  const { activeTurnControls } = await load('src/session-runtime/boot/config.mjs');
  const mgr = await load('src/runtime/agent/orchestrator/session/manager.mjs');
  const { createHash } = await import('node:crypto');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const { spawn } = await import('node:child_process');
  const words = (n, w) => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ');
  const cases = [];
  for (const name of pastedCases) {
    const text = `${name}: ${PASTED}`;
    const bytes = Buffer.from(text, 'utf8');
    let part;
    let holder = null;
    if (name !== 'gone' && name !== 'held-open') {
      const submitted = store.materializePromptSubmission('[Pasted text #1 +900 lines]', { pastedTexts: { 1: { id: 1, text } } });
      part = submitted.prompt.find((p) => p.type === 'text' && p.attachmentRef);
    } else {
      const attachmentRef = createHash('sha256').update(bytes).digest('hex');
      part = { type: 'text', attachmentRef, sizeBytes: bytes.length, textKind: 'paste' };
      if (name === 'held-open') {
        // Stored by an earlier run of the process (so no read of it is cached here), then held open by another process.
        const path = store.attachmentFilePath(attachmentRef);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes);
        holder = spawn('powershell.exe', ['-NoProfile', '-Command', `$f=[IO.File]::Open('${path}','Open','Read','None'); [Console]::Out.WriteLine('held'); [Console]::In.ReadLine() | Out-Null; $f.Close()`], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
        await new Promise((resolve, reject) => {
          holder.stdout.once('data', (chunk) => (String(chunk).includes('held') ? resolve() : reject(new Error(String(chunk)))));
          holder.once('error', reject);
        });
      }
    }
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Review this paste.' }, part] },
      ...Array.from({ length: 39 }, (_, i) => (i % 2 ? { role: 'user', content: words(80, `u${i}_`) } : { role: 'assistant', content: words(80, `a${i}_`) })),
    ];
    const live = { id: `gaps-pasted-${name}`, provider: 'openai', model: 'gpt-x', contextWindow: 8000, rawContextWindow: 8000, effectiveContextWindowPercent: 100, tools: [], messages, compaction: { auto: true } };
    const sends = [];
    let sendStarted;
    const started = new Promise((resolve) => (sendStarted = resolve));
    // The signal each send was handed, to record whether it was aborted once the session ended.
    const signals = [];
    const provider = {
      name: 'openai',
      send: async (...sendArgs) => {
        // Every argument as sent (the options carry the abort signal: recorded as its state).
        sends.push(exactArgs(sendArgs, { classes: { AbortSignal: (s) => ({ aborted: s.aborted }) } }));
        signals.push(sendArgs[3]?.signal ?? null);
        sendStarted();
        // The first summary send in flight when its session ends: it ends with the signal's reason, as a real provider's
        // does. A start after the end is answered.
        if (endedInFlight.includes(name) && sends.length === 1) {
          const { signal } = sendArgs[3];
          return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        }
        // A real provider rejects a send whose signal is aborted with the signal's reason.
        if (sendArgs[3]?.signal?.aborted) throw sendArgs[3].signal.reason;
        // A request error no provider retries (Node's real providers retry inside `send`; this one answers once).
        if (name === 'provider-error') throw Object.assign(new Error('openai: 400 invalid request'), { status: 400 });
        const content = name === 'empty-summary' ? '' : 'SUMMARY of the conversation so far';
        return { content, usage: { inputTokens: 1000, outputTokens: 50, cachedTokens: 0 } };
      },
    };
    // The session is on disk before the compaction, as a session a client addresses is.
    await saveSessionAsync(live);
    if (name === 'cancelled') {
      const parent = new AbortController();
      parent.abort(new Error('parent turn cancelled'));
      linkParentSignalToSession(live.id, parent.signal);
    }
    let result;
    let deleted;
    let after;
    let firstSends;
    // The compaction as the client reaches it, and for `shutdown` through the session ops that register it with the runtime.
    // What the session published around the compaction: the hooks the session ops dispatch (`preCompactHook`,
    // `postCompactHook`).
    const events = [];
    live.preCompactHook = async ({ trigger }) => events.push(['pre', trigger]);
    live.postCompactHook = async ({ trigger }) => events.push(['post', trigger]);
    const initial = structuredClone(JSON.parse(JSON.stringify(live, (k, v) => (typeof v === 'function' ? undefined : v))));
    const rt = { activeTurnAbortControllers: new Set(), closeRequested: false, session: live };
    const controls = activeTurnControls(rt);
    const ops = createSessionOps({
      getSession: () => live,
      setSession: () => {},
      getActiveTurnCount: () => 0,
      mgr,
      invalidateContextStatusCache: () => {},
      registerActiveTurnController: controls.registerActiveTurnController,
    });
    const ended = {
      closed: () => closeSession(live.id, 'cli-agent-close'),
      deleted: async () => {
        await closeSession(live.id, 'desktop-session-delete', { tombstone: true });
        deleted = await deleteSession(live.id);
      },
      shutdown: async () => controls.abortActiveTurns(new SessionClosedError(live.id, 'runtime close (reason=cli-exit)', 'cli-exit')),
    }[name];
    try {
      result = { value: exact(await _withRegisteredProviderForTestAsync('openai', provider, async () => {
        if (!ended) return compactSessionMessages(live.id);
        // The compaction a client's compact request starts: the session ops' (they dispatch the hooks).
        const compacting = ended ? ops.compact() : compactSessionMessages(live.id);
        await started;
        await ended();
        const answer = await compacting;
        if (!ended) return answer;
        // After the end: the summary send's signal, what the store holds, and a start after it.
        firstSends = sends.length;
        const stored = loadSession(live.id);
        const storedHeader = stored ? JSON.parse(JSON.stringify(stored, (k, v) => (k === 'messages' || typeof v === 'function' ? undefined : v))) : null;
        const changedKeys = storedHeader ? [...new Set([...Object.keys(initial), ...Object.keys(storedHeader)])].filter((k) => k !== 'messages' && JSON.stringify(initial[k]) !== JSON.stringify(storedHeader[k])).sort() : null;
        after = {
          signalsAborted: signals.map((s) => s?.aborted ?? null),
          stored: stored ? { messages: exact(stored.messages), headerChangedKeys: changedKeys } : null,
          events: structuredClone(events),
        };
        let nextStart;
        try {
          nextStart = { value: exact(await ops.compact()) };
        } catch (error) {
          nextStart = { error: exact(error) };
        }
        after.next = { ...nextStart, sendsAfter: sends.length - firstSends };
        return answer;
      })) };
    } catch (error) {
      result = { error: exact(error) };
    } finally {
      if (holder) {
        holder.stdin.end('\n');
        await new Promise((resolve) => holder.once('exit', resolve));
      }
    }
    cases.push(scrubData({ name, blob: name === 'gone' ? null : bytes.toString('base64'), part: exact(part), messages: exact(messages), sends: firstSends === undefined ? sends : sends.slice(0, firstSends), result, ...(after === undefined ? {} : { after }), ...(deleted === undefined ? {} : { deleted }) }));
  }
  return { cases };
}

const scenarios = {
  'legacy-json-keys': legacyJsonKeys,
  'image-strip': imageStrip,
  'attachment-preflight': attachmentPreflight,
  'compaction-pasted-text': compactionPastedText,
};

const finalDir = join(FIXTURES_ROOT, 'session-gaps');
const outDir = stageSet(finalDir, only ? [`${only}.json`] : null);
const recorded = [];
for (const [id, run] of Object.entries(scenarios)) {
  if (only && id !== only) continue;
  writeJson(join(outDir, `${id}.json`), { scenario: id, ...(await run()) });
  recorded.push(id);
}
if (only && !recorded.length) throw new Error(`no scenario ${only}`);
writeSetManifest(outDir, {
  set: 'session-gaps',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <export of b6f10295a with the patch applied> --patch benchmarks/rust-core/recorders/node-patches/node-fix-manual-compaction-ends-with-session.patch`,
  extra: {
    scenarios: Object.keys(scenarios),
    values: 'exact (benchmarks/rust-core/recorders/lib/exact.mjs)',
    exclusions: [
      'attachment-preflight: each send records the Responses request body Node builds from the messages it hands the provider (`wire`: openai-responses-payload.mjs buildRequestBody, public OpenAI route); the replay compares the body the core\'s openai body builder makes from the request the run hands its provider, whole; the run reads each stored file itself before that (the host\'s attachment resolver, as Node\'s builder reads it with readAttachmentBase64). The recorded `messages` (which carry the file parts\' measured facts) are not compared for these cases: the body is what is sent',
      'attachment-preflight, text-only-scan: no `wire` is recorded for it. Its provider (deepseek, nativePdf = false) sends a chat body after preparePdfTextForProvider has read the PDF as text through pdf.js, and the core wires that step only for the managed local route (run_host/media.rs MediaLowering::prepare_pdf_text), so no product path of the core builds this body for a stored PDF; the stored reference stays unread for a provider that takes a PDF as text. The replay compares the request messages the core hands the provider, with Node\'s file part without the measured facts (sizeBytes, pageCount, textPages, textChars), which the core prices from the part\'s stored row, and those facts compared whole with that row',
      'compaction-pasted-text: the whole set is recorded from the tree with benchmarks/rust-core/recorders/node-patches/node-fix-manual-compaction-ends-with-session.patch applied (Node 1.4.5 gave a manual compaction no signal of its own, so closing the session or the runtime could not stop one in flight and its result came back after the close; the patch registers the compaction with the session\'s controller and with the runtime\'s active turns). The patch changes only that path: the cases that run no close record the same results, and their summary send now carries the signal (recorded as its state, { aborted: false }); closed, deleted and shutdown exist only because of it. Those three also record `after`: whether each summary send\'s signal was aborted, the stored session (transcript whole, and the header keys that differ from the header before the compaction), the events published (the session ops\' pre/post compact hooks, through which these cases start the compaction) and a second start (its answer, and how many summary sends it made); the first start\'s summary send never answers, a start after it does. The replay compares: the hooks whole; that the core dropped the summary stream in flight (Node: the send\'s signal aborted); the transcript whole; the header as a set (no key changed that Node\'s did not: closed\'s keys are Node\'s own tombstone bookkeeping); a deleted session as nothing stored in Node, and in the core as gone or carrying its delete mark with no summary applied (the core\'s log keeps the mark); a start after the end of closed and deleted as one that begins no compaction and asks no summary. The start after shutdown is not compared: Node\'s runtime stays up after abortActiveTurns and compacts again, the core\'s shutdown ends the directory',
      'image-strip, error-after-partial-output: the error carries what the provider\'s stream tracker put on it (partialContent, partialToolCalls, toolCallsDispatched, liveTextEmitted) and the stamps stampStreamOutcome adds; the replay builds each from the text and completed calls the core\'s stream delivered before it failed',
      'legacy-json-keys: the document is recorded as 1.4.5 read it (a lone surrogate kept: exact\'s utf16 tag; two-distinct-lone-surrogates holds two such keys); the migration replay compares it with each lone surrogate read as U+FFFD and the keys that are equal after that as one (the last value at the first\'s place), because the core\'s store holds UTF-8 text and no UTF-8 text holds a lone surrogate (mixdog-migrate json::replace_lone_surrogates, long_session_log.rs)',
      'attachment-preflight, compaction-pasted-text: the data directory inside a recorded value is written <data>',
      'compaction-pasted-text: the replay compares a thrown failure by name and message only; its errno fields (code, errno, syscall, path) are recorded but not compared, because the core\'s attachment reader carries the read\'s text and no errno (ReadError::Other, run_host/media.rs resolve_ref)',
    ],
    ...recorderProvenance(import.meta.url),
  },
  identity,
});
commitStage(outDir, finalDir);
console.log(`recorded ${recorded.join(', ')}`);
process.exit(0);
