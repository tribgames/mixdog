import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DESKTOP_IPC } from '../shared/contract.ts';
import { downloadToFile, registerFileDialogIpc } from './ipc-file-dialogs.ts';

test('a server window rejects the conversation import picker with a localized local-only message', async () => {
  const handlers = new Map();
  let opened = 0;
  registerFileDialogIpc({
    window: {},
    app: {},
    connectionKind: 'ssh',
    dialog: { showOpenDialog: async () => void opened++ },
    host: {},
    handle: (channel, fn) => handlers.set(channel, fn),
    invokeDesktopOperation: async () => undefined,
    nativeT: (key) => `[ko] ${key}`,
    describeLocalPaths: async () => [],
  });
  await assert.rejects(
    handlers.get(DESKTOP_IPC.chooseConversationImportFile)({}),
    /^Error: \[ko\] Importing conversations is available only on this PC\.$/
  );
  assert.equal(opened, 0);
});

test('the conversation import picker offers compressed Codex rollouts as well as .jsonl', async () => {
  const handlers = new Map();
  let options;
  registerFileDialogIpc({
    window: {},
    app: {},
    connectionKind: 'local',
    dialog: {
      showOpenDialog: async (_window, given) => {
        options = given;
        return { canceled: true, filePaths: [] };
      },
    },
    host: {},
    handle: (channel, fn) => handlers.set(channel, fn),
    invokeDesktopOperation: async () => undefined,
    nativeT: (key) => key,
    describeLocalPaths: async () => [],
  });
  await handlers.get(DESKTOP_IPC.chooseConversationImportFile)({});
  assert.deepEqual(options.filters[0].extensions, ['jsonl', 'zst']);
});

test('dialogs start in the folder used last instead of the Electron 43+ Downloads default', async () => {
  const handlers = new Map();
  const seen = [];
  const project = join(tmpdir(), 'mixdog-projects', 'alpha');
  const saved = join(tmpdir(), 'mixdog-saves', 'notes.txt');
  registerFileDialogIpc({
    window: {},
    app: {},
    connectionKind: 'local',
    dialog: {
      showOpenDialog: async (_window, given) => {
        seen.push(given.defaultPath);
        return { canceled: false, filePaths: [project] };
      },
      showSaveDialog: async (_window, given) => {
        seen.push(given.defaultPath);
        return { canceled: false, filePath: saved };
      },
    },
    host: {},
    handle: (channel, fn) => handlers.set(channel, fn),
    invokeDesktopOperation: async () => undefined,
    nativeT: (key) => key,
    describeLocalPaths: async () => [],
  });
  await handlers.get(DESKTOP_IPC.chooseProject)({});
  await handlers.get(DESKTOP_IPC.saveWorkspace)({}, '', [{ path: project }]);
  await handlers.get(DESKTOP_IPC.chooseProject)({});
  assert.deepEqual(seen, [
    undefined,
    join(tmpdir(), 'mixdog-projects', 'project.code-workspace'),
    join(tmpdir(), 'mixdog-saves'),
  ]);
});

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

test('the in-flight download file is never dot-prefixed (cloud-sync folders refuse such names)', async () => {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await withServer(
    async (_req, res) => {
      res.write('first');
      await held;
      res.end('second');
    },
    async (url, dir) => {
      const file = join(dir, 'out.txt');
      const download = downloadToFile(url, file);
      let inFlight = [];
      for (let attempt = 0; attempt < 100 && inFlight.length === 0; attempt += 1) {
        inFlight = await readdir(dir);
        if (inFlight.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      release();
      await download;
      assert.equal(inFlight.length, 1, `one in-flight file: ${inFlight}`);
      assert.match(inFlight[0], /^mixdog-tmp-[0-9a-f]{16}$/);
      assert.deepEqual(await readdir(dir), ['out.txt']);
    }
  );
});

test('a pre-existing file at the temp name is never written to or removed', async (t) => {
  const realRandomBytes = crypto.randomBytes;
  t.mock.method(crypto, 'randomBytes', (size, ...rest) =>
    size === 8 ? Buffer.alloc(8, 0xab) : realRandomBytes(size, ...rest)
  );
  syncBuiltinESMExports();
  t.after(() => syncBuiltinESMExports());
  const tempName = `mixdog-tmp-${'ab'.repeat(8)}`;
  for (const respond of [(_req, res) => res.end('new'), (_req, res) => ((res.statusCode = 404), res.end('nope'))]) {
    await withServer(respond, async (url, dir) => {
      const file = join(dir, 'out.txt');
      await writeFile(file, 'old');
      await writeFile(join(dir, tempName), 'someone else');
      await assert.rejects(downloadToFile(url, file), /EEXIST|HTTP 404/);
      assert.equal(await readFile(file, 'utf8'), 'old');
      assert.equal(await readFile(join(dir, tempName), 'utf8'), 'someone else');
    });
  }
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

test('Save as writes a data URL whole, replacing the destination without a temp file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'save-as-data-'));
  try {
    const handlers = new Map();
    const file = join(dir, 'out.bin');
    await writeFile(file, '\0\0\0\0\0\0\0\0\0\0');
    registerFileDialogIpc({
      window: {},
      app: {},
      dialog: {
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showSaveDialog: async () => ({ canceled: false, filePath: file }),
      },
      host: {},
      handle: (channel, fn) => handlers.set(channel, fn),
      invokeDesktopOperation: async () => undefined,
      nativeT: (key) => key,
      describeLocalPaths: async () => [],
    });
    assert.equal(await handlers.get(DESKTOP_IPC.saveFileAs)({}, 'data:text/plain;base64,aGVsbG8=', 'out.bin'), true);
    assert.equal(await readFile(file, 'utf8'), 'hello');
    assert.deepEqual(await readdir(dir), ['out.bin']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
