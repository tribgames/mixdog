import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOptions, executeMediaTool, listMediaCatalog } from './tool.mjs';
import { MEDIA_ACTIONS, TOOL_DEFS } from './tool-defs.mjs';

const controls = (extra = {}) => ({ aspectRatio: ['16:9', '1:1', '9:16'], resolution: ['1k', '2k'], maxReferences: 2, ...extra });

const LANES = [
  {
    id: 'lane-a', label: 'Lane A', authenticated: true, kinds: ['image', 'video'],
    image: { defaultModel: 'a-image', models: [{ id: 'a-image', label: 'A image', controls: controls() }] },
    video: { defaultModel: 'a-video', models: [{ id: 'a-video', label: 'A video', controls: { aspectRatio: ['16:9'], durations: [5, 8], maxReferences: 1 } }] },
  },
  {
    id: 'lane-b', label: 'Lane B', authenticated: true, kinds: ['image'],
    image: { defaultModel: 'b-image', models: [{ id: 'b-image', label: 'B image', controls: controls({ maxReferences: 0 }) }] },
  },
  {
    id: 'lane-out', label: 'Signed out', authenticated: false, kinds: ['image'],
    image: { defaultModel: 'x', models: [{ id: 'x', label: 'x', controls: controls() }] },
  },
];

function fakeGraph({ outcome = 'done', lanes = LANES } = {}) {
  const jobs = new Map();
  let counter = 0;
  const assetPath = join(tmpdir(), `mixdog-media-asset-${process.pid}.png`);
  return {
    assetPath,
    calls: [],
    lanes: { listMediaLanes: () => lanes },
    jobs: {
      startMediaJob: (request) => {
        const job = { id: `job-${++counter}`, status: 'running', ...request, startedAt: Date.now() };
        jobs.set(job.id, job);
        return job;
      },
      getMediaJob: (id) => {
        const job = jobs.get(id);
        if (job && job.status === 'running') {
          Object.assign(job, outcome === 'done' ? { status: 'done', assetId: 'asset-1' } : { status: 'failed', error: 'provider said no' }, { endedAt: Date.now() });
        }
        return job;
      },
      cancelMediaJob: (id) => {
        const job = jobs.get(id);
        if (job) job.status = 'canceled';
        return job || null;
      },
    },
    store: { resolveMediaFile: async () => ({ path: assetPath }) },
  };
}

const parse = (result) => JSON.parse(result.content[0].text);

test('media is one deferred tool whose description names no lane', () => {
  assert.equal(TOOL_DEFS.length, 1);
  assert.equal(TOOL_DEFS[0].name, 'media');
  assert.deepEqual(TOOL_DEFS[0].inputSchema.properties.action.enum, MEDIA_ACTIONS);
  assert.doesNotMatch(TOOL_DEFS[0].description, /grok|gemini|openai|kling/i);
  assert.ok(JSON.stringify(TOOL_DEFS[0]).length < 3000);
});

test('list narrows: lanes → models for a kind → one model\'s controls, signed-out lanes only named', () => {
  const summary = listMediaCatalog(LANES);
  assert.deepEqual(summary.lanes.map((lane) => lane.id), ['lane-a', 'lane-b']);
  assert.deepEqual(summary.signedOut, ['lane-out']);
  assert.equal(summary.lanes[0].image, 'a-image');
  assert.ok(!('models' in summary.lanes[0]));

  const video = listMediaCatalog(LANES, { kind: 'video' });
  assert.deepEqual(video.lanes.map((lane) => lane.id), ['lane-a']);
  assert.deepEqual(video.lanes[0].models, ['a-video']);

  const model = listMediaCatalog(LANES, { kind: 'image', model: 'b-image' });
  assert.deepEqual(model.models.map((entry) => entry.lane), ['lane-b']);
  assert.deepEqual(model.models[0].controls.aspectRatio, ['16:9', '1:1', '9:16']);

  assert.throws(() => listMediaCatalog(LANES, { kind: 'image', model: 'nope' }), /not available/);
});

