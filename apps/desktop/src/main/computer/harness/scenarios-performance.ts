import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import type { BrowserWindow } from 'electron';
import type { CommandResult, CapturePayload } from './scenario-types';
import { capturePayload, actionPayload } from './scenario-ocr';
import { progress, runScenario, sequencePerformancePath } from './scenario-runtime';
import type { ScenarioContext, ScenarioGroup } from './scenario-context';

function assertContinuationReady(ctx: ScenarioContext, response: CommandResult) {
  const { fixtureWindowId } = ctx;
  const payload = actionPayload(response);
  assert.notEqual(payload.ok, false, JSON.stringify(payload));
  assert.notEqual(
    (payload.verdict as Record<string, unknown> | undefined)?.decision,
    'escalate',
    JSON.stringify(payload)
  );
  const observation = payload.capture_after as CapturePayload | undefined;
  assert.equal(observation?.ok, true, JSON.stringify(payload));
  assert.equal(observation?.window_id, fixtureWindowId, JSON.stringify(payload));
  return payload;
}

async function resetSink(fixture: BrowserWindow): Promise<void> {
  await fixture.webContents.executeJavaScript(
    `document.querySelector('#sink').value='';document.querySelector('#sink').dispatchEvent(new Event('input'))`
  );
}

/** One typed continuation per command, each with its own post-action capture. */
async function measureSeparateTyping(ctx: ScenarioContext, index: number, separateDurations: number[]): Promise<void> {
  const { fixture, fixtureWindowId, command } = ctx;
  const separateSession = `sequence-performance-separate-${index}`;
  try {
    await resetSink(fixture);
    const capture = capturePayload(
      await command(
        {
          action: 'capture',
          window_id: fixtureWindowId,
          mode: 'vision',
        },
        separateSession
      )
    );
    assert.ok(capture.frame_id);
    const startedAt = performance.now();
    assertContinuationReady(
      ctx,
      await command(
        {
          action: 'type',
          window_id: fixtureWindowId,
          frame_id: capture.frame_id,
          x: 200,
          y: 245,
          text: 'SEQUENCE42',
          delivery: 'background',
        },
        separateSession
      )
    );
    assertContinuationReady(
      ctx,
      await command(
        {
          action: 'type',
          window_id: fixtureWindowId,
          text: 'TAIL',
          delivery: 'background',
        },
        separateSession
      )
    );
    separateDurations.push(performance.now() - startedAt);
    const state = (await fixture.webContents.executeJavaScript(
      `({value:document.querySelector('#sink')?.value||''})`
    )) as { value?: string };
    assert.equal(state.value, 'SEQUENCE42TAIL');
  } finally {
    await command({ action: 'session_release' }, separateSession);
  }
}

/** The same typing as one batched sequence command. */
async function measureSequenceTyping(ctx: ScenarioContext, index: number, sequenceDurations: number[]): Promise<void> {
  const { fixture, fixtureWindowId, command } = ctx;
  const sequenceSession = `sequence-performance-batched-${index}`;
  try {
    await resetSink(fixture);
    const capture = capturePayload(
      await command(
        {
          action: 'capture',
          window_id: fixtureWindowId,
          mode: 'vision',
        },
        sequenceSession
      )
    );
    assert.ok(capture.frame_id);
    const startedAt = performance.now();
    const result = assertContinuationReady(
      ctx,
      await command(
        {
          action: 'sequence',
          window_id: fixtureWindowId,
          steps: [
            {
              action: 'type',
              frame_id: capture.frame_id,
              x: 200,
              y: 245,
              text: 'SEQUENCE42',
            },
            { action: 'type', text: 'TAIL' },
          ],
          delivery: 'background',
        },
        sequenceSession
      )
    );
    sequenceDurations.push(performance.now() - startedAt);
    assert.equal(result.completed, true, JSON.stringify(result));
    const state = (await fixture.webContents.executeJavaScript(
      `({value:document.querySelector('#sink')?.value||''})`
    )) as { value?: string };
    assert.equal(state.value, 'SEQUENCE42TAIL');
  } finally {
    await command({ action: 'session_release' }, sequenceSession);
  }
}

function buildSequenceReport(separateDurations: number[], sequenceDurations: number[], repeats: number) {
  const percentile = (values: number[], fraction: number) => {
    const sorted = [...values].sort((left, right) => left - right);
    return Number(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))].toFixed(2));
  };
  const separateP50 = percentile(separateDurations, 0.5);
  const separateP95 = percentile(separateDurations, 0.95);
  const sequenceP50 = percentile(sequenceDurations, 0.5);
  const sequenceP95 = percentile(sequenceDurations, 0.95);
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    repeats,
    fresh_observation_excluded_from_latency: true,
    separate: {
      continuation_calls: repeats * 2,
      post_action_captures: repeats * 2,
      p50_ms: separateP50,
      p95_ms: separateP95,
    },
    sequence: {
      continuation_calls: repeats,
      post_action_captures: repeats,
      p50_ms: sequenceP50,
      p95_ms: sequenceP95,
    },
    reduction: {
      continuation_calls_percent: 50,
      post_action_captures_percent: 50,
      p50_latency_percent: Number((((separateP50 - sequenceP50) / separateP50) * 100).toFixed(2)),
      p95_latency_percent: Number((((separateP95 - sequenceP95) / separateP95) * 100).toFixed(2)),
    },
  };
  return report;
}

export const performanceScenarios: ScenarioGroup = {
  S30: async (ctx) => {
    await runScenario('S30', 'sequence reduces focus-chain calls and captures', 'sequence-performance', async () => {
      const repeats = 10;
      const separateDurations: number[] = [];
      const sequenceDurations: number[] = [];
      for (let index = 0; index < repeats; index += 1) {
        await measureSeparateTyping(ctx, index, separateDurations);
        await measureSequenceTyping(ctx, index, sequenceDurations);
      }
      const report = buildSequenceReport(separateDurations, sequenceDurations, repeats);
      if (sequencePerformancePath) {
        writeFileSync(sequencePerformancePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      }
      progress(`S30 METRICS ${JSON.stringify(report)}`);
    });
  },
};
