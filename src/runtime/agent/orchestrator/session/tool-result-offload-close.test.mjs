import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import * as fsNamespace from 'node:fs';
import * as fsPromisesNamespace from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

// Releasing the verified artifact's descriptor is cleanup. When it fails, the
// offload has still happened — the bytes are on disk and were hash-verified —
// so the completed offload must keep reporting its artifact.
let failClose = false;

const { default: fsDefault, ...fsNamed } = fsNamespace;
const closeSync = (fd) => {
  fsNamespace.closeSync(fd);
  if (failClose) throw new Error('close failed');
};
mock.module('node:fs', {
  namedExports: { ...fsNamed, closeSync },
  defaultExport: { ...fsDefault, closeSync },
});

const { default: fsPromisesDefault, ...fsPromisesNamed } = fsPromisesNamespace;
const open = async (...args) => {
  const handle = await fsPromisesNamespace.open(...args);
  if (!failClose) return handle;
  return {
    stat: (...rest) => handle.stat(...rest),
    readFile: (...rest) => handle.readFile(...rest),
    close: async () => {
      await handle.close();
      throw new Error('close failed');
    },
  };
};
mock.module('node:fs/promises', {
  namedExports: { ...fsPromisesNamed, open },
  defaultExport: { ...fsPromisesDefault, open },
});

const { maybeOffloadToolResult, persistToolResultArtifactSync } = await import('./tool-result-offload.mjs');

test('a failed descriptor close keeps the completed offload instead of reporting nothing', async () => {
  const originalDataDir = process.env.MIXDOG_DATA_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-offload-close-'));
  process.env.MIXDOG_DATA_DIR = dataDir;
  const sessionId = 'session-offload-close';
  const raw = 'offload close regression body\n';
  try {
    const written = persistToolResultArtifactSync({ sessionId, toolCallId: 'first-call', content: raw });
    assert.ok(written, 'the first persist writes the artifact');
    // Both remaining calls take the already-persisted verification path, the
    // only one that closes a descriptor.
    failClose = true;
    const deduped = persistToolResultArtifactSync({ sessionId, toolCallId: 'sync-call', content: raw });
    assert.equal(deduped?.sha256, written.sha256, 'the sync offload reports its verified artifact');
    const offloaded = await maybeOffloadToolResult(sessionId, 'async-call', 'shell', raw, { force: true });
    assert.ok(
      offloaded.startsWith('[tool output offloaded:'),
      'the async offload reports its pointer instead of falling back to the inline text'
    );
  } finally {
    failClose = false;
    if (originalDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = originalDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
