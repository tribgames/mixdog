import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { shouldSupersedePanelEpoch, supersedePanelEpoch } from './panel-epoch.mjs';
import { createPanelSurface } from './panel-surface.mjs';
import { createSlashDispatch } from './slash-dispatch.mjs';
import { createBtwController } from './btw-controller.mjs';
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
  const btwPanels = [];
  const session = { id: 's1' };
  const btw = createBtwController({
    getStore: () => store,
    setPanel: (p) => btwPanels.push(p),
    getSessionId: () => session.id,
  });
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
    btw,
  });
  return { runSlashCommand, notices, calls, opened, exits, doctors, btw, btwPanels, session, current: () => live };
}

test('/btw resolves as a command with a question param', () => {
  const cmd = SLASH_COMMANDS.find((c) => c.name === 'btw');
  assert.equal(cmd.params, '<question>');
  assert.equal(normalizeSlashCommandName('BTW'), 'btw');
});

test('/btw with no question shows the usage hint and sends no request', async () => {
  const h = createHarness({
    store: { askSide: async (q) => h.calls.push(['askSide', q]), cancelSide: () => h.calls.push(['cancelSide']) },
  });
  h.runSlashCommand('btw', '   ');
  await flush();
  assert.deepEqual(h.notices, [['usage: /btw <question>', 'warn']]);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.btwPanels, []);
});

test('/btw asks the side question while a turn is running and shows the answer', async () => {
  const h = createHarness({
    state: { busy: true },
    store: { askSide: async (q) => (h.calls.push(['askSide', q]), { text: 'because' }), cancelSide: () => {} },
  });
  assert.equal(h.runSlashCommand('btw', 'why?'), true);
  await flush();
  assert.deepEqual(h.calls, [['askSide', 'why?']]);
  assert.deepEqual(h.notices, []);
  assert.deepEqual(h.btwPanels, [
    { question: 'why?', status: 'pending', text: '' },
    { question: 'why?', status: 'done', text: 'because' },
  ]);
});

test('/btw failure shows the error message in the panel', async () => {
  const h = createHarness({
    store: {
      askSide: async () => {
        throw new Error('no side model');
      },
    },
  });
  h.runSlashCommand('btw', 'q');
  await flush();
  assert.deepEqual(h.btwPanels.at(-1), { question: 'q', status: 'error', text: 'no side model' });
});

test('closing a pending /btw panel (Esc) cancels the side request and ignores the late result', async () => {
  let release;
  const h = createHarness({
    store: {
      askSide: () => new Promise((resolve) => (release = resolve)),
      cancelSide: () => h.calls.push(['cancelSide']),
    },
  });
  h.runSlashCommand('btw', 'slow');
  await flush();
  h.btw.close();
  release({ text: 'late' });
  await flush();
  assert.deepEqual(h.calls, [['cancelSide']]);
  assert.deepEqual(h.btwPanels, [{ question: 'slow', status: 'pending', text: '' }, null]);
});

test('a session change cancels a pending /btw for its originating session and clears the panel', async () => {
  let release;
  const h = createHarness({
    store: {
      askSide: () => new Promise((resolve) => (release = resolve)),
      cancelSide: (sessionId) => h.calls.push(['cancelSide', sessionId]),
    },
  });
  h.runSlashCommand('btw', 'slow');
  await flush();
  h.btw.sync();
  assert.deepEqual(h.calls, [], 'same session: nothing to cancel');
  h.session.id = 's2';
  h.btw.sync();
  release({ text: 'late answer' });
  await flush();
  assert.deepEqual(h.calls, [['cancelSide', 's1']]);
  assert.deepEqual(h.btwPanels, [{ question: 'slow', status: 'pending', text: '' }, null]);
});

test('a settled /btw answer from another session is ignored, and a settled panel clears on session change', async () => {
  let release;
  const h = createHarness({
    store: { askSide: () => new Promise((resolve) => (release = resolve)), cancelSide: () => {} },
  });
  h.runSlashCommand('btw', 'q');
  await flush();
  h.session.id = 's2';
  release({ text: 'stale' });
  await flush();
  assert.deepEqual(h.btwPanels, [{ question: 'q', status: 'pending', text: '' }], 'settlement dropped');

  const settled = createHarness({ store: { askSide: async () => ({ text: 'ok' }), cancelSide: () => {} } });
  settled.runSlashCommand('btw', 'q');
  await flush();
  settled.session.id = 's2';
  settled.btw.sync();
  assert.equal(settled.btwPanels.at(-1), null);
});

