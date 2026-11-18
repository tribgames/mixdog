// A server window's transfers: chunked uploads with progress and cancel, and
// stepwise downloads that clean up after themselves.
import assert from 'node:assert/strict';
import test from 'node:test';

import { SERVER_UPLOAD_MAX_BYTES } from '../shared/server-files.ts';
import {
  downloadServerFile,
  ServerTransferCancelledError,
  serverUploadRefusal,
  serverUploadScope,
  uploadFileToServer,
} from './server-file-transfer.ts';

function fakeUploadApi({ chunkBytes = 4, failAt = -1 } = {}) {
  const calls = [];
  const received = [];
  return {
    calls,
    received,
    api: {
      serverUploadBegin: async (name, size, scope) => {
        calls.push(['begin', name, size, scope]);
        return { uploadId: 'u1', chunkBytes, maxBytes: SERVER_UPLOAD_MAX_BYTES, inFlightChunks: 1 };
      },
      serverUploadChunk: async (id, offset, bytes) => {
        calls.push(['chunk', id, offset, bytes.length]);
        if (offset === failAt) throw new Error('disk full');
        received.push(...bytes);
        return { received: offset + bytes.length };
      },
      serverUploadCommit: async (id) => {
        calls.push(['commit', id]);
        return { absolutePath: '/srv/u/a.bin', name: 'a.bin', dir: false, size: received.length, accessToken: 't' };
      },
      serverUploadAbort: async (id) => {
        calls.push(['abort', id]);
        return true;
      },
    },
  };
}

test('an upload sends the file in chunks, reports progress and commits', async () => {
  const { api, calls, received } = fakeUploadApi();
  const progress = [];
  const file = new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])], 'a.bin');
  const entry = await uploadFileToServer(api, file, 'session-1', {
    onProgress: (sent, total) => progress.push([sent, total]),
  });
  assert.equal(entry.absolutePath, '/srv/u/a.bin');
  assert.deepEqual(received, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(progress, [
    [4, 10],
    [8, 10],
    [10, 10],
  ]);
  assert.deepEqual(
    calls.map(([kind, , offset]) => (kind === 'chunk' ? offset : kind)),
    ['begin', 0, 4, 8, 'commit']
  );
});

test('a cancelled upload stops between chunks and is aborted on the server', async () => {
  const { api, calls } = fakeUploadApi();
  const controller = new AbortController();
  const file = new File([new Uint8Array(12)], 'a.bin');
  await assert.rejects(
    uploadFileToServer(api, file, 's', { signal: controller.signal, onProgress: () => controller.abort() }),
    ServerTransferCancelledError
  );
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ['begin', 'chunk', 'abort']
  );
});

test('a failed chunk aborts the upload and surfaces the failure', async () => {
  const { api, calls } = fakeUploadApi({ failAt: 4 });
  await assert.rejects(uploadFileToServer(api, new File([new Uint8Array(10)], 'a.bin'), 's'), /disk full/);
  assert.equal(calls.at(-1)[0], 'abort');
});

test('empty and oversized files are refused before anything is sent', async () => {
  const { api, calls } = fakeUploadApi();
  assert.match(serverUploadRefusal({ name: 'big.iso', size: SERVER_UPLOAD_MAX_BYTES + 1 }), /big\.iso/);
  assert.equal(serverUploadRefusal({ name: 'ok.txt', size: 1 }), '');
  await assert.rejects(uploadFileToServer(api, new File([], 'empty.txt'), 's'), /empty\.txt/);
  assert.deepEqual(calls, []);
});

test('a download steps until done, and a cancelled one is aborted', async () => {
  const calls = [];
  let received = 0;
  const api = {
    serverDownloadBegin: async () => ({ downloadId: 'd1', name: 'r.pdf', size: 9 }),
    serverDownloadStep: async () => {
      received = Math.min(9, received + 4);
      calls.push(['step', received]);
      return { received, size: 9, done: received === 9 };
    },
    serverDownloadFinish: async () => ({ path: 'C:\\Users\\me\\Downloads\\r.pdf' }),
    serverDownloadAbort: async () => {
      calls.push(['abort']);
      return true;
    },
  };
  const begun = [];
  const done = await downloadServerFile(api, '/srv/repo', 'r.pdf', undefined, {
    onBegin: (name, size) => begun.push([name, size]),
  });
  assert.equal(done.path, 'C:\\Users\\me\\Downloads\\r.pdf');
  assert.deepEqual(begun, [['r.pdf', 9]]);
  assert.deepEqual(calls, [
    ['step', 4],
    ['step', 8],
    ['step', 9],
  ]);
  received = 0;
  calls.length = 0;
  const controller = new AbortController();
  await assert.rejects(
    downloadServerFile(api, '/srv/repo', 'r.pdf', undefined, {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    }),
    ServerTransferCancelledError
  );
  assert.deepEqual(calls, [['step', 4], ['abort']]);
});

