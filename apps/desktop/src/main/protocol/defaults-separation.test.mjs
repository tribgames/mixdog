// The boot path of the defaults-separation diagnostic: main/boot-timeline.ts (what index.ts's startDesktopDiagnostics calls) driven
// with the real createDesktopDiagnostics, against the complete output of b6f10295a's own boot (record/record-defaults-separation.mjs:
// Node's startDesktopDiagnostics run unchanged beside its writer).
//
// Compared: the early line the drain writes, `desktop-start`, and the failure line, whole-line and in that order. Not compared:
// `process-entry`, `app-ready` and `daemon-service-start`, which index.ts's startDesktopDiagnostics and reportDaemonServiceStart
// still write themselves (unchanged, and not part of boot-timeline).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

import { NODE_COMMIT, NODE_TREE } from '../../shared/test-recorded/record/node-source.mjs';
import { createBootTimeline } from '../boot-timeline.ts';
import { createDesktopDiagnostics } from '../desktop-diagnostics.ts';
import { reportDefaultsSeparation } from './defaults-separation.ts';

const recorded = JSON.parse(readFileSync(new URL('../../shared/test-recorded/defaults-separation.node-boot.json', import.meta.url), 'utf8'));
const { inputs } = recorded;
const failed = { defaultsSeparation: { ok: false, message: inputs.error.message } };
const COMPARED = [inputs.early[0].event, 'desktop-start', 'defaults-separation-failed'];
const expected = recorded.lines.filter((line) => COMPARED.includes(JSON.parse(line).event));

/** Boots as index.ts does: the early line, the reply at `replyAt`, then open (drain, `desktop-start`). */
async function boot(t, replyAt, reply = failed) {
  const dir = mkdtempSync(join(tmpdir(), 'boot-timeline-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: new Date(inputs.early[0].at) });
  t.after(() => mock.timers.reset());
  const timeline = createBootTimeline();
  const sendReply = () => reportDefaultsSeparation(reply, timeline.defaultsSeparationFailed);
  timeline.write(inputs.early[0].event, inputs.early[0].entry);
  if (replyAt === 'before-open') sendReply();
  mock.timers.setTime(inputs.now);
  const context = {
    appVersion: inputs.appVersion,
    packaged: inputs.packaged,
    bootId: inputs.desktopBootId,
    scenario: inputs.desktopBootScenario,
    pid: inputs.process.pid,
    platform: inputs.process.platform,
    arch: inputs.process.arch,
  };
  const log = createDesktopDiagnostics(join(dir, 'd.jsonl'), context);
  timeline.open(log, () =>
    log.write('desktop-start', {
      totalMs: Date.now() - inputs.desktopProcessStartedAt,
      nodeVersion: inputs.process.versions.node,
      sessionProcess: 'daemon',
      gpuRendering: inputs.softwareRenderingThisLaunch ? 'software-fallback' : 'hardware',
      crashReporterStatus: inputs.crashReporterStatus,
    })
  );
  if (replyAt === 'after-open') sendReply();
  await log.flush();
  return readFileSync(join(dir, 'd.jsonl'), 'utf8').split('\n').filter(Boolean);
}

test('the recording is an exact run of the pinned Node boot', () => {
  assert.equal(recorded.exact, true);
  assert.equal(recorded.source.commit, NODE_COMMIT);
  assert.equal(recorded.source.tree, NODE_TREE);
  assert.deepEqual(recorded.source.functions.map((f) => f.name), ['reportDaemonServiceStart', 'startDesktopDiagnostics']);
  assert.equal(recorded.lines.join('\n') + '\n', recorded.jsonl);
  assert.deepEqual(recorded.lines.map((l) => JSON.parse(l).event), ['process-entry', 'app-ready', 'daemon-service-start', ...COMPARED]);
});

for (const replyAt of ['before-open', 'after-open']) {
  test(`a failure reported ${replyAt} is written after desktop-start, as Node's boot wrote it`, async (t) => {
    const lines = await boot(t, replyAt);
    assert.deepEqual(lines, expected);
    assert.equal('occurredAt' in JSON.parse(lines[2]), false);
  });
}

test('a separation that worked, or a core that reports none, writes no failure', async (t) => {
  for (const reply of [{ defaultsSeparation: { ok: true } }, {}]) {
    for (const replyAt of ['before-open', 'after-open']) {
      assert.deepEqual(await boot(t, replyAt, reply), expected.slice(0, 2));
    }
  }
});