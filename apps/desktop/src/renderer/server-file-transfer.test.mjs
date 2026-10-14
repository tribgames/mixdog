// A server window's transfers: chunked uploads with progress and cancel, and
// stepwise downloads that clean up after themselves.
import assert from 'node:assert/strict';
import test from 'node:test';

import { SERVER_UPLOAD_MAX_BYTES } from '../shared/server-files.ts';
import {
  downloadServerFile,
  serverFilePath,
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
        return { uploadId: 'u1', chunkBytes, maxBytes: SERVER_UPLOAD_MAX_BYTES };
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

test('server paths and upload scopes are POSIX-safe', () => {
  assert.equal(serverFilePath('/srv/repo/', 'src\\a.ts'), '/srv/repo/src/a.ts');
  assert.equal(serverFilePath('/', 'etc/hosts'), '/etc/hosts');
  assert.equal(serverFilePath('/srv/repo', '.'), '/srv/repo');
  assert.equal(serverUploadScope('session:abc/def'), 'session_abc_def');
  assert.equal(serverUploadScope('..'), 'draft');
  assert.equal(serverUploadScope(''), 'draft');
});
