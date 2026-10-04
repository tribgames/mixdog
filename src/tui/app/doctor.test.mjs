import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildDoctorReport, formatDoctorReport, nodeEngineSupport, runDoctorChecks } from './doctor.mjs';

const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
const state = () => ({ provider: 'openai' });

// The local-installation checks read the data folder; keep them off the
// developer's real ~/.mixdog.
const dataRoot = mkdtempSync(join(tmpdir(), 'mixdog-doctor-'));
process.env.MIXDOG_DATA_DIR = join(dataRoot, 'data');
mkdirSync(process.env.MIXDOG_DATA_DIR);
writeFileSync(join(process.env.MIXDOG_DATA_DIR, 'mixdog-config.json'), '{}');

// Fixtures follow the runtime contracts, including enabled/activeHere rather
// than the obsolete disabled field and configuredEvents rather than events.
function runtime(overrides = {}) {
  return {
    checkForUpdate: async () => ({
      currentVersion: '1.0.0',
      latestVersion: '1.0.0',
      updateAvailable: false,
    }),
    getProviderSetup: async () => ({
      api: [{ id: 'openai', type: 'api-key', enabled: true, authenticated: true }],
      oauth: [],
      local: [],
    }),
    mcpStatus: () => ({ configuredCount: 0, connectedCount: 0, servers: [] }),
    getToolModuleSettings: () => ({
      memory: { installed: true, enabled: true },
      git: { installed: true, enabled: true },
      office: { installed: true, enabled: false },
      tidy: { installed: false, enabled: false },
      localProvider: { installed: true, enabled: true, models: [{ id: 'm', installed: true }], installations: [] },
    }),
    getVoiceStatus: () => ({ enabled: true, installed: true, components: { model: true } }),
    getRecapSettings: () => ({ enabled: true }),
    getChannelSettings: () => ({ status: { running: true, mode: 'daemon' } }),
    skillsStatus: () => ({ count: 0, skills: [] }),
    pluginsStatus: () => ({ count: 0, plugins: [] }),
    hooksStatus: () => ({
      enabled: true,
      ruleCount: 0,
      configuredEvents: [],
      events: ['runtime:start', 'tool:before'],
      errors: [],
    }),
    ...overrides,
  };
}

test('a stopped channel worker is idle without automation and a warning with it', async () => {
  const stopped = { getChannelSettings: () => ({ status: { running: false } }) };
  const channelsCheck = async (overrides) =>
    (await runDoctorChecks(runtime({ ...stopped, ...overrides }), state)).checks.find(
      (check) => check.id === 'automation'
    );

  const idle = await channelsCheck({
    getChannelSetup: async () => ({
      schedules: [{ name: 'nightly', enabled: false }, { name: 'once', enabled: true, status: 'done' }],
      webhooks: [{ name: 'deploy', enabled: false }],
    }),
  });
  assert.equal(idle.level, 'ok');
  assert.equal(idle.detail, 'idle (no active schedules or webhooks)');

  for (const setup of [
    { schedules: [{ name: 'nightly', enabled: true }], webhooks: [] },
    { schedules: [], webhooks: [{ name: 'deploy' }] },
  ]) {
    const active = await channelsCheck({ getChannelSetup: async () => setup });
    assert.equal(active.level, 'warn');
    assert.equal(active.detail, 'worker stopped with active automation');
    assert.deepEqual(active.fix, { hint: 'enabled schedules and webhooks are not running' });
  }

  const unknown = await channelsCheck({});
  assert.equal(unknown.level, 'warn');
  assert.equal(unknown.detail, 'worker stopped');
});

function reportRow(report, label) {
  const row = report.split('\n').find((line) => line.slice(2).startsWith(`${label}:`));
  assert.ok(row, `missing ${label} row`);
  return row;
}

test('Node support respects every alternative in the shipped engine range', () => {
  assert.equal(pkg.engines.node, '^22.19.0 || >=24.0.0');
  for (const [version, supported] of [
    ['20.20.0', false],
    ['22.18.0', false],
    ['22.19.0', true],
    ['22.99.0', true],
    ['23.0.0', false],
    ['23.99.0', false],
    ['24.0.0', true],
    ['25.0.0', true],
    ['26.0.0-rc.1', false],
  ]) {
    assert.equal(nodeEngineSupport(version, pkg.engines.node), supported, version);
  }
});

