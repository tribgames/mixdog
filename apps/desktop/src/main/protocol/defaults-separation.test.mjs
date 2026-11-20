// The boot path of the defaults-separation diagnostic: main/boot-timeline.ts (what index.ts's startDesktopDiagnostics calls) driven
// with the real createDesktopDiagnostics. Checked: the early line the drain writes, `desktop-start` and the failure line, in that
// order, and that the failure line carries no `occurredAt`, whether the core's reply comes before or after the log opens.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

import { createBootTimeline } from '../boot-timeline.ts';
import { createDesktopDiagnostics } from '../desktop-diagnostics.ts';
import { reportDefaultsSeparation } from './defaults-separation.ts';

const MESSAGE = "EACCES: permission denied, open 'mixdog-config.json'";
const failed = { defaultsSeparation: { ok: false, message: MESSAGE } };
const EARLY = { event: 'login-shell-environment', entry: { durationMs: 12 }, at: '2026-01-02T03:04:04.000Z' };
const NOW = 1767323041500;
const STARTED_AT = 1767323040000;

/** Boots as index.ts does: the early line, the reply at `replyAt`, then open (drain, `desktop-start`). */
async function boot(t, replyAt, reply = failed) {
  const dir = mkdtempSync(join(tmpdir(), 'boot-timeline-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: new Date(EARLY.at) });
  t.after(() => mock.timers.reset());
  const timeline = createBootTimeline();
  const sendReply = () => reportDefaultsSeparation(reply, timeline.defaultsSeparationFailed);
  timeline.write(EARLY.event, EARLY.entry);
  if (replyAt === 'before-open') sendReply();
  mock.timers.setTime(NOW);
  const log = createDesktopDiagnostics(join(dir, 'd.jsonl'), {
    appVersion: '1.2.3',
    packaged: true,
    bootId: 'boot-1',
    scenario: 'defaults-failure',
    pid: 13064,
    platform: 'win32',
    arch: 'x64',
  });
  timeline.open(log, () =>
    log.write('desktop-start', {
      totalMs: Date.now() - STARTED_AT,
      nodeVersion: '22.20.0',
      sessionProcess: 'daemon',
      gpuRendering: 'hardware',
      crashReporterStatus: 'started',
    })
  );
  if (replyAt === 'after-open') sendReply();
  await log.flush();
  return readFileSync(join(dir, 'd.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

for (const replyAt of ['before-open', 'after-open']) {
  test(`a failure reported ${replyAt} is written after desktop-start, whole and without occurredAt`, async (t) => {
    const lines = await boot(t, replyAt);
    assert.deepEqual(
      lines.map((line) => line.event),
      [EARLY.event, 'desktop-start', 'defaults-separation-failed']
    );
    assert.equal(lines[2].message, MESSAGE);
    assert.equal('occurredAt' in lines[2], false);
    assert.equal(lines[1].totalMs, NOW - STARTED_AT);
  });
}

test('a separation that worked, or a core that reports none, writes no failure', async (t) => {
  for (const reply of [{ defaultsSeparation: { ok: true } }, {}]) {
    for (const replyAt of ['before-open', 'after-open']) {
      const lines = await boot(t, replyAt, reply);
      assert.deepEqual(
        lines.map((line) => line.event),
        [EARLY.event, 'desktop-start']
      );
    }
  }
});
