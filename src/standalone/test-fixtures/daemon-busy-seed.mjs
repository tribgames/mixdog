// Seeds an isolated Mixdog data dir for the busy-sessions scenario of
// scripts/daemon-load-bench.mjs: realistic multi-MB session records (plus a
// compaction archive for the first few), a store of ~300 session files, and a
// small git repository for workspace management. Written the way the store
// itself persists a session (`<data>/sessions/<id>.json`, the archive beside
// it as `<id>.compaction-archive.jsonl`, tmp file then rename), so any release
// tree reads it back; only the archive line writer comes from the tree under
// test, because its header format is that tree's own.
//
// Deterministic: every byte derives from `seed` (and the wall clock only for
// the record timestamps, which are relative to `now`).
import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MB = 1024 * 1024;
/** Sizes of the busy sessions' records, from the report's heaviest sessions
 *  (2.0 MB + 13.5 MB archive, 1.7 + 2.8, 1.3 + 4.4, a 2.65 MB agent-sized
 *  one), then more multi-MB records; `archiveMb` only on the first three. */
const BUSY_PROFILES = [
  { jsonMb: 2.0, archiveMb: 13.5 },
  { jsonMb: 1.7, archiveMb: 2.8 },
  { jsonMb: 1.3, archiveMb: 4.4 },
  { jsonMb: 2.65, archiveMb: 0 },
  ...[1.5, 2.2, 1.4, 1.9, 2.4, 1.6, 1.8, 2.1].map((jsonMb) => ({ jsonMb, archiveMb: 0 })),
];
/** One archive segment's target size: a compaction drops about this much. */
const ARCHIVE_SEGMENT_BYTES = 1.5 * MB;

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A pool of paragraphs of pseudo-prose / code-ish text, so records are not
 *  one repeated byte (JSON.parse and stringify cost depends on content). */
function textPool(rand) {
  const syllables = ['ses', 'ion', 'sto', 're', 'lock', 'ev', 'ent', 'loop', 'sav', 'wri', 'te', 'ren', 'ame', 'tool', 'ca', 'll'];
  const word = () => Array.from({ length: 1 + Math.floor(rand() * 3) }, () => syllables[Math.floor(rand() * syllables.length)]).join('');
  return Array.from({ length: 400 }, () => {
    const sentences = 2 + Math.floor(rand() * 10);
    return Array.from({ length: sentences }, () =>
      Array.from({ length: 6 + Math.floor(rand() * 14) }, word).join(' ') + (rand() < 0.2 ? '();' : '.')
    ).join(' ');
  });
}

function sessionRecord({ id, cwd, title, now, ageMs, provider, model }) {
  return {
    id,
    owner: 'user',
    agent: 'lead',
    closed: false,
    generation: 1,
    provider,
    model,
    toolMode: 'full',
    cwd,
    title,
    createdAt: now - ageMs - 3_600_000,
    updatedAt: now - ageMs,
    tools: [],
  };
}

/** Messages of a conversation until the JSON reaches `targetBytes`: user
 *  prompts, assistant text with tool calls, and the (large) tool results. */
function transcriptMessages({ rand, pool, targetBytes, sessionId }) {
  const messages = [];
  const pick = () => pool[Math.floor(rand() * pool.length)];
  let bytes = 0;
  let turn = 0;
  const push = (message) => {
    messages.push(message);
    bytes += JSON.stringify(message).length + 1;
  };
  while (bytes < targetBytes) {
    turn += 1;
    const callId = `toolu_${sessionId}_${turn}`;
    push({ role: 'user', content: `${pick()} (turn ${turn})` });
    push({
      role: 'assistant',
      content: [
        { type: 'text', text: pick() },
        { type: 'tool_use', id: callId, name: 'read', input: { path: `src/module-${turn % 97}.mjs`, offset: turn } },
      ],
    });
    const result = Array.from({ length: 1 + Math.floor(rand() * 6) }, pick).join('\n');
    push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: result }] });
    push({ role: 'assistant', content: [{ type: 'text', text: pick() }] });
  }
  return messages;
}