test('unknown engine syntax or missing metadata is unverified, never healthy', () => {
  for (const range of [undefined, '', '>=22', '~22.19.0', '^22.19.0 || something-else']) {
    assert.equal(nodeEngineSupport('24.0.0', range), null, String(range));
  }
  assert.equal(nodeEngineSupport('unknown', pkg.engines.node), null);
});

test('healthy report preserves the shared desktop/TUI text contract without speculative Defender advice', async () => {
  const report = await buildDoctorReport(runtime(), state);
  const lines = report.split('\n');
  assert.equal(lines.length, 17);
  assert.equal(lines[0], 'mixdog doctor — installation health');
  assert.equal(lines.at(-1), '15 ok · 0 warnings · 0 failed');
  assert.equal(reportRow(report, 'mixdog'), '✓ mixdog: v1.0.0 · up to date');
  assert.equal(reportRow(report, 'providers'), '✓ providers: 1 ready · route openai');
  assert.equal(reportRow(report, 'memory'), '✓ memory: installed · enabled · recap enabled');
  assert.equal(reportRow(report, 'hooks'), '✓ hooks: enabled · 0 rules · 0 configured events');
  assert.equal(reportRow(report, 'config'), '✓ config: mixdog-config.json is valid');
  assert.doesNotMatch(report, /→/);
  assert.doesNotMatch(report, /Defender|Add-MpPreference|pgdata|core memory available/i);
});

test('structured rows carry summary counts and the command that fixes each problem', async () => {
  const result = await runDoctorChecks(
    runtime({
      checkForUpdate: async () => ({ currentVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true }),
      getProviderSetup: async () => ({
        api: [{ id: 'openai', type: 'api-key', enabled: true, authenticated: false }],
        oauth: [],
        local: [],
      }),
    }),
    state
  );
  const byId = Object.fromEntries(result.checks.map((check) => [check.id, check]));
  assert.deepEqual(
    result.checks.map((check) => check.id),
    [
      'mixdog', 'node', 'providers', 'mcp', 'memory', 'localProvider', 'builtins', 'voice',
      'automation', 'skills', 'plugins', 'hooks', 'data', 'config', 'logs',
    ]
  );
  assert.deepEqual(result.summary, { ok: 13, warn: 1, fail: 1 });
  assert.deepEqual(byId.mixdog.fix, { command: '/update' });
  assert.equal(byId.providers.level, 'fail');
  assert.deepEqual(byId.providers.fix, { command: '/providers' });
  assert.equal(byId.hooks.fix, undefined);
  const report = formatDoctorReport(result);
  assert.match(report, /✗ providers: route openai has no auth · 0 ready\n {4}→ run \/providers\n/);
  assert.equal(report.split('\n').at(-1), '13 ok · 1 warnings · 1 failed');
});

async function rowOf(id, overrides) {
  return (await runDoctorChecks(runtime(overrides), state)).checks.find((check) => check.id === id);
}

test('local provider row: not installed, disabled, failed, empty and healthy', async () => {
  const local = (value) => ({ getToolModuleSettings: () => ({ localProvider: value }) });
  assert.deepEqual(
    (await rowOf('localProvider', local({ installed: false, enabled: false }))).detail,
    'not installed'
  );
  assert.equal((await rowOf('localProvider', local({ installed: true, enabled: false }))).level, 'ok');
  const models = [{ installed: true }];
  const failed = await rowOf(
    'localProvider',
    local({ installed: true, enabled: true, models, installations: [{ state: 'complete', updatedAt: 1 }, { state: 'failed', updatedAt: 2, error: 'secret' }] })
  );
  assert.equal(failed.level, 'warn');
  assert.deepEqual(failed.fix, { command: '/providers' });
  assert.doesNotMatch(failed.detail, /secret/);
  const recovered = await rowOf(
    'localProvider',
    local({ installed: true, enabled: true, models, installations: [{ state: 'failed', updatedAt: 1 }, { state: 'complete', updatedAt: 2 }] })
  );
  assert.equal(recovered.level, 'ok');
  const empty = await rowOf('localProvider', local({ installed: true, enabled: true, models: [], installations: [] }));
  assert.equal(empty.level, 'warn');
  assert.equal(recovered.detail, 'installed · enabled · 1 models installed');
});

