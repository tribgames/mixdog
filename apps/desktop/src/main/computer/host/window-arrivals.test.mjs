import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url:
            'data:text/javascript,' +
            encodeURIComponent('export const BrowserWindow = { getAllWindows: () => [] }; export const screen = {};'),
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});
const { ARRIVALS_READ_BUDGET_MS, ARRIVALS_WATCH_INTERVAL_MS, ARRIVALS_WATCH_SPAN_MS, createWindowArrivals } =
  await import('./window-arrivals.ts');
const { createSessionLifecycle } = await import('./session-lifecycle.ts');
const { createExecutionState } = await import('./execution-state.ts');
const { createComputerExecutionPolicy } = await import('./execution-policy.ts');
const { settleWindowTransition } = await import('./window-settle.ts');
const { settleInputRun } = await import('./input-run-settle.ts');
const { ComputerUseCoordinator } = await import('../session/coordinator.ts');
const { computeComputerWindowTransition } = await import('../shared/window-transition.ts');
const { createWindowReads } = await import('./window-reads.ts');
const { createWorkerPool } = await import('../backend/worker-pool.ts');
const { RESPONSE_MARKER } = await import('../backend/program.ts');
const { WINDOW_ARRIVALS_SESSION_ID } = await import('../shared/common.ts');

function record(id, title, overrides = {}) {
  return {
    id,
    title,
    className: 'Chrome_WidgetWin_1',
    app: 'chrome',
    pid: 7,
    ownerId: '',
    focused: false,
    minimized: false,
    maximized: false,
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    ...overrides,
  };
}

const CONSOLE = record('hwnd:0x10', 'Search Console - Chrome', { focused: true });
const POPUP = record('hwnd:0x20', 'Authorize app / X - Chrome', { width: 500, height: 640 });
const OTHER = record('hwnd:0x30', 'Notes', { app: 'notepad', pid: 9 });

/** A desktop whose snapshot read, like the native one, carries no app names.
 *  `failNext` makes the next arrivals reads fail; `hang` leaves them unanswered. */
function desktop(initial) {
  const windows = [...initial];
  const readComputerWindows = async (_command, includeApp = false) =>
    windows.map((window) => (includeApp ? { ...window } : { ...window, app: '' }));
  const screen = {
    windows,
    failNext: 0,
    hang: false,
    readComputerWindows,
    peekComputerWindows: (command, includeApp) => {
      if (screen.hang) return new Promise(() => {});
      if (screen.failNext > 0) {
        screen.failNext--;
        return Promise.resolve(null);
      }
      return readComputerWindows(command, includeApp);
    },
  };
  return screen;
}

function lifecycleFixture(t, screen, runCommand, policy = createComputerExecutionPolicy()) {
  const coordinator = new ComputerUseCoordinator();
  const sessionIdFor = (command) => command.session_id;
  const arrivals = createWindowArrivals({ policy, sessionIdFor, peekComputerWindows: screen.peekComputerWindows });
  const host = createSessionLifecycle({
    coordinator,
    execution: createExecutionState(),
    powerShellBySession: new Map(),
    workerLastUsedAt: new Map(),
    retirePowerShell() {},
    callPowerShell: async () => ({ ok: true }),
    cancelElevatedSession: async () => true,
    elevatedSessionIds: () => [],
    sessionIdFor,
    releaseSessionState() {},
    invalidateWorkerGeneration() {},
    releaseCaptureSession() {},
    cleanupInput: async () => true,
    runCommand,
    recaptureRequiredReply: async () => null,
    windowArrivals: arrivals,
  });
  t.after(async () => {
    await host.stopAllComputerSessions();
    coordinator.reset();
  });
  const send = (command) =>
    host.executeSerialized({ session_id: 'agent', ...command }).then((result) => JSON.parse(result.text));
  return Object.assign(send, { arrivals, host });
}

const reply = (action, extra = {}) => ({ text: JSON.stringify({ ok: true, action, ...extra }) });