function archiveSegments({ rand, pool, targetBytes, sessionId, now }) {
  const segments = [];
  let total = 0;
  for (let seq = 1; total < targetBytes; seq += 1) {
    const items = [];
    let bytes = 0;
    while (bytes < Math.min(ARCHIVE_SEGMENT_BYTES, targetBytes - total)) {
      const item = {
        kind: 'message',
        id: `arch${seq}_${items.length}`,
        role: items.length % 2 ? 'assistant' : 'user',
        text: pool[Math.floor(rand() * pool.length)],
        archived: true,
      };
      items.push(item);
      bytes += JSON.stringify(item).length + 1;
    }
    items.push({ kind: 'statusdone', id: `arch${seq}_divider`, status: 'compacted', label: 'Conversation compacted', at: now });
    segments.push({ seq, prev: seq > 1 ? seq - 1 : null, at: now - (1000 - seq) * 60_000, items });
    total += bytes;
  }
  return segments;
}

function writeAtomic(path, text) {
  const tmp = `${path}.seed-tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** A git repository with one commit (workspace management needs a repo). */
export function createFixtureRepo(dir) {
  mkdirSync(dir, { recursive: true });
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', ...args], {
      cwd: dir,
      stdio: 'ignore',
    });
  git('init', '-q');
  writeFileSync(join(dir, 'README.md'), '# daemon load bench fixture\n');
  git('add', '.');
  git('commit', '-q', '-m', 'fixture');
  return dir;
}

/**
 * @param {object} options
 * @param {string} options.treeRoot  source tree under test (for the archive line writer)
 * @param {string} options.dataDir  MIXDOG_DATA_DIR of the isolated home
 * @param {string} options.cwd  working directory recorded in every session
 * @param {number} options.busy  busy sessions (heavy multi-MB records)
 * @param {number} options.files  total session files in the store (busy + filler)
 * @param {number} options.seed
 * @param {number} options.sizeScale  multiplies every byte size (1 = report sizes)
 */
export async function seedBusyStore({
  treeRoot,
  dataDir,
  cwd,
  busyCwd = cwd,
  busy,
  files,
  seed,
  sizeScale = 1,
  provider = 'openai',
  model = 'gpt-4o-mini',
}) {
  const { compactionSegmentLine } = await import(
    pathToFileURL(join(treeRoot, 'src/runtime/agent/orchestrator/session/compaction-archive.mjs')).href
  );
  const rand = mulberry32(seed);
  const pool = textPool(rand);
  const storeDir = join(dataDir, 'sessions');
  mkdirSync(storeDir, { recursive: true });
  const now = Date.now();
  const busyRows = [];
  let totalBytes = 0;

  for (let index = 0; index < busy; index += 1) {
    const profile = BUSY_PROFILES[index % BUSY_PROFILES.length];
    const id = `sess_busy_${String(index).padStart(3, '0')}`;
    const record = sessionRecord({ id, cwd: busyCwd, title: `busy session ${index}`, now, ageMs: index * 60_000, provider, model });
    record.messages = transcriptMessages({ rand, pool, targetBytes: profile.jsonMb * MB * sizeScale, sessionId: id });
    let archiveBytes = 0;
    if (profile.archiveMb > 0) {
      const segments = archiveSegments({ rand, pool, targetBytes: profile.archiveMb * MB * sizeScale, sessionId: id, now });
      const text = `${segments.map((segment) => compactionSegmentLine(segment)).join('\n')}\n`;
      archiveBytes = Buffer.byteLength(text);
      record.compaction = { archive: { nextSeq: segments.length + 1, clearedThrough: 0 } };
      writeAtomic(join(storeDir, `${id}.compaction-archive.jsonl`), text);
    }
    const text = JSON.stringify(record);
    writeAtomic(join(storeDir, `${id}.json`), text);
    const jsonBytes = Buffer.byteLength(text);
    totalBytes += jsonBytes + archiveBytes;
    busyRows.push({ id, jsonBytes, archiveBytes, messages: record.messages.length });
  }

  // The rest of the store: 40 KB to ~1.6 MB records, mean ~0.57 MB (the
  // reported store: 307 files, 204 MB).
  const fillerCount = Math.max(0, files - busy);
  for (let index = 0; index < fillerCount; index += 1) {
    const id = `sess_fill_${String(index).padStart(4, '0')}`;
    const record = sessionRecord({ id, cwd, title: `stored session ${index}`, now, ageMs: (busy + index + 1) * 120_000, provider, model });
    const targetBytes = (40 * 1024 + rand() ** 2 * 1.6 * MB) * sizeScale;
    record.messages = transcriptMessages({ rand, pool, targetBytes, sessionId: id });
    const text = JSON.stringify(record);
    writeAtomic(join(storeDir, `${id}.json`), text);
    totalBytes += Buffer.byteLength(text);
  }

  return {
    seed,
    sizeScale,
    storeFiles: busy + fillerCount,
    storeBytes: totalBytes,
    busy: busyRows,
  };
}
