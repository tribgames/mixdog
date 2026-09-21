import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { countTextStatsStreaming } from './text-stats.mjs';

test('a final NUL byte still terminates the last line on both scan paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-text-stats-'));
  try {
    const asciiFile = join(root, 'ascii.txt');
    const utf8File = join(root, 'utf8.txt');
    const ascii = Buffer.from([0x61, 0x0a, 0x62, 0x00]); // "a\nb\0"
    // A byte >= 0x80 ("é") routes the same count onto the UTF-8 code-unit scan.
    const utf8 = Buffer.from('a\né\0', 'utf-8');
    writeFileSync(asciiFile, ascii);
    writeFileSync(utf8File, utf8);

    assert.equal((await countTextStatsStreaming(asciiFile, ascii.length)).lines, 2);
    assert.equal((await countTextStatsStreaming(utf8File, utf8.length)).lines, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
