// `readSessionHistory` lets the host decide whether an attachment id belongs to
// a session whose chip the pane still shows after a compaction. It is an
// internal host read, never a transcript read a window, a paired phone or a
// page can make: only readSessionAttachment calls it and only attachment
// metadata leaves it; an id the session's visible history never named is
// refused, a cleared or capped archive's included.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test from 'node:test';

import { DESKTOP_IPC } from '../shared/contract.ts';
import { fileDownloadErrorReason } from '../shared/file-downloads.ts';
import { registerSessionIpc } from './ipc-sessions.ts';
import { createRemoteMethods } from './remote-methods.ts';
import { readSessionAttachment } from './session-attachments.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-history-boundary-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const sessionsDir = join(dataDir, 'sessions');
mkdirSync(sessionsDir);
const { readStoredSessionTranscript } = await import(
  '../../../../src/runtime/agent/orchestrator/session/store-summary-reader.mjs'
);
const { compactionSegmentLine } = await import(
  '../../../../src/runtime/agent/orchestrator/session/compaction-archive.mjs'
);

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const record = (bytes, name) => ({
  id: sha(bytes),
  attachmentRef: sha(bytes),
  kind: 'image',
  name,
  mimeType: 'image/png',
  size: bytes.length,
});

const bytes = {
  live: Buffer.from('pasted in the live window'),
  visible: Buffer.from('pasted before the last compaction'),
  cleared: Buffer.from('pasted before a clear'),
  capped: Buffer.from('pasted before the archive cap'),
  other: Buffer.from('another session attachment'),
};
const blobs = new Map(Object.values(bytes).map((buffer) => [sha(buffer), buffer]));
const ids = Object.fromEntries(Object.entries(bytes).map(([key, buffer]) => [key, sha(buffer)]));

const segment = (seq, buffer) =>
  compactionSegmentLine({
    seq,
    prev: seq > 1 ? seq - 1 : null,
    at: seq,
    items: [
      {
        id: `arch${seq}_0_1`,
        kind: 'user',
        text: `PRIVATE ROW TEXT ${seq}`,
        archived: true,
        attachments: [record(buffer, 'image.png')],
      },
      { id: `arch${seq}_divider`, kind: 'statusdone', status: 'compacted' },
    ],
  });

function storeSession(sessionId, { messages, segments = [], archive = null }) {
  writeFileSync(
    join(sessionsDir, `${sessionId}.json`),
    JSON.stringify({
      id: sessionId,
      createdAt: 1_000,
      updatedAt: 2_000,
      status: 'idle',
      owner: 'user',
      messages,
      ...(archive ? { compaction: { archive } } : {}),
    })
  );
  if (segments.length) {
    writeFileSync(
      join(sessionsDir, `${sessionId}.compaction-archive.jsonl`),
      `${segments.map(([seq, buffer]) => segment(seq, buffer)).join('\n')}\n`
    );
  }
}

const sentMessage = (text, buffer) => ({
  role: 'user',
  content: text,
  meta: {
    transcript: { messageId: `msg_${sha(Buffer.from(text)).slice(0, 8)}`, attachments: [record(buffer, 'image.png')] },
  },
});

// s1: segment 1 was cleared (hidden), 2 is visible; segment 0 was dropped by the cap
// (not in the file at all). s2 holds the other attachment.
storeSession('s1', {
  messages: [sentMessage('newest', bytes.live)],
  segments: [
    [1, bytes.cleared],
    [2, bytes.visible],
  ],
  archive: { nextSeq: 3, clearedThrough: 1 },
});
storeSession('s2', { messages: [sentMessage('other session', bytes.other)] });

/** The host as the app wires it: the window it holds, the daemon's attachment
 *  history read, and the attachment store. */
function hostFor(window = { items: [] }) {
  const historyReads = [];
  return {
    historyReads,
    readSessionTranscript: async () => window,
    readSessionHistory: async (sessionId) => {
      historyReads.push(sessionId);
      const stored = await readStoredSessionTranscript(sessionId, { attachmentHistory: true });
      return stored ? { items: stored.items } : null;
    },
    readAttachmentImage: async (ref) => blobs.get(ref)?.toString('base64') ?? null,
  };
}

const refusedAs = async (promise, reason) => {
  const error = await promise.then(
    () => null,
    (failure) => failure
  );
  assert.ok(error, `expected a ${reason} refusal`);
  assert.equal(fileDownloadErrorReason(error), reason, String(error?.message));
};

