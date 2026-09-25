import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  LAG_PROFILE_FLAG_FILE,
  LAG_PROFILE_SAMPLING_US,
  createLagProfiler,
  isLagWindow,
  profileFileName,
  shortenScriptUrl,
  summarizeCpuProfile,
} from './daemon-lag-profiler.mjs';

const SRC = path.resolve(tmpdir(), 'mixdog-repo', 'src');

function tempDataDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mixdog-lag-profile-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function flagOn(dataDir) {
  writeFileSync(path.join(dataDir, LAG_PROFILE_FLAG_FILE), '');
}

function flagOff(dataDir) {
  rmSync(path.join(dataDir, LAG_PROFILE_FLAG_FILE), { force: true });
}

function tinyProfile() {
  return {
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1, columnNumber: -1 }, children: [2] },
      { id: 2, callFrame: { functionName: 'hot', url: pathToFileURL(path.join(SRC, 'a.mjs')).href, lineNumber: 9 } },
    ],
    startTime: 0,
    endTime: 2000,
    samples: [2, 2],
    timeDeltas: [0, 1000],
  };
}

function fakeInspector({ failOn = null } = {}) {
  const sessions = [];
  async function createSession() {
    const session = {
      calls: [],
      disconnected: false,
      post(method, params, callback) {
        this.calls.push([method, params]);
        if (method === failOn) return callback(new Error(`${method} boom`));
        callback(null, method === 'Profiler.stop' ? { profile: tinyProfile() } : {});
      },
      disconnect() {
        this.disconnected = true;
      },
    };
    sessions.push(session);
    return session;
  }
  return { sessions, createSession };
}

function fakeClock(startMs = Date.parse('2026-04-08T12:00:00.000Z')) {
  let ms = startMs;
  return () => {
    const date = new Date(ms);
    ms += 30_000;
    return date;
  };
}

function profileFiles(dataDir) {
  try {
    return readdirSync(path.join(dataDir, 'profiles')).sort();
  } catch {
    return [];
  }
}

test('lag window thresholds: p99 >= 1000ms or max >= 2000ms', () => {
  assert.equal(isLagWindow({ p99Ms: 999, maxMs: 1999 }), false);
  assert.equal(isLagWindow({ p99Ms: 1000, maxMs: 0 }), true);
  assert.equal(isLagWindow({ p99Ms: 0, maxMs: 2000 }), true);
  assert.equal(isLagWindow({}), false);
});

test('a window is kept only when its own lag crosses a threshold', async (t) => {
  const dataDir = tempDataDir(t);
  const lines = [];
  const inspector = fakeInspector();
  const profiler = createLagProfiler({
    dataDir,
    log: (line) => lines.push(line),
    now: fakeClock(),
    createSession: inspector.createSession,
    srcRoot: SRC,
  });
  flagOn(dataDir);

  assert.equal(await profiler.tick({ p99Ms: 5000, maxMs: 9000 }), 'started');
  assert.deepEqual(inspector.sessions[0].calls, [
    ['Profiler.enable', {}],
    ['Profiler.setSamplingInterval', { interval: LAG_PROFILE_SAMPLING_US }],
    ['Profiler.start', {}],
  ]);
  assert.equal(LAG_PROFILE_SAMPLING_US, 1000);
  assert.deepEqual(profileFiles(dataDir), []);

  assert.equal(await profiler.tick({ p99Ms: 999, maxMs: 1999, busySessions: 3 }), 'discarded');
  assert.deepEqual(profileFiles(dataDir), []);
  assert.deepEqual(
    inspector.sessions[0].calls.slice(3).map(([method]) => method),
    ['Profiler.stop', 'Profiler.start'],
  );

  assert.equal(await profiler.tick({ p99Ms: 1000, maxMs: 1200, busySessions: 30 }), 'saved');
  assert.equal(await profiler.tick({ p99Ms: 10, maxMs: 2000, busySessions: 7 }), 'saved');
  const files = profileFiles(dataDir);
  assert.deepEqual(files, [
    'daemon-lag-2026-04-08T12-00-30.000Z.cpuprofile',
    'daemon-lag-2026-04-08T12-01-00.000Z.cpuprofile',
  ]);
  const saved = JSON.parse(readFileSync(path.join(dataDir, 'profiles', files[0]), 'utf8'));
  assert.deepEqual(saved, tinyProfile());

  const savedLines = lines.filter((line) => line.startsWith('lag-profile saved'));
  assert.deepEqual(savedLines, [
    `lag-profile saved file=${files[0]} p99=1000ms max=1200ms busySessions=30 top=hot@a.mjs:10=2ms`,
    `lag-profile saved file=${files[1]} p99=10ms max=2000ms busySessions=7 top=hot@a.mjs:10=2ms`,
  ]);
});

