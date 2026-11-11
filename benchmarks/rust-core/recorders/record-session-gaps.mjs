// What Node b6f10295a (the 1.4.5 release) does in the session gaps the core closed (gaps-session.md, items 4, 6–11),
// one scenario per file of `native/core/fixtures/session-gaps/`, each driven through Node's own entry:
//   legacy-json-keys   `loadLegacySession` (store/legacy-session.mjs, over `readTopLevelLifecycleRecord`) on the bytes
//                      of a legacy `<id>.json`: the document 1.4.5 reads, or null for a record it cannot read.
//
//   node benchmarks/rust-core/recorders/record-session-gaps.mjs --tree <exact export of b6f10295a> [--only <scenario>]
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-session-gaps.mjs';
const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const args = parseArgs();
const tree = resolveTree(args);
const only = args.get('only');
const identity = exactProductIdentity(tree, NODE_COMMIT);
const load = (path) => import(pathToFileURL(join(tree, path)).href);

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
    // What a migrated session carries of the document: its title and messages. The whole document is not kept, since a
    // lone-surrogate key 1.4.5 read is not text a strict JSON reader accepts back.
    cases: legacyTexts.map(([name, text]) => {
      const document = loadLegacySession(text, LEGACY_ID);
      return { name, text, document: document && { title: document.title, messages: document.messages } };
    }),
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
      sends.push(rows(sent).filter((m) => m.role !== 'system').map(({ role, content, toolCalls, toolCallId }) => ({ role, content, ...(toolCalls ? { toolCalls } : {}), ...(toolCallId ? { toolCallId } : {}) })));
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
      error = String(e?.message || e);
    }
    return { sends, result, error, transcript: rows(messages).map(({ role, content }) => ({ role, content })) };
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

const scenarios = { 'legacy-json-keys': legacyJsonKeys, 'image-strip': imageStrip };

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
  extra: { scenarios: Object.keys(scenarios), ...recorderProvenance(import.meta.url) },
  identity,
});
commitStage(outDir, finalDir);
console.log(`recorded ${recorded.join(', ')}`);
process.exit(0);
