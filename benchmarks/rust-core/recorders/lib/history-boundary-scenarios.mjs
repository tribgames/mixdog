// The cases of apps/desktop/src/main/session-history-boundary.test.mjs (b6f10295a), as functions of the modules they drive (the recorder
// passes the Node tree's, the desktop's replay the product's) and of a data folder both set as MIXDOG_DATA_DIR before the store
// modules are loaded. Each returns what the test asserted on, whole. The test's last case (a scan of the app's source files for the
// name of the history read) is a property of the source tree, not of a call, and is not recorded.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const record = (bytes, name) => ({ id: sha(bytes), attachmentRef: sha(bytes), kind: 'image', name, mimeType: 'image/png', size: bytes.length });
const bytes = {
  live: Buffer.from('pasted in the live window'),
  visible: Buffer.from('pasted before the last compaction'),
  cleared: Buffer.from('pasted before a clear'),
  capped: Buffer.from('pasted before the archive cap'),
  other: Buffer.from('another session attachment'),
};
const blobs = new Map(Object.values(bytes).map((buffer) => [sha(buffer), buffer]));
const ids = Object.fromEntries(Object.entries(bytes).map(([key, buffer]) => [key, sha(buffer)]));

export function historyBoundaryScenarios({ dataDir, DESKTOP_IPC, fileDownloadErrorReason, registerSessionIpc, createRemoteMethods, readSessionAttachment, readStoredSessionTranscript, compactionSegmentLine }) {
  const sessionsDir = join(dataDir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const segment = (seq, buffer) =>
    compactionSegmentLine({
      seq,
      prev: seq > 1 ? seq - 1 : null,
      at: seq,
      items: [
        { id: `arch${seq}_0_1`, kind: 'user', text: `PRIVATE ROW TEXT ${seq}`, archived: true, attachments: [record(buffer, 'image.png')] },
        { id: `arch${seq}_divider`, kind: 'statusdone', status: 'compacted' },
      ],
    });
  function storeSession(sessionId, { messages, segments = [], archive = null }) {
    writeFileSync(join(sessionsDir, `${sessionId}.json`), JSON.stringify({ id: sessionId, createdAt: 1_000, updatedAt: 2_000, status: 'idle', owner: 'user', messages, ...(archive ? { compaction: { archive } } : {}) }));
    if (segments.length) writeFileSync(join(sessionsDir, `${sessionId}.compaction-archive.jsonl`), `${segments.map(([seq, buffer]) => segment(seq, buffer)).join('\n')}\n`);
  }
  const sentMessage = (text, buffer) => ({ role: 'user', content: text, meta: { transcript: { messageId: `msg_${sha(Buffer.from(text)).slice(0, 8)}`, attachments: [record(buffer, 'image.png')] } } });
  // s1: segment 1 was cleared (hidden), 2 is visible; segment 0 was dropped by the cap (not in the file at all). s2 holds the other attachment.
  storeSession('s1', { messages: [sentMessage('newest', bytes.live)], segments: [[1, bytes.cleared], [2, bytes.visible]], archive: { nextSeq: 3, clearedThrough: 1 } });
  storeSession('s2', { messages: [sentMessage('other session', bytes.other)] });
  /** The host as the app wires it: the window it holds, the daemon's attachment history read, and the attachment store. */
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
  const outcome = (promise) => promise.then((value) => ({ opened: value.bytes.toString() }), (error) => ({ refusedAs: fileDownloadErrorReason(error), message: String(error?.message) }));
  const registered = (host) => {
    const handlers = new Map();
    registerSessionIpc({ handle: (channel, listener) => handlers.set(channel, listener), host, invokeDesktopOperation: async () => null });
    return handlers;
  };
  return {
    'a compacted attachment opens; a cleared, capped, foreign or guessed id is refused': async () => {
      const host = hostFor();
      return {
        visible: await outcome(readSessionAttachment(host, 's1', ids.visible)),
        live: await outcome(readSessionAttachment(host, 's1', ids.live)),
        cleared: await outcome(readSessionAttachment(host, 's1', ids.cleared)),
        capped: await outcome(readSessionAttachment(host, 's1', ids.capped)),
        otherSessionsId: await outcome(readSessionAttachment(host, 's1', ids.other)),
        visibleIdOfOtherSession: await outcome(readSessionAttachment(host, 's2', ids.visible)),
        guessed: await outcome(readSessionAttachment(host, 's1', sha(Buffer.from('guess')))),
        noSuchSession: await outcome(readSessionAttachment(host, 'sess_nowhere', ids.visible)),
      };
    },
    'the stored history is read only when the held window does not name the id': async () => {
      const host = hostFor({ items: [{ id: 'u', kind: 'user', attachments: [record(bytes.live, 'image.png')] }] });
      await readSessionAttachment(host, 's1', ids.live);
      const afterHeld = [...host.historyReads];
      await readSessionAttachment(host, 's1', ids.visible);
      return { afterHeld, afterCompacted: [...host.historyReads] };
    },
    'the desktop read answers attachment bytes and name only, never a transcript row': async () => {
      const host = hostFor();
      const handlers = registered(host);
      const sessionId = `sess_desktop_${'a'.repeat(64)}`;
      storeSession(sessionId, { messages: [sentMessage('a desktop message', bytes.live)] });
      const answer = await handlers.get(DESKTOP_IPC.readSessionAttachment)({}, sessionId, ids.live);
      return { keys: Object.keys(answer).sort(), answer, namesTheMessage: JSON.stringify(answer).includes('a desktop message') };
    },
    'no channel of the renderer, the paired phone or the service reaches the history as a transcript read': async () => {
      const host = hostFor();
      const remote = createRemoteMethods({ host });
      const handlers = registered(host);
      return {
        remoteHas: ['readSessionHistory', 'readSessionTranscript'].map((name) => ({ name, own: Object.hasOwn(remote, name) })),
        ipcNamesAHistoryRead: [...Object.keys(DESKTOP_IPC), ...Object.values(DESKTOP_IPC)].some((name) => /SessionHistory|session-history/i.test(name)),
        handlerNamesAHistoryRead: [...handlers.keys()].some((channel) => /history/i.test(String(channel))),
      };
    },
  };
}
