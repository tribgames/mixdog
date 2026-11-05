#!/usr/bin/env node
// Genuine 1.4.5 per-message presence: for every message of every migration-corpus session json,
// whether `restoreTranscriptItems` shows any row for it. Each message is restored in a window
// of its own (the message before it, for the context-ack rule; the session's later tool
// messages, whose results hide a built-in skill load), so rows folded into a neighbour's
// aggregate card cannot hide it; a row belongs to the message whose index is in its id.
// `mixdog_protocol::message_class::messages_shown` must give the same booleans
// (`mixdog-core/src/session/transcript_golden.rs`, `presence_equals_nodes_for_every_message`).
//
//   node benchmarks/rust-core/recorders/record-message-presence.mjs --tree <tree w/ node_modules> \
//        [--corpus <migration-corpus>]
// Output: native/core/fixtures/migration/message-presence/presence.json
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
  FIXTURES_ROOT,
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
let shownCount = 0;
let hiddenCount = 0;
for (const file of files.sort()) {
  const session = JSON.parse(readFileSync(file, 'utf8'));
  if (!session.id || !Array.isArray(session.messages)) continue;
  const { messages } = session;
  const results = messages.map((message, index) => (message?.role === 'tool' ? index : -1)).filter((index) => index >= 0);
  const shown = messages.map((message, index) => {
    const before = index > 0 ? [messages[index - 1]] : [];
    const later = results.filter((at) => at > index).map((at) => messages[at]);
    const window = [...before, message, ...later];
    const prefix = `hist_${session.id}_${before.length}_`;
    const rows = restoreTranscriptItems(window, { sessionId: session.id });
    return rows.some((row) => String(row?.id ?? '').startsWith(prefix));
  });
  for (const value of shown) value ? (shownCount += 1) : (hiddenCount += 1);
  sessions.push({ key: relative(corpus, file).split(sep).join('/'), id: session.id, shown });
}

const finalOut = join(FIXTURES_ROOT, 'migration', 'message-presence');
const out = stageSet(finalOut);
writeJson(join(out, 'presence.json'), {
  note: 'per corpus session json (key = path under the corpus): shown[i] = restoreTranscriptItems shows a row for messages[i]',
  sessions,
});
writeSetManifest(out, {
  set: 'migration/message-presence',
  recorder: 'benchmarks/rust-core/recorders/record-message-presence.mjs',
  command: 'node benchmarks/rust-core/recorders/record-message-presence.mjs --tree <tree> [--corpus <migration-corpus>]',
  extra: { sessions: sessions.length, shown: shownCount, hidden: hiddenCount },
});
commitStage(out, finalOut);
console.log(`sessions=${sessions.length} shown=${shownCount} hidden=${hiddenCount}`);
