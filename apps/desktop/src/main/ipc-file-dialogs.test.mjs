import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { downloadToFile } from './ipc-file-dialogs.ts';

async function withServer(handler, run) {
  const dir = await mkdtemp(join(tmpdir(), 'save-as-'));
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}/`, dir);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

test('successful download replaces the destination and leaves no temp file', async () => {
  await withServer(
    (_req, res) => res.end('new'),
    async (url, dir) => {
      const file = join(dir, 'out.txt');
      await writeFile(file, 'old');
      await downloadToFile(url, file);
      assert.equal(await readFile(file, 'utf8'), 'new');
      assert.deepEqual(await readdir(dir), ['out.txt']);
    }
  );
});

test('a destination name near the filesystem limit still downloads', async () => {
  await withServer(
    (_req, res) => res.end('new'),
    async (url, dir) => {
      const name = `${'n'.repeat(220)}.txt`;
      const file = join(dir, name);
      await writeFile(file, 'old');
      await downloadToFile(url, file);
      assert.equal(await readFile(file, 'utf8'), 'new');
      assert.deepEqual(await readdir(dir), [name]);
    }
  );
});

test('HTTP failure keeps the existing destination', async () => {
  await withServer(
    (_req, res) => {
      res.statusCode = 404;
      res.end('nope');
    },
    async (url, dir) => {
      const file = join(dir, 'out.txt');
      await writeFile(file, 'old');
      await assert.rejects(downloadToFile(url, file), /HTTP 404/);
      assert.equal(await readFile(file, 'utf8'), 'old');
      assert.deepEqual(await readdir(dir), ['out.txt']);
    }
  );
});

test('a download aborted mid-stream keeps the destination intact and removes the temp file', async () => {
  await withServer(
    (req, res) => {
      res.write('partial');
      setTimeout(() => req.socket.destroy(), 50);
    },
    async (url, dir) => {
      const file = join(dir, 'out.txt');
      await writeFile(file, 'old');
      await assert.rejects(downloadToFile(url, file));
      assert.equal(await readFile(file, 'utf8'), 'old');
      assert.deepEqual(await readdir(dir), ['out.txt']);
    }
  );
});