test('disposing the controller (unmount) cancels a pending /btw without touching the panel', async () => {
  const h = createHarness({
    store: { askSide: () => new Promise(() => {}), cancelSide: (sessionId) => h.calls.push(['cancelSide', sessionId]) },
  });
  h.runSlashCommand('btw', 'q');
  await flush();
  h.btw.dispose();
  assert.deepEqual(h.calls, [['cancelSide', 's1']]);
  assert.equal(h.btwPanels.length, 1, 'no setPanel after unmount');
});

test('a new /btw replaces a pending one and cancels it first', async () => {
  const h = createHarness({
    store: {
      askSide: (q) => (h.calls.push(['askSide', q]), new Promise(() => {})),
      cancelSide: () => h.calls.push(['cancelSide']),
    },
  });
  h.runSlashCommand('btw', 'one');
  await flush();
  h.runSlashCommand('btw', 'two');
  await flush();
  assert.deepEqual(h.calls, [['askSide', 'one'], ['cancelSide'], ['askSide', 'two']]);
});

test('/btw followed immediately by close sends no request and no cancel', async () => {
  const h = createHarness({
    store: {
      askSide: (q) => (h.calls.push(['askSide', q]), new Promise(() => {})),
      cancelSide: (sessionId) => h.calls.push(['cancelSide', sessionId]),
    },
  });
  h.runSlashCommand('btw', 'one');
  h.btw.close();
  await flush();
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.btwPanels, [{ question: 'one', status: 'pending', text: '' }, null]);
});

test('/btw replaced before dispatch sends only the newest question', async () => {
  const h = createHarness({
    store: {
      askSide: (q) => (h.calls.push(['askSide', q]), new Promise(() => {})),
      cancelSide: (sessionId) => h.calls.push(['cancelSide', sessionId]),
    },
  });
  h.runSlashCommand('btw', 'one');
  h.runSlashCommand('btw', 'two');
  await flush();
  assert.deepEqual(h.calls, [['askSide', 'two']]);
});

test('/btw followed immediately by a session switch never sends through the new session', async () => {
  const h = createHarness({
    store: {
      askSide: (q) => (h.calls.push(['askSide', q]), new Promise(() => {})),
      cancelSide: (sessionId) => h.calls.push(['cancelSide', sessionId]),
    },
  });
  h.runSlashCommand('btw', 'one');
  h.session.id = 's2';
  h.btw.sync();
  await flush();
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.btwPanels, [{ question: 'one', status: 'pending', text: '' }, null]);
});

test('/btw session switch without sync still drops the undispatched request', async () => {
  const h = createHarness({
    store: { askSide: (q) => (h.calls.push(['askSide', q]), { text: 'x' }), cancelSide: () => {} },
  });
  h.runSlashCommand('btw', 'one');
  h.session.id = 's2';
  await flush();
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.btwPanels, [{ question: 'one', status: 'pending', text: '' }]);
});

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
  assert.ok(messages.includes('usage: /fast [on|off|ultra]'));
  assert.ok(messages.includes('autoclear on · idle 10m'));
  assert.ok(messages.includes('Goal paused.'));
});

test('/fast ultra selects Ultrafast and reports a model that lacks it', async () => {
  const h = createHarness();
  h.runSlashCommand('fast', 'ultra');
  await flush();
  assert.deepEqual(h.calls.at(-1), ['setFast', 'ultrafast']);
  assert.ok(h.notices.some(([m]) => m === 'Ultrafast for openai/gpt-5'));
  const g = createHarness({
    store: {
      setFast: async () => {
        throw new Error('ultrafast is not available for openai/gpt-5');
      },
    },
  });
  g.runSlashCommand('fast', 'ultra');
  await flush();
  assert.ok(g.notices.some(([m]) => m.includes('ultrafast is not available for openai/gpt-5')));
});

test('busy guards refuse the destructive session commands and say so', () => {
  const h = createHarness({ state: { busy: true } });
  assert.equal(h.runSlashCommand('clear', ''), false);
  assert.equal(h.runSlashCommand('outputstyle', 'x'), false);
  assert.equal(h.runSlashCommand('compact', ''), false);
  assert.equal(h.runSlashCommand('resume', ''), false);
  assert.equal(h.runSlashCommand('inherit', ''), false);
  assert.equal(h.runSlashCommand('fork', ''), false);
  assert.deepEqual(
    h.notices.map(([message]) => message),
    [
      'wait for the current session command to finish before /clear',
      'wait for the current turn to finish before /OutputStyle',
      'wait for the current turn to finish before /compact',
      'wait for the current turn to finish before /resume',
      'wait for the current turn to finish before /inherit',
      'wait for the current turn to finish before /fork',
    ]
  );
  h.runSlashCommand('effort', 'low');
  const g = createHarness({ state: { commandBusy: true } });
  assert.equal(g.runSlashCommand('doctor', ''), false);
  assert.equal(g.runSlashCommand('new', ''), false);
});

