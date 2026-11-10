import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import React from 'react';
import { Text, render } from 'ink';
import { useTranscriptActivity } from './use-transcript-activity.mjs';

// What App reads off this hook: the agent revision key, the active-tool
// segments, and the primitive statusline stats projection.
function Harness({ control, state }) {
  control.api = useTranscriptActivity({ state });
  return React.createElement(Text, null, 'ready');
}

function mount(context, state) {
  const control = {};
  const stdout = new PassThrough();
  stdout.columns = 40;
  stdout.rows = 10;
  stdout.on('data', () => {});
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  const view = render(React.createElement(Harness, { control, state }), {
    stdout,
    stdin,
    stderr: stdout,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  context.after(() => {
    view.unmount();
    stdin.end();
    stdout.end();
  });
  return { control, settle: (ms = 20) => delay(ms) };
}

const STATS = {
  currentContextSource: 'engine',
  currentEstimatedContextTokens: 11,
  currentContextTokens: 12,
  contextTokens: 13,
  latestPromptTokens: 14,
  latestInputTokens: 15,
  latestCachedTokens: 16,
  latestCacheWriteTokens: 17,
  inputTokens: 18,
  cachedTokens: 19,
  cacheWriteTokens: 20,
  promptTokens: 21,
  turns: 22,
};

test('the agent revision keys off the worker/job slices and the stats projection drops everything else', async (context) => {
  const { control, settle } = mount(context, {
    agentWorkers: [{ tag: 'a', status: 'running', stage: 'edit', sessionId: 's1', extra: 'ignored' }],
    agentJobs: [{ task_id: 'j1', status: 'queued', tag: 'a', sessionId: 's1', startedAt: 1, finishedAt: 0, error: '' }],
    items: [],
    stats: { ...STATS, notPublished: 99 },
  });
  await settle();

  assert.equal(
    control.api.agentRevision,
    JSON.stringify({
      workers: [['a', 'running', 'edit', 's1']],
      jobs: [['j1', 'queued', 'a', 's1', 1, 0, '']],
    })
  );
  assert.deepEqual(control.api.statuslineStats, STATS);
  assert.equal(control.api.activeTools, null, 'no running tool cards means no segments');
});

test('the engine-published active-tool summary drives the statusline segments', async (context) => {
  const { control, settle } = mount(context, {
    agentWorkers: [],
    agentJobs: [],
    items: [],
    stats: STATS,
    activeToolSummary: '2:1000:0:0:1:2000',
  });
  await settle();

  assert.deepEqual(control.api.activeTools, {
    shell: { count: 2, startedAt: 1000 },
    agent: { count: 1, startedAt: 2000 },
  });
});

test('without an engine summary the local transcript scan counts pending cards', async (context) => {
  const { control, settle } = mount(context, {
    agentWorkers: [],
    agentJobs: [],
    stats: STATS,
    items: [
      {
        kind: 'tool',
        aggregate: true,
        count: 3,
        completedCount: 0,
        startedAt: 500,
        categories: { s: { category: 'Shell', count: 2 }, w: { category: 'Web Research', count: 1 } },
      },
      {
        kind: 'tool',
        aggregate: true,
        count: 1,
        completedCount: 1,
        startedAt: 100,
        categories: { s: { category: 'Shell', count: 1 } },
      },
    ],
  });
  await settle();

  assert.deepEqual(control.api.activeTools, {
    shell: { count: 2, startedAt: 500 },
    web_search: { count: 1, startedAt: 500 },
  });
});
