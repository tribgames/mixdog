// Synthetic fixtures: the title records Claude Code appends to a transcript, and
// Codex rollouts that continue another rollout through `history_base`.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

const { convertCandidateFile, enumerateCandidates, listConversations, resetConversationDiscovery } = await import(
  './discovery.mjs'
);

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'mixdog-title-history-')));
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

let seq = 0;
const freshEnv = () => {
  resetConversationDiscovery();
  const home = join(root, `case-${++seq}`);
  mkdirSync(home, { recursive: true });
  return { home, env: { CODEX_HOME: join(home, 'codex'), CLAUDE_CONFIG_DIR: join(home, 'claude') } };
};
const noneImported = { has: () => false, get: () => null };
const jsonl = (records) => `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;

async function listAll(source, env) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const page = await listConversations({ source }, { imported: noneImported, env });
    if (page.complete) return page.rows;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('discovery never completed');
}

// ── Claude Code stored titles ────────────────────────────────────────────────
const claudeEntry = (uuid, parentUuid, type, text, cwd) => ({
  uuid,
  parentUuid,
  type,
  isSidechain: false,
  sessionId: 'claude-title',
  cwd,
  message: { role: type, content: type === 'user' ? text : [{ type: 'text', text }] },
});

async function claudeTitle(extraRecords, { padBytes = 0 } = {}) {
  const { home, env } = freshEnv();
  const dir = join(env.CLAUDE_CONFIG_DIR, 'projects', 'C--titles');
  mkdirSync(dir, { recursive: true });
  const records = [
    claudeEntry('u1', null, 'user', 'First message title', home),
    claudeEntry('a1', 'u1', 'assistant', 'Ok', home),
  ];
  if (padBytes) records.push(claudeEntry('a2', 'a1', 'assistant', 'x'.repeat(padBytes), home));
  writeFileSync(join(dir, 'claude-title.jsonl'), jsonl([...records, ...extraRecords]));
  const rows = await listAll('claude', env);
  assert.equal(rows.length, 1);
  return rows[0].title;
}

test('Claude Code title: a /rename (custom-title) wins over an AI title and summary', async () => {
  assert.equal(
    await claudeTitle([
      { type: 'ai-title', sessionId: 'claude-title', aiTitle: 'AI name' },
      { type: 'summary', leafUuid: 'a1', summary: 'A summary' },
      { type: 'custom-title', sessionId: 'claude-title', customTitle: 'Renamed by user' },
    ]),
    'Renamed by user'
  );
});

test('Claude Code title: the AI title wins over a summary and the last prompt', async () => {
  assert.equal(
    await claudeTitle([
      { type: 'ai-title', sessionId: 'claude-title', aiTitle: 'AI name' },
      { type: 'summary', leafUuid: 'a1', summary: 'A summary' },
      { type: 'last-prompt', sessionId: 'claude-title', lastPrompt: 'Later prompt' },
    ]),
    'AI name'
  );
});

test('Claude Code title: a summary comes before the last prompt', async () => {
  assert.equal(
    await claudeTitle([
      { type: 'last-prompt', sessionId: 'claude-title', lastPrompt: 'Later prompt' },
      { type: 'summary', leafUuid: 'a1', summary: 'A summary' },
    ]),
    'A summary'
  );
  assert.equal(
    await claudeTitle([{ type: 'last-prompt', sessionId: 'claude-title', lastPrompt: 'Later prompt' }]),
    'Later prompt'
  );
});

test('Claude Code title: no title record (task-summary and agent-name never name it) falls back to the first message', async () => {
  assert.equal(
    await claudeTitle([
      { type: 'task-summary', sessionId: 'claude-title', summary: 'Working on it', timestamp: '2026-01-01T00:00:00Z' },
      { type: 'agent-name', sessionId: 'claude-title', agentName: 'worker' },
    ]),
    'First message title'
  );
});

test('Claude Code title: the last of repeated records wins, and a title in the tail of a long transcript is found', async () => {
  assert.equal(
    await claudeTitle(
      [
        { type: 'custom-title', sessionId: 'claude-title', customTitle: 'Old name' },
        { type: 'custom-title', sessionId: 'claude-title', customTitle: 'New name' },
      ],
      { padBytes: 700 * 1024 }
    ),
    'New name'
  );
});

// ── Codex history_base ───────────────────────────────────────────────────────
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const msg = (role, text) => ({
  type: 'response_item',
  payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
});
const meta = (threadId, cwd, extra = {}) => ({
  type: 'session_meta',
  payload: { id: threadId, cwd, originator: 'Codex Desktop', source: 'vscode', history_mode: 'paginated', ...extra },
});
const byteLength = (records) => Buffer.byteLength(jsonl(records));

// Writes `rollout-…-<thread>[_<rollout>].jsonl[.zst]` under sessions (or another folder).
function writeRollout(env, thread, rollout, records, { folder = 'sessions', ext = 'jsonl' } = {}) {
  const dir = join(env.CODEX_HOME, folder, '2026', '01', '01');
  mkdirSync(dir, { recursive: true });
  const ids = rollout === thread ? thread : `${thread}_${rollout}`;
  const path = join(dir, `rollout-2026-01-01T00-00-00-${ids}.${ext}`);
  writeFileSync(path, ext.endsWith('.zst') ? zlib.zstdCompressSync(jsonl(records)) : jsonl(records));
  return path;
}

const base = (rollout, records) => ({
  thread_id: rollout,
  end_ordinal_exclusive: records.length,
  end_byte_offset: byteLength(records),
});

async function convert(env, path, limits) {
  const { candidates } = await enumerateCandidates('codex', env);
  const candidate = candidates.find((entry) => entry.path === realpathSync.native(path));
  return convertCandidateFile(candidate, limits);
}
const texts = (conversion) => conversion.turns.map((turn) => turn.text);

// A reverted thread: A (root) ← B ← C, each continuing the previous one up to a cutoff.
function revertedThread(env, cwd) {
  const thread = id(1);
  const aHead = [meta(thread, cwd), msg('user', 'first question'), msg('assistant', 'first answer')];
  const aPath = writeRollout(env, thread, thread, [...aHead, msg('user', 'dropped after A cutoff')]);
  const bHead = [
    meta(thread, cwd, { history_base: base(thread, aHead) }),
    msg('user', 'second question'),
    msg('assistant', 'second answer'),
  ];
  const bPath = writeRollout(env, thread, id(2), [...bHead, msg('user', 'dropped after B cutoff')]);
  const cRecords = [
    meta(thread, cwd, { history_base: base(id(2), bHead) }),
    msg('user', 'third question'),
    msg('assistant', 'third answer'),
  ];
  const cPath = writeRollout(env, thread, id(3), cRecords);
  return { aPath, bPath, cPath, aHead, bHead, thread };
}

const FULL_THREAD = [
  'first question',
  'first answer',
  'second question',
  'second answer',
  'third question',
  'third answer',
];

test('Codex history_base: a two-level chain is reassembled oldest first, each base cut at its offset', async () => {
  const { home, env } = freshEnv();
  const { cPath, thread } = revertedThread(env, home);
  const conversation = await convert(env, cPath);
  assert.deepEqual([conversation.errorCode, conversation.warnings, conversation.foreignSessionId], [null, [], thread]);
  assert.deepEqual(texts(conversation), FULL_THREAD);
  assert.equal(conversation.messageCount, 6);
});

test('Codex history_base: an earlier revision of the same thread is not listed, the current one is', async () => {
  const { home, env } = freshEnv();
  revertedThread(env, home);
  const rows = await listAll('codex', env);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].messageCount, rows[0].warnings.includes('historyPartial')], [null, false]);
});

test('Codex history_base: the parent of a fork is another thread and stays listed', async () => {
  const { home, env } = freshEnv();
  const parentHead = [meta(id(10), home), msg('user', 'parent question'), msg('assistant', 'parent answer')];
  writeRollout(env, id(10), id(10), parentHead);
  const forkPath = writeRollout(env, id(11), id(11), [
    meta(id(11), home, { history_base: base(id(10), parentHead) }),
    msg('user', 'fork question'),
    msg('assistant', 'fork answer'),
  ]);
  assert.equal((await listAll('codex', env)).length, 2);
  assert.deepEqual(texts(await convert(env, forkPath)), [
    'parent question',
    'parent answer',
    'fork question',
    'fork answer',
  ]);
});

test('Codex history_base: a missing base keeps the partial warning and imports what is readable', async () => {
  const { home, env } = freshEnv();
  const path = writeRollout(env, id(20), id(21), [
    meta(id(20), home, { history_base: { thread_id: id(99), end_ordinal_exclusive: 3, end_byte_offset: 50 } }),
    msg('user', 'own question'),
    msg('assistant', 'own answer'),
  ]);
  const conversation = await convert(env, path);
  assert.deepEqual([conversation.errorCode, conversation.warnings], [null, ['historyUnavailable']]);
  assert.deepEqual(texts(conversation), ['own question', 'own answer']);
});

test('Codex history_base: a compressed rollout with a missing base is listed with title, count and the reason', async () => {
  const { home, env } = freshEnv();
  writeRollout(
    env,
    id(30),
    id(31),
    [
      meta(id(30), home, { history_base: { thread_id: id(98), end_ordinal_exclusive: 3, end_byte_offset: 50 } }),
      msg('user', 'own question'),
      msg('assistant', 'own answer'),
    ],
    { ext: 'jsonl.zst' }
  );
  const rows = await listAll('codex', env);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    [rows[0].title, rows[0].messageCount, rows[0].warnings.includes('historyUnavailable')],
    ['own question', 2, true]
  );
});

// ── compressed (zstd) rollouts ───────────────────────────────────────────────
const comparable = ({ bytesRead, ...conversation }) => conversation;

test('compressed rollout: a conversation stored only as .jsonl.zst is listed and converts like its plain form', async () => {
  const plain = freshEnv();
  const records = [meta(id(100), plain.home), msg('user', 'packed question'), msg('assistant', 'packed answer')];
  const plainPath = writeRollout(plain.env, id(100), id(100), records);
  const packed = freshEnv();
  const packedPath = writeRollout(packed.env, id(100), id(100), records, { ext: 'jsonl.zst' });
  const rows = await listAll('codex', packed.env);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].warnings.includes('unreadable'), false);
  const fromPlain = await convert(plain.env, plainPath);
  const fromPacked = await convert(packed.env, packedPath);
  assert.equal(fromPacked.errorCode, null);
  assert.deepEqual(texts(fromPacked), ['packed question', 'packed answer']);
  assert.deepEqual(comparable(fromPacked), comparable(fromPlain));
});

test('compressed rollout: a plain file and its compressed sibling are listed once, the plain one is read', async () => {
  const { home, env } = freshEnv();
  const records = [meta(id(101), home), msg('user', 'plain question'), msg('assistant', 'plain answer')];
  const plainPath = writeRollout(env, id(101), id(101), records);
  // The sibling is unreadable on purpose: it must never be opened.
  writeFileSync(`${plainPath}.zst`, 'not zstd');
  assert.equal((await listAll('codex', env)).length, 1);
  const { candidates } = await enumerateCandidates('codex', env);
  assert.deepEqual(
    candidates.map((candidate) => candidate.path),
    [realpathSync.native(plainPath)]
  );
  assert.deepEqual(texts(await convert(env, plainPath)), ['plain question', 'plain answer']);
});

test('compressed rollout: a compressed base contributes exactly the records before its decompressed cutoff', async () => {
  const { home, env } = freshEnv();
  // Highly compressible, so the cutoff lies far beyond the compressed file size.
  const head = [meta(id(110), home), msg('user', 'packed question'), msg('assistant', `packed ${'z'.repeat(50_000)}`)];
  const packedPath = writeRollout(env, id(110), id(110), [...head, msg('user', 'dropped after cutoff')], {
    ext: 'jsonl.zst',
  });
  const good = base(id(110), head);
  assert.ok(good.end_byte_offset > statSync(packedPath).size);
  const own = (historyBase, thread) => [
    meta(thread, home, { history_base: historyBase }),
    msg('user', 'own question'),
    msg('assistant', 'own answer'),
  ];
  const path = writeRollout(env, id(111), id(111), own(good, id(111)));
  const conversation = await convert(env, path);
  assert.deepEqual([conversation.errorCode, conversation.warnings], [null, []]);
  assert.deepEqual(texts(conversation), [
    'packed question',
    `packed ${'z'.repeat(50_000)}`,
    'own question',
    'own answer',
  ]);
  // A cutoff inside a record, or past the decompressed end, is never a slice.
  for (const [index, end] of [
    good.end_byte_offset - 3,
    byteLength([...head, msg('user', 'dropped after cutoff')]) + 1,
  ].entries()) {
    const bad = writeRollout(
      env,
      id(112 + index),
      id(112 + index),
      own({ ...good, end_byte_offset: end }, id(112 + index))
    );
    const partial = await convert(env, bad);
    assert.deepEqual(
      [index, partial.warnings, texts(partial)],
      [index, ['historyPartial'], ['own question', 'own answer']]
    );
  }
});

test('compressed rollout: the file limit counts decompressed bytes and stops the chain with the size-limit reason', async () => {
  const { home, env } = freshEnv();
  const head = [meta(id(120), home), msg('user', 'packed question'), msg('assistant', `packed ${'z'.repeat(50_000)}`)];
  writeRollout(env, id(120), id(120), head, { ext: 'jsonl.zst' });
  const own = [
    meta(id(121), home, { history_base: base(id(120), head) }),
    msg('user', 'own question'),
    msg('assistant', 'own answer'),
  ];
  const path = writeRollout(env, id(121), id(121), own);
  // The compressed base is a few hundred bytes, far under this limit; its decompressed cutoff is not.
  const limited = await convert(env, path, { maxFileBytes: 20_000 });
  assert.deepEqual([limited.errorCode, limited.warnings], [null, ['historySizeLimit']]);
  assert.deepEqual(texts(limited), ['own question', 'own answer']);
  const roomy = await convert(env, path, { maxFileBytes: 200_000 });
  assert.deepEqual([roomy.warnings, roomy.turns.length], [[], 4]);
});

test('compressed rollout: an unreadable compressed base is reported as unavailable', async () => {
  const { home, env } = freshEnv();
  const head = [meta(id(130), home), msg('user', 'packed')];
  const packed = writeRollout(env, id(130), id(130), head, { ext: 'jsonl.zst' });
  writeFileSync(packed, 'damaged, not zstd');
  const path = writeRollout(env, id(131), id(131), [
    meta(id(131), home, { history_base: base(id(130), head) }),
    msg('user', 'own question'),
    msg('assistant', 'own answer'),
  ]);
  const conversation = await convert(env, path);
  assert.deepEqual(
    [conversation.warnings, texts(conversation)],
    [['historyUnavailable'], ['own question', 'own answer']]
  );
});

test('compressed rollout: a runtime without zstd lists the file with a newer-Node notice and refuses to convert it', async (t) => {
  const { home, env } = freshEnv();
  const packedPath = writeRollout(
    env,
    id(140),
    id(140),
    [meta(id(140), home), msg('user', 'q'), msg('assistant', 'a')],
    { ext: 'jsonl.zst' }
  );
  const original = Object.getOwnPropertyDescriptor(zlib, 'createZstdDecompress');
  Object.defineProperty(zlib, 'createZstdDecompress', { ...original, value: undefined });
  t.after(() => Object.defineProperty(zlib, 'createZstdDecompress', original));
  const rows = await listAll('codex', env);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].warnings.includes('needsNewerNode'), true);
  await assert.rejects(convert(env, packedPath), { code: 'needsNewerNode' });
});

test('compressed rollout: without zstd, a plain conversation on a compressed base keeps the newer-Node reason, listed and converted', async (t) => {
  const { home, env } = freshEnv();
  const head = [meta(id(150), home), msg('user', 'packed question'), msg('assistant', 'packed answer')];
  writeRollout(env, id(150), id(150), head, { ext: 'jsonl.zst' });
  const path = writeRollout(env, id(151), id(151), [
    meta(id(151), home, { history_base: base(id(150), head) }),
    msg('user', 'own question'),
    msg('assistant', 'own answer'),
  ]);
  const original = Object.getOwnPropertyDescriptor(zlib, 'createZstdDecompress');
  Object.defineProperty(zlib, 'createZstdDecompress', { ...original, value: undefined });
  t.after(() => Object.defineProperty(zlib, 'createZstdDecompress', original));
  const { candidates } = await enumerateCandidates('codex', env);
  const own = candidates.find((candidate) => candidate.path === realpathSync.native(path));
  const row = (await listAll('codex', env)).find((entry) => entry.id === own.id);
  assert.equal(row.warnings.includes('needsNewerNode'), true);
  const conversation = await convert(env, path);
  assert.deepEqual([conversation.warnings, texts(conversation)], [['needsNewerNode'], ['own question', 'own answer']]);
});

test('rollout file names follow the source app: `rollout-….jsonl` or `.jsonl.zst`, case-sensitive', async () => {
  const { env } = freshEnv();
  const dir = join(env.CODEX_HOME, 'sessions', '2026', '01', '01');
  mkdirSync(dir, { recursive: true });
  const record = jsonl([meta(id(160), env.CODEX_HOME), msg('user', 'q'), msg('assistant', 'a')]);
  const stamp = '2026-01-01T00-00-00';
  const kept = `rollout-${stamp}-${id(160)}.jsonl`;
  writeFileSync(join(dir, kept), record);
  for (const name of [
    `notes-${stamp}-${id(161)}.jsonl.zst`, // not a rollout name
    `rollout-${stamp}-${id(162)}.jsonl.ZST`, // the suffix is case-sensitive
    `rollout-${stamp}-${id(163)}.JSONL`,
    `rollout-${stamp}-${id(164)}.zst`, // compressed but not a .jsonl.zst
  ]) {
    writeFileSync(join(dir, name), zlib.zstdCompressSync(record));
  }
  const { candidates } = await enumerateCandidates('codex', env);
  assert.deepEqual(
    candidates.map((candidate) => candidate.path),
    [realpathSync.native(join(dir, kept))]
  );
});

test('compressed rollout: the continuing file itself counts at its decompressed size', async () => {
  const { home, env } = freshEnv();
  const head = [meta(id(170), home), msg('user', 'base question'), msg('assistant', 'base answer')];
  writeRollout(env, id(170), id(170), head);
  const ownRecords = [
    meta(id(171), home, { history_base: base(id(170), head) }),
    msg('user', 'own question'),
    msg('assistant', `own ${'q'.repeat(50_000)}`),
  ];
  const path = writeRollout(env, id(171), id(171), ownRecords, { ext: 'jsonl.zst' });
  const end = byteLength(head);
  // The first-record pre-read takes one 8 KiB chunk; the file and the base cutoff would be one byte over together.
  const limit = byteLength(ownRecords) + 8 * 1024 + end - 1;
  const conversation = await convert(env, path, { maxFileBytes: limit });
  assert.deepEqual([conversation.errorCode, conversation.warnings], [null, ['historySizeLimit']]);
  assert.deepEqual(texts(conversation), ['own question', `own ${'q'.repeat(50_000)}`]);
});

test('Codex history_base: a cycle is cut where it closes', async () => {
  const { home, env } = freshEnv();
  const thread = id(40);
  const yRecords = [
    meta(thread, home, { history_base: { thread_id: thread, end_ordinal_exclusive: 1, end_byte_offset: 1 } }),
    msg('user', 'y question'),
    msg('assistant', 'y answer'),
  ];
  writeRollout(env, thread, id(41), yRecords);
  const xPath = writeRollout(env, thread, thread, [
    meta(thread, home, { history_base: base(id(41), yRecords) }),
    msg('user', 'x question'),
    msg('assistant', 'x answer'),
  ]);
  const conversation = await convert(env, xPath);
  assert.deepEqual(conversation.warnings, ['historyPartial']);
  assert.deepEqual(texts(conversation), ['y question', 'y answer', 'x question', 'x answer']);
});

test('Codex history_base: bases that would take the total over the file limit are left out with the warning', async () => {
  const { home, env } = freshEnv();
  const { cPath, aHead, bHead } = revertedThread(env, home);
  const cSize = byteLength([
    meta(id(1), home, { history_base: base(id(2), bHead) }),
    msg('user', 'third question'),
    msg('assistant', 'third answer'),
  ]);
  // Every metadata read counts too: C's first record, then B's (read up to B's cutoff).
  const limit = cSize + cSize + 2 * byteLength(bHead) + byteLength(aHead) - 1;
  const conversation = await convert(env, cPath, { maxFileBytes: limit });
  assert.deepEqual(conversation.warnings, ['historySizeLimit']);
  assert.equal(conversation.errorCode, null);
  assert.deepEqual(texts(conversation), ['second question', 'second answer', 'third question', 'third answer']);
});

test('Codex history_base: metadata pre-reads count against the file limit', async () => {
  const { home, env } = freshEnv();
  const { cPath, bHead } = revertedThread(env, home);
  const cSize = byteLength([
    meta(id(1), home, { history_base: base(id(2), bHead) }),
    msg('user', 'third question'),
    msg('assistant', 'third answer'),
  ]);
  // The file and B's cutoff alone fit, but not once C's first record is also read ahead.
  const conversation = await convert(env, cPath, { maxFileBytes: cSize + byteLength(bHead) });
  assert.deepEqual(conversation.warnings, ['historySizeLimit']);
  assert.deepEqual(texts(conversation), ['third question', 'third answer']);
});

test('Codex history_base: blank lines before the first record do not escape the cutoff', async () => {
  const { home, env } = freshEnv();
  const thread = id(50);
  const blanks = '\n'.repeat(400);
  const baseDir = join(env.CODEX_HOME, 'sessions', '2026', '01', '01');
  mkdirSync(baseDir, { recursive: true });
  writeFileSync(
    join(baseDir, `rollout-2026-01-01T00-00-00-${thread}.jsonl`),
    `${blanks}${jsonl([meta(thread, home), msg('user', 'hidden by padding')])}`
  );
  const path = writeRollout(env, id(51), id(51), [
    meta(id(51), home, { history_base: { thread_id: thread, end_ordinal_exclusive: 2, end_byte_offset: 100 } }),
    msg('user', 'own question'),
    msg('assistant', 'own answer'),
  ]);
  const conversation = await convert(env, path);
  assert.deepEqual([conversation.warnings, texts(conversation)], [['historyPartial'], ['own question', 'own answer']]);
});

test('Codex history_base: a malformed cutoff or base ends in the partial warning, never a wrong slice', async () => {
  const { home, env } = freshEnv();
  const ownRecords = (thread, historyBase) => [
    meta(thread, home, { history_base: historyBase }),
    msg('user', 'own question'),
    msg('assistant', 'own answer'),
  ];
  const parentHead = [meta(id(60), home), msg('user', 'parent question'), msg('assistant', 'parent answer')];
  writeRollout(env, id(60), id(60), parentHead);
  const good = base(id(60), parentHead);
  const cases = [
    { ...good, end_ordinal_exclusive: 0 }, // would include the source's session metadata
    { ...good, end_byte_offset: good.end_byte_offset + 1 }, // past the end of the rollout
    { ...good, end_byte_offset: good.end_byte_offset - 3 }, // inside a record
    { ...good, end_byte_offset: -1 },
    { ...good, end_byte_offset: 1.5 },
  ];
  for (const [index, historyBase] of cases.entries()) {
    const path = writeRollout(env, id(70 + index), id(70 + index), ownRecords(id(70 + index), historyBase));
    const conversation = await convert(env, path);
    assert.deepEqual(
      [index, conversation.warnings, texts(conversation)],
      [index, ['historyPartial'], ['own question', 'own answer']]
    );
  }
  // A base that is not a paginated history is not followed either.
  const legacyHead = [meta(id(80), home, { history_mode: 'legacy' }), msg('user', 'legacy')];
  writeRollout(env, id(80), id(80), legacyHead);
  const legacy = writeRollout(env, id(81), id(81), ownRecords(id(81), base(id(80), legacyHead)));
  assert.deepEqual((await convert(env, legacy)).warnings, ['historyPartial']);
});

// ── listing a continuation ───────────────────────────────────────────────────
test('Codex history_base: a continuation holding only metadata stays listed while its predecessor is hidden', async () => {
  const { home, env } = freshEnv();
  const thread = id(90);
  const aRecords = [meta(thread, home), msg('user', 'real question'), msg('assistant', 'real answer')];
  writeRollout(env, thread, thread, aRecords);
  const bPath = writeRollout(env, thread, id(91), [meta(thread, home, { history_base: base(thread, aRecords) })]);
  const rows = await listAll('codex', env);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].messageCount, rows[0].warnings.includes('empty')], [null, false]);
  assert.deepEqual(texts(await convert(env, bPath)), ['real question', 'real answer']);
});

test('Codex history_base: revisions that name each other never hide the whole thread', async () => {
  const { home, env } = freshEnv();
  const thread = id(95);
  const records = (historyBase) => [
    meta(thread, home, { history_base: historyBase }),
    msg('user', 'q'),
    msg('assistant', 'a'),
  ];
  writeRollout(env, thread, thread, records({ thread_id: id(96), end_ordinal_exclusive: 1, end_byte_offset: 1 }));
  writeRollout(env, thread, id(96), records({ thread_id: thread, end_ordinal_exclusive: 1, end_byte_offset: 1 }));
  assert.equal((await listAll('codex', env)).length, 1);
});
