import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { postAsset, recordFile } from './release-assets.mjs';

// Past the ~26 s after which a curl idle limit of 1024 B/s over 20 s abandons a silent response wait.
const FINALIZE_MS = 32_000;

test('a silent finalization over 20 s still returns the uploaded asset', { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'release-assets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'package.deb');
  writeFileSync(file, Buffer.alloc(4 * 1024 * 1024, 7));
  let finalize;
  const server = createServer((req, res) => {
    const hash = createHash('sha256');
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    });
    req.on('end', () => {
      const name = new URL(req.url, 'http://127.0.0.1').searchParams.get('name');
      const asset = { name, state: 'uploaded', size, digest: `sha256:${hash.digest('hex')}` };
      finalize = setTimeout(
        () => res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify(asset)),
        FINALIZE_MS
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    clearTimeout(finalize);
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}/assets?name=package.deb`;
  assert.deepEqual(JSON.parse(await postAsset(file, url)), { ...(await recordFile(file)), state: 'uploaded' });
});
