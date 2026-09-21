import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { shouldSupersedePanelEpoch, supersedePanelEpoch } from './panel-epoch.mjs';
import { createPanelSurface } from './panel-surface.mjs';
import { createSlashDispatch } from './slash-dispatch.mjs';
import { normalizeSlashCommandName, SLASH_COMMANDS, slashCommandTokenForPaletteAccept } from './slash-commands.mjs';

// runSlashCommand against a fake store: which opener or store call each
// command reaches, what it reports, and when a busy state refuses it.

function createHarness({ state = {}, store: overrides = {} } = {}) {
  supersedePanelEpoch();
  let live = null;
  const notices = [];
  const calls = [];
  const opened = [];
  const surface = createPanelSurface({
    setPicker: (next) => {
      const previous = live;
      live = typeof next === 'function' ? next(previous) : next;
      if (shouldSupersedePanelEpoch(previous, live)) supersedePanelEpoch();
    },
    setContextPanel: () => {},
    setUsagePanel: () => {},
  });
  const record = (name, result) => {
    return async (...args) => {
      calls.push([name, ...args]);
      return typeof result === 'function' ? result(...args) : result;
    };
  };
  const opener = (name) => (options) => {
    opened.push([name, options]);
  };
  const store = {
    pushNotice: (message, tone) => notices.push([message, tone]),
    setModel: record('setModel', true),
    setWorkflow: record('setWorkflow', (id) => ({ id })),
    setOutputStyle: record('setOutputStyle', (id) => ({ current: { id } })),
    getOutputStyle: record('getOutputStyle', { current: { label: 'Simple' } }),
    listThemes: () => [
      { id: 'dawn', label: 'Dawn' },
      { id: 'dusk', label: 'Dusk' },
    ],
    getTheme: () => 'dusk',
    setTheme: (id) => {
      calls.push(['setTheme', id]);
      return { id };
    },
    setEffort: record('setEffort', (value) => value),
    setFast: record('setFast', (value) => value),
    toggleFast: record('toggleFast', true),
    setAutoClear: record('setAutoClear', (patch) => ({ enabled: patch.enabled !== false, idleMs: 600_000 })),
    getAutoClear: record('getAutoClear', { enabled: true, idleMs: 300_000 }),
    compact: record('compact', { changed: true }),
    newSession: record('newSession', true),
    clear: record('clear', undefined),
    resume: record('resume', true),
    memoryControl: record('memoryControl', undefined),
    goalControl: record('goalControl', { message: 'Goal paused.' }),
    inheritSession: record('inheritSession', { messages: 4, sessionId: 's9' }),
    ...overrides,
  };
  const exits = [];
  const doctors = [];
  const { runSlashCommand } = createSlashDispatch({
    state: { busy: false, commandBusy: false, provider: 'openai', model: 'gpt-5', ...state },
    store,
    normalizeSlashCommandName,
    surface,
    closeUsagePanel: () => {},
    openModelPicker: opener('model'),
    modelSwitchNotice: () => 'model switched',
    openWebSearchPicker: opener('websearch'),
    openAgentsPicker: opener('agents'),
    openWorkflowPicker: opener('workflow'),
    workflowSwitchNotice: (result) => `workflow → ${result.id}`,
    openOutputStylePicker: opener('outputstyle'),
    outputStyleNotice: (result) => `style → ${result.current.id}`,
    openThemePicker: opener('theme'),
    themeNotice: (applied) => `theme → ${applied.id}`,
    openEffortPicker: opener('effort'),
    enterProject: (target) => calls.push(['enterProject', target]),
    openProjectPicker: opener('project'),
    openMcpPicker: opener('mcp'),
    openSkillsPicker: opener('skills'),
    openPluginsPicker: opener('plugins'),
    openProviderSetupPicker: opener('providers'),
    openMemoryCorePicker: opener('memory'),
    parseMemoryCommand: (arg) => ({ parsed: arg }),
    openSettingsPicker: opener('settings'),
    openAutoClearPicker: opener('autoclear'),
    formatDuration: (ms) => `${ms / 60_000}m`,
    openResumePicker: opener('resume'),
    openUsagePanel: opener('usage'),
    openContextPicker: opener('context'),
    openProfilePicker: opener('profile'),
    openUpdatePicker: opener('update'),
    runDoctor: async () => doctors.push(1),
    requestExit: () => exits.push(1),
  });
  return { runSlashCommand, notices, calls, opened, exits, doctors, current: () => live };
}