test('a popup that opens after the settle check is named by the next command, once', async (t) => {
  const screen = desktop([CONSOLE, OTHER]);
  const before = await screen.readComputerWindows({});
  // Had it existed at the settle mark, this popup would have been the act's successor.
  assert.equal(
    computeComputerWindowTransition(before, [...before, POPUP], CONSOLE.id, CONSOLE.pid).next_target_reason,
    'single_same_process_window_opened'
  );
  const send = lifecycleFixture(t, screen, async (command) => {
    if (command.action !== 'sequence') return reply(command.action);
    const timings = {};
    const { transition } = await settleWindowTransition(
      { assertExecutionNotAborted() {}, readComputerWindows: screen.readComputerWindows },
      {
        command: { action: 'click' },
        action: 'click',
        windowsBefore: await screen.readComputerWindows(command),
        targetWindowId: CONSOLE.id,
        pid: CONSOLE.pid,
        appHint: '',
        timings,
      }
    );
    assert.ok(timings.settle_ms >= 140, 'the act paid its one settle');
    // The page's timer opens the popup after that single scan.
    screen.windows.push(POPUP);
    return reply('sequence', { window_transition: transition });
  });

  assert.equal((await send({ action: 'capture', window_id: CONSOLE.id })).windows_opened_since_last_action, undefined);
  const act = await send({ action: 'sequence', window_id: CONSOLE.id, steps: [{ action: 'click', ref: 'e1' }] });
  assert.deepEqual(act.window_transition.opened_windows, []);
  assert.equal(act.window_transition.next_target, undefined);
  assert.equal(act.windows_opened_since_last_action, undefined);

  const next = await send({ action: 'capture', window_id: CONSOLE.id });
  assert.deepEqual(next.windows_opened_since_last_action, [
    { id: POPUP.id, title: 'Authorize app / X - Chrome', app: 'chrome' },
  ]);
  assert.equal((await send({ action: 'list_windows' })).windows_opened_since_last_action, undefined);
});

test('each session keeps its own baseline', async (t) => {
  const screen = desktop([CONSOLE]);
  const send = lifecycleFixture(t, screen, async (command) => reply(command.action));
  await send({ action: 'capture', session_id: 'a' });
  await send({ action: 'capture', session_id: 'b' });
  screen.windows.push(POPUP);
  assert.equal((await send({ action: 'capture', session_id: 'a' })).windows_opened_since_last_action.length, 1);
  assert.equal((await send({ action: 'capture', session_id: 'b' })).windows_opened_since_last_action.length, 1);
});

test('a restricted session hears only about windows its authorization covers', async (t) => {
  const policy = createComputerExecutionPolicy({
    version: 1,
    actions: ['capture', 'act'],
    windows: [{ id: CONSOLE.id, pid: CONSOLE.pid }],
    expiresAt: '2099-01-01T00:00:00Z',
  });
  const screen = desktop([OTHER]);
  const send = lifecycleFixture(t, screen, async (command) => reply(command.action), policy);
  await send({ action: 'capture', window_id: CONSOLE.id });
  // The authorized window (re)appears beside a popup the authorization does not cover.
  screen.windows.push(CONSOLE, POPUP);
  const next = await send({ action: 'capture', window_id: CONSOLE.id });
  assert.deepEqual(next.windows_opened_since_last_action, [{ id: CONSOLE.id, title: CONSOLE.title, app: 'chrome' }]);
  assert.doesNotMatch(JSON.stringify(next), /Authorize app/);
  // An unauthorized arrival is never named later either.
  assert.equal((await send({ action: 'capture', window_id: CONSOLE.id })).windows_opened_since_last_action, undefined);
});

test('a reply that cannot carry arrivals leaves them for the next command', async (t) => {
  const screen = desktop([CONSOLE]);
  const send = lifecycleFixture(t, screen, async (command) =>
    command.action === 'clipboard_read' ? { text: '{"user":"clipboard json"}' } : reply(command.action)
  );
  await send({ action: 'capture' });
  screen.windows.push(POPUP);
  assert.deepEqual(await send({ action: 'clipboard_read' }), { user: 'clipboard json' });
  assert.equal((await send({ action: 'capture' })).windows_opened_since_last_action[0].id, POPUP.id);
});

const RESTRICTED = {
  version: 1,
  actions: ['capture', 'act'],
  windows: [{ id: CONSOLE.id, pid: CONSOLE.pid }],
  expiresAt: '2099-01-01T00:00:00Z',
};

/** One batched act step through the real settle, whose native reply shows
 *  `opened` appearing between its before and after lists. */