test('session commands: /new, /clear, /compact outcomes, /resume id, /fork, /inherit alias, /doctor, /quit, unknown', async () => {
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
  h.runSlashCommand('fork', '');
  h.runSlashCommand('inherit', '');
  h.runSlashCommand('schedules', '');
  h.runSlashCommand('doctor', '');
  h.runSlashCommand('quit', '');
  h.runSlashCommand('bogus', '');
  await flush();
  assert.deepEqual(
    h.calls.map((c) => c[0]),
    ['newSession', 'clear', 'resume', 'inheritSession', 'inheritSession']
  );
  const messages = h.notices.map(([message]) => message);
  for (const expected of ['Compact done.', 'too small', 'nothing to compact', 'Compact failed.', 'Compact failed: x']) {
    assert.ok(messages.includes(expected), expected);
  }
  assert.ok(messages.includes('Resumed abc'));
  assert.ok(messages.includes('forked 4 messages into s9'));
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

test('/shells lists held shells and releases one only with --confirm', async () => {
  const h = createHarness({
    store: {
      listShellJobs: async () => ({
        jobs: [
          { taskId: 'job_a', command: 'npm run dev' },
          { taskId: 'job_b', command: 'node server.js', terminationUnconfirmed: true },
        ],
      }),
      releaseShellJob: async (taskId) => {
        h.calls.push(['releaseShellJob', taskId]);
        return { released: true };
      },
    },
  });
  h.runSlashCommand('shells', '');
  await flush();
  assert.equal(h.notices.length, 1);
  const [listing, tone] = h.notices[0];
  assert.equal(tone, 'warn');
  assert.match(listing, /job_a {2}running {2}npm run dev/);
  assert.match(listing, /job_b {2}termination unconfirmed {2}node server\.js/);
  h.runSlashCommand('shells', 'release job_b');
  await flush();
  assert.match(h.notices[1][0], /may still be running.*\/shells release job_b --confirm/);
  assert.deepEqual(h.calls, [], 'nothing is released without --confirm');
  h.runSlashCommand('shells', 'release job_b --confirm');
  await flush();
  assert.deepEqual(h.calls, [['releaseShellJob', 'job_b']]);
  assert.deepEqual(h.notices[2], ['Released job_b.', 'info']);
});

const STOP_JOBS = [
  { taskId: 'job_a', command: 'npm run dev' },
  { taskId: 'job_b', command: 'tail -f log' },
];
const stopHarness = (stopResult = { stopped: 2, stopping: 0 }, jobs = STOP_JOBS) => {
  const h = createHarness({
    store: {
      listStoppableShellJobs: async () => ({ jobs }),
      stopShellJobs: async () => {
        h.calls.push(['stopShellJobs']);
        return stopResult;
      },
    },
  });
  return h;
};

test('/stop says so when no background shell is running and opens no prompt', async () => {
  const h = stopHarness(undefined, []);
  h.runSlashCommand('stop', '');
  await flush();
  assert.deepEqual(h.notices, [['No background shells are running.', 'info']]);
  assert.equal(h.current(), null);
  assert.deepEqual(h.calls, []);
});

test('/stop confirms once with the commands, and stopping happens only after Stop', async () => {
  const h = stopHarness();
  h.runSlashCommand('stop', '');
  await flush();
  const prompt = h.current();
  assert.equal(prompt.title, 'Stop 2 background shells?');
  assert.deepEqual(
    prompt.footer.map((row) => row.text),
    ['npm run dev', 'tail -f log']
  );
  assert.deepEqual(h.calls, [], 'nothing is stopped before the confirmation');
  prompt.onSelect('stop');
  await flush();
  assert.deepEqual(h.calls, [['stopShellJobs']]);
  assert.deepEqual(h.notices, [['Stopped 2', 'info']]);
  assert.equal(h.current(), null);
});

test('cancelling the /stop prompt stops nothing', async () => {
  const h = stopHarness();
  h.runSlashCommand('stop', '');
  await flush();
  h.current().onSelect('cancel');
  await flush();
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.notices, []);
  assert.equal(h.current(), null);
  h.runSlashCommand('stop', '');
  await flush();
  h.current().onCancel();
  await flush();
  assert.deepEqual(h.calls, []);
});

test('/stop reports shells that are still stopping', async () => {
  const h = stopHarness({ stopped: 1, stopping: 1 });
  h.runSlashCommand('stop', '');
  await flush();
  h.current().onSelect('stop');
  await flush();
  assert.deepEqual(h.notices, [['Stopped 1 · 1 still stopping', 'warn']]);
});