test('bare panel commands paint a loading frame and hand over to their opener', async () => {
  const h = createHarness();
  const panels = [
    ['model', 'model'],
    ['websearch', 'websearch'],
    ['agents', 'agents'],
    ['workflow', 'workflow'],
    ['outputstyle', 'outputstyle'],
    ['theme', 'theme'],
    ['effort', 'effort'],
    ['project', 'project'],
    ['mcp', 'mcp'],
    ['skills', 'skills'],
    ['plugins', 'plugins'],
    ['providers', 'providers'],
    ['memory', 'memory'],
    ['autoclear', 'autoclear'],
    ['resume', 'resume'],
    ['usage', 'usage'],
    ['context', 'context'],
    ['config', 'settings'],
    ['profile', 'profile'],
    ['update', 'update'],
  ];
  for (const [command, openerName] of panels) {
    assert.equal(h.runSlashCommand(command, ''), true, command);
    assert.equal(h.opened.at(-1)[0], openerName, command);
  }
  h.runSlashCommand('model', 'refresh');
  assert.deepEqual(h.opened.at(-1), ['model', { refreshModels: true }]);
  h.runSlashCommand('agents', 'refresh');
  assert.deepEqual(h.opened.at(-1), ['agents', { refreshModels: true }]);
  await flush();
  assert.equal(h.current(), null, 'an opener that painted nothing releases the loading frame');
});

test('argument forms write through the store and report the outcome', async () => {
  const h = createHarness();
  h.runSlashCommand('model', 'gpt-x');
  h.runSlashCommand('workflow', 'review');
  h.runSlashCommand('outputstyle', 'simple');
  h.runSlashCommand('outputstyle', 'status');
  h.runSlashCommand('theme', 'Dawn');
  h.runSlashCommand('theme', 'status');
  h.runSlashCommand('theme', 'nope');
  h.runSlashCommand('effort', 'high');
  h.runSlashCommand('fast', 'off');
  h.runSlashCommand('fast', '');
  h.runSlashCommand('fast', 'maybe');
  h.runSlashCommand('autoclear', '10m');
  h.runSlashCommand('autoclear', 'status');
  h.runSlashCommand('memory', 'search x');
  h.runSlashCommand('project', 'C:/other');
  h.runSlashCommand('goal', 'pause');
  await flush();
  assert.deepEqual(
    h.calls.map((c) => c[0]),
    [
      'setModel',
      'setWorkflow',
      'setOutputStyle',
      'getOutputStyle',
      'setTheme',
      'setEffort',
      'setFast',
      'toggleFast',
      'setAutoClear',
      'getAutoClear',
      'memoryControl',
      'enterProject',
      'goalControl',
    ]
  );
  assert.deepEqual(h.calls.find((c) => c[0] === 'setAutoClear').slice(1), [{ duration: '10m' }]);
  assert.deepEqual(h.calls.find((c) => c[0] === 'memoryControl').slice(1), [{ parsed: 'search x' }]);
  const messages = h.notices.map(([message]) => message);
  assert.ok(messages.includes('model switched'));
  assert.ok(messages.includes('workflow → review'));
  assert.ok(messages.includes('style → simple'));
  assert.ok(messages.includes('Output style: Simple'));
  assert.ok(messages.includes('theme → dawn'));
  assert.ok(messages.includes('Theme: Dusk'));
  assert.ok(messages.includes('usage: /theme [id]. Available: dawn, dusk'));
  assert.ok(messages.includes('Effort set to high'));
  assert.ok(messages.includes('Fast mode off for openai/gpt-5'));
  assert.ok(messages.includes('usage: /fast [on|off]'));
  assert.ok(messages.includes('autoclear on · idle 10m'));
  assert.ok(messages.includes('Goal paused.'));
});

