#!/usr/bin/env node
// Genuine 1.4.5 transcript display: what Node's stored-transcript projection shows for every
// session json of the migration corpus, in `history` mode (storedHistorySlice, whole): the rows
// of the visible compaction archive (archived items and their dividers, `compactionArchiveRange`
// + `readCompactionArchivePage`) followed by `restoreTranscriptItems` of the session's messages.
// The Rust `Transcript` (mixdog-core session) must show the same rows for the same session after
// migration (`session/transcript_golden.rs`).
//
//   node benchmarks/rust-core/recorders/record-transcript-display.mjs --tree <tree w/ node_modules> \
//        [--corpus <migration-corpus>]
// Output: native/core/fixtures/migration/transcript-display/display.json
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  FIXTURES_ROOT,
  SECRET_PATTERNS,
  commitStage,
  importFrom,
  parseArgs,
  resolveTree,
  stageSet,
  writeJson,
  writeSetManifest,
} from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const corpus = resolve(args.get('corpus') ?? 'C:/Users/tempe/.mixdog/data/scratch/rust-core/migration-corpus');
const { restoreTranscriptItems } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/transcript-restore/restore.mjs');
const { compactionArchiveRange, readCompactionArchivePage } = await importFrom(
  tree,
  'src/runtime/agent/orchestrator/session/compaction-archive.mjs'
);

const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'electron-profile') walk(path);
    } else if (/\.json$/.test(entry.name) && path.split(sep).includes('sessions')) files.push(path);
  }
};
walk(corpus);

const sessions = [];
const skipped = [];
for (const file of files.sort()) {
  const key = relative(corpus, file).split(sep).join('/');
  const session = JSON.parse(readFileSync(file, 'utf8'));
  if (!session.id || !Array.isArray(session.messages)) {
    skipped.push({ key, reason: 'no id or messages' });
    continue;
  }
  const restored = restoreTranscriptItems(session.messages, { sessionId: session.id });
  const range = compactionArchiveRange(session);
  const archive = range
    ? (await readCompactionArchivePage(dirname(file), session.id, { ...range, limit: Number.POSITIVE_INFINITY })).items
    : [];
  sessions.push({ key, id: session.id, archived: archive.length, rows: [...archive, ...restored] });
}

// A fixture never holds credential-shaped text. The shapes found in the rows are replaced by a
// marker, in the recording and (by the same list) in the Rust rows before they are compared.
const REDACTION = '\u00abredacted\u00bb';
const redact = [];
const text = JSON.stringify(sessions);
for (const pattern of SECRET_PATTERNS) {
  if (!pattern.test(text)) continue;
  if (pattern.source.includes('(?!')) throw new Error(`a credential shape without a portable redaction: ${pattern}`);
  redact.push(pattern.source);
}
const redactions = redact.map((source) => new RegExp(source, 'g'));
const clean = (value) => {
  if (typeof value === 'string') return redactions.reduce((s, re) => s.replace(re, REDACTION), value);
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)]));
  return value;
};

const finalOut = join(FIXTURES_ROOT, 'migration', 'transcript-display');
const out = stageSet(finalOut);
writeJson(join(out, 'display.json'), {
  note: 'archive page + restoreTranscriptItems per corpus session json; key = path under the corpus; archived = leading archive rows; redact = credential shapes replaced by the marker in every string',
  redact: { marker: REDACTION, patterns: redact },
  sessions: clean(sessions),
  skipped,
});
writeSetManifest(out, {
  set: 'migration/transcript-display',
  recorder: 'benchmarks/rust-core/recorders/record-transcript-display.mjs',
  command: 'node benchmarks/rust-core/recorders/record-transcript-display.mjs --tree <tree> [--corpus <migration-corpus>]',
  extra: { sessions: sessions.length, skipped: skipped.length },
});
commitStage(out, finalOut);
console.log(`sessions=${sessions.length} skipped=${skipped.length}`);