test('only the 10 newest profiles are retained', async (t) => {
  const dataDir = tempDataDir(t);
  const dir = path.join(dataDir, 'profiles');
  const old = [];
  for (let i = 0; i < 11; i += 1) {
    old.push(profileFileName(new Date(Date.UTC(2026, 0, 1, 0, 0, i))));
  }
  const inspector = fakeInspector();
  const profiler = createLagProfiler({
    dataDir,
    now: fakeClock(Date.parse('2026-04-08T00:00:00.000Z')),
    createSession: inspector.createSession,
  });
  flagOn(dataDir);
  assert.equal(await profiler.tick(), 'started');
  mkdirSync(dir, { recursive: true });
  for (const name of old) writeFileSync(path.join(dir, name), '{}');
  writeFileSync(path.join(dir, 'notes.txt'), 'keep me');

  assert.equal(await profiler.tick({ p99Ms: 1500, maxMs: 1500 }), 'saved');
  const remaining = readdirSync(dir).sort();
  assert.equal(remaining.filter((name) => name.endsWith('.cpuprofile')).length, 10);
  assert.ok(remaining.includes('notes.txt'));
  assert.ok(remaining.includes('daemon-lag-2026-04-08T00-00-00.000Z.cpuprofile'));
  assert.equal(remaining.includes(old[0]), false);
  assert.equal(remaining.includes(old[1]), false);
  assert.ok(remaining.includes(old[2]));
});

test('top-15 self time aggregates samples per function, including gc/program/idle', () => {
  const url = (rel) => pathToFileURL(path.join(SRC, rel)).href;
  const nm = pathToFileURL(path.join(tmpdir(), 'app', 'node_modules', 'pkg', 'lib', 'x.js')).href;
  const nodes = [
    { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, children: [2, 3, 5, 6, 7, 8] },
    { id: 2, callFrame: { functionName: 'parse', url: url('runtime/parse.mjs'), lineNumber: 41 }, children: [4] },
    { id: 3, callFrame: { functionName: 'parse', url: url('runtime/parse.mjs'), lineNumber: 41 } },
    { id: 4, callFrame: { functionName: '', url: nm, lineNumber: 0 } },
    { id: 5, callFrame: { functionName: '(garbage collector)', url: '', lineNumber: -1 } },
    { id: 6, callFrame: { functionName: '(program)', url: '', lineNumber: -1 } },
    { id: 7, callFrame: { functionName: '(idle)', url: '', lineNumber: -1 } },
    { id: 8, callFrame: { functionName: 'emit', url: 'node:events', lineNumber: 99 } },
  ];
  // Timestamps 0,1,3,6,10,15,21 ms; the last sample runs to endTime 30ms.
  const profile = {
    nodes,
    startTime: 0,
    endTime: 30_000,
    samples: [2, 3, 4, 5, 6, 7, 8],
    timeDeltas: [0, 1000, 2000, 3000, 4000, 5000, 6000],
  };
  assert.deepEqual(summarizeCpuProfile(profile, { srcRoot: SRC }), [
    { label: 'emit@node:events:100', ms: 9 },
    { label: '(idle)', ms: 6 },
    { label: '(program)', ms: 5 },
    { label: '(garbage collector)', ms: 4 },
    { label: 'parse@runtime/parse.mjs:42', ms: 3 },
    { label: '(anonymous)@pkg/lib/x.js:1', ms: 3 },
  ]);

  const many = { nodes: [{ id: 1, callFrame: { functionName: '(root)', url: '' } }], samples: [], timeDeltas: [] };
  for (let i = 0; i < 20; i += 1) {
    many.nodes.push({ id: i + 2, callFrame: { functionName: `f${i}`, url: url('m.mjs'), lineNumber: i } });
    many.samples.push(i + 2);
    many.timeDeltas.push(i === 0 ? 0 : 1000 * i);
  }
  many.endTime = many.timeDeltas.reduce((sum, d) => sum + d, 0) + 50_000;
  const top = summarizeCpuProfile(many, { srcRoot: SRC });
  assert.equal(top.length, 15);
  assert.equal(top[0].label, 'f19@m.mjs:20');
  assert.ok(top.every((entry, i) => i === 0 || top[i - 1].ms >= entry.ms));
});

