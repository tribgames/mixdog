import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeGlobTool } from './search-glob-tool.mjs';

const REFUSED = /^Error: glob refuses UNC\/SMB path "\/\/\?\//;

test('a verbatim or device-namespace base path is refused whether or not it exists, never split at its `?`', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'glob-verbatim-'));
  try {
    mkdirSync(join(cwd, 'a'));
    const paths = [
      `\\\\?\\${join(cwd, 'a')}`,
      `\\\\?\\${join(cwd, 'missing')}`,
      '\\\\?\\UNC\\server\\share',
      '//?/UNC/server/share',
    ];
    for (const path of paths) {
      assert.match(String(await executeGlobTool({ pattern: '*.ts', path }, cwd)), REFUSED, path);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
