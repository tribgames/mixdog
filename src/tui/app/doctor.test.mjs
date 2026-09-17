import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildDoctorReport, nodeEngineSupport } from './doctor.mjs';

const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
const state = () => ({ provider: 'openai' });

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
    getToolModuleSettings: () => ({ memory: { installed: true, enabled: true } }),
    getRecapSettings: () => ({ enabled: true }),
    getChannelSettings: () => ({ enabled: true, status: { running: true, mode: 'daemon' } }),
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
  assert.equal(report.split('\n').length, 10);
  assert.equal(report.split('\n')[0], 'mixdog doctor — installation health');
  assert.equal(reportRow(report, 'mixdog'), '✓ mixdog: v1.0.0 · up to date');
  assert.equal(reportRow(report, 'providers'), '✓ providers: 1 ready · route openai');
  assert.equal(reportRow(report, 'memory'), '✓ memory: installed · enabled · recap enabled');
  assert.equal(reportRow(report, 'hooks'), '✓ hooks: enabled · 0 rules · 0 configured events');
  assert.doesNotMatch(report, /Defender|Add-MpPreference|pgdata|core memory available/i);
});

test('missing, null, empty and rejected accessors never become healthy defaults', async () => {
  for (const value of [undefined, null, {}]) {
    const rt = Object.fromEntries(Object.keys(runtime()).map((key) => [key, async () => value]));
    const report = await buildDoctorReport(rt, state);
    for (const label of ['mixdog', 'providers', 'mcp', 'memory', 'channels', 'skills', 'plugins', 'hooks']) {
      assert.match(reportRow(report, label), /^⚠ /, `${label}: ${String(value)}`);
    }
  }
  const missing = await buildDoctorReport({}, state);
  assert.equal(reportRow(missing, 'providers'), '⚠ providers: status unavailable');

  const rejected = runtime({
    getProviderSetup: async () => { throw new Error('Authorization: Bearer secret-token'); },
    mcpStatus: () => { throw new Error('https://user:secret-password@example.test'); },
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
  assert.equal(reportRow(report, 'channels'), '✓ channels: enabled · worker running');
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
  const report = await buildDoctorReport(runtime({
    getProviderSetup: async () => ({
      pendingSecrets: true,
      api: [{ id: 'openai', enabled: true, authenticated: true }],
      oauth: [],
      local: [],
    }),
  }), state);
  assert.equal(
    reportRow(report, 'providers'),
    '⚠ providers: credentials still loading · route openai · run /doctor again when ready'
  );
});

test('provider readiness distinguishes configuration, authentication, reauth and local installation', async () => {
  for (const [group, entry, expected] of [
    ['api', { type: 'api-key', enabled: true, authenticated: false }, '✗ providers: route openai has no auth'],
    ['oauth', { type: 'oauth', enabled: true, authenticated: true, usable: false, reauthRequired: true },
      '✗ providers: route openai requires sign-in again'],
    ['oauth', { type: 'oauth', enabled: true, authenticated: true, usable: false },
      '✗ providers: route openai is not usable'],
    ['local', { type: 'local', enabled: false, authenticated: true, detected: true, usable: false },
      '✗ providers: route openai is disabled'],
    ['local', { type: 'local', enabled: true, detected: false, usable: false },
      '✗ providers: route openai has no installed runtime/model'],
    ['local', { type: 'local', enabled: true, detected: true, usable: true },
      '✓ providers: 1 ready · route openai'],
    ['oauth', { type: 'oauth', enabled: true, authenticated: true, usable: true, refreshable: true },
      '✓ providers: 1 ready · route openai'],
  ]) {
    const report = await buildDoctorReport(runtime({
      getProviderSetup: async () => ({ api: [], oauth: [], local: [], [group]: [{ id: 'openai', ...entry }] }),
    }), state);
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
  const report = await buildDoctorReport(runtime({
    mcpStatus: () => ({ configuredCount: 3, connectedCount: 2, servers }),
  }), state);
  assert.equal(reportRow(report, 'mcp'), '✓ mcp: 2/2 connected · 1 disabled · 1 outside this project');
});

test('MCP names active failures and pending connections without leaking errors', async () => {
  const report = await buildDoctorReport(runtime({
    mcpStatus: async () => ({
      configuredCount: 2,
      connectedCount: 0,
      servers: [
        { name: 'broken', enabled: true, connected: false, status: 'failed', error: 'token=secret' },
        { name: 'pending', enabled: true, connected: false, status: 'disconnected' },
      ],
    }),
  }), state);
  assert.equal(reportRow(report, 'mcp'), '⚠ mcp: 0/2 connected · failed: broken · disconnected: pending');
  assert.doesNotMatch(report, /token=secret/);
});

test('MCP with incomplete server details does not claim nothing is configured', async () => {
  const report = await buildDoctorReport(runtime({
    mcpStatus: () => ({ configuredCount: 2, connectedCount: 0, servers: [] }),
  }), state);
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
    const report = await buildDoctorReport(runtime({
      getToolModuleSettings: () => ({ memory }),
      getRecapSettings: () => { recapReads++; return recap; },
    }), state);
    assert.equal(reportRow(report, 'memory'), expected);
    assert.equal(recapReads, memory.installed && memory.enabled ? 1 : 0);
  }
});

test('channels distinguish disabled, stopped and unknown workers and support the worker accessor', async () => {
  for (const [settings, worker, expected] of [
    [{ enabled: false }, undefined, '✓ channels: disabled'],
    [{ enabled: true, status: { running: false } }, undefined, '⚠ channels: enabled · worker stopped'],
    [{ enabled: true }, undefined, '⚠ channels: enabled · worker status unavailable'],
    [{ enabled: true }, { running: true }, '✓ channels: enabled · worker running'],
  ]) {
    const report = await buildDoctorReport(runtime({
      getChannelSettings: (options) => { assert.deepEqual(options, { includeStatus: true }); return settings; },
      getChannelWorkerStatus: async () => worker,
    }), state);
    assert.equal(reportRow(report, 'channels'), expected);
  }
});

test('skills and plugins report disabled and project-scoped entries without false alarms', async () => {
  for (const [label, method] of [['skills', 'skillsStatus'], ['plugins', 'pluginsStatus']]) {
    const entries = [
      { name: 'ready', enabled: true, activeHere: true },
      { name: 'off', enabled: false, dependencyIssues: ['uninstalled optional feature'] },
      { name: 'elsewhere', enabled: true, activeHere: false, error: 'not active here' },
    ];
    const report = await buildDoctorReport(runtime({
      [method]: () => ({ count: 3, [label]: entries }),
    }), state);
    assert.equal(reportRow(report, label), `✓ ${label}: 1/3 active · 1 disabled · 1 outside this project`);
  }
});

test('active skill dependency issues and plugin failures are warnings without raw details', async () => {
  const report = await buildDoctorReport(runtime({
    skillsStatus: () => ({
      skills: [{ name: 'needs-tool', enabled: true, dependencyIssues: [{ message: 'private config' }] }],
    }),
    pluginsStatus: () => ({ plugins: [{ name: 'broken', enabled: true, error: 'credential=private' }] }),
    hooksStatus: () => ({
      enabled: true,
      configuredEvents: ['tool:before'],
      events: ['runtime:start', 'tool:before', 'tool:after'],
      ruleCount: 2,
      errors: [{ message: 'secret hook configuration' }],
    }),
  }), state);
  assert.equal(reportRow(report, 'skills'), '⚠ skills: 1/1 active · issues: needs-tool');
  assert.equal(reportRow(report, 'plugins'), '⚠ plugins: 1/1 active · issues: broken');
  assert.equal(reportRow(report, 'hooks'), '⚠ hooks: enabled · 2 rules · 1 configured events · 1 configuration errors');
  assert.doesNotMatch(report, /private|secret hook configuration/);
});
