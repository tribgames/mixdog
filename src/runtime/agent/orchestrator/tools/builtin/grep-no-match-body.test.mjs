// Every grep path answers a miss with the one short no-match body; the
// single-file rescue and the pattern chunk-merge used to print the long
// "(no matches) pattern=… path=…" form instead.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runGrepChunkMerge } from './lib/grep-chunk-merge.mjs';
import { runGrepSingleFileRescue } from './lib/grep-single-file-rescue.mjs';

const RESCUE_NOTICE = '\n[notice] native search could not serve this file scope; the file was scanned directly.';

test('the single-file rescue answers a miss with the short no-match body', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-grep-no-match-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'status');
  await writeFile(file, 'Name:\tnode\nUid:\t0\n');
  const base = {
    filePath: file,
    searchPath: file,
    workDir: root,
    patterns: ['NoSuchFieldHere'],
    caseInsensitive: false,
    multilineMode: false,
    onlyMatching: false,
    fileType: null,
    outputMode: 'content',
    showLineNumbers: true,
    withFilename: false,
    filenameOmitted: true,
    beforeN: 0,
    afterN: 0,
    contextN: 0,
    headLimit: 250,
    offset: 0,
  };
  assert.equal(await runGrepSingleFileRescue(base), `(no matches)${RESCUE_NOTICE}`);
  assert.equal(await runGrepSingleFileRescue({ ...base, contextN: 2 }), `(no matches)${RESCUE_NOTICE}`);
});

test('a chunk-merged pattern set answers a miss with the short no-match body', async () => {
  const out = await runGrepChunkMerge({
    args: { pattern: ['alpha', 'beta'] },
    patterns: ['alpha', 'beta'],
    patternChunkCap: 1,
    workDir: '/project',
    options: {},
    patternCapNote: '',
    outputMode: 'content',
    headLimit: 250,
    headLimitCoerced: null,
    offset: 0,
    beforeN: null,
    afterN: null,
    contextN: null,
    executeGrepTool: async () => '(no matches)',
  });
  assert.equal(out, '[pattern set split into 2 chunks]\n(no matches)');
});