test('a compacted attachment opens; a cleared, capped, foreign or guessed id is refused', async () => {
  const host = hostFor();
  // The visible archive and the record name their own attachments.
  assert.deepEqual((await readSessionAttachment(host, 's1', ids.visible)).bytes, bytes.visible);
  assert.deepEqual((await readSessionAttachment(host, 's1', ids.live)).bytes, bytes.live);
  // The cleared segment is hidden from the conversation: its id is not the session's.
  await refusedAs(readSessionAttachment(host, 's1', ids.cleared), 'not-linked');
  // The capped one is in no file; another session's id and a guess are not named.
  await refusedAs(readSessionAttachment(host, 's1', ids.capped), 'not-linked');
  await refusedAs(readSessionAttachment(host, 's1', ids.other), 'not-linked');
  await refusedAs(readSessionAttachment(host, 's2', ids.visible), 'not-linked');
  await refusedAs(readSessionAttachment(host, 's1', sha(Buffer.from('guess'))), 'not-linked');
  await refusedAs(readSessionAttachment(host, 'sess_nowhere', ids.visible), 'not-linked');
});

test('the stored history is read only when the held window does not name the id', async () => {
  const window = { items: [{ id: 'u', kind: 'user', attachments: [record(bytes.live, 'image.png')] }] };
  const host = hostFor(window);
  await readSessionAttachment(host, 's1', ids.live);
  assert.deepEqual(host.historyReads, []);
  await readSessionAttachment(host, 's1', ids.visible);
  assert.deepEqual(host.historyReads, ['s1']);
});

test('the desktop read answers attachment bytes and name only, never a transcript row', async () => {
  const host = hostFor();
  const handlers = new Map();
  registerSessionIpc({
    handle: (channel, listener) => handlers.set(channel, listener),
    host,
    invokeDesktopOperation: async () => null,
  });
  const sessionId = `sess_desktop_${'a'.repeat(64)}`;
  storeSession(sessionId, { messages: [sentMessage('a desktop message', bytes.live)] });
  const answer = await handlers.get(DESKTOP_IPC.readSessionAttachment)({}, sessionId, ids.live);
  assert.deepEqual(Object.keys(answer).sort(), ['dataUrl', 'mimeType', 'name', 'size']);
  assert.equal(JSON.stringify(answer).includes('a desktop message'), false);
});

test('no channel of the renderer, the paired phone or the service reaches the history as a transcript read', async () => {
  const host = hostFor();
  // A paired phone calls only the methods its table holds, by own name.
  const remote = createRemoteMethods({ host });
  for (const name of ['readSessionHistory', 'readSessionTranscript']) {
    assert.equal(Object.hasOwn(remote, name), false, `${name} is not a remote method`);
  }
  // The window's IPC is a fixed channel list: none is a history read.
  const handlers = new Map();
  registerSessionIpc({
    handle: (channel, listener) => handlers.set(channel, listener),
    host,
    invokeDesktopOperation: async () => null,
  });
  assert.equal(
    [...Object.keys(DESKTOP_IPC), ...Object.values(DESKTOP_IPC)].some((name) =>
      /SessionHistory|session-history/i.test(name)
    ),
    false
  );
  assert.equal(
    [...handlers.keys()].some((channel) => /history/i.test(String(channel))),
    false
  );
});

/** Source files of the app, tests excluded. */
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mjs|js)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

test('only the host, its client and readSessionAttachment name the history read', () => {
  const root = join(import.meta.dirname, '..');
  const naming = sourceFiles(root)
    .filter((file) => readFileSync(file, 'utf8').includes('readSessionHistory'))
    .map((file) => relative(root, file).split(sep).join('/'))
    .sort();
  assert.deepEqual(naming, [
    // The service RPC list and its typed contract (main <-> service process only).
    'main/desktop-service-client.ts',
    'main/desktop-service-contract.ts',
    // The download host's type Pick, handed on to readSessionAttachment.
    'main/file-downloads.ts',
    // The one caller.
    'main/session-attachments.ts',
    'main/session-host-transport.ts',
    'main/session-host.ts',
  ]);
  // Not the window's preload / renderer / shared contract, nor any remote table.
  assert.equal(
    naming.some((file) => /^(preload|renderer|shared)\//.test(file) || /remote/.test(file)),
    false
  );
});
