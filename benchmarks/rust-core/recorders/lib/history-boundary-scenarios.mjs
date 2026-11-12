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
  filler: Buffer.from('pasted into a segment of the cap test'),
};
const blobs = new Map(Object.values(bytes).map((buffer) => [sha(buffer), buffer]));
const ids = Object.fromEntries(Object.entries(bytes).map(([key, buffer]) => [key, sha(buffer)]));

export function historyBoundaryScenarios({ dataDir, DESKTOP_IPC, fileDownloadErrorReason, registerSessionIpc, createRemoteMethods, readSessionAttachment, readStoredSessionTranscript, loadSession, saveSessionAsync, releaseIdleSessionWriter, clearSessionMessages, scheduleCompactionArchive, flushCompactionArchiveWrites, stampCompactionMessageIds }) {
  const sessionsDir = join(dataDir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  // A session as a shipped record of the store holds it (the capture publishes only for a session whose record exists); what the sessions hold
  // beyond it is done to them by the operations below.
  const storedRecord = (id, messages) => writeFileSync(join(sessionsDir, `${id}.json`), JSON.stringify({ id, createdAt: 1_000, updatedAt: 2_000, status: 'idle', owner: 'user', messages }));
  const sentMessage = (text, buffer, pad = 0) => ({ role: 'user', content: `${text} ${'x'.repeat(pad)}`, meta: { transcript: { messageId: `msg_${sha(Buffer.from(text)).slice(0, 8)}`, attachments: [record(buffer, 'image.png')] } } });
  const conversation = (text, buffer, pad) => [sentMessage(text, buffer, pad), { role: 'assistant', content: `reply to ${text} ${'x'.repeat(pad)}` }, { role: 'user', content: `follow-up to ${text} ${'x'.repeat(pad)}` }, { role: 'assistant', content: `answer to ${text} ${'x'.repeat(pad)}` }];
  // The segments of the archive are written by the compaction's own capture (scheduleCompactionArchive, what the compaction runner calls
  // with the messages it dropped), the hide by the real clear (clearSessionMessages), the cap by the capture's own writer over its byte
  // cap: s1's first segment holds the id the clear hides; after the clear three large segments follow, the first holding the id the cap drops, and a small last one the id that stays.
  const CAP = 20_000;
  const compacted = async (session, messages) => {
    stampCompactionMessageIds(messages, session.id);
    scheduleCompactionArchive({ session, before: messages, after: [], maxBytes: CAP });
    await flushCompactionArchiveWrites();
    await saveSessionAsync(session);
  };
  const ready = (async () => {
    storedRecord('s1', []);
    const s1 = loadSession('s1');
    await compacted(s1, conversation('cleared', bytes.cleared, 2_000));
    await clearSessionMessages('s1');
    const cleared = loadSession('s1');
    await compacted(cleared, conversation('capped', bytes.capped, 2_000));
    await compacted(cleared, conversation('filler one', bytes.filler, 2_000));
    await compacted(cleared, conversation('filler two', bytes.filler, 2_000));
    await compacted(cleared, conversation('visible', bytes.visible));    cleared.messages = [sentMessage('newest', bytes.live)];
    await saveSessionAsync(cleared);
    storedRecord('s2', [sentMessage('other session', bytes.other)]);
    await releaseIdleSessionWriter('s1');
  })();
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
      await ready;
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
      await ready;
      const host = hostFor();
      const handlers = registered(host);
      const sessionId = `sess_desktop_${'a'.repeat(64)}`;
      storedRecord(sessionId, [sentMessage('a desktop message', bytes.live)]);
      const answer = await handlers.get(DESKTOP_IPC.readSessionAttachment)({}, sessionId, ids.live);
      return { keys: Object.keys(answer).sort(), answer, namesTheMessage: JSON.stringify(answer).includes('a desktop message') };
    },
    'no channel of the renderer, the paired phone or the service reaches the history as a transcript read': async () => {
      await ready;
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
