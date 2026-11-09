// The boot path of the defaults-separation diagnostic: main/boot-timeline.ts (what index.ts's startDesktopDiagnostics calls) driven
// with the real createDesktopDiagnostics, against the lines b6f10295a's own boot wrote (record/record-defaults-separation.mjs):
// the failure comes after `desktop-start`, carries `{ message }` only, and a reply that comes before the log exists waits for it.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

import { NODE_COMMIT, NODE_TREE } from '../../shared/test-recorded/record/node-source.mjs';
import { createBootTimeline } from '../boot-timeline.ts';
import { createDesktopDiagnostics } from '../desktop-diagnostics.ts';
import { reportDefaultsSeparation } from './defaults-separation.ts';

const recorded = JSON.parse(readFileSync(new URL('../../shared/test-recorded/defaults-separation.node-line.json', import.meta.url), 'utf8'));
const failed = { defaultsSeparation: { ok: false, message: recorded.message } };

/** Boots as index.ts does: lines written before the log exists, the reply at `replyAt`, then open (drain, `desktop-start`). */
async function boot(t, replyAt, reply = failed) {
  const dir = mkdtempSync(join(tmpdir(), 'boot-timeline-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: new Date(recorded.early.at) });
  t.after(() => mock.timers.reset());
  const timeline = createBootTimeline();
  const sendReply = () => reportDefaultsSeparation(reply, timeline.defaultsSeparationFailed);
  timeline.write(recorded.early.event, recorded.early.entry);
  if (replyAt === 'before-open') sendReply();
  mock.timers.setTime(new Date(recorded.at).getTime());
  const log = createDesktopDiagnostics(join(dir, 'd.jsonl'), recorded.context, { now: () => new Date(recorded.at) });
  timeline.open(log, () => log.write('desktop-start', { totalMs: 5 }));
  if (replyAt === 'after-open') sendReply();
  await log.flush();
  return readFileSync(join(dir, 'd.jsonl'), 'utf8').split('\n').filter(Boolean);
}

test('the recording names the Node commit and tree', () => {
  assert.equal(recorded.source.commit, NODE_COMMIT);
  assert.equal(recorded.source.tree, NODE_TREE);
});

for (const replyAt of ['before-open', 'after-open']) {
  test(`a failure reported ${replyAt} is written after desktop-start, as Node's boot wrote it`, async (t) => {
    const lines = await boot(t, replyAt);
    assert.deepEqual(lines, recorded.lines);
    assert.deepEqual(lines.map((l) => JSON.parse(l).event), [recorded.early.event, 'desktop-start', 'defaults-separation-failed']);
    assert.equal('occurredAt' in JSON.parse(lines[2]), false);
  });
}

test('a separation that worked, or a core that reports none, writes no failure', async (t) => {
  for (const reply of [{ defaultsSeparation: { ok: true } }, {}]) {
    for (const replyAt of ['before-open', 'after-open']) {
      assert.deepEqual((await boot(t, replyAt, reply)).map((l) => JSON.parse(l).event), [recorded.early.event, 'desktop-start']);
    }
  }
});