async function settleActStep(policy, screen, arrivals, opened) {
  const command = { action: 'click', window_id: CONSOLE.id, session_id: 'agent' };
  const executionContext = new AsyncLocalStorage();
  const host = {
    sessionIdFor: () => 'agent',
    executionContext,
    sessionDesktopAnchor: new Map(),
    claimComputerTargets: async () => {},
    readComputerWindows: screen.readComputerWindows,
    windowArrivals: arrivals,
  };
  const before = await screen.readComputerWindows(command);
  screen.windows.push(...opened);
  const after = await screen.readComputerWindows(command);
  const settled = await executionContext.run({ sessionId: 'agent', aborted: false }, () =>
    settleInputRun(host, policy, {
      run: { command, action: 'click', isMutation: true, actionTimings: {} },
      prepared: { targetWindowId: CONSOLE.id, logicalTargetWindowId: CONSOLE.id, batchSequenceStep: true },
      response: {
        ok: true,
        result: {
          step_result: { pid: CONSOLE.pid, delivery_accepted: true },
          windows_before: before,
          windows_after: after,
          settle_delay_ms: 150,
        },
      },
      commandStartedAt: performance.now(),
    })
  );
  return { command, reply: JSON.parse(settled.text) };
}

test('a window an act step transition already named is not named again', async () => {
  const screen = desktop([CONSOLE]);
  const policy = createComputerExecutionPolicy();
  const arrivals = createWindowArrivals({ policy, sessionIdFor: () => 'agent', ...screen });
  assert.deepEqual(await arrivals.read({ session_id: 'agent' }), []);
  const { command, reply: settled } = await settleActStep(policy, screen, arrivals, [POPUP]);
  assert.equal(settled.window_transition.opened_windows[0].id, POPUP.id);
  assert.deepEqual(await arrivals.read(command), []);
});

test('a restricted act never names disallowed popups that select no successor', async () => {
  const screen = desktop([CONSOLE]);
  const policy = createComputerExecutionPolicy(RESTRICTED);
  const arrivals = createWindowArrivals({ policy, sessionIdFor: () => 'agent', ...screen });
  await arrivals.read({ session_id: 'agent' });
  // Two same-process popups: no unique successor, so no successor authorization runs.
  const twin = { ...POPUP, id: 'hwnd:0x21', title: 'Authorize app (2) / X - Chrome' };
  const { command, reply: settled } = await settleActStep(policy, screen, arrivals, [POPUP, twin]);
  assert.equal(settled.window_transition.next_target, undefined);
  assert.deepEqual(settled.window_transition.opened_windows, []);
  assert.doesNotMatch(JSON.stringify(settled), /Authorize app/);
  const next = await arrivals.report(command, await arrivals.read(command), reply('capture'));
  assert.doesNotMatch(next.text, /Authorize app/);
});

test('an arrivals read that never answers costs the command only its short budget', async (t) => {
  const screen = desktop([CONSOLE]);
  screen.hang = true;
  const send = lifecycleFixture(t, screen, async (command) => reply(command.action));
  const startedAt = performance.now();
  const result = await send({ action: 'capture', window_id: CONSOLE.id });
  assert.equal(result.ok, true);
  assert.ok(performance.now() - startedAt < ARRIVALS_READ_BUDGET_MS + 500, 'bounded by the read budget');
});

test('a failed first read leaves the baseline unknown, so a popup that opens next is still named', async (t) => {
  const screen = desktop([CONSOLE]);
  screen.failNext = 1;
  const send = lifecycleFixture(t, screen, async (command) => reply(command.action));
  await send({ action: 'capture', window_id: CONSOLE.id });
  screen.windows.push(POPUP);
  const next = await send({ action: 'capture', window_id: CONSOLE.id });
  assert.ok(next.windows_opened_since_last_action.some((window) => window.id === POPUP.id));
  assert.equal((await send({ action: 'capture', window_id: CONSOLE.id })).windows_opened_since_last_action, undefined);
});