test('busy guards refuse the destructive session commands and say so', () => {
  const h = createHarness({ state: { busy: true } });
  assert.equal(h.runSlashCommand('clear', ''), false);
  assert.equal(h.runSlashCommand('outputstyle', 'x'), false);
  assert.equal(h.runSlashCommand('compact', ''), false);
  assert.equal(h.runSlashCommand('resume', ''), false);
  assert.equal(h.runSlashCommand('inherit', ''), false);
  assert.deepEqual(
    h.notices.map(([message]) => message),
    [
      'wait for the current session command to finish before /clear',
      'wait for the current turn to finish before /OutputStyle',
      'wait for the current turn to finish before /compact',
      'wait for the current turn to finish before /resume',
      'wait for the current turn to finish before /inherit',
    ]
  );
  h.runSlashCommand('effort', 'low');
  const g = createHarness({ state: { commandBusy: true } });
  assert.equal(g.runSlashCommand('doctor', ''), false);
  assert.equal(g.runSlashCommand('new', ''), false);
});

test('session commands: /new, /clear, /compact outcomes, /resume id, /inherit, /doctor, /quit, unknown', async () => {
  const h = createHarness({
    store: {
      compact: (() => {
        const results = [
          { changed: true },
          { changed: false, reason: 'too small' },
          { changed: false },
          null,
          { error: 'x' },
        ];
        return async () => results.shift();
      })(),
    },
  });
  h.runSlashCommand('new', '');
  h.runSlashCommand('clear', '');
  for (let i = 0; i < 5; i += 1) h.runSlashCommand('compact', '');
  h.runSlashCommand('resume', 'abc');
  h.runSlashCommand('inherit', '');
  h.runSlashCommand('schedules', '');
  h.runSlashCommand('doctor', '');
  h.runSlashCommand('quit', '');
  h.runSlashCommand('bogus', '');
  await flush();
  assert.deepEqual(
    h.calls.map((c) => c[0]),
    ['newSession', 'clear', 'resume', 'inheritSession']
  );
  const messages = h.notices.map(([message]) => message);
  for (const expected of ['Compact done.', 'too small', 'nothing to compact', 'Compact failed.', 'Compact failed: x']) {
    assert.ok(messages.includes(expected), expected);
  }
  assert.ok(messages.includes('Resumed abc'));
  assert.ok(messages.includes('inherited 4 messages into s9'));
  assert.ok(messages.includes('Schedules and webhooks are managed in the Mixdog desktop app'));
  assert.ok(messages.includes('unknown command: /bogus'));
  assert.deepEqual(h.doctors, [1]);
  assert.deepEqual(h.exits, [1]);
});

test('command aliases reach the same panels and exit action through the real normalizer', () => {
  const h = createHarness();
  for (const [command, opener] of [
    ['projects', 'project'],
    ['style', 'outputstyle'],
    ['output-style', 'outputstyle'],
    ['setting', 'settings'],
    ['config', 'settings'],
  ]) {
    assert.equal(h.runSlashCommand(command), true);
    assert.equal(h.opened.at(-1)[0], opener);
  }
  assert.equal(h.runSlashCommand('exit'), true);
  assert.equal(h.runSlashCommand('q'), true);
  assert.deepEqual(h.exits, [1, 1]);
});

test('palette acceptance preserves the full /new alias while partial matches use /clear', async () => {
  const command = SLASH_COMMANDS.find((entry) => entry.name === 'clear');
  const h = createHarness();
  const newToken = slashCommandTokenForPaletteAccept(command, '/NEW');
  const clearToken = slashCommandTokenForPaletteAccept(command, '/ne');
  assert.equal(newToken, 'new');
  assert.equal(clearToken, 'clear');
  assert.equal(h.runSlashCommand(newToken), true);
  assert.equal(h.runSlashCommand(clearToken), true);
  await flush();
  assert.deepEqual(
    h.calls.map(([name]) => name),
    ['newSession', 'clear']
  );
});