test('built-ins row lists states and treats missing bridges as informational', async () => {
  const row = await rowOf('builtins');
  assert.equal(row.level, 'ok');
  assert.match(row.detail, /^enabled: git · disabled: office · not installed: tidy · browser use .* · computer use /);
});

test('voice row: disabled ok, uninstalled warns, installed ok', async () => {
  assert.equal((await rowOf('voice', { getVoiceStatus: () => ({ enabled: false }) })).level, 'ok');
  const warn = await rowOf('voice', { getVoiceStatus: () => ({ enabled: true, installed: false, components: {} }) });
  assert.equal(warn.level, 'warn');
  assert.deepEqual(warn.fix, { hint: 'reinstall voice from Extensions' });
  const noModel = await rowOf('voice', { getVoiceStatus: () => ({ enabled: true, installed: true, components: { model: false } }) });
  assert.equal(noModel.level, 'warn');
  assert.equal((await rowOf('voice')).level, 'ok');
});

test('a stalled check times out without holding back the others', async () => {
  const started = Date.now();
  const result = await runDoctorChecks(runtime({ mcpStatus: () => new Promise(() => {}) }), state, {
    timeoutMs: 50,
  });
  assert.ok(Date.now() - started < 2000);
  const mcp = result.checks.find((check) => check.id === 'mcp');
  assert.equal(mcp.level, 'warn');
  assert.match(mcp.detail, /^no response within/);
  assert.equal(result.checks.find((check) => check.id === 'providers').level, 'ok');
});

test('local installation checks cover a missing folder, a broken config and runaway logs', async () => {
  const missing = await runDoctorChecks(runtime(), state, { dataDir: join(dataRoot, 'absent') });
  const missingById = Object.fromEntries(missing.checks.map((check) => [check.id, check]));
  assert.equal(missingById.data.level, 'fail');
  assert.match(missingById.data.detail, /^not found · /);
  assert.equal(missingById.config.level, 'ok');
  assert.equal(missingById.logs.level, 'fail');

  const broken = join(dataRoot, 'broken');
  mkdirSync(broken);
  writeFileSync(join(broken, 'mixdog-config.json'), '{"channels": ');
  for (let index = 0; index < 301; index++) writeFileSync(join(broken, `mcp-debug.${index}.1.log`), '');
  const result = await runDoctorChecks(runtime(), state, { dataDir: broken });
  const byId = Object.fromEntries(result.checks.map((check) => [check.id, check]));
  assert.equal(byId.data.level, 'ok');
  assert.equal(byId.config.level, 'fail');
  assert.ok(byId.config.fix?.hint);
  assert.equal(byId.logs.level, 'warn');
  assert.equal(byId.logs.detail, '301 log files in the data folder (over 300)');
});

test('missing, null, empty and rejected accessors never become healthy defaults', async () => {
  for (const value of [undefined, null, {}]) {
    const rt = Object.fromEntries(Object.keys(runtime()).map((key) => [key, async () => value]));
    const report = await buildDoctorReport(rt, state);
    for (const label of ['mixdog', 'providers', 'mcp', 'memory', 'automation', 'skills', 'plugins', 'hooks']) {
      assert.match(reportRow(report, label), /^⚠ /, `${label}: ${String(value)}`);
    }
  }
  const missing = await buildDoctorReport({}, state);
  assert.equal(reportRow(missing, 'providers'), '⚠ providers: status unavailable');

  const rejected = runtime({
    getProviderSetup: async () => {
      throw new Error('Authorization: Bearer secret-token');
    },
    mcpStatus: () => {
      throw new Error('https://user:secret-password@example.test');
    },
  });
  const report = await buildDoctorReport(rejected, state);
  assert.match(reportRow(report, 'providers'), /^✗ .*check failed/);
  assert.match(reportRow(report, 'mcp'), /^✗ .*check failed/);
  assert.match(reportRow(report, 'hooks'), /^✓ /);
  assert.doesNotMatch(report, /secret-token|secret-password|Authorization/);
});

