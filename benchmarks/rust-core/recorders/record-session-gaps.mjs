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

const scenarios = { 'legacy-json-keys': legacyJsonKeys };

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