test('script URLs shorten relative to src/ or node_modules/', () => {
  assert.equal(shortenScriptUrl(pathToFileURL(path.join(SRC, 'standalone', 'd.mjs')).href, SRC), 'standalone/d.mjs');
  assert.equal(
    shortenScriptUrl(path.join(tmpdir(), 'x', 'node_modules', 'a', 'node_modules', 'b', 'i.js'), SRC),
    'b/i.js',
  );
  assert.equal(shortenScriptUrl('node:internal/timers', SRC), 'node:internal/timers');
});

test('the flag file switches profiling on and off without a restart', async (t) => {
  const dataDir = tempDataDir(t);
  const lines = [];
  const inspector = fakeInspector();
  const profiler = createLagProfiler({
    dataDir,
    log: (line) => lines.push(line),
    now: fakeClock(),
    createSession: inspector.createSession,
  });

  assert.equal(await profiler.tick({ p99Ms: 5000 }), 'disabled');
  assert.equal(inspector.sessions.length, 0);
  assert.equal(profiler.active, false);

  flagOn(dataDir);
  assert.equal(await profiler.tick(), 'started');
  assert.equal(profiler.active, true);

  flagOff(dataDir);
  assert.equal(await profiler.tick({ p99Ms: 5000 }), 'disabled');
  assert.equal(profiler.active, false);
  const first = inspector.sessions[0];
  assert.deepEqual(first.calls.slice(-2).map(([method]) => method), ['Profiler.stop', 'Profiler.disable']);
  assert.equal(first.disconnected, true);
  assert.deepEqual(profileFiles(dataDir), []);
  assert.deepEqual(lines, [`lag-profile enabled dir=${path.join(dataDir, 'profiles')}`, 'lag-profile disabled']);

  flagOn(dataDir);
  assert.equal(await profiler.tick(), 'started');
  assert.equal(inspector.sessions.length, 2);
});

test('profiler failures are caught, logged once, and never reject the tick', async (t) => {
  const dataDir = tempDataDir(t);
  const lines = [];
  const inspector = fakeInspector({ failOn: 'Profiler.enable' });
  const profiler = createLagProfiler({
    dataDir,
    log: (line) => lines.push(line),
    createSession: inspector.createSession,
  });
  flagOn(dataDir);
  assert.equal(await profiler.tick(), 'failed');
  assert.equal(await profiler.tick(), 'failed');
  assert.deepEqual(lines, ['lag-profile failed profiler: Profiler.enable boom']);
  assert.equal(inspector.sessions.every((session) => session.disconnected), true);
  assert.equal(profiler.active, false);
});

test('the real node:inspector session produces a DevTools .cpuprofile for a lag window', async (t) => {
  const dataDir = tempDataDir(t);
  const lines = [];
  const profiler = createLagProfiler({ dataDir, log: (line) => lines.push(line) });
  flagOn(dataDir);
  assert.equal(await profiler.tick(), 'started');
  const until = Date.now() + 100;
  let spin = 0;
  while (Date.now() < until) spin += Math.sqrt(spin + 1);
  assert.equal(await profiler.tick({ p99Ms: 1200, maxMs: 2500, busySessions: 30 }), 'saved');
  flagOff(dataDir);
  assert.equal(await profiler.tick(), 'disabled');

  const [file] = profileFiles(dataDir);
  const profile = JSON.parse(readFileSync(path.join(dataDir, 'profiles', file), 'utf8'));
  assert.ok(Array.isArray(profile.nodes) && profile.nodes.length > 0);
  assert.ok(Array.isArray(profile.samples) && profile.samples.length > 0);
  assert.ok(Array.isArray(profile.timeDeltas));
  assert.match(
    lines.find((line) => line.startsWith('lag-profile saved')),
    /^lag-profile saved file=daemon-lag-\S+\.cpuprofile p99=1200ms max=2500ms busySessions=30 top=\S/,
  );
});