test('all status accessors can be asynchronous without losing flags or counts', async () => {
  const rt = runtime();
  for (const [name, fn] of Object.entries(rt)) rt[name] = async (...args) => fn(...args);
  const report = await buildDoctorReport(rt, state);
  assert.equal(reportRow(report, 'automation'), '✓ automation: worker running');
  assert.equal(reportRow(report, 'skills'), '✓ skills: 0/0 active');
  assert.equal(reportRow(report, 'plugins'), '✓ plugins: 0/0 active');
  assert.equal(reportRow(report, 'hooks'), '✓ hooks: enabled · 0 rules · 0 configured events');
});

test('updates and offline checks remain warnings rather than failures', async () => {
  for (const [update, detail] of [
    [{ currentVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true }, 'update available → v1.1.0'],
    [{ currentVersion: '1.0.0', latestVersion: null }, 'update check skipped (registry unreachable)'],
  ]) {
    const report = await buildDoctorReport(runtime({ checkForUpdate: async () => update }), state);
    assert.equal(reportRow(report, 'mixdog'), `⚠ mixdog: v1.0.0 · ${detail}`);
  }
});

test('pending credentials do not claim an enabled provider is authenticated or broken', async () => {
  const report = await buildDoctorReport(
    runtime({
      getProviderSetup: async () => ({
        pendingSecrets: true,
        api: [{ id: 'openai', enabled: true, authenticated: true }],
        oauth: [],
        local: [],
      }),
    }),
    state
  );
  assert.equal(
    reportRow(report, 'providers'),
    '⚠ providers: credentials still loading · route openai · run /doctor again when ready'
  );
});

test('provider readiness distinguishes configuration, authentication, reauth and local installation', async () => {
  for (const [group, entry, expected] of [
    ['api', { type: 'api-key', enabled: true, authenticated: false }, '✗ providers: route openai has no auth'],
    [
      'oauth',
      { type: 'oauth', enabled: true, authenticated: true, usable: false, reauthRequired: true },
      '✗ providers: route openai requires sign-in again',
    ],
    [
      'oauth',
      { type: 'oauth', enabled: true, authenticated: true, usable: false },
      '✗ providers: route openai is not usable',
    ],
    [
      'local',
      { type: 'local', enabled: false, authenticated: true, detected: true, usable: false },
      '✗ providers: route openai is disabled',
    ],
    [
      'local',
      { type: 'local', enabled: true, detected: false, usable: false },
      '✗ providers: route openai has no installed runtime/model',
    ],
    ['local', { type: 'local', enabled: true, detected: true, usable: true }, '✓ providers: 1 ready · route openai'],
    [
      'oauth',
      { type: 'oauth', enabled: true, authenticated: true, usable: true, refreshable: true },
      '✓ providers: 1 ready · route openai',
    ],
  ]) {
    const report = await buildDoctorReport(
      runtime({
        getProviderSetup: async () => ({ api: [], oauth: [], local: [], [group]: [{ id: 'openai', ...entry }] }),
      }),
      state
    );
    assert.ok(reportRow(report, 'providers').startsWith(expected), JSON.stringify(entry));
  }
});

test('unknown or absent routes remain unverified', async () => {
  for (const provider of ['', 'not-listed']) {
    const report = await buildDoctorReport(runtime(), () => ({ provider }));
    assert.match(reportRow(report, 'providers'), /^⚠ /);
  }
});

test('MCP checks only enabled servers in this project, including connected unconfigured servers', async () => {
  const servers = [
    { name: 'active', configured: true, enabled: true, connected: true, activeHere: true },
    { name: 'off', configured: true, enabled: false, connected: false, status: 'disabled', error: 'old failure' },
    { name: 'elsewhere', configured: true, enabled: true, activeHere: false, connected: false, status: 'failed' },
    { name: 'live', configured: false, connected: true },
  ];
  const report = await buildDoctorReport(
    runtime({
      mcpStatus: () => ({ configuredCount: 3, connectedCount: 2, servers }),
    }),
    state
  );
  assert.equal(reportRow(report, 'mcp'), '✓ mcp: 2/2 connected · 1 disabled · 1 outside this project');
});

