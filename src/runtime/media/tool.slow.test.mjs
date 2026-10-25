import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOptions, executeMediaTool, listMediaCatalog } from './tool.mjs';
import { MEDIA_ACTIONS, TOOL_DEFS } from './tool-defs.mjs';

const controls = (extra = {}) => ({
  aspectRatio: ['16:9', '1:1', '9:16'],
  resolution: ['1k', '2k'],
  maxReferences: 2,
  ...extra,
});

const LANES = [
  {
    id: 'lane-a',
    label: 'Lane A',
    authenticated: true,
    kinds: ['image', 'video'],
    image: { defaultModel: 'a-image', models: [{ id: 'a-image', label: 'A image', controls: controls() }] },
    video: {
      defaultModel: 'a-video',
      models: [
        { id: 'a-video', label: 'A video', controls: { aspectRatio: ['16:9'], durations: [5, 8], maxReferences: 1 } },
      ],
    },
  },
  {
    id: 'lane-b',
    label: 'Lane B',
    authenticated: true,
    kinds: ['image'],
    image: {
      defaultModel: 'b-image',
      models: [{ id: 'b-image', label: 'B image', controls: controls({ maxReferences: 0 }) }],
    },
  },
  {
    id: 'lane-out',
    label: 'Signed out',
    authenticated: false,
    kinds: ['image'],
    image: { defaultModel: 'x', models: [{ id: 'x', label: 'x', controls: controls() }] },
  },
];

