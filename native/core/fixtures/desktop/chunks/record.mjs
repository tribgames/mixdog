// Records Node's server upload chunk behaviour (server-file-operations.ts): node --experimental-transform-types
// --import <ts resolver> record-chunks.mjs > chunks.json  (run with a temp data dir)
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerFileOperations } from '../../../../../apps/desktop/src/main/server-file-operations.ts';

const ops = createServerFileOperations({ userDataPath: mkdtempSync(join(tmpdir(), 'chunks-')) });
const call = (name, ...args) => ops.invoke(name, args);
const outcome = async (run) => {
  try {
    return { ok: await run() };
  } catch (error) {
    return { error: { name: error.name, message: error.message } };
  }
};
const cases = [];
const record = async (label, run) => cases.push({ label, ...(await outcome(run)) });

const begun = await call('serverUploadBegin', 'a.txt', 4, 'draft');
const id = begun.uploadId;
await record('first chunk', () => call('serverUploadChunk', id, 0, 'aGk='));
await record('retry of the last chunk', () => call('serverUploadChunk', id, 0, 'aGk='));
await record('chunk ahead of the received bytes', () => call('serverUploadChunk', id, 3, 'aGk='));
await record('data that is not canonical base64', () => call('serverUploadChunk', id, 2, '!!'));
await record('empty data', () => call('serverUploadChunk', id, 2, ''));
await record('offset past the declared size', () => call('serverUploadChunk', id, 5, 'aGk='));
await record('offset that is not an integer', () => call('serverUploadChunk', id, 1.5, 'aGk='));
await record('unknown upload', () => call('serverUploadChunk', 'nope', 0, 'aGk='));
const both = await Promise.allSettled([call('serverUploadChunk', id, 2, 'aGk='), call('serverUploadChunk', id, 2, 'aGk=')]);
cases.push({
  label: 'two chunks at the same offset at once',
  results: both.map((r) => (r.status === 'fulfilled' ? { ok: r.value } : { error: { name: r.reason.name, message: r.reason.message } })),
});
await record('retry after the upload completed', () => call('serverUploadChunk', id, 2, 'aGk='));
const small = (await call('serverUploadBegin', 'b.txt', 2, 'draft')).uploadId;
await record('chunk larger than declared', () => call('serverUploadChunk', small, 0, 'YWJj'));
await record('the upload is gone after that', () => call('serverUploadChunk', small, 0, 'YWI='));
console.log(JSON.stringify({ node: process.version, cases }, null, 2));
await ops.dispose();