// A server that applies chunks in arrival order, answers each after a delay, and counts what is unacknowledged.
function pipelinedServer({ chunkBytes = 4, inFlightChunks = 3, failAt = -1 } = {}) {
  const log = [];
  const state = { active: 0, maxActive: 0, written: [], aborted: false };
  const api = {
    serverUploadBegin: async () => ({ uploadId: 'u1', chunkBytes, maxBytes: SERVER_UPLOAD_MAX_BYTES, inFlightChunks }),
    serverUploadChunk: async (_id, offset, bytes) => {
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      log.push(['send', offset]);
      await new Promise((resolve) => setTimeout(resolve, 2));
      state.active -= 1;
      if (offset === failAt) throw new Error('disk full');
      if (offset !== state.written.length) throw new Error('out of order');
      state.written.push(...bytes);
      log.push(['ack', offset]);
      return { received: offset + bytes.length };
    },
    serverUploadCommit: async () => {
      log.push(['commit', state.active]);
      return { absolutePath: '/srv/u/a.bin', name: 'a.bin', dir: false, size: state.written.length, accessToken: 't' };
    },
    serverUploadAbort: async () => {
      log.push(['abort', state.active]);
      state.aborted = true;
      return true;
    },
  };
  return { api, log, state };
}

test('a pipelined upload keeps the stated window in flight, stays intact and commits after the last acknowledgement', async () => {
  const { api, log, state } = pipelinedServer();
  const bytes = Uint8Array.from({ length: 40 }, (_, i) => i);
  const progress = [];
  await uploadFileToServer(api, new File([bytes], 'a.bin'), 's', { onProgress: (sent) => progress.push(sent) });
  assert.equal(state.maxActive, 3);
  assert.deepEqual(state.written, [...bytes]);
  assert.deepEqual(progress, [4, 8, 12, 16, 20, 24, 28, 32, 36, 40]);
  assert.deepEqual(log.at(-1), ['commit', 0]);
  assert.deepEqual(log.at(-2), ['ack', 36]);
});

test('cancelling mid-flight sends nothing more and requests the abort at once, once', async () => {
  const { api, log, state } = pipelinedServer();
  const controller = new AbortController();
  await assert.rejects(
    uploadFileToServer(api, new File([new Uint8Array(40)], 'a.bin'), 's', {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    }),
    ServerTransferCancelledError
  );
  assert.equal(state.aborted, true);
  assert.equal(log.filter(([kind]) => kind === 'abort').length, 1);
  assert.ok(log.filter(([kind]) => kind === 'send').length <= 4, 'only the window and the chunk it freed were sent');
  assert.ok(!log.some(([kind]) => kind === 'commit'));
});

test('a cancel returns without waiting for a chunk whose reply never comes, and its late progress is suppressed', async () => {
  const progress = [];
  const aborts = [];
  let releaseHeld;
  const api = {
    serverUploadBegin: async () => ({ uploadId: 'u1', chunkBytes: 4, maxBytes: SERVER_UPLOAD_MAX_BYTES, inFlightChunks: 3 }),
    serverUploadChunk: (_id, offset, bytes) =>
      new Promise((resolve) => {
        releaseHeld = () => resolve({ received: offset + bytes.length });
      }),
    serverUploadCommit: async () => assert.fail('a cancelled upload never commits'),
    serverUploadAbort: async (id) => void aborts.push(id),
  };
  const controller = new AbortController();
  const upload = uploadFileToServer(api, new File([new Uint8Array(40)], 'a.bin'), 's', {
    signal: controller.signal,
    onProgress: (sent) => progress.push(sent),
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(upload, ServerTransferCancelledError);
  assert.deepEqual(aborts, ['u1']);
  releaseHeld();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(progress, [], 'a reply that comes after the cancel reports nothing');
});

test('an error on one chunk of the window fails the upload with its own cause and aborts it once', async () => {
  const { api, log } = pipelinedServer({ failAt: 8 });
  await assert.rejects(uploadFileToServer(api, new File([new Uint8Array(40)], 'a.bin'), 's'), /disk full/);
  assert.equal(log.filter(([kind]) => kind === 'abort').length, 1);
  assert.ok(!log.some(([kind]) => kind === 'commit'));
});

test('when the last outstanding chunk is the one that fails, its own error is reported, with one abort and no commit', async () => {
  const { api, log } = pipelinedServer({ failAt: 0 });
  await assert.rejects(uploadFileToServer(api, new File([new Uint8Array(4)], 'a.bin'), 's'), /disk full/);
  assert.equal(log.filter(([kind]) => kind === 'abort').length, 1);
  assert.ok(!log.some(([kind]) => kind === 'commit'));
});

test('upload scopes are POSIX-safe', () => {
  assert.equal(serverUploadScope('session:abc/def'), 'session_abc_def');
  assert.equal(serverUploadScope('..'), 'draft');
  assert.equal(serverUploadScope(''), 'draft');
});