function fakeGraph({ outcome = 'done', lanes = LANES, remembered = null } = {}) {
  const jobs = new Map();
  let counter = 0;
  const assetPath = join(tmpdir(), `mixdog-media-asset-${process.pid}.png`);
  return {
    assetPath,
    lanes: { listMediaLanes: async () => lanes },
    defaults: { getMediaDefault: (kind) => (remembered && remembered.kind === kind ? remembered : null) },
    jobs: {
      startMediaJob: async (request) => {
        const job = { id: `job-${++counter}`, status: 'running', ...request, startedAt: Date.now() };
        jobs.set(job.id, job);
        return job;
      },
      getMediaJob: (id) => {
        const job = jobs.get(id);
        if (job && job.status === 'running') {
          Object.assign(
            job,
            outcome === 'done'
              ? { status: 'done', assetId: 'asset-1' }
              : { status: 'failed', error: 'provider said no' },
            { endedAt: Date.now() }
          );
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
  const size = JSON.stringify(TOOL_DEFS[0]).length;
  assert.ok(
    size < 3000,
    `media tool schema is ${size} chars; budget 3000 — trim the description or justify raising the budget`
  );
});

test("list narrows: lanes → models for a kind → one model's controls, signed-out lanes only named", () => {
  const summary = listMediaCatalog(LANES);
  assert.deepEqual(
    summary.lanes.map((lane) => lane.id),
    ['lane-a', 'lane-b']
  );
  assert.deepEqual(summary.signedOut, ['lane-out']);
  assert.equal(summary.lanes[0].image, 'a-image');
  assert.ok(!('models' in summary.lanes[0]));

  const video = listMediaCatalog(LANES, { kind: 'video' });
  assert.deepEqual(
    video.lanes.map((lane) => lane.id),
    ['lane-a']
  );
  assert.deepEqual(video.lanes[0].models, ['a-video']);

  const model = listMediaCatalog(LANES, { kind: 'image', model: 'b-image' });
  assert.deepEqual(
    model.models.map((entry) => entry.lane),
    ['lane-b']
  );
  assert.deepEqual(model.models[0].controls.aspectRatio, ['16:9', '1:1', '9:16']);

  assert.throws(() => listMediaCatalog(LANES, { kind: 'image', model: 'nope' }), /not available/);
});

test('buildOptions validates against the model controls', () => {
  const lane = LANES[0];
  assert.deepEqual(buildOptions(lane, 'image', controls(), { aspect: '16:9' }), {
    aspectRatio: '16:9',
    resolution: '2k',
  });
  assert.throws(() => buildOptions(lane, 'image', controls(), { aspect: '4:3' }), /aspect "4:3" is not supported/);
  assert.throws(
    () => buildOptions(lane, 'video', lane.video.models[0].controls, { duration: 12 }),
    /duration 12s is not supported/
  );
  assert.deepEqual(buildOptions(lane, 'video', lane.video.models[0].controls, { duration: 8 }), { duration: 8 });
  const openai = { id: 'openai-oauth' };
  assert.deepEqual(buildOptions(openai, 'image', { size: ['1536x1024', 'auto'] }, { aspect: '16:9' }), {
    size: '1536x1024',
  });
  assert.deepEqual(buildOptions(openai, 'image', { maxReferences: 5 }, {}), {});
  assert.throws(() => buildOptions(openai, 'image', { maxReferences: 5 }, { quality: 'high' }), /not supported/);
  assert.throws(() => buildOptions(lane, 'image', { aspectRatio: ['1:1'] }, { resolution: '4k' }), /not supported/);
});

test('generate picks the first signed-in lane, waits, and copies the asset to path', async () => {
  const graph = fakeGraph();
  await writeFile(graph.assetPath, Buffer.from('png-bytes'));
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-media-tool-'));
  try {
    const result = parse(
      await executeMediaTool(
        { action: 'generate', kind: 'image', prompt: 'an open notebook by a window', path: 'cover', aspect: '16:9' },
        { cwd, deps: graph }
      )
    );
    assert.equal(result.ok, true);
    assert.equal(result.lane, 'lane-a');
    assert.equal(result.model, 'a-image');
    assert.equal(result.laneSource, 'first');
    assert.deepEqual(result.options, { aspectRatio: '16:9', resolution: '2k' });
    assert.equal(result.output, join(cwd, 'cover.png'));
    assert.equal(String(await readFile(result.output)), 'png-bytes');
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(graph.assetPath, { force: true });
  }
});

test('generate follows the remembered lane/model when none is passed, and falls back when it no longer applies', async () => {
  const followed = fakeGraph({ remembered: { kind: 'image', lane: 'lane-b', model: 'b-image' } });
  await writeFile(followed.assetPath, Buffer.from('png-bytes'));
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-media-remembered-'));
  const generate = (deps, extra = {}) =>
    executeMediaTool({ action: 'generate', kind: 'image', prompt: 'x', path: 'x.png', ...extra }, { cwd, deps }).then(
      parse
    );
  try {
    const remembered = await generate(followed);
    assert.equal(remembered.lane, 'lane-b');
    assert.equal(remembered.model, 'b-image');
    assert.equal(remembered.laneSource, 'remembered');

    const listed = parse(await executeMediaTool({ action: 'list', kind: 'image' }, { deps: followed }));
    assert.deepEqual(listed.remembered, { lane: 'lane-b', model: 'b-image' });
    assert.ok(
      !('remembered' in parse(await executeMediaTool({ action: 'list', kind: 'image' }, { deps: fakeGraph() })))
    );

    const explicit = await generate(followed, { lane: 'lane-a' });
    assert.equal(explicit.lane, 'lane-a');
    assert.equal(explicit.laneSource, 'requested');

    const signedOut = await generate(fakeGraph({ remembered: { kind: 'image', lane: 'lane-out', model: 'x' } }));
    assert.equal(signedOut.lane, 'lane-a');
    assert.equal(signedOut.model, 'a-image');
    assert.equal(signedOut.laneSource, 'first');

    const staleModel = await generate(fakeGraph({ remembered: { kind: 'image', lane: 'lane-a', model: 'gone' } }));
    assert.equal(staleModel.lane, 'lane-a');
    assert.equal(staleModel.model, 'a-image', 'a model the lane no longer lists falls back to the lane default');
    assert.equal(staleModel.laneSource, 'remembered');

    const otherKind = await generate(fakeGraph({ remembered: { kind: 'video', lane: 'lane-b', model: 'b-image' } }));
    assert.equal(otherKind.laneSource, 'first', 'a video default never steers an image generate');
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(followed.assetPath, { force: true });
  }
});

test('generate rejects a lane that is not signed in and reports what is, and fails clearly with no lane', async () => {
  const wrongLane = parse(
    await executeMediaTool(
      { action: 'generate', kind: 'image', prompt: 'x', path: 'x.png', lane: 'lane-out' },
      { deps: fakeGraph() }
    )
  );
  assert.equal(wrongLane.ok, false);
  assert.match(wrongLane.error, /not signed in/);
  assert.deepEqual(
    wrongLane.lanes.map((lane) => lane.id),
    ['lane-a', 'lane-b']
  );

  const none = parse(
    await executeMediaTool(
      { action: 'generate', kind: 'video', prompt: 'x', path: 'x.mp4' },
      { deps: fakeGraph({ lanes: [LANES[1]] }) }
    )
  );
  assert.equal(none.ok, false);
  assert.match(none.error, /No signed-in lane generates video/);
  assert.deepEqual(none.lanes, []);
});

test('references are capped by the model and a failed job surfaces the provider error', async () => {
  const graph = fakeGraph({ outcome: 'failed' });
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-media-ref-'));
  try {
    await writeFile(join(cwd, 'ref.png'), Buffer.from('ref'));
    const capped = parse(
      await executeMediaTool(
        { action: 'generate', kind: 'image', prompt: 'x', path: 'x.png', lane: 'lane-b', references: ['ref.png'] },
        { cwd, deps: graph }
      )
    );
    assert.match(capped.error, /takes no reference images/);

    const failed = parse(
      await executeMediaTool(
        { action: 'generate', kind: 'image', prompt: 'x', path: 'x.png', references: ['ref.png'] },
        { cwd, deps: graph }
      )
    );
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
    const started = parse(
      await executeMediaTool(
        { action: 'generate', kind: 'video', prompt: 'x', path: 'clip.mp4', duration: 5, wait: false },
        { cwd, deps: graph }
      )
    );
    assert.equal(started.status, 'running');
    assert.match(started.nextAction, /status job:job-1/);
    const done = parse(
      await executeMediaTool({ action: 'status', job: started.job, path: 'clip.mp4' }, { cwd, deps: graph })
    );
    assert.equal(done.status, 'done');
    assert.equal(done.output, join(cwd, 'clip.mp4'));

    const second = parse(
      await executeMediaTool(
        { action: 'generate', kind: 'video', prompt: 'y', path: 'y.mp4', wait: false },
        { cwd, deps: graph }
      )
    );
    const canceled = parse(await executeMediaTool({ action: 'cancel', job: second.job }, { deps: graph }));
    assert.equal(canceled.status, 'canceled');

    const unknown = parse(await executeMediaTool({ action: 'status', job: 'nope' }, { deps: graph }));
    assert.equal(unknown.ok, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(graph.assetPath, { force: true });
  }
});

test('cancel reports an unknown job and views the job itself, not the cancel receipt', async () => {
  // The real job store: cancelMediaJob answers `{ id, canceled }` for any id.
  const job = { id: 'job-7', status: 'running', kind: 'video', lane: 'lane-a', model: 'a-video', startedAt: 1 };
  const deps = {
    jobs: {
      getMediaJob: (id) => (id === job.id ? { ...job } : null),
      cancelMediaJob: (id) => ({ id, canceled: id === job.id }),
    },
  };
  const unknown = parse(await executeMediaTool({ action: 'cancel', job: 'nope' }, { deps }));
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /job "nope" is not known/);
  const canceled = parse(await executeMediaTool({ action: 'cancel', job: 'job-7' }, { deps }));
  assert.equal(canceled.ok, true);
  assert.equal(canceled.canceled, true);
  assert.deepEqual(
    [canceled.job, canceled.status, canceled.kind, canceled.lane],
    ['job-7', 'running', 'video', 'lane-a']
  );
});

const namedLane = (id, authenticated = true, kinds = ['image']) => ({
  id,
  label: id,
  authenticated,
  kinds,
  image: { defaultModel: `${id}-image`, models: [{ id: `${id}-image`, label: id, controls: { maxReferences: 1 } }] },
});
const catalogOrder = (signedIn) =>
  ['grok-oauth', 'xai', 'openai-oauth', 'gemini', 'antigravity-oauth'].map((id) =>
    namedLane(id, signedIn.includes(id))
  );

test('default lane prefers the signed-in ChatGPT lane, below requested and remembered', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-media-default-'));
  const run = async (signedIn, { remembered = null, ...extra } = {}) => {
    const graph = fakeGraph({ lanes: catalogOrder(signedIn), remembered });
    await writeFile(graph.assetPath, Buffer.from('png-bytes'));
    return parse(
      await executeMediaTool(
        { action: 'generate', kind: 'image', prompt: 'x', path: 'x.png', ...extra },
        { cwd, deps: graph }
      )
    );
  };
  const mixed = await run(['grok-oauth', 'xai', 'openai-oauth', 'gemini', 'antigravity-oauth']);
  assert.deepEqual([mixed.lane, mixed.laneSource], ['openai-oauth', 'first']);

  const noChatgpt = await run(['xai', 'gemini']);
  assert.deepEqual([noChatgpt.lane, noChatgpt.laneSource], ['xai', 'first']);

  const rememberedWins = await run(['grok-oauth', 'openai-oauth'], {
    remembered: { kind: 'image', lane: 'grok-oauth', model: 'grok-oauth-image' },
  });
  assert.deepEqual([rememberedWins.lane, rememberedWins.laneSource], ['grok-oauth', 'remembered']);

  const staleRemembered = await run(['grok-oauth', 'openai-oauth'], {
    remembered: { kind: 'image', lane: 'gemini', model: 'x' },
  });
  assert.deepEqual([staleRemembered.lane, staleRemembered.laneSource], ['openai-oauth', 'first']);

  const requestedWins = await run(['grok-oauth', 'openai-oauth', 'gemini'], {
    lane: 'gemini',
    remembered: { kind: 'image', lane: 'grok-oauth', model: 'grok-oauth-image' },
  });
  assert.deepEqual([requestedWins.lane, requestedWins.laneSource], ['gemini', 'requested']);
  await rm(cwd, { recursive: true, force: true });
});

test('a lane named by the user is passed explicitly and used', async () => {
  const graph = fakeGraph({ lanes: catalogOrder(['grok-oauth', 'openai-oauth', 'antigravity-oauth']) });
  await writeFile(graph.assetPath, Buffer.from('png-bytes'));
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-media-named-'));
  const generate = (lane) =>
    executeMediaTool(
      { action: 'generate', kind: 'image', prompt: 'x', path: 'x.png', lane },
      { cwd, deps: graph }
    ).then(parse);
  for (const lane of ['grok-oauth', 'antigravity-oauth', 'openai-oauth']) {
    const result = await generate(lane);
    assert.deepEqual([result.lane, result.laneSource], [lane, 'requested']);
  }
  const signedOut = await generate('gemini');
  assert.equal(signedOut.ok, false);
  assert.match(signedOut.error, /not signed in/);
  await rm(cwd, { recursive: true, force: true });
});

test('the media schema offers aspect/resolution/quality only when the model lists them', () => {
  const { aspect, resolution, quality } = TOOL_DEFS[0].inputSchema.properties;
  for (const field of [aspect, resolution, quality]) assert.match(field.description, /only when the model lists/);
});

test('background is passed only when the model lists it; auto sends nothing', () => {
  const openai = { id: 'openai-oauth' };
  const listed = { maxReferences: 5, background: ['auto', 'transparent', 'opaque'] };
  assert.deepEqual(buildOptions(openai, 'image', listed, { background: 'transparent' }), { background: 'transparent' });
  assert.deepEqual(buildOptions(openai, 'image', listed, { background: 'opaque' }), { background: 'opaque' });
  assert.deepEqual(buildOptions(openai, 'image', listed, { background: 'auto' }), {});
  assert.throws(() => buildOptions(openai, 'image', listed, { background: 'clear' }), /not supported/);
  assert.throws(() => buildOptions(openai, 'image', listed, { aspect: '16:9' }), /not supported/);
  assert.throws(() => buildOptions(LANES[0], 'image', controls(), { background: 'transparent' }), /background/);
  assert.ok(TOOL_DEFS[0].inputSchema.properties.background.description.includes('only when the model lists'));
});

function pinnedGraph(pins, { outcome = 'done' } = {}) {
  const graph = fakeGraph({ outcome, remembered: { kind: 'image', lane: 'lane-b', model: 'b-image' } });
  const started = [];
  const scoped = [];
  const start = graph.jobs.startMediaJob;
  graph.jobs.startMediaJob = async (request) => {
    started.push(request);
    return start(request);
  };
  graph.defaults.getMediaPin = (kind) => (pins[kind] ? { kind, account: '', model: '', ...pins[kind] } : null);
  graph.lanes.mediaLaneAccountProvider = (id) => (id === 'lane-a' ? 'acct-provider' : '');
  graph.accounts = {
    withProviderAccount: (provider, account, run) => {
      scoped.push([provider, account]);
      return run();
    },
  };
  return { graph, started, scoped };
}

const generatePinned = (graph, extra = {}) =>
  executeMediaTool(
    { action: 'generate', kind: 'image', prompt: 'x', path: 'pinned.png', ...extra },
    { cwd: tmpdir(), deps: graph }
  ).then(parse);

test('a pinned model is used when the chat names none, ahead of the remembered choice', async () => {
  const { graph, started } = pinnedGraph({ image: { lane: 'lane-a', model: 'a-image' } });
  await writeFile(graph.assetPath, Buffer.from('png'));
  try {
    const result = await generatePinned(graph);
    assert.equal(result.lane, 'lane-a');
    assert.equal(result.model, 'a-image');
    assert.equal(result.laneSource, 'pinned');
    assert.equal(started[0].lane, 'lane-a');
    assert.ok(!('account' in started[0]), 'no pinned account → the call follows the current account');

    const auto = await generatePinned(pinnedGraph({}).graph);
    assert.equal(auto.laneSource, 'remembered', "auto keeps today's ordered behaviour");
    const otherKind = await generatePinned(pinnedGraph({ video: { lane: 'lane-a', model: 'a-video' } }).graph);
    assert.equal(otherKind.laneSource, 'remembered', 'a video pin never steers an image call');
  } finally {
    await rm(graph.assetPath, { force: true });
  }
});

test('a generator the chat names wins over the pin for that call', async () => {
  const { graph, started } = pinnedGraph({ image: { lane: 'lane-a', model: 'a-image', account: 'acct-2' } });
  await writeFile(graph.assetPath, Buffer.from('png'));
  try {
    const named = await generatePinned(graph, { lane: 'lane-b' });
    assert.equal(named.lane, 'lane-b');
    assert.equal(named.laneSource, 'requested');
    assert.ok(!('account' in started[0]), "the pin's account does not follow a named generator");
    const again = await generatePinned(graph);
    assert.equal(again.lane, 'lane-a', 'the next call without a name is pinned again');
  } finally {
    await rm(graph.assetPath, { force: true });
  }
});

test('a pinned account routes the call through that account', async () => {
  const { graph, started, scoped } = pinnedGraph({ image: { lane: 'lane-a', model: '', account: 'acct-2' } });
  await writeFile(graph.assetPath, Buffer.from('png'));
  try {
    const result = await generatePinned(graph);
    assert.equal(result.lane, 'lane-a');
    assert.equal(result.model, 'a-image', 'an empty pinned model is the generator default');
    assert.deepEqual(scoped, [['acct-provider', 'acct-2']], 'the catalog is read as the pinned account');
    assert.equal(started[0].account, 'acct-2');
  } finally {
    await rm(graph.assetPath, { force: true });
  }
});

test('a pinned generator never falls back to another when it cannot serve', async () => {
  const signedOut = pinnedGraph({ image: { lane: 'lane-out', model: 'x' } });
  const missingModel = pinnedGraph({ image: { lane: 'lane-a', model: 'gone' } });
  const failing = pinnedGraph(
    { image: { lane: 'lane-a', model: 'a-image', account: 'acct-2' } },
    { outcome: 'failed' }
  );
  assert.match((await generatePinned(signedOut.graph)).error, /lane "lane-out" is not signed in/);
  assert.equal(signedOut.started.length, 0, 'no other lane is tried');
  assert.match((await generatePinned(missingModel.graph)).error, /model "gone" is not available on lane-a/);
  assert.equal(missingModel.started.length, 0);
  const quota = await generatePinned(failing.graph);
  assert.equal(quota.ok, false);
  assert.match(quota.error, /generation failed on lane-a\/a-image: provider said no/);
  assert.equal(failing.started.length, 1, 'the failure is reported as is, with no second attempt');
});