test('MCP names active failures and pending connections without leaking errors', async () => {
  const report = await buildDoctorReport(
    runtime({
      mcpStatus: async () => ({
        configuredCount: 2,
        connectedCount: 0,
        servers: [
          { name: 'broken', enabled: true, connected: false, status: 'failed', error: 'token=secret' },
          { name: 'pending', enabled: true, connected: false, status: 'disconnected' },
        ],
      }),
    }),
    state
  );
  assert.equal(reportRow(report, 'mcp'), '⚠ mcp: 0/2 connected · failed: broken · disconnected: pending');
  assert.doesNotMatch(report, /token=secret/);
});

test('MCP with incomplete server details does not claim nothing is configured', async () => {
  const report = await buildDoctorReport(
    runtime({
      mcpStatus: () => ({ configuredCount: 2, connectedCount: 0, servers: [] }),
    }),
    state
  );
  assert.equal(reportRow(report, 'mcp'), '⚠ mcp: status unavailable');
});

test('memory reports install/enable configuration instead of asserting availability', async () => {
  for (const [memory, recap, expected] of [
    [{ installed: false, enabled: false }, null, '✓ memory: not installed'],
    [{ installed: true, enabled: false }, null, '✓ memory: installed · disabled'],
    [{ installed: true, enabled: true }, { enabled: false }, '✓ memory: installed · enabled · recap disabled'],
    [{ installed: true, enabled: true }, null, '⚠ memory: installed · enabled · recap status unavailable'],
  ]) {
    let recapReads = 0;
    const report = await buildDoctorReport(
      runtime({
        getToolModuleSettings: () => ({ memory }),
        getRecapSettings: () => {
          recapReads++;
          return recap;
        },
      }),
      state
    );
    assert.equal(reportRow(report, 'memory'), expected);
    assert.equal(recapReads, memory.installed && memory.enabled ? 1 : 0);
  }
});

test('automation distinguishes stopped and unknown workers and supports the worker accessor', async () => {
  for (const [settings, worker, expected] of [
    [{ status: { running: false } }, undefined, '⚠ automation: worker stopped'],
    [{}, undefined, '⚠ automation: worker status unavailable'],
    [{}, { running: true }, '✓ automation: worker running'],
  ]) {
    const report = await buildDoctorReport(
      runtime({
        getChannelSettings: (options) => {
          assert.deepEqual(options, { includeStatus: true });
          return settings;
        },
        getChannelWorkerStatus: async () => worker,
      }),
      state
    );
    assert.equal(reportRow(report, 'automation'), expected);
  }
});

test('skills and plugins report disabled and project-scoped entries without false alarms', async () => {
  for (const [label, method] of [
    ['skills', 'skillsStatus'],
    ['plugins', 'pluginsStatus'],
  ]) {
    const entries = [
      { name: 'ready', enabled: true, activeHere: true },
      { name: 'off', enabled: false, dependencyIssues: ['uninstalled optional feature'] },
      { name: 'elsewhere', enabled: true, activeHere: false, error: 'not active here' },
    ];
    const report = await buildDoctorReport(
      runtime({
        [method]: () => ({ count: 3, [label]: entries }),
      }),
      state
    );
    assert.equal(reportRow(report, label), `✓ ${label}: 1/3 active · 1 disabled · 1 outside this project`);
  }
});

test('active skill dependency issues and plugin failures are warnings without raw details', async () => {
  const report = await buildDoctorReport(
    runtime({
      skillsStatus: () => ({
        skills: [{ name: 'needs-tool', enabled: true, dependencyIssues: [{ message: 'private config' }] }],
      }),
      pluginsStatus: () => ({
        plugins: [{ name: 'broken', enabled: true, invalid: true }],
        missing: [
          { id: 'gone', name: 'gone', enabled: true },
          { id: 'off', name: 'off', enabled: false },
        ],
      }),
      hooksStatus: () => ({
        enabled: true,
        configuredEvents: ['tool:before'],
        events: ['runtime:start', 'tool:before', 'tool:after'],
        ruleCount: 2,
        errors: [{ message: 'secret hook configuration' }],
      }),
    }),
    state
  );
  assert.equal(reportRow(report, 'skills'), '⚠ skills: 1/1 active · issues: needs-tool');
  assert.equal(reportRow(report, 'plugins'), '⚠ plugins: 1/1 active · issues: broken, gone');
  assert.equal(reportRow(report, 'hooks'), '⚠ hooks: enabled · 2 rules · 1 configured events · 1 configuration errors');
  assert.doesNotMatch(report, /private|secret hook configuration/);
});
