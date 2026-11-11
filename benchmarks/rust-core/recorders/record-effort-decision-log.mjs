#!/usr/bin/env node
// Golden of the effort judge's decision log as Node keeps it after local `main` bb8c5e3b7
// (src/runtime/effort-judge/decision-log.mjs, judge-client.mjs `recordEffortDecision`), recorded from
// an export of b6f10295a with that change applied (node-patches/node-change-effort-decision-log.patch).
// Per scenario: the files the log finds in a fresh directory, the entries recorded one by one, each
// record's rotation awaited before the next (`settled()`), and every file under the directory
// afterwards. The data directory's log (`data`) runs `decisionLog(<root>/effort-judge/decisions.jsonl,
// { segmentBytes })` with a small segment; a redirected log (`override`) runs `recordEffortDecision`
// with MIXDOG_EFFORT_DECISIONS_LOG set, whose file never rotates. Files are base64 (a log may hold
// bytes that are not UTF-8); entries are text, their key order being part of the bytes.
//
//   node benchmarks/rust-core/recorders/record-effort-decision-log.mjs --tree <git archive of b6f10295a (src, apps,
//        package.json) with the patch applied, with node_modules> --patch benchmarks/rust-core/recorders/node-patches/node-change-effort-decision-log.patch
//        [--only <scenario>]
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { commitStage, FIXTURES_ROOT, importFrom, nodeTreeIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-effort-decision-log.mjs';
const args = parseArgs();
const tree = resolveTree(args);
// Checked before anything is recorded: the tree is the commit with the patch and nothing else.
const identity = nodeTreeIdentity(args, tree, REF);
if (!identity.patch) throw new Error('record from the export with --patch node-patches/node-change-effort-decision-log.patch');
const { decisionLog } = await importFrom(tree, 'src/runtime/effort-judge/decision-log.mjs');
const { recordEffortDecision } = await importFrom(tree, 'src/runtime/effort-judge/judge-client.mjs');

const at = (day, second) => `2026-11-${day}T10:${String(Math.floor(second / 60)).padStart(2, '0')}:${String(second % 60).padStart(2, '0')}.000Z`;
const turn = (day, second, extra) => ({ at: at(day, second), sessionId: 's1', provider: 'anthropic-oauth', model: 'claude-opus-5-5', mode: 'on', chosen: 'medium', base: 'medium', requestChars: 40, ...extra });
const step = (day, second, n, extra) => ({ at: at(day, second), sessionId: 's2', provider: 'openai', model: 'gpt-6.1', mode: 'on', atStep: n, ...extra });
const answered = (effort, ms) => ({ effort, step: 1, level: 2, confidence: 0.5, ms, probs: [0.25, 0.5, 0.125, 0.125] });
const without = (entry, key) => {
  const { [key]: _gone, ...rest } = entry;
  return rest;
};
const lines = (entries) => entries.map((entry) => `${typeof entry === 'string' ? entry : JSON.stringify(entry)}\n`).join('');
const sharedSession = { tab: 1 };

const MIXED = [
  turn(11, 1, answered('low', 99)),
  step(11, 2, 1, { skipped: 'timeout' }),
  step(11, 3, 2, { base: 'medium', ...answered('high', 100) }),
  turn(11, 4, { skipped: 'load-error: model.onnx: bad' }),
  step(11, 5, 3, { skipped: 'busy', sessionId: 7 }),
  turn(11, 6, { ...answered('medium', 12.5), sessionId: '' }),
  step(11, 7, 4, { skipped: null }),
  turn(11, 8, { ...answered('high', 500), base: null }),
  step(10, 9, 5, { skipped: 'warming', provider: 'custom:x' }),
  turn(12, 0, { ...answered('low', 1200), sessionId: 's3' }),
  without(step(11, 10, 6, { base: 'low', ...answered('low', 300) }), 'sessionId'),
  turn(11, 11, { skipped: '10' }),
  turn(11, 12, { skipped: '2' }),
  turn(11, 13, { skipped: '😀 emoji' }),
  turn(11, 14, { skipped: 'ｚ wide' }),
  step(11, 15, 7, { base: 'high', ...answered('xhigh', 499.9) }),
  turn(11, 16, { provider: 5, model: true, skipped: 'a:b:c' }),
  step(11, 17, null, { skipped: 'timeout' }),
  turn(11, 18, { sessionId: sharedSession, ...answered('low', 199) }),
  turn(11, 19, { sessionId: sharedSession, ...answered('low', 200) }),
  turn(11, 0, { sessionId: 1.5, ...answered('medium', 0) }),
  step(11, 20, 8, { ms: -3, effort: null }),
  step(11, 21, 9, { skipped: { code: 1 }, ms: '250' }),
  turn(11, 22, { provider: ['a', null, 'b'], ...answered('high', 301) }),
  turn(11, 23, answered('medium', 250)),
  step(11, 24, 10, { skipped: 'timeout' }),
];

const legacyLines = [
  JSON.stringify(turn(11, 30, answered('low', 120))),
  '{"at":"2026-11-11T10:00:09.000Z","sessionId":"s9","provider":"anthro',
  'not json',
  '{"no":"time"}',
  '[1,2]',
  'null',
  '"2026-11-11T10:00:00Z"',
  '{"at":"2026-11"}',
  '',
  `${JSON.stringify(step(11, 31, 1, { skipped: 'busy' }))}\r`,
  JSON.stringify(step(11, 32, 2, { skipped: 'busy', model: 'é' })),
  JSON.stringify(turn(9, 33, answered('high', 80))),
  // Diagnostic text cut inside a surrogate pair: JSON.stringify writes the lone half as `\udxxx`.
  JSON.stringify(turn(11, 34, { skipped: 'load-error: model.onnx: \ud83d' })),
  JSON.stringify(step(11, 35, 3, { provider: 'custom:\ud800', base: 'low\udfff', ...answered('high', 90) })),
];
const legacyFile = Buffer.concat([
  Buffer.from(lines(legacyLines)),
  // A line whose bytes are not UTF-8: the reader counts it with the replacement character.
  Buffer.from('{"at":"2026-11-11T10:00:40.000Z","provider":"'),
  Buffer.from([0xff, 0xfe]),
  Buffer.from('","skipped":"busy"}\n'),
]);

// name, log (`data` / `override`), segment size, files present before, entries.
const SCENARIOS = {
  segments: { log: 'data', segmentBytes: 700, before: {}, entries: MIXED },
  legacy: {
    log: 'data',
    segmentBytes: 400,
    before: {
      'effort-judge/decisions.jsonl': legacyFile,
      'effort-judge/decisions.1.jsonl': Buffer.from(lines([step(11, 50, 1, { skipped: 'timeout' })])),
      'effort-judge/decisions.leaving.jsonl': Buffer.from(`${lines([turn(11, 51, answered('low', 90))])}${JSON.stringify(turn(11, 52, { skipped: 'busy' }))}`),
    },
    entries: MIXED.slice(0, 3),
  },
  'leaving-first': {
    log: 'data',
    segmentBytes: 500,
    before: {
      'effort-judge/decisions.1.jsonl': Buffer.from(lines([step(11, 40, 1, { skipped: 'busy' }), step(11, 41, 2, { skipped: 'busy' })])),
      'effort-judge/decisions.leaving.jsonl': Buffer.from(lines([turn(11, 42, answered('medium', 140))])),
    },
    entries: MIXED.slice(3, 9),
  },
  'summary-appends': {
    log: 'data',
    segmentBytes: 300,
    before: { 'effort-judge/decisions-summary.jsonl': Buffer.from('{"day":"2026-11-01","judged":1}\n') },
    entries: MIXED.slice(9, 20),
  },
  redirected: { log: 'override', segmentBytes: 300, before: {}, entries: MIXED.slice(0, 8) },
};

function filesUnder(root, prefix = '') {
  const out = {};
  for (const name of readdirSync(join(root, prefix)).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(join(root, rel)).isDirectory()) Object.assign(out, filesUnder(root, rel));
    else out[rel] = readFileSync(join(root, rel)).toString('base64');
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

async function record(name) {
  const { log, segmentBytes, before, entries } = SCENARIOS[name];
  const root = mkdtempSync(join(tmpdir(), 'decision-log-'));
  try {
    for (const [rel, bytes] of Object.entries(before)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), bytes);
    }
    const texts = entries.map((entry) => JSON.stringify(entry));
    if (log === 'data') {
      const target = decisionLog(join(root, 'effort-judge', 'decisions.jsonl'), { segmentBytes });
      for (const entry of entries) {
        target.record(entry);
        await target.settled();
      }
    } else {
      process.env.MIXDOG_EFFORT_DECISIONS_LOG = join(root, 'redirected', 'log.jsonl');
      try {
        for (const entry of entries) recordEffortDecision(entry);
      } finally {
        delete process.env.MIXDOG_EFFORT_DECISIONS_LOG;
      }
    }
    return {
      name,
      log,
      segmentBytes,
      before: Object.fromEntries(Object.entries(before).map(([rel, bytes]) => [rel, bytes.toString('base64')])),
      entries: texts,
      after: filesUnder(root),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const ONLY = args.get('only') ?? null;
if (ONLY) {
  // One scenario, printed: the committed fixture is the full run's.
  if (!SCENARIOS[ONLY]) throw new Error(`no scenario ${ONLY}; one of ${Object.keys(SCENARIOS).join(', ')}`);
  const text = `${JSON.stringify(await record(ONLY), null, 2)}\n`;
  await new Promise((written, failed) => process.stdout.write(text, (error) => (error ? failed(error) : written())));
  process.exit(0);
}
const scenarios = [];
for (const name of Object.keys(SCENARIOS)) scenarios.push(await record(name));
const FIXTURES = join(FIXTURES_ROOT, 'effort-decision-log');
const out = stageSet(FIXTURES);
writeJson(join(out, 'golden.json'), {
  note: 'Node decision-log.mjs (b6f10295a + node-change-effort-decision-log.patch): files before, entries recorded one by one (rotation settled after each), every file after; file bytes base64.',
  scenarios,
});
writeSetManifest(out, {
  set: 'effort-decision-log',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <git archive of ${REF} (src, apps, package.json) with ${identity.patch.file} applied, with node_modules> --patch ${identity.patch.file}`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    scenarios: scenarios.map((scenario) => ({ name: scenario.name, entries: scenario.entries.length, files: Object.keys(scenario.after) })),
    exclusions: [],
  },
});
commitStage(out, FIXTURES);
console.log(`effort-decision-log: ${scenarios.length} scenarios`);
process.exit(0);
