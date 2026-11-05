// Regenerates corpus_rows.json: what Node's restore shows for every user-role and room
// message of the migrated corpus sessions, from the Node functions themselves.
//
//   cargo test -p mixdog-migrate --lib restore::tests::dump_corpus_messages -- --ignored
//       (with MIXDOG_RESTORE_DUMP=<dump.json>)
//   node generate.mjs <mixdog repo root> <dump.json> > corpus_rows.json
//
// For each session, one `createUserTextRestore()` serves the whole load (one shared read
// budget, as `restoreTranscriptItems` does) and each message goes through the branch
// `restoreTranscriptRange` takes for it: `roomRowItem` for a room row,
// `restoredUserTranscriptItems` for a user row. Each entry is the message index, the kinds of
// its rows and the sha256 of the stable JSON of its normalized rows and prompt-history text.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [repo, dumpPath] = process.argv.slice(2);
const restorePath = join(repo, 'src/runtime/agent/orchestrator/session/transcript-restore/restore.mjs');
const restoreUrl = pathToFileURL(restorePath).href;

// restoredUserTranscriptItems is module-private: a load hook exports it from restore.mjs.
const hooks = `
export async function load(url, context, next) {
  const loaded = await next(url, context);
  if (url === ${JSON.stringify(restoreUrl)}) {
    const source = String(loaded.source) + '\\nexport { restoredUserTranscriptItems };\\n';
    return { ...loaded, source, shortCircuit: true };
  }
  return loaded;
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);

const { restoredUserTranscriptItems } = await import(restoreUrl);
const { createUserTextRestore } = await import(
  pathToFileURL(join(repo, 'src/runtime/agent/orchestrator/session/transcript-restore/user-text.mjs')).href
);
const { isRoomRowMessage, roomRowItem } = await import(
  pathToFileURL(join(repo, 'src/runtime/agent/orchestrator/session/agent-room.mjs')).href
);
const { promptHistoryKey } = await import(pathToFileURL(join(repo, 'src/tui/prompt-history-store.mjs')).href);

// migration-corpus/tools/corpus-lib.cjs stable(): keys sorted by UTF-16 code unit.
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

function normalized(row) {
  const pick = (keys) => Object.fromEntries(keys.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));
  switch (row.kind) {
    case 'user':
      return pick(['kind', 'text', 'steered']);
    case 'tool':
      return pick(['kind', 'name', 'args', 'result', 'rawResult', 'isError', 'count', 'completedCount', 'messageId', 'at']);
    case 'turndone':
      return pick(['kind', 'status', 'elapsedMs', 'messageId']);
    default:
      return { kind: row.kind };
  }
}

const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
const out = {};
for (const [scenario, { dataDir, sessions }] of Object.entries(dump)) {
  process.env.MIXDOG_DATA_DIR = dataDir;
  out[scenario] = {};
  for (const [sessionId, messages] of Object.entries(sessions)) {
    const userText = createUserTextRestore();
    const entries = [];
    messages.forEach((message, index) => {
      let part = 0;
      const nextId = () => `hist_${sessionId}_${index}_${++part}`;
      let rows;
      if (isRoomRowMessage(message)) rows = [roomRowItem(message, nextId())];
      else if (message?.role === 'user') rows = restoredUserTranscriptItems(message, nextId, userText);
      else return;
      rows = JSON.parse(JSON.stringify(rows)).map(normalized);
      const user = rows.find((row) => row.kind === 'user');
      const prompt = user && promptHistoryKey(user.text) ? user.text : null;
      const digest = createHash('sha256').update(stable({ rows, prompt })).digest('hex');
      entries.push([index, rows.map((row) => row.kind).join(','), digest]);
    });
    out[scenario][sessionId] = entries;
  }
}
process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