test('a failed first read before an act takes the act own before list as the baseline', async (t) => {
  const screen = desktop([CONSOLE, OTHER]);
  screen.failNext = 1;
  const send = lifecycleFixture(t, screen, async (command) => {
    if (command.action === 'sequence') {
      send.arrivals.noteSettled(command, await screen.readComputerWindows(command), []);
      screen.windows.push(POPUP);
    }
    return reply(command.action);
  });
  await send({ action: 'sequence', window_id: CONSOLE.id });
  const next = await send({ action: 'capture', window_id: CONSOLE.id });
  assert.deepEqual(
    next.windows_opened_since_last_action.map((window) => window.id),
    [POPUP.id]
  );
});

test('a stop while the report reads app names refuses the reply instead of publishing it', async (t) => {
  const screen = desktop([CONSOLE]);
  let enrichmentStarted;
  const started = new Promise((resolve) => {
    enrichmentStarted = resolve;
  });
  let releaseEnrichment;
  const peek = screen.peekComputerWindows;
  screen.peekComputerWindows = (command, includeApp) => {
    if (!includeApp) return peek(command, includeApp);
    enrichmentStarted();
    return new Promise((resolve) => {
      releaseEnrichment = () => resolve(peek(command, includeApp));
    });
  };
  const send = lifecycleFixture(t, screen, async (command) => reply(command.action));
  await send({ action: 'capture', window_id: CONSOLE.id });
  screen.windows.push(POPUP);
  const pending = send({ action: 'capture', window_id: CONSOLE.id });
  await started;
  await send.host.abortComputerSession({ action: 'session_abort', session_id: 'agent' });
  releaseEnrichment();
  await assert.rejects(pending, /computer_session_aborted/);
});

test('a slow arrivals read never sits in front of the next command request', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-window-arrivals-'));
  const workers = new Map();
  const pool = createWorkerPool({
    dataDirectory: () => directory,
    isBridgeEnabled: () => false,
    isDisposed: () => false,
    spawnProcess: () => {
      const child = Object.assign(new EventEmitter(), {
        pid: 100 + workers.size,
        killed: false,
        exitCode: null,
        signalCode: null,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill() {
          this.killed = true;
          return true;
        },
      });
      workers.set(child.pid, child);
      return child;
    },
  });
  t.after(async () => {
    for (const child of workers.values()) {
      child.exitCode = 0;
      child.emit('exit', 0);
    }
    pool.removeHostScript();
    await rm(directory, { recursive: true, force: true });
  });
  const sessionIdFor = (command) => command.session_id;
  const reads = createWindowReads({ callPowerShell: pool.callPowerShell, sessionIdFor });
  const arrivals = createWindowArrivals({
    policy: createComputerExecutionPolicy(),
    sessionIdFor,
    peekComputerWindows: reads.peekComputerWindows,
  });
  const lines = (child) =>
    String(child.stdin.read() || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));

  // The arrivals worker never answers; the read gives up after its budget.
  assert.deepEqual(await arrivals.read({ action: 'capture', session_id: 'agent' }), []);
  const arrivalsWorker = pool.powerShellBySession.get(WINDOW_ARRIVALS_SESSION_ID);
  assert.deepEqual(
    lines(arrivalsWorker).map((request) => request.action),
    ['window_snapshot']
  );

  // The command's own request goes straight to its own worker and settles on
  // that worker's reply while the arrivals read is still unanswered.
  const command = pool.callPowerShell({ action: 'snapshot', session_id: 'agent' });
  const commandWorker = pool.powerShellBySession.get('agent');
  assert.notEqual(commandWorker, arrivalsWorker);
  const [request] = lines(commandWorker);
  assert.equal(request.action, 'snapshot');
  commandWorker.stdout.write(`${RESPONSE_MARKER}${JSON.stringify({ id: request.id, ok: true, result: {} })}\n`);
  assert.equal((await command).ok, true);
  assert.equal(arrivalsWorker.killed, false);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a popup that opens after the reply and closes before the next command is still named', async (t) => {
  const screen = desktop([CONSOLE]);
  const peeks = [];
  const peek = screen.peekComputerWindows;
  screen.peekComputerWindows = (command, includeApp) => {
    peeks.push(performance.now());
    return peek(command, includeApp);
  };
  const send = lifecycleFixture(t, screen, async (command) => reply(command.action));
  await send({ action: 'capture', window_id: CONSOLE.id });
  const startedAt = performance.now();
  await send({ action: 'sequence', window_id: CONSOLE.id });
  const repliedAt = performance.now();
  const commandReads = peeks.length;
  assert.ok(repliedAt - startedAt < ARRIVALS_WATCH_INTERVAL_MS, 'the watch adds nothing to the reply');
  setTimeout(() => screen.windows.push(POPUP), 500);
  setTimeout(() => screen.windows.splice(screen.windows.indexOf(POPUP), 1), 750);
  await sleep(ARRIVALS_WATCH_SPAN_MS + 200);
  assert.ok(peeks.slice(commandReads).every((at) => at >= repliedAt + ARRIVALS_WATCH_INTERVAL_MS - 5));
  assert.equal(screen.windows.includes(POPUP), false, 'closed before the next command');
  const next = await send({ action: 'capture', window_id: CONSOLE.id });
  assert.deepEqual(
    next.windows_opened_since_last_action.map((window) => [window.id, window.title]),
    [[POPUP.id, POPUP.title]]
  );
  assert.equal((await send({ action: 'capture', window_id: CONSOLE.id })).windows_opened_since_last_action, undefined);
});

