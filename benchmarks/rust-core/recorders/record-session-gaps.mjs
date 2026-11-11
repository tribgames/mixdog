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
import { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';
import { exact, exactArgs } from './lib/exact.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-session-gaps.mjs';
const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const args = parseArgs();
const tree = resolveTree(args);
const only = args.get('only');
const identity = exactProductIdentity(tree, NODE_COMMIT);
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
      if (step.error) throw Object.assign(new Error(step.error.message), { httpStatus: step.error.status, ...(step.error.code ? { code: step.error.code } : {}) });
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
          sends.push({ messages: structuredClone(messages), providerState: structuredClone(opts?.providerState) });
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
const pastedCases = ['stored', 'gone', 'held-open'];

async function compactionPastedText() {
  const store = await load('src/runtime/attachments/store.mjs');
  const { runSessionCompaction } = await load('src/runtime/agent/orchestrator/session/manager/compaction-runner.mjs');
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
    if (name === 'stored') {
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
        holder = spawn('powershell.exe', ['-NoProfile', '-Command', `$f=[IO.File]::Open('${path}','Open','Read','None'); [Console]::Out.WriteLine('held'); [Console]::In.ReadLine() | Out-Null; $f.Close()`], { stdio: ['pipe', 'pipe', 'inherit'] });
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
    const provider = {
      name: 'openai',
      send: async (...sendArgs) => {
        // Every argument as sent (the options carry the abort signal: recorded as its state).
        sends.push(exactArgs(sendArgs, { classes: { AbortSignal: (s) => ({ aborted: s.aborted }) } }));
        return { content: 'SUMMARY of the conversation so far', usage: { inputTokens: 1000, outputTokens: 50, cachedTokens: 0 } };
      },
    };
    let result;
    try {
      result = { value: exact(await runSessionCompaction(live, { mode: 'manual', force: true, provider, sessionId: live.id })) };
    } catch (error) {
      result = { error: exact(error) };
    } finally {
      if (holder) {
        holder.stdin.end('\n');
        await new Promise((resolve) => holder.once('exit', resolve));
      }
    }
    cases.push(scrubData({ name, blob: name === 'gone' ? null : bytes.toString('base64'), part: exact(part), messages: exact(messages), sends, result }));
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
  command: `node ${RECORDER} --tree <exact export of b6f10295a>`,
  extra: {
    scenarios: Object.keys(scenarios),
    values: 'exact (benchmarks/rust-core/recorders/lib/exact.mjs)',
    exclusions: [
      'attachment-preflight, compaction-pasted-text: the data directory inside a recorded value is written <data>',
    ],
    ...recorderProvenance(import.meta.url),
  },
  identity,
});
commitStage(outDir, finalDir);
console.log(`recorded ${recorded.join(', ')}`);
process.exit(0);
