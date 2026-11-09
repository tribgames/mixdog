// The defaults-separation outcome in the initialize reply is recorded as Node's app-ready catch recorded it: the line below is the
// one b6f10295a's own createDesktopDiagnostics wrote (record/record-defaults-separation.mjs).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDesktopDiagnostics } from '../desktop-diagnostics.ts';
import { NODE_COMMIT, NODE_TREE } from '../../shared/test-recorded/record/node-source.mjs';
import { reportDefaultsSeparation } from './defaults-separation.ts';

const recorded = JSON.parse(readFileSync(new URL('../../shared/test-recorded/defaults-separation.node-line.json', import.meta.url), 'utf8'));

async function linesFor(reply) {
  const dir = mkdtempSync(join(tmpdir(), 'defaults-separation-'));
  try {
    const diagnostics = createDesktopDiagnostics(join(dir, 'd.jsonl'), recorded.context, { now: () => new Date(recorded.at) });
    reportDefaultsSeparation(reply, (event, details) => diagnostics.write(event, details));
    await diagnostics.flush();
    try {
      return readFileSync(join(dir, 'd.jsonl'), 'utf8');
    } catch {
      return '';
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the recording names the Node commit and tree', () => {
  assert.equal(recorded.source.commit, NODE_COMMIT);
  assert.equal(recorded.source.tree, NODE_TREE);
});

test('a failed separation records the line Node recorded, with the reply message', async () => {
  assert.equal(await linesFor({ defaultsSeparation: { ok: false, message: recorded.message } }), recorded.line);
});

test('a separation that worked, or a core that reports none, records nothing', async () => {
  assert.equal(await linesFor({ defaultsSeparation: { ok: true } }), '');
  assert.equal(await linesFor({}), '');
});