test('buildOptions validates against the model controls', () => {
  const lane = LANES[0];
  assert.deepEqual(buildOptions(lane, 'image', controls(), { aspect: '16:9' }), { aspectRatio: '16:9', resolution: '2k' });
  assert.throws(() => buildOptions(lane, 'image', controls(), { aspect: '4:3' }), /aspect "4:3" is not supported/);
  assert.throws(() => buildOptions(lane, 'video', lane.video.models[0].controls, { duration: 12 }), /duration 12s is not supported/);
  assert.deepEqual(buildOptions(lane, 'video', lane.video.models[0].controls, { duration: 8 }), { duration: 8 });
  const openai = { id: 'openai-oauth' };
  assert.deepEqual(buildOptions(openai, 'image', { size: ['1536x1024', 'auto'] }, { aspect: '16:9' }), { size: '1536x1024', quality: 'high' });
});

test('generate picks the first signed-in lane, waits, and copies the asset to path', async () => {
  const graph = fakeGraph();
  await writeFile(graph.assetPath, Buffer.from('png-bytes'));
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-media-tool-'));
  try {
    const result = parse(await executeMediaTool(
      { action: 'generate', kind: 'image', prompt: 'an open notebook by a window', path: 'cover', aspect: '16:9' },
      { cwd, deps: graph },
    ));
    assert.equal(result.ok, true);
    assert.equal(result.lane, 'lane-a');
    assert.equal(result.model, 'a-image');
    assert.deepEqual(result.options, { aspectRatio: '16:9', resolution: '2k' });
    assert.equal(result.output, join(cwd, 'cover.png'));
    assert.equal(String(await readFile(result.output)), 'png-bytes');
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(graph.assetPath, { force: true });
  }
});

test('generate rejects a lane that is not signed in and reports what is, and fails clearly with no lane', async () => {
  const wrongLane = parse(await executeMediaTool(
    { action: 'generate', kind: 'image', prompt: 'x', path: 'x.png', lane: 'lane-out' },
    { deps: fakeGraph() },
  ));
  assert.equal(wrongLane.ok, false);
  assert.match(wrongLane.error, /not signed in/);
  assert.deepEqual(wrongLane.lanes.map((lane) => lane.id), ['lane-a', 'lane-b']);

  const none = parse(await executeMediaTool(
    { action: 'generate', kind: 'video', prompt: 'x', path: 'x.mp4' },
    { deps: fakeGraph({ lanes: [LANES[1]] }) },
  ));
  assert.equal(none.ok, false);
  assert.match(none.error, /No signed-in lane generates video/);
  assert.deepEqual(none.lanes, []);
});

test('references are capped by the model and a failed job surfaces the provider error', async () => {
  const graph = fakeGraph({ outcome: 'failed' });
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-media-ref-'));
  try {
    await writeFile(join(cwd, 'ref.png'), Buffer.from('ref'));
    const capped = parse(await executeMediaTool(
      { action: 'generate', kind: 'image', prompt: 'x', path: 'x.png', lane: 'lane-b', references: ['ref.png'] },
      { cwd, deps: graph },
    ));
    assert.match(capped.error, /takes no reference images/);

    const failed = parse(await executeMediaTool(
      { action: 'generate', kind: 'image', prompt: 'x', path: 'x.png', references: ['ref.png'] },
      { cwd, deps: graph },
    ));
    assert.equal(failed.ok, false);
    assert.match(failed.error, /provider said no/);
    assert.equal(failed.job, 'job-1');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('wait:false returns a job id; status writes the file when done; cancel stops a job', async () => {
  const graph = fakeGraph();
  await writeFile(graph.assetPath, Buffer.from('clip'));
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-media-async-'));
  try {
    const started = parse(await executeMediaTool(
      { action: 'generate', kind: 'video', prompt: 'x', path: 'clip.mp4', duration: 5, wait: false },
      { cwd, deps: graph },
    ));
    assert.equal(started.status, 'running');
    assert.match(started.nextAction, /status job:job-1/);
    const done = parse(await executeMediaTool({ action: 'status', job: started.job, path: 'clip.mp4' }, { cwd, deps: graph }));
    assert.equal(done.status, 'done');
    assert.equal(done.output, join(cwd, 'clip.mp4'));

    const second = parse(await executeMediaTool({ action: 'generate', kind: 'video', prompt: 'y', path: 'y.mp4', wait: false }, { cwd, deps: graph }));
    const canceled = parse(await executeMediaTool({ action: 'cancel', job: second.job }, { deps: graph }));
    assert.equal(canceled.status, 'canceled');

    const unknown = parse(await executeMediaTool({ action: 'status', job: 'nope' }, { deps: graph }));
    assert.equal(unknown.ok, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(graph.assetPath, { force: true });
  }
});