test('a watch whose reader is refused stops after one look', async (t) => {
  const screen = desktop([CONSOLE]);
  let peeks = 0;
  const peek = screen.peekComputerWindows;
  screen.peekComputerWindows = (command, includeApp) => {
    peeks++;
    return peeks > 2 ? Promise.resolve(null) : peek(command, includeApp);
  };
  const send = lifecycleFixture(t, screen, async (command) => reply(command.action));
  await send({ action: 'capture', window_id: CONSOLE.id });
  await send({ action: 'sequence', window_id: CONSOLE.id });
  await sleep(ARRIVALS_WATCH_SPAN_MS + 200);
  assert.equal(peeks, 3, 'two command reads and one refused look');
});

test('a watch read that lands after its session was released records nothing for a reused id', async (t) => {
  const screen = desktop([CONSOLE]);
  let lookStarted;
  const started = new Promise((resolve) => {
    lookStarted = resolve;
  });
  let answerLook;
  let holdNext = false;
  const arrivals = createWindowArrivals({
    policy: createComputerExecutionPolicy(),
    sessionIdFor: (command) => command.session_id,
    peekComputerWindows: (command, includeApp) => {
      if (!holdNext) return screen.readComputerWindows(command, includeApp);
      holdNext = false;
      lookStarted();
      return new Promise((resolve) => {
        answerLook = resolve;
      });
    },
  });
  const capture = { action: 'capture', session_id: 'agent' };
  assert.deepEqual(await arrivals.read(capture), []);
  holdNext = true;
  arrivals.watch({ action: 'click', session_id: 'agent' });
  // The watch's own timers do not hold the process open.
  const keepAlive = setInterval(() => {}, 50);
  t.after(() => clearInterval(keepAlive));
  await started;
  arrivals.forget('agent');
  // The popup the old session's look saw; it is gone before the id is reused.
  answerLook([CONSOLE, { ...POPUP, app: '' }]);
  await sleep(ARRIVALS_WATCH_INTERVAL_MS * 2);
  assert.deepEqual(await arrivals.read(capture), [], 'the reused session only takes its baseline');
  assert.deepEqual(await arrivals.read(capture), [], 'and never inherits the old popup');
});

test('a read slower than the budget still seeds a session that has no baseline', async () => {
  const screen = desktop([CONSOLE]);
  let reads = 0;
  let answerFirst;
  const arrivals = createWindowArrivals({
    policy: createComputerExecutionPolicy(),
    sessionIdFor: () => 'agent',
    peekComputerWindows: (command, includeApp) => {
      if (reads++ > 0) return screen.readComputerWindows(command, includeApp);
      // A worker still starting: the reply comes after the budget.
      return new Promise((resolve) => {
        answerFirst = () => resolve(screen.readComputerWindows(command));
      });
    },
  });
  const command = { action: 'capture', session_id: 'agent' };
  assert.deepEqual(await arrivals.read(command), []);
  answerFirst();
  await new Promise((resolve) => setImmediate(resolve));
  screen.windows.push(POPUP);
  assert.deepEqual(
    (await arrivals.read(command)).map((window) => window.id),
    [POPUP.id]
  );
});
