// End to end: the real worker process runs `office.run` over its stdio protocol, as the core's
// pool drives it, and the result keeps the Node office tool's shape plus the write receipts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startWorker } from './test/worker-client.mjs';

test('office.run refuses a space-prefixed outside path and a symlink escape', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exthost-approve-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'exthost-outside-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'exthost-data-'));
  const worker = startWorker();
  try {
    await worker.ready;
    const create = (file) => ({ action: 'create', format: 'docx', mode: 'portable', path: file });
    const run = (args) => worker.call('office.run', { args, cwd: root, dataDir: data }, [root]);

    const spaced = path.join(outside, 'spaced.docx');
    const first = await run(create(` ${spaced}`));
    assert.ok(first.result.err, 'a leading space does not turn an outside path into a workspace one');
    assert.equal(fs.existsSync(spaced), false);

    fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
    const escaped = path.join(outside, 'escaped.docx');
    const second = await run(create(path.join('link', 'escaped.docx')));
    assert.ok(second.result.err, 'a symlink out of the workspace is refused');
    assert.equal(fs.existsSync(escaped), false);

    const inside = await run(create('inside.docx'));
    assert.ok(inside.result.ok, 'a plain workspace path still works');
  } finally {
    await worker.stop();
    for (const dir of [root, outside, data]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('office.run creates a document, reports its write, and keeps the session pinned', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exthost-office-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'exthost-data-'));
  const worker = startWorker();
  try {
    await worker.ready;
    const file = path.join(root, 'a.docx');
    const { result, chunks } = await worker.call(
      'office.run',
      { args: { action: 'create', format: 'docx', mode: 'portable', path: file }, cwd: root, dataDir: data },
      [root]
    );
    assert.equal(result.pin, true, 'an open session pins the thread to this worker');
    const { content } = result.ok.result;
    const created = JSON.parse(content[0].text);
    assert.equal(created.fileKind, 'docx');
    assert.equal(created.created, true);
    assert.match(created.session, /^office_/);
    assert.equal(fs.existsSync(file), true);

    const { writes } = result.ok;
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, file);
    assert.equal(writes[0].before, null);
    assert.equal(writes[0].after.bytes, fs.statSync(file).size);
    assert.deepEqual(Buffer.concat(chunks), fs.readFileSync(file));

    const unapproved = await worker.call(
      'office.run',
      { args: { action: 'open', path: path.join(os.tmpdir(), 'other.docx') }, cwd: root, dataDir: data },
      [root]
    );
    assert.ok(unapproved.result.err, 'a path outside the approved set is refused');
  } finally {
    await worker.stop();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});
