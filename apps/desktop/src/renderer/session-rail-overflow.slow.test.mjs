import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { SESSION_RAIL_DEFAULT_WIDTH, SESSION_RAIL_MAX_WIDTH, SESSION_RAIL_MIN_WIDTH } from './session-rail-layout.ts';
import { PANEL_TYPE_ROLES, typeOffTier } from './test-support/panel-type-roles.mjs';

const resolveDir = fileURLToPath(new URL('.', import.meta.url));
const loader = { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' };

// A busy session in the panel at a given width: every category open, long
// names everywhere, more rows than each list's first few.
const HARNESS = `
  import { flushSync } from 'react-dom';
  import { createRoot } from 'react-dom/client';
  import { islandAgentRows } from './agent-activity-model';
  import { useSessionGoal } from './SessionGoalIsland';
  import { ContextSection, InfoSection } from './session-rail-info';
  import { GoalSection, TodoSection } from './session-rail-goal';
  import { AgentsSection, ShellsSection } from './session-rail-jobs';
  import { ChangesSection, GitSection } from './session-rail-changes';
  import { useLayoutEffect } from 'react';
  import { useSessionRailFolds } from './session-rail-folds';
  import { clearBranchMenuCache } from './branch-menu';
  import { clearBranchMenuReads } from './branch-menu-data';
  import { installScrollbarMetrics } from './scrollbar-metrics';
  import { bindScrollProgress } from './scroll-progress';
  import { AGENT_ROW_STATES, agentStateWords } from './agent-row-meta';
  import { shellStateWords } from './ComposerIsland';
  import i18next from './i18n.ts';
  import ko from './locales/ko.json';
  import de from './locales/de.json';
  import ru from './locales/ru.json';
  import es from './locales/es.json';
  import fr from './locales/fr.json';
  import it from './locales/it.json';
  import ja from './locales/ja.json';
  import ptBR from './locales/pt-BR.json';
  import vi from './locales/vi.json';
  import zhCN from './locales/zh-CN.json';
  import zhTW from './locales/zh-TW.json';
  import './session-rail.css';

  const CATALOGS = { ko, de, ru, es, fr, it, ja, 'pt-BR': ptBR, vi, 'zh-CN': zhCN, 'zh-TW': zhTW };
  window.setLanguage = async (language) => {
    if (language !== 'en') i18next.addResourceBundle(language, 'translation', CATALOGS[language], true, true);
    await i18next.changeLanguage(language);
  };

  const SESSION = 'busy-session';
  const PROJECT = 'C:/work/an-extremely-long-project-folder-name-that-never-ends';
  const long = (word) => word + '-' + 'very-long-segment-'.repeat(6) + 'end';
  const workspace = {
    cwd: PROJECT + '-wt/' + long('feature'), branch: long('feature/session-rail'), repoCommonDir: PROJECT + '/.git',
    worktreeId: 'wt-1', mergeTarget: 'main', revision: 7, baseCommit: 'abcdef1234',
    transition: { state: 'idle', txId: null },
  };
  window.mixdogDesktop = {
    invokeCapability: async ({ capability }) => {
      if (capability === 'getBranchMenu') {
        // A test can hold the read (window.branchGate) to see the tab before its rows land.
        if (window.branchGate) await window.branchGate.promise;
        const names = Array.from({ length: 5 }, (_, index) => long('worktree-' + index));
        return { value: {
          workspace,
          branches: [{ name: 'main' }, { name: workspace.branch }, ...names.map((name) => ({ name }))],
          occupancy: [
            { branch: 'main', kind: 'current' },
            { branch: workspace.branch, kind: 'session', sessionId: SESSION, path: workspace.cwd },
            ...names.map((name, index) => ({ branch: name, kind: 'session', sessionId: 'other-' + index, path: PROJECT + '-wt/' + name })),
          ],
          retainedWorktree: null,
        } };
      }
      if (capability === 'previewWorktreeCleanup') return { value: { hasCandidates: true } };
      // The ledger: the jobs' agents at the widest compact figure they can read ("999.9M").
      if (capability === 'getSessionUsage') {
        const usage = (tokens) => ({
          turns: 2, input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, tokens, unmeasuredTurns: 0,
          costUsd: 0, costKnownTurns: 2, costUnpricedTurns: 0,
        });
        return { value: { ...usage(1000), agents: usage(1_999_800_000), sessions: {
          'job-agent-0': usage(999_900_000), 'job-agent-1': usage(999_900_000),
        } } };
      }
      // What the window holds: MCP tools load nothing.
      if (capability === 'contextStatus') {
        return { value: {
          messages: { semantic: { system: { tokens: 20000 }, chat: { tokens: 150000 } } },
          request: { toolSchemaBreakdown: { code: { tokens: 4000 } } },
        } };
      }
      return { value: null };
    },
    // A shell's Stop answers what the test sets (window.stopAnswer).
    stopShellJob: () => window.stopAnswer(),
    // A clean checkout two commits ahead: Git and its actions.
    gitStatus: async () => ({
      repository: true, root: PROJECT, branch: 'main', detached: false, unborn: false, upstream: true,
      upstreamName: 'origin/main', remote: true, ahead: 2, behind: 0, operation: '', files: [],
    }),
    gitReview: async () => ({ repository: true, root: PROJECT, base: 'HEAD', files: [] }),
  };

  const now = Date.now();
  const snapshot = {
    sessionId: SESSION,
    busy: true,
    contextPercent: 87,
    contextTokens: 200000,
    stats: {
      inputTokens: 123456789, outputTokens: 98765432, cacheReadTokens: 876543210, costUsd: 12345.67,
      currentContextTokens: 174000, currentContextSource: 'last_api_request',
    },
    goal: {
      id: 'goal-1', status: 'blocked', title: long('Find the relay memory leak'),
      objective: long('Reproduce the leak under a long relay connection, then bisect') + ' ' + long('and fix'),
      blocker: long('Waiting for the soak test machine to come back online'),
      createdAt: now - 3_600_000 * 30, lastStartedAt: now - 3_600_000 * 30, timeUsedMs: 3_600_000 * 30,
    },
    todo: {
      phases: [
        { name: long('Reproduce'), tasks: Array.from({ length: 4 }, (_, i) => ({ content: long('step ' + i), status: i ? 'pending' : 'in_progress' })) },
        { name: long('Fix'), tasks: Array.from({ length: 4 }, (_, i) => ({ content: long('fix ' + i), status: i < 2 ? 'completed' : 'pending' })) },
      ],
      completed: 2, abandoned: 0, total: 8,
    },
  };
  const lead = { tag: 'lead:' + SESSION, sessionId: SESSION, ownerSessionId: SESSION, agent: 'lead', status: 'idle', stage: 'idle' };
  const pool = [lead, ...Array.from({ length: 12 }, (_, i) => ({
    tag: long('agent-' + i), sessionId: 'agent-' + i, ownerSessionId: SESSION, parentSessionId: SESSION,
    agent: 'worker', provider: 'anthropic', model: long('claude-opus'), effort: 'medium', status: i % 3 ? 'running' : 'completed', stage: i % 3 ? 'streaming' : 'completed',
    startedAt: now - 3_600_000 * 9, turnStartedAt: i % 3 ? now - 3_600_000 * 9 : null, settledAt: i % 3 ? 0 : now,
    todo: { completed: 12, total: 99, current: long('current step') },
  })),
  // Short names, one with a step list and one without, beside the long ones.
  ...['a', 'b'].map((tag, i) => ({
    tag, sessionId: 'short-' + tag, ownerSessionId: SESSION, parentSessionId: SESSION, agent: 'worker', provider: 'anthropic',
    model: long('claude-opus'), effort: 'medium', status: 'running', stage: 'streaming', startedAt: now - 60_000,
    turnStartedAt: now - 60_000, todo: i ? null : { completed: 1, total: 4, current: 'read' },
  }))];
  const shells = Array.from({ length: 8 }, (_, i) => ({
    key: 'shell-' + i, kind: 'shell', label: 'npm run ' + long('script-' + i) + ' -- --watch --reporter=verbose',
    startedAt: now - 3_600_000 * 9, finished: i >= 6, status: i >= 6 ? 'completed' : undefined, exitCode: i >= 6 ? 0 : undefined,
    taskId: 'task-' + i, cwd: PROJECT,
  }));
  const files = new Map(Array.from({ length: 8 }, (_, i) => [
    'src/' + long('deeply/nested/folder') + '/' + long('file-name-' + i) + '.tsx',
    { additions: 123456 - i, deletions: 98765, lineStats: true, status: 'M', binary: false, parts: [] },
  ]));
  // A short name in a folder too long for the row beside it, and a path that fits whole.
  files.set('packages/' + long('desktop') + '/src/renderer/session-rail/index.tsx',
    { additions: 12, deletions: 3, lineStats: true, status: 'M', binary: false, parts: [] });
  files.set('src/app/main.ts', { additions: 1, deletions: 0, lineStats: true, status: 'M', binary: false, parts: [] });
  const view = {
    label: 'Uncommitted', fileCount: files.size, files,
    headlineStats: { additions: 987654, deletions: 876543, hasLineStats: true },
    sessionId: SESSION, historyTurns: 3, busy: true, sourcePicker: true, emptyText: '', ready: true,
  };
  const noop = () => {};
  // Where a mark's ink ends: its shapes' right edge (half a stroke past it), scaled from its view box into its box as
  // drawn (transform included).
  const inkRight = (svg) => {
    const rect = svg.getBoundingClientRect();
    const view = svg.viewBox.baseVal;
    const scale = Math.min(rect.width / view.width, rect.height / view.height);
    const offset = (rect.width - view.width * scale) / 2;
    const right = Math.max(
      ...[...svg.querySelectorAll('path, circle, rect, line, polyline, polygon, ellipse')].map((shape) => {
        const style = getComputedStyle(shape);
        const stroke = style.stroke === 'none' ? 0 : Number.parseFloat(style.strokeWidth) || 0;
        const bbox = shape.getBBox();
        return bbox.x + bbox.width + stroke / 2;
      })
    );
    return rect.left + offset + (right - view.x) * scale;
  };
  window.inkRight = inkRight;
  const model = {
    provider: 'anthropic', model: long('claude-model-with-a-long-name'), effort: 'high', fast: false, fastCapable: false,
    sessionId: SESSION, modelDisabled: false, tuningDisabled: false,
    invokeResult: async (action) => action(), applySnapshot: noop, onOpenSettings: noop,
  };
  const choice = (id, label, valueLabel) => ({ id, label, valueLabel, disabled: false, options: [], onSelect: noop });

  // The panel's kinds start folded; the measured scenes open each kind the first time it shows, as a user would,
  // and leave a fold a test makes afterwards alone.
  const openedKinds = new Set();
  function OpenKinds() {
    const { setGroups } = useSessionRailFolds(SESSION);
    useLayoutEffect(() => {
      const fresh = [...document.querySelectorAll('.session-rail .composer-island-agent-fold[data-fold]')]
        .map((fold) => fold.dataset.fold)
        .filter((key) => !openedKinds.has(key));
      if (!fresh.length) return;
      for (const key of fresh) openedKinds.add(key);
      setGroups(Object.fromEntries(fresh.map((key) => [key, true])));
    });
    return null;
  }

  function Rail({ width, folded = [], height }) {
    const folds = useSessionRailFolds(SESSION);
    const goal = useSessionGoal(snapshot);
    const fold = (category) => ({ open: !folded.includes(category), onToggle: noop });
    return <aside className="session-rail" style={{ width, height }}>
      <OpenKinds />
      <div className="session-rail-body">
        <div className="session-rail-content">
          <InfoSection {...fold('info')} snapshot={snapshot} sessionId={SESSION} workspace={workspace}
            projectPath={PROJECT} projectLabel={long('Project label')} projects={[]} locked={false} agentMode={false}
            answersModelPickerRequests={false} model={model}
            sessionChoices={[choice('workflow', 'Workflow', long('Workflow value')), choice('mode', 'Delegation', long('Delegation value'))]}
            onFlash={noop} onOpenCommandSurface={noop} onMoveSessionToProject={async () => {}} />
          <ContextSection {...fold('context')} snapshot={snapshot} onViewDetails={noop} />
          <GoalSection model={goal} {...fold('goal')} />
          <TodoSection model={goal} folds={folds} {...fold('todo')} />
          <AgentsSection {...fold('agents')} sessionId={SESSION} agents={islandAgentRows(pool, SESSION)} poolRows={pool}
            busy shellKeys={null} />
          <ShellsSection {...fold('shells')} sessionId={SESSION} shells={shells} shellKeys={null} />
          <ChangesSection {...fold('changes')} view={view} cwd={PROJECT} onOpenChanges={noop} onOpenChangeFile={noop} />
          <GitSection {...fold('git')} sessionId={SESSION} cwd={PROJECT} />
        </div>
      </div>
    </aside>;
  }
  // A quiet session: its usage as wide as the worded line gets ("123.4M tokens · ~000 tok/s · Cache hit 100.0%", no
  // cost), and a window 40% full, a gauge with no tone.
  const quietSession = {
    sessionId: 'quiet-session',
    contextTokens: 200000,
    stats: {
      usageReadout: { input: 0, cacheRead: 123000000, cacheWrite: 0, output: 400000, speedOutputTokens: 83000, speedMs: 1000000 },
      currentContextTokens: 80000, currentContextSource: 'last_api_request',
    },
  };
  function Quiet({ width, readout }) {
    const quiet = readout ? { ...quietSession, stats: { ...quietSession.stats, usageReadout: readout } } : quietSession;
    return <aside className="session-rail" style={{ width }}>
      <div className="session-rail-body">
        <div className="session-rail-content">
          <InfoSection open onToggle={noop} snapshot={quiet} sessionId={quiet.sessionId} workspace={null} projectPath=""
            projectLabel="app" projects={[]} locked={false} agentMode={false} answersModelPickerRequests={false} model={model}
            sessionChoices={[]} onFlash={noop} onOpenCommandSurface={noop} />
          <ContextSection open onToggle={noop} snapshot={quiet} onViewDetails={noop} />
        </div>
      </div>
    </aside>;
  }
  window.mountQuiet = (width, readout) => {
    installScrollbarMetrics();
    root ??= createRoot(document.getElementById('root'));
    flushSync(() => root.render(<Quiet width={width} readout={readout} />));
  };
  // Info's usage row: its line's form (worded, or icons) and whether it stands whole on one line after the mark.
  window.usageLine = () => {
    const row = document.querySelector('[data-category="info"] .session-rail-usage');
    const readout = row.querySelector('.composer-usage-readout');
    const items = [...readout.children];
    const mark = row.querySelector(':scope > .session-rail-ic').getBoundingClientRect();
    const tops = new Set(items.map((item) => Math.round(item.getBoundingClientRect().top)));
    // The room the row leaves the line: its content box less the mark and the label beside it.
    const style = getComputedStyle(row);
    const others = [...row.children].filter((child) => child !== readout);
    const room =
      row.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight) -
      others.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0);
    return {
      shown: !readout.hidden,
      room,
      fullWidth: Number(readout.dataset.fullWidth),
      fontSize: getComputedStyle(readout).fontSize,
      gap: readout.style.getPropertyValue('--readout-gap'),
      sepMargins: [...readout.querySelectorAll('.composer-readout-sep')].map((sep) => getComputedStyle(sep).marginLeft),
      supporting: (() => {
        const probe = document.createElement('span');
        probe.style.fontSize = 'var(--mx-font-supporting)';
        row.append(probe);
        const size = getComputedStyle(probe).fontSize;
        probe.remove();
        return size;
      })(),
      text: readout.textContent,
      worded: items.length > 0 && items.every((item) => !item.querySelector('svg')),
      icons: items.length > 0 && items.every((item) => item.querySelector('svg')),
      oneLine: tops.size === 1,
      whole: readout.scrollWidth <= readout.clientWidth + 0.5 && readout.getBoundingClientRect().right <= row.getBoundingClientRect().right + 0.5,
      afterMark: readout.getBoundingClientRect().left >= mark.right - 0.5,
    };
  };
  // Context's head percent and its rows: each figure's colour beside the text ink and the muted ink, and the gap
  // above Free space.
  window.contextFigures = () => {
    const section = document.querySelector('[data-category="context"]');
    const ink = getComputedStyle(section.querySelector('.session-rail-tt').closest('.session-rail')).color;
    const muted = getComputedStyle(section.querySelector('.session-rail-sm')).color;
    const rows = [...section.querySelectorAll('.session-rail-part')];
    const free = section.querySelector('.session-rail-part[data-context-key="free"]');
    return {
      ink,
      muted,
      percent: getComputedStyle(section.querySelector('.session-rail-context-percent')).color,
      tone: section.querySelector('.session-rail-context-percent').dataset.tone ?? null,
      rows: rows.map((row) => ({
        key: row.dataset.contextKey,
        zero: row.hasAttribute('data-zero'),
        color: getComputedStyle(row.querySelector('.session-rail-num')).color,
      })),
      freeGap: free.getBoundingClientRect().top - free.previousElementSibling.getBoundingClientRect().bottom,
    };
  };
  // Two agents and two shells at a width: the first of each in the state the test names (an agent's state, with or
  // without its turn's clock at its widest; one of SHELL_CASES), the second running for 5s. The round keys the first
  // shell anew, so a stop asked in one round is not in the next.
  const WIDEST_CLOCK = 35_990_000;
  const SHELL_CASES = {
    running: { finished: false },
    // Running under an hour, as the other shell is.
    quick: { finished: false },
    stopped: { finished: true, status: 'cancelled' },
    exited: { finished: true, status: 'completed', exitCode: 0 },
    failed: { finished: true, status: 'failed', exitCode: 1 },
    held: { finished: false, terminationUnconfirmed: true },
    // Asked to stop: the answer pending, refused, or the kill sent but unconfirmed (window.stopAnswer).
    stopping: { finished: false },
    refused: { finished: false },
    'stop-unconfirmed': { finished: false },
  };
  window.jobCases = () => ({ agents: AGENT_ROW_STATES, shells: Object.keys(SHELL_CASES) });
  window.stateWords = () => ({ agents: agentStateWords(), shells: shellStateWords() });
  function Jobs({ width, agent, shell, round }) {
    const at = Date.now();
    const worker = (index, clock) => ({
      tag: 'job-' + index, sessionId: 'job-agent-' + index, ownerSessionId: SESSION, parentSessionId: SESSION,
      agent: 'worker', provider: 'anthropic', model: 'claude-opus', effort: 'medium', status: 'running',
      stage: 'streaming', startedAt: at - 60_000, turnStartedAt: clock ? at - clock : null,
    });
    const row = (node, state) => ({
      node: { agent: node, sessionId: node.sessionId, depth: 0, parentSessionId: SESSION, children: [] },
      state, waitingForTasks: false, finished: ['idle', 'done', 'cancelled'].includes(state),
    });
    const first = worker(0, agent.clock ? WIDEST_CLOCK : 0);
    const second = worker(1, 5_000);
    const agents = [row(first, agent.state), row(second, 'running')];
    const shells = [
      { key: 'job-shell-0-' + round, kind: 'shell', label: 'npm run watch-0', startedAt: at - (shell === 'quick' ? 30_000 : WIDEST_CLOCK),
        taskId: 'job-task-0-' + round, cwd: PROJECT, ...SHELL_CASES[shell] },
      { key: 'job-shell-1', kind: 'shell', label: 'npm run watch-1', startedAt: at - 5_000, taskId: 'job-task-1',
        cwd: PROJECT, finished: false },
    ];
    return <aside className="session-rail" style={{ width }}>
      <OpenKinds />
      <div className="session-rail-body">
        <div className="session-rail-content">
          <AgentsSection open onToggle={noop} sessionId={SESSION} agents={agents} poolRows={[lead, first, second]}
            busy shellKeys={null} />
          <ShellsSection open onToggle={noop} sessionId={SESSION} shells={shells} shellKeys={null} />
        </div>
      </div>
    </aside>;
  }
  let root = null;
  window.mountJobs = (props) => {
    installScrollbarMetrics();
    root ??= createRoot(document.getElementById('root'));
    flushSync(() => root.render(<Jobs {...props} />));
    window.matchGutter();
  };
  // The second agent's and shell's name column; what the first of each reads in its state column, and whether it is
  // read whole: not cut, right of the name column and inside its row.
  window.jobState = () => {
    const agentRow = (index) => document.querySelector('[data-category="agents"] [data-agent-tag="job-' + index + '"]');
    const shellRows = document.querySelectorAll('[data-category="shells"] .composer-island-row');
    const nameWidth = (row) => row.querySelector('.schedules-row-copy').getBoundingClientRect().width;
    const read = (row) => {
      const copy = row.querySelector('.schedules-row-copy').getBoundingClientRect();
      const word = row.querySelector('.agent-activity-elapsed');
      const box = word.getBoundingClientRect();
      const edge = row.getBoundingClientRect();
      return {
        text: word.textContent,
        whole:
          word.scrollWidth <= word.clientWidth + 0.5 &&
          box.left >= copy.right - 0.5 &&
          box.right <= edge.right + 0.5 &&
          box.top >= edge.top - 0.5 &&
          box.bottom <= edge.bottom + 0.5,
        shown: getComputedStyle(word).visibility === 'visible',
      };
    };
    // A shell row's buttons: shown at rest (nothing up to the row faded out); icon buttons in the row's fourth column,
    // right of its state on its line; a worded one on a line of its own under the command.
    const actions = (row) => {
      const cell = row.querySelector('.composer-island-row-actions');
      const buttons = [...cell.querySelectorAll('button')];
      const shown = buttons.every((button) => {
        if (getComputedStyle(button).visibility !== 'visible') return false;
        for (let at = button; at && at !== row.parentElement; at = at.parentElement) {
          if (getComputedStyle(at).opacity === '0') return false;
        }
        return true;
      });
      const a = cell.getBoundingClientRect();
      const word = row.querySelector('.agent-activity-elapsed').getBoundingClientRect();
      const command = row.querySelector('.schedules-row-copy').getBoundingClientRect();
      const edge = row.getBoundingClientRect();
      const worded = buttons.some((button) => !button.hasAttribute('data-icon'));
      return {
        labels: buttons.map((button) => button.getAttribute('aria-label')),
        shown: buttons.length > 0 && shown,
        worded,
        placed: worded
          ? a.top >= command.bottom - 0.5 && a.bottom <= edge.bottom + 0.5
          : a.left >= word.right - 0.5 && a.right <= edge.right + 0.5 && Math.abs((a.top + a.bottom) / 2 - (word.top + word.bottom) / 2) <= 2,
      };
    };
    return {
      agentName: nameWidth(agentRow(1)),
      shellName: nameWidth(shellRows[1]),
      agent: read(agentRow(0)),
      shell: read(shellRows[0]),
      shellColumns: getComputedStyle(shellRows[0].parentElement).gridTemplateColumns.split(' ').length,
      // The Shells head's left and right lines; each row's state dot and its last icon button's glyph.
      shellHead: (() => {
        const head = document.querySelector('[data-category="shells"] .session-rail-tg');
        return {
          left: head.querySelector('.session-rail-tt').getBoundingClientRect().left,
          right: head.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(head).paddingRight),
        };
      })(),
      shellDots: [...shellRows].map((row) => row.querySelector('.sidebar-resource-icon').getBoundingClientRect().left),
      shellGlyphEnds: [...shellRows].map((row) => {
        const last = row.querySelector('.composer-island-row-actions > :last-child');
        return last?.hasAttribute('data-icon') ? inkRight(last.querySelector('svg')) : null;
      }),
      shellActions: [...shellRows].map(actions),
    };
  };
  window.mountFixture = (width, folded, height) => {
    // The app measures the scrollbar's reserve at start; the lists pay their inset with it.
    installScrollbarMetrics();
    root ??= createRoot(document.getElementById('root'));
    root.render(<Rail width={width} folded={folded} height={height} />);
  };
  // The panel's column binds its position as SessionRailCard binds it.
  let unbindBody = null;
  window.bindBody = () => {
    unbindBody?.();
    unbindBody = bindScrollProgress(document.querySelector('.session-rail-body'));
  };
  // The Shells' row marks against the head's figures and the agents' state words; the soft, muted and full inks.
  window.shellMarks = () => {
    const list = document.querySelector('[data-category="shells"] .session-rail-bd');
    const ink = (value) => {
      const probe = document.createElement('span');
      probe.style.color = value;
      list.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    return {
      // The head's right line (where its end figures stand; Shells' own follow its name).
      figures: (() => {
        const head = document.querySelector('[data-category="shells"] .session-rail-tg');
        return head.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(head).paddingRight);
      })(),
      states: [...document.querySelectorAll('[data-category="agents"] .agent-pool-row > .agent-activity-status')].map(
        (state) => state.getBoundingClientRect().right
      ),
      scrolls: list.scrollHeight > list.clientHeight,
      gutter: list.offsetWidth - list.clientWidth - list.clientLeft * 2,
      // The list's visible box: past it, a press area is clipped.
      clip: list.getBoundingClientRect().left + list.clientLeft + list.clientWidth,
      soft: ink('var(--mx-text-soft)'),
      muted: ink('var(--mx-text-muted)'),
      text: ink('var(--mx-text)'),
      marks: [...list.querySelectorAll('.composer-island-row-actions > [data-icon]')].map((button) => {
        const svg = button.querySelector('svg').getBoundingClientRect();
        const box = button.getBoundingClientRect();
        return {
          icon: button.dataset.icon,
          last: button === button.parentElement.lastElementChild,
          size: [svg.width, svg.height],
          press: [box.width, box.height],
          right: box.right,
          ink: inkRight(button.querySelector('svg')),
          color: getComputedStyle(button).color,
        };
      }),
    };
  };
  // Each scroller of the panel: where it stands, and how opaque its mask leaves its top and bottom edges (1: whole);
  // a list's scrollbar gutter, kept whole by a mask layer of its own.
  window.fades = () =>
    [...document.querySelectorAll('.session-rail-body, .session-rail-bd[data-scroll]')].map((node) => {
      const style = getComputedStyle(node);
      const mask = style.maskImage;
      const gradient = mask.slice(mask.lastIndexOf('linear-gradient('));
      // Each stop's alpha and position; at an edge the stop drawn is the last one at 0 (top) or the first at 100%.
      const stops = [...gradient.matchAll(/rgba?\\(([^)]*)\\)\\s*([^,]*)/g)].map((match) => {
        const parts = match[1].split(/[\\s,/]+/).filter(Boolean);
        const at = match[2].trim();
        const unclosed = at.split(')').length > at.split('(').length;
        return { alpha: parts.length > 3 ? Number(parts[3]) : 1, at: unclosed ? at.slice(0, -1).trim() : at };
      });
      const atTop = stops.filter((stop) => stop.at === '0px' || stop.at === '0%');
      const atEnd = stops.filter((stop) => stop.at === '100%' || stop.at === 'calc(100% - 0px)');
      const alphas = [(atTop.at(-1) ?? stops[0])?.alpha, (atEnd[0] ?? stops.at(-1))?.alpha];
      return {
        scroller: node.closest('.session-rail-sec')?.dataset.category ?? 'panel',
        top: node.scrollTop,
        max: node.scrollHeight - node.clientHeight,
        bound: node.style.getPropertyValue('--mx-scroll-top') === String(node.scrollTop),
        topAlpha: alphas[0],
        bottomAlpha: alphas.at(-1),
        layers: mask.split('linear-gradient(').length - 1,
        gutter: node.offsetWidth - node.clientWidth - node.clientLeft * 2,
        gutterLayer: [style.maskSize.split(',')[0].trim(), style.maskPosition.split(',')[0].trim()],
        mask,
      };
    });
  // Each section's head: where its name starts against the rows' own left edge (the body's content box) and where
  // its figures end against their right edge, whether anything is drawn before the name, what else the head holds,
  // and the boxes along it from left to right.
  window.heads = () => [...document.querySelectorAll('.session-rail-sec')].map((section) => {
    const hd = section.querySelector(':scope > .session-rail-hd');
    const tg = hd.querySelector('.session-rail-tg');
    const box = (node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, height: rect.height };
    };
    // What is drawn: the name, the chevron, the figures as far as their text reaches, the count.
    const sm = tg.querySelector('.session-rail-sm');
    const smBox = box(sm);
    const smText = [...sm.children].map(box);
    const chevron = tg.querySelector(':scope > svg.session-rail-cv');
    const parts = [
      ['name', box(tg.querySelector('.session-rail-tt'))],
      ...(chevron ? [['chevron', box(chevron)]] : []),
      ...(smText.length ? [['figures', { left: Math.max(smBox.left, Math.min(...smText.map((r) => r.left))), right: Math.min(smBox.right, Math.max(...smText.map((r) => r.right))) }]] : []),
      ...[...tg.querySelectorAll(':scope > .session-rail-ct')].map((node) => ['count', box(node)]),
    ];
    const body = section.querySelector('.session-rail-bd');
    const bodyLeft = body ? body.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(body).paddingLeft) : null;
    const title = tg.querySelector('.session-rail-tt');
    const before = [...hd.querySelectorAll('svg')].filter(
      (svg) => svg.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING || svg.getBoundingClientRect().right <= title.getBoundingClientRect().left
    );
    const rect = section.getBoundingClientRect();
    const inset = Number.parseFloat(getComputedStyle(section).getPropertyValue('--session-rail-inset'));
    return {
      category: section.dataset.category,
      open: section.hasAttribute('data-open'),
      contentLeft: rect.left + inset,
      contentRight: rect.right - inset,
      bodyLeft,
      marks: before.length,
      // Anything in the head besides its fold control.
      extra: [...hd.children].filter((node) => node !== tg).map((node) => node.className),
      chevron: chevron ? { size: chevron.getBoundingClientRect().width, down: chevron.classList.contains('lucide-chevron-down') } : null,
      parts,
    };
  });

  // The lines the rows share: Info's first row (its mark, its text, its right line) against the rows of the
  // scrolling lists and Git's; each changed file's folder and name.
  window.railLines = () => {
    const box = (node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    };
    const info = document.querySelector('[data-category="info"] .session-rail-row:has(> .session-rail-ic):has(> .session-rail-cut)');
    const lineEnd = (row) => box(row).right - Number.parseFloat(getComputedStyle(row).paddingRight);
    const markBox = box(info.querySelector('.session-rail-ic'));
    const reference = {
      mark: markBox.left,
      markCentre: (markBox.left + markBox.right) / 2,
      text: box(info.querySelector('.session-rail-cut')).left,
      right: box(info).right,
      lineEnd: lineEnd(info),
    };
    const cut = (node) => node.scrollWidth > node.clientWidth + 0.5;
    // The Goal: its mark and text in the title row or the plain-text form; every other part of it (the state line, an
    // unfolded objective, a note, the stop confirmation) starts on its text's line.
    const goal = document.querySelector('[data-category="goal"] .session-rail-goal');
    const lead = goal.querySelector(':scope > :is(.session-rail-goal-title, .session-rail-goal-marked)');
    const start = (node) => {
      const style = getComputedStyle(node);
      return box(node).left + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft);
    };
    const goalLines = {
      mark: lead.firstElementChild.matches('svg.session-rail-ic') ? box(lead.firstElementChild) : null,
      text: box(lead.querySelector(':scope > span')).left,
      parts: [...goal.children].filter((node) => node !== lead).map((node) => [node.className, start(node)]),
    };
    // Where a mark's ink starts: its shapes' left edge (half a stroke past it), scaled from its view box into its box
    // as drawn (transform included).
    const inkLeft = (svg) => {
      const rect = svg.getBoundingClientRect();
      const view = svg.viewBox.baseVal;
      const scale = Math.min(rect.width / view.width, rect.height / view.height);
      const offset = (rect.width - view.width * scale) / 2;
      const shapes = [...svg.querySelectorAll('path, circle, rect, line, polyline, polygon, ellipse')];
      const left = Math.min(
        ...shapes.map((shape) => {
          const style = getComputedStyle(shape);
          const stroke = style.stroke === 'none' ? 0 : Number.parseFloat(style.strokeWidth) || 0;
          return shape.getBBox().x - stroke / 2;
        })
      );
      return rect.left + offset + (left - view.x) * scale;
    };
    // The agents list against To-do's: its "Remaining" line, its rows' state circle and text, the step in progress.
    const agentsList = document.querySelector('[data-category="agents"] .composer-island-agents');
    const style = (node) => getComputedStyle(node);
    const look = (node) => [style(node).fontSize, style(node).lineHeight, style(node).fontWeight, style(node).color];
    const todoLabel = document.querySelector('[data-category="todo"] .session-rail-gl');
    const todoRows = [...document.querySelectorAll('[data-category="todo"] .session-rail-group > .session-rail-row')];
    const todoRow = (status) => todoRows.find((row) => row.dataset.status === status);
    const rowLook = (row) => [box(row).bottom - box(row).top, style(row).borderRadius, style(row).backgroundColor, style(row).fontWeight];
    const todo = {
      label: [...look(todoLabel), box(todoLabel).bottom - box(todoLabel).top],
      glyph: inkLeft(todoRows[0].querySelector(':scope > svg')),
      glyphWidth: box(todoRows[0].querySelector(':scope > svg')).right - box(todoRows[0].querySelector(':scope > svg')).left,
      text: box(todoRows[0].querySelector('.session-rail-cut')).left,
      resting: rowLook(todoRow('pending')),
    };
    const agentRows = {
      folds: [...agentsList.querySelectorAll('.composer-island-agent-fold')].map((fold) => ({
        look: [...look(fold), box(fold).bottom - box(fold).top],
        first: fold.firstElementChild.className,
        name: box(fold.querySelector('.composer-island-agent-fold-name')).left,
      })),
      rows: [...agentsList.querySelectorAll('.agent-pool-row')].map((row) => {
        const ring = row.querySelector(':scope > .agent-row-ring > svg');
        const status = row.querySelector(':scope > .agent-activity-status');
        const steps = row.querySelector(':scope > .agent-row-steps');
        return {
          working: row.hasAttribute('data-working'),
          look: rowLook(row),
          ring: ring && { ink: inkLeft(ring), width: box(ring).right - box(ring).left },
          name: box(row.querySelector('.agent-pool-name')).left,
          steps: [box(steps).left, box(steps).right, steps.textContent],
          state: [box(status).left, box(status).right],
        };
      }),
    };
    const agents = {
      todo,
      ...agentRows,
      // Each fold and row in order: what it is, its top and its height.
      pitch: [...agentsList.children]
        .filter((child) => !child.matches('.session-rail-state-col'))
        .map((child) => {
          const node = child.firstElementChild;
          return [child.matches('.composer-island-agent-group') ? 'fold' : 'row', box(node).top, box(node).bottom - box(node).top];
        }),
      // Kind lines: how far the count, the line's last part, ends from the line's own right edge.
      foldEnds: [...agentsList.querySelectorAll('.composer-island-agent-fold')].map((fold) => {
        const last = fold.lastElementChild;
        return [
          last.className,
          box(fold).right - Number.parseFloat(getComputedStyle(fold).paddingRight) - box(last).right,
        ];
      }),
    };
    return {
      reference,
      // The heads' left line: a section's name.
      headLeft: box(document.querySelector('[data-category="info"] .session-rail-tt')).left,
      ink: {
        info: inkLeft(info.querySelector('.session-rail-ic')),
        goal: goalLines.mark ? inkLeft(lead.firstElementChild) : null,
        files: [...document.querySelectorAll('[data-category="changes"] .session-rail-row > svg.session-rail-ic')].map(inkLeft),
        git: [...document.querySelectorAll('[data-category="git"] .composer-island-git-label > svg')].map(inkLeft),
      },
      agents,
      goal: goalLines,
      scrolled: [...document.querySelectorAll('.session-rail-bd[data-scroll] > .session-rail-row')].map((row) => ({
        category: row.closest('.session-rail-sec').dataset.category,
        lineEnd: lineEnd(row),
      })),
      git: [...document.querySelectorAll('[data-category="git"] .composer-island-git-row')].map((row) => ({
        action: row.dataset.action,
        mark: box(row.querySelector('.composer-island-git-label > svg')).left,
        text: box(row.querySelector('.composer-island-git-label > span')).left,
        picked: row.getAttribute('aria-checked') === 'true',
        check: row.querySelector('.session-rail-git-on') && box(row.querySelector('.session-rail-git-on')).right,
        rule: getComputedStyle(row).borderTopWidth,
      })),
      gitRun: box(document.querySelector('[data-category="git"] .session-rail-hd > .composer-island-git-run')).right,
      paths: [...document.querySelectorAll('[data-category="changes"] .session-rail-row')].map((row) => {
        const dir = row.querySelector('.turn-review-files-dir');
        const name = row.querySelector('.turn-review-files-name');
        const icon = row.querySelector(':scope > svg.session-rail-ic.lucide-file');
        return {
          path: row.title,
          icon: icon && { first: row.firstElementChild === icon, width: box(icon).right - box(icon).left },
          text: box(dir ?? name).left,
          dir: dir?.textContent ?? '',
          dirCut: dir ? cut(dir) : false,
          nameCut: cut(name),
        };
      }),
    };
  };
  // Headless, the metrics probe reads no reserve while a list's stable gutter takes its track; the app publishes
  // what the engine reserves, so the fixture publishes a scrolling list's own.
  window.matchGutter = () => {
    const list = document.querySelector('.session-rail-bd[data-scroll]');
    const reserve = list.offsetWidth - list.clientWidth - list.clientLeft * 2;
    document.documentElement.style.setProperty('--mx-scrollbar-gutter', reserve + 'px');
    return reserve;
  };
  // Info's two popups: the Branch row's tab and the Project select's listbox, each opened from its row and measured
  // against it, the Info section's height before and while the tab is open, and whether each closes again.
  window.infoPopups = async () => {
    const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const box = (node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    };
    const info = document.querySelector('[data-category="info"]');
    const heightBefore = info.getBoundingClientRect().height;
    const branchRow = info.querySelector('button.session-rail-row:has(> svg.lucide-git-branch)');
    branchRow.click();
    let host = null;
    for (let tries = 0; tries < 60 && !(host && getComputedStyle(host).visibility === 'visible'); tries += 1) {
      await frames();
      host = document.querySelector('.branch-tab-host');
    }
    const tab = host && {
      inBody: host.parentElement === document.body,
      position: getComputedStyle(host).position,
      panel: Boolean(host.querySelector(':scope > section.composer-island-panel.composer-island-branch-panel')),
      box: box(host),
      row: box(branchRow),
      viewport: { right: innerWidth, bottom: innerHeight },
      heightWhileOpen: info.getBoundingClientRect().height,
      head: Boolean(host.querySelector('.composer-island-phead, .composer-island-close')),
      // Its foot: every button's line, and Clean up drawn as its broom alone.
      foot: (() => {
        const foot = host.querySelector('.branch-menu-foot');
        const prune = foot?.querySelector('[data-kind="prune"]');
        return foot && {
          lines: new Set([...foot.querySelectorAll('button')].map((button) => Math.round(button.getBoundingClientRect().top))).size,
          prune: prune && {
            width: prune.getBoundingClientRect().width,
            text: prune.innerText.trim(),
            name: prune.getAttribute('aria-label') || prune.title,
          },
        };
      })(),
    };
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await frames();
    const tabClosed = !document.querySelector('.branch-tab-host');
    const select = info.querySelector('.session-rail-select');
    const trigger = select.querySelector('button.mx-select-trigger');
    trigger.click();
    await frames();
    const listbox = document.querySelector('.mx-menu[role="listbox"]');
    const listed = listbox && { inBody: listbox.parentElement === document.body, box: box(listbox) };
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await frames();
    return {
      heightBefore,
      tab,
      tabClosed,
      select: {
        trigger: box(trigger),
        mark: box(trigger.querySelector('.mx-select-leading svg')),
        value: box(trigger.querySelector('.mx-select-value')),
        listed,
        closed: !document.querySelector('.mx-menu[role="listbox"]'),
      },
    };
  };

  // The Branch row's tab opened once, closed, its read forgotten (as a new window has none) and opened again with the
  // read held: the tab's height each frame from the loading line through the rows landing.
  window.branchTabLoad = async (width) => {
    const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const branchRow = () =>
      document.querySelector('[data-category="info"] button.session-rail-row:has(> svg.lucide-git-branch)');
    clearBranchMenuCache();
    branchRow().click();
    for (let tries = 0; tries < 60 && !document.querySelector('.branch-tab-host [data-branch]'); tries += 1) await frames();
    await frames();
    const first = document.querySelector('.branch-tab-host').getBoundingClientRect().height;
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await frames();
    // A new panel with nothing read.
    clearBranchMenuReads();
    flushSync(() => root.render(null));
    flushSync(() => root.render(<Rail width={width} />));
    for (let tries = 0; tries < 60 && !branchRow(); tries += 1) await frames();
    window.branchGate = Promise.withResolvers();
    const row = branchRow();
    row.click();
    const heights = [];
    let host = null;
    for (let tries = 0; tries < 60 && !host?.querySelector('[data-loading]'); tries += 1) {
      await frames();
      host = document.querySelector('.branch-tab-host');
    }
    const loading = Boolean(host?.querySelector('[data-loading]'));
    for (let i = 0; i < 4; i += 1) {
      heights.push(['loading', host.getBoundingClientRect().height]);
      await frames();
    }
    window.branchGate.resolve();
    window.branchGate = null;
    for (let i = 0; i < 12; i += 1) {
      await frames();
      heights.push([host.querySelector('[data-branch]') ? 'rows' : 'loading', host.getBoundingClientRect().height]);
    }
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await frames();
    return { loading, heights, first };
  };
  // Each menu an Info row opens (project, branch, model, workflow, delegation): its row's box and its own, open.
  window.rowMenus = async () => {
    const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const box = (node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    };
    const info = document.querySelector('[data-category="info"]');
    const cases = [
      ['project', '.session-rail-select > button.mx-select-trigger', '.mx-menu[role="listbox"]'],
      ['branch', 'button.session-rail-row:has(> svg.lucide-git-branch)', '.branch-tab-host'],
      ['model', 'button.session-rail-row:has(> svg.lucide-sparkles)', '.route-sheet'],
      ['workflow', 'button.session-rail-pick[title="Workflow"]', '.composer-route-choices'],
      ['delegation', 'button.session-rail-pick[title="Delegation"]', '.composer-route-choices'],
    ];
    const found = [];
    for (const [name, rowSelector, menuSelector] of cases) {
      const row = info.querySelector(rowSelector);
      if (!row) {
        found.push({ name, row: null });
        continue;
      }
      row.click();
      let menu = null;
      for (let tries = 0; tries < 60 && !(menu && getComputedStyle(menu).visibility === 'visible'); tries += 1) {
        await frames();
        menu = document.querySelector(menuSelector);
      }
      // Measured where it settles, past its opening motion.
      if (menu) await Promise.all(menu.getAnimations({ subtree: true }).map((motion) => motion.finished.catch(() => {})));
      found.push({ name, row: box(row), menu: menu && box(menu), viewport: innerWidth });
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      await frames();
      if (document.querySelector(menuSelector)) row.click();
      await frames();
    }
    return found;
  };

  // Every row, head and foot: nothing past its own box, and neither the panel
  // nor a list inside a sheet scrolls sideways.
  window.overflows = () => {
    const out = [];
    for (const scroller of document.querySelectorAll('.session-rail-body, .session-rail-bd')) {
      if (scroller.scrollWidth > scroller.clientWidth) {
        const category = scroller.closest('.session-rail-sec')?.dataset.category ?? 'panel';
        const edge = scroller.getBoundingClientRect().left + scroller.clientLeft + scroller.clientWidth;
        const past = [...scroller.querySelectorAll('*')].filter((node) => node.getBoundingClientRect().right > edge + 0.5);
        const widest = past.map((node) => node.className?.baseVal ?? node.className).slice(0, 3).join(' | ');
        out.push('scrolls sideways: ' + category + ' ' + scroller.scrollWidth + ' in ' + scroller.clientWidth + ': ' + widest);
      }
    }
    const rows = document.querySelectorAll(
      '.session-rail-row, .session-rail-hd, .session-rail-ft, .session-rail-goal-line, .session-rail .composer-island-row, ' +
        '.session-rail-gh, .session-rail .agent-pool-row'
    );
    // A head and a foot each hold one line, a shell row two (a worded button under its command), an agent row one.
    const tallest = (row) =>
      row.matches('.session-rail-hd, .session-rail-ft') ? 47 : row.matches('.composer-island-row') ? 60 : 37;
    // A shell row's last icon button reaches past the row by its negative margin, so its glyph ends on the head's
    // right line: that much is its row's own.
    const hang = (row) => {
      const icon = row.querySelector(':scope > .composer-island-row-actions > [data-icon]:last-child');
      return icon ? Math.max(0, -Number.parseFloat(getComputedStyle(icon).marginRight)) : 0;
    };
    for (const row of rows) {
      const box = row.getBoundingClientRect();
      const reach = row.matches('.composer-island-row') ? hang(row) : 0;
      if (row.scrollWidth > row.clientWidth + 1 + reach) out.push('scrolls: ' + row.className + ' ' + row.textContent.slice(0, 40));
      for (const child of row.querySelectorAll('*')) {
        const style = getComputedStyle(child);
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
        if (child.closest('.session-rail-act') && getComputedStyle(child.closest('.session-rail-act')).opacity === '0') continue;
        // Inside a box that clips it (a name ending in an ellipsis), that box is what is measured.
        let clipped = false;
        for (let node = child.parentElement; node && node !== row; node = node.parentElement) {
          if (getComputedStyle(node).overflowX !== 'visible') clipped = true;
        }
        if (clipped) continue;
        const rect = child.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const allowed = child.closest('.composer-island-row-actions > [data-icon]:last-child') ? reach : 0;
        // A mark drawn left of its column by its own shift (its ink on the heads' left line): that much is its own.
        let drawnLeft = 0;
        for (let node = child; node && node !== row; node = node.parentElement) {
          const transform = getComputedStyle(node).transform;
          if (transform !== 'none') drawnLeft += Math.max(0, -new DOMMatrix(transform).m41);
        }
        if (rect.right > box.right + 1 + allowed || rect.left < box.left - 1 - drawnLeft) {
          out.push('past its row: ' + (child.className?.baseVal ?? child.className) + ' in ' + row.textContent.slice(0, 40));
        }
        if (rect.bottom > box.bottom + 1 || rect.top < box.top - 1) {
          out.push('above or below its row: ' + (child.className?.baseVal ?? child.className) + ' in ' + row.textContent.slice(0, 40));
        }
      }
      if (box.height > tallest(row)) out.push('taller than a row: ' + box.height + ' ' + row.textContent.slice(0, 40));
    }
    return { count: rows.length, out };
  };
`;

/** A page with the fixture's bundle and the app's styles loaded: one for the file, each case mounting its own fixture
 *  in it. */
let fixture = null;
function openFixture() {
  fixture ??= loadFixture();
  return fixture;
}
after(async () => {
  if (fixture) await (await fixture).browser.close();
});

async function loadFixture() {
  const [bundle, styles] = await Promise.all([
    build({
      stdin: { resolveDir, loader: 'tsx', contents: HARNESS },
      outfile: 'session-rail-overflow.js',
      bundle: true,
      write: false,
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': '"http://localhost/renderer/"' },
      loader,
      plugins: [
        {
          name: 'worker-stub',
          setup(builder) {
            builder.onResolve({ filter: /\?worker$/ }, (args) => ({ path: args.path, namespace: 'worker-stub' }));
            builder.onLoad({ filter: /.*/, namespace: 'worker-stub' }, () => ({
              contents: 'export default class {};',
              loader: 'js',
            }));
          },
        },
      ],
    }),
    build({
      stdin: {
        resolveDir,
        loader: 'css',
        contents:
          '@import "./font-faces.css"; @import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css";',
      },
      outfile: 'session-rail-overflow.css',
      bundle: true,
      write: false,
      loader,
    }),
  ]);
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.stack.split('\n').slice(0, 4).join(' <- ')));
  await page.setViewport({ width: 1200, height: 900 });
  await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');
  // The panel's own CSS is a chunk of its own: the desktop layers load after it here, the order in which a rule of
  // theirs on a class the panel borrows would win a tie.
  const css = bundle.outputFiles.find((file) => file.path.endsWith('.css'));
  if (css) await page.addStyleTag({ content: css.text });
  await page.addStyleTag({ content: styles.outputFiles[0].text });
  // The route picker's shared terminal figures read process at load; the app's bundler gives them one.
  await page.addScriptTag({ content: 'window.process = { env: {}, platform: "win32", argv: [], versions: {} };' });
  await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });
  assert.deepEqual(errors, [], 'the fixture loads');
  return { browser, page, errors };
}

test('the panel at 400px and at its 300px minimum with a busy session: nothing overflows its row', async () => {
  const { page, errors } = await openFixture();
  for (const width of [400, SESSION_RAIL_MIN_WIDTH]) {
    await page.evaluate((next) => window.mountFixture(next), width);
    await page.waitForSelector('[data-category="changes"] .session-rail-row');
    await page.waitForSelector('[data-category="git"] .composer-island-git-row');
    assert.ok((await page.evaluate(() => window.matchGutter())) > 0, 'a scrolling list reserves its gutter');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const { count, out } = await page.evaluate(() => window.overflows());
    assert.deepEqual(errors, []);
    const categories = await page.evaluate(() =>
      [...document.querySelectorAll('.session-rail-sec')].map((section) => section.dataset.category)
    );
    assert.deepEqual(categories, ['info', 'context', 'goal', 'todo', 'agents', 'shells', 'changes', 'git']);
    const rows = await page.evaluate(() => ({
      agents: document.querySelectorAll('[data-category="agents"] .agent-pool-row').length,
      shells: document.querySelectorAll('[data-category="shells"] .composer-island-row').length,
    }));
    assert.deepEqual(rows, { agents: 14, shells: 8 }, `every agent and shell listed at ${width}px`);
    assert.ok(count > 30, `rows measured at ${width}px: ${count}`);
    assert.equal(out.length, 0, `at ${width}px:\n${out.join('\n')}`);

    // The Goal's title unfolded, so its objective paragraph is measured with the rest of it.
    await page.evaluate(async () => {
      if (!document.querySelector('[data-category="goal"] .session-rail-goal-text')) {
        document.querySelector('[data-category="goal"] .session-rail-goal-title').click();
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const lines = await page.evaluate(() => window.railLines());
    const near = (actual, expected, message) =>
      assert.ok(Math.abs(actual - expected) <= 0.5, `${width}px, ${message}: ${actual} ≠ ${expected}`);
    // The Goal's mark (a 14px glyph) in the rows' 16px mark column, its text on their text line, and everything under
    // it starting on that line.
    assert.ok(lines.goal.mark, `${width}px: the goal's mark leads its text`);
    near(lines.goal.mark.right - lines.goal.mark.left, 16, "the goal's mark column width");
    near(lines.goal.mark.bottom - lines.goal.mark.top, 14, "the goal's glyph");
    // Every mark's ink starts on the heads' left line (a section's name), within a pixel: Info's, the Goal's flag,
    // a changed file's and Git's.
    // Every miss is listed together, after the rows' own checks.
    const inkOff = [];
    const onLine = (left, what) => {
      if (Math.abs(left - lines.headLeft) > 1)
        inkOff.push(`${width}px, ${what}: ink at ${left.toFixed(2)} ≠ ${lines.headLeft}`);
    };
    onLine(lines.ink.info, "Info's mark");
    onLine(lines.ink.goal, "the Goal's flag");
    const { agents } = lines;
    assert.ok(lines.ink.files.length > 0 && lines.ink.git.length > 0 && agents.folds.length > 0);
    for (const left of lines.ink.files) onLine(left, 'a file mark');
    for (const left of lines.ink.git) onLine(left, 'a Git mark');
    // The Agents list is To-do's. A kind's line is its "Remaining" line (tier, ink, height): no mark before its
    // name, which starts on the heads' left line.
    for (const [index, fold] of agents.folds.entries()) {
      assert.deepEqual(fold.look, agents.todo.label, `${width}px, kind ${index}: To-do's "Remaining" line`);
      assert.equal(fold.first, 'composer-island-agent-fold-name', `${width}px, kind ${index}: its name leads the line`);
      near(fold.name, lines.headLeft, `kind ${index}: its name on the heads' left line`);
    }
    for (const [index, [last, gap]] of agents.foldEnds.entries()) {
      assert.equal(last, 'composer-island-agent-fold-count', `${width}px, kind ${index}: its count ends the line`);
      near(gap, 0, `kind ${index}: its count on the line's right edge`);
    }
    // A row is a to-do row: its ring where the to-do's state circle stands, at its size, with a step list or none;
    // its name on the to-do's text line; its height, radius, wash and weight the resting to-do's (a wash is a row
    // pointed at, never a state), at work or finished.
    assert.ok(
      agents.rows.every((row) => row.ring),
      'a ring on every row'
    );
    for (const [index, row] of agents.rows.entries()) {
      const what = `agent ${index}${row.working ? ' (at work)' : ''}`;
      if (row.ring) {
        near(row.ring.width, agents.todo.glyphWidth, `${what}: its ring's size`);
        if (Math.abs(row.ring.ink - agents.todo.glyph) > 1)
          inkOff.push(`${width}px, ${what}: its ring at ${row.ring.ink}`);
      }
      near(row.name, agents.todo.text, `${what}: its name on the to-do's text line`);
      assert.deepEqual(row.look, agents.todo.resting, `${width}px, ${what}: the to-do's row`);
    }
    // The step figures and the states each end on one right line down the list, the figures before the states.
    const stepsRight = agents.rows[0].steps[1];
    const stateRight = agents.rows[0].state[1];
    for (const [index, row] of agents.rows.entries()) {
      near(row.steps[1], stepsRight, `agent ${index}: its step figure's right line`);
      near(row.state[1], stateRight, `agent ${index}: its state's right line`);
      assert.ok(row.steps[1] <= row.state[0] + 0.5, `${width}px, agent ${index}: its figure before its state`);
    }
    assert.ok(agents.rows.some((row) => row.steps[2] === '12/99') && agents.rows.some((row) => row.steps[2] === ''));
    // One rhythm: a kind's line To-do's 28px label, each row a panel row (32px), nothing between them; a kind after
    // rows 8px lower.
    const { pitch } = agents;
    assert.ok(pitch.length > 1 && pitch[0][0] === 'fold', JSON.stringify(pitch));
    for (const [index, [kind, top, height]] of pitch.entries()) {
      near(height, kind === 'fold' ? 28 : 32, `${kind} ${index}: its height`);
      if (index === 0) continue;
      const [aboveKind, aboveTop, aboveHeight] = pitch[index - 1];
      near(top, aboveTop + aboveHeight + (kind === 'fold' && aboveKind === 'row' ? 8 : 0), `${kind} ${index}: its top`);
    }
    assert.deepEqual([...new Set(inkOff)], [], 'marks with their ink on the heads’ left line');
    near(lines.goal.text, lines.reference.text, "the goal's text");
    assert.ok(lines.goal.parts.some(([name]) => name.includes('session-rail-goal-line')));
    assert.ok(
      lines.goal.parts.some(([name]) => name.includes('session-rail-goal-text')),
      'the unfolded objective'
    );
    for (const [name, left] of lines.goal.parts) near(left, lines.reference.text, `the goal's ${name}`);
    // A scrolling list's rows end on the right line every other row ends on.
    assert.deepEqual([...new Set(lines.scrolled.map((row) => row.category))], ['changes']);
    for (const row of lines.scrolled) near(row.lineEnd, lines.reference.lineEnd, `a ${row.category} row's right line`);
    // Git's rows: the rows' mark column and their text line, the check of the one picked on their right line, no rule
    // between them; Run at the head's end, its border on the rows' wash edge (8px past the right line).
    assert.deepEqual(
      lines.git.map((row) => row.action),
      ['pr', 'commit-push', 'commit']
    );
    for (const row of lines.git) {
      // Commit · push's narrow arrow is drawn a pixel left of the column, so its ink meets the heads' left line.
      near(row.mark, lines.reference.mark - (row.action === 'commit-push' ? 1 : 0), `Git ${row.action}: its mark`);
      near(row.text, lines.reference.text, `Git ${row.action}: its label`);
      assert.equal(row.picked, row.action === 'commit', `Git ${row.action}: Commit is the pick until another is`);
      if (row.picked) near(row.check, lines.reference.lineEnd, `Git ${row.action}: its check`);
      else assert.equal(row.check, null, `Git ${row.action}: no check`);
      assert.equal(row.rule, '0px', `Git ${row.action}: no rule above it`);
    }
    near(lines.gitRun, lines.reference.lineEnd + 8, "Git's Run");
    // A changed file's folder gives up whole leading segments ("…/") before the name is cut, and is never cut itself
    // while the name stands whole.
    for (const path of lines.paths) {
      const dir = path.path.slice(0, path.path.lastIndexOf('/') + 1);
      const what = `${width}px, ${path.path}: "${path.dir}"`;
      // Its file mark first, 16px wide (its ink on the heads' left line, checked above), the path on the rows' text line.
      assert.ok(path.icon?.first, `${what}: the file mark leads the row`);
      near(path.icon.width, 16, `${path.path}: its mark's column`);
      near(path.text, lines.reference.text, `${path.path}: its path`);
      if (path.dir !== dir) {
        assert.ok(path.dir.startsWith('…/') && dir.endsWith(path.dir.slice(1)), `${what}: whole trailing segments`);
        assert.ok(path.dir === '…/' || path.dir.slice(2).split('/').length < dir.split('/').length, what);
      }
      if (!path.nameCut) assert.equal(path.dirCut, false, `${what}: the folder is not cut while the name is whole`);
      else assert.equal(path.dir, '…/', `${what}: the name is cut only once the folder is gone`);
    }
    const byPath = Object.fromEntries(lines.paths.map((path) => [path.path, path]));
    assert.equal(byPath['src/app/main.ts'].dir, 'src/app/', `${width}px: a folder that fits stands whole`);
    const nested = lines.paths.find((path) => path.path.endsWith('/session-rail/index.tsx'));
    assert.ok(
      nested.dir.startsWith('…/') && nested.dir !== '…/' && !nested.nameCut,
      `${width}px: "${nested.dir}" before a whole name`
    );

    // Info's popups. The Branch row's tab: in the body, fixed, under its row and as wide as it, inside the window,
    // headless, its foot on one line, and the section keeps its height while it is open; a press outside closes it.
    const popups = await page.evaluate(() => window.infoPopups());
    const { tab } = popups;
    assert.ok(tab, `${width}px: the tab opens`);
    assert.deepEqual([tab.inBody, tab.position, tab.panel], [true, 'fixed', true], `${width}px: the tab's host`);
    assert.ok(tab.box.top >= tab.row.bottom, `${width}px: under its row: ${tab.box.top} < ${tab.row.bottom}`);
    near(tab.box.left, tab.row.left, 'the tab as wide as its row: its left edge');
    near(tab.box.right, tab.row.right, 'the tab as wide as its row: its right edge');
    assert.equal(tab.head, false, `${width}px: no head or close button`);
    assert.ok(tab.foot?.prune, `${width}px: Clean up in the tab's foot`);
    assert.ok(
      tab.foot.prune.width <= 28.5 && tab.foot.prune.text === '' && tab.foot.prune.name,
      `${width}px: Clean up is its broom alone, named: ${JSON.stringify(tab.foot.prune)}`
    );
    assert.equal(tab.foot.lines, 1, `${width}px: the tab's foot on one line`);
    assert.ok(
      tab.box.left >= 0 && tab.box.right <= tab.viewport.right && tab.box.bottom <= tab.viewport.bottom,
      `${width}px: inside the window: ${JSON.stringify(tab.box)}`
    );
    near(tab.heightWhileOpen, popups.heightBefore, "Info's height while the tab is open");
    assert.ok(popups.tabClosed, `${width}px: a press outside closes the tab`);
    // The Project select: a panel row (its folder in the rows' mark column, its value on their text line), its
    // listbox in the body below it, closed by Escape.
    const { select } = popups;
    // A 14px folder centred in the rows' 16px mark column.
    near((select.mark.left + select.mark.right) / 2, lines.reference.markCentre, "the Project select's folder mark");
    near(select.value.left, lines.reference.text, "the Project select's value");
    near(select.trigger.right, lines.reference.right, "the Project select's right edge");
    assert.ok(select.listed?.inBody, `${width}px: the project listbox opens in the body`);
    assert.ok(select.listed.box.top >= select.trigger.bottom, `${width}px: below the row`);
    assert.ok(select.closed, `${width}px: Escape closes the listbox`);
  }
});

test("Info's usage line stands worded on one line at the panel's default (least) width, in icons only where the row is too narrow for its worded form; Context's figures", async () => {
  const { page, errors } = await openFixture();
  const formAt = async (width, readout) => {
    await page.evaluate((next, usage) => window.mountQuiet(next, usage), width, readout);
    await page.waitForSelector('[data-category="context"] .session-rail-part');
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return page.evaluate(() => window.usageLine());
  };
  const whole = (at, form) => {
    assert.ok(
      form.shown && form.oneLine && form.whole && form.afterMark,
      `${at}: one whole line after the mark: ${JSON.stringify(form)}`
    );
    assert.equal(form.fontSize, form.supporting, `${at}: the line at the supporting size`);
  };

  // The rule: worded exactly when the worded form (data-full-width) fits the row's room, icons otherwise.
  const byRule = (at, form) => {
    whole(at, form);
    if (Math.abs(form.fullWidth - form.room) < 1) return;
    const fits = form.fullWidth <= form.room;
    assert.ok(
      fits ? form.worded : form.icons,
      `${at}: ${fits ? 'worded' : 'icons'} (asks ${form.fullWidth} of ${form.room}): ${JSON.stringify(form)}`
    );
  };

  // A short line, "900 토큰 · 83 tok/s · 캐시 히트 66.7%": in words at the least width.
  await page.evaluate(() => window.setLanguage('ko'));
  const korean = await formAt(SESSION_RAIL_DEFAULT_WIDTH, {
    input: 300,
    cacheRead: 600,
    cacheWrite: 0,
    output: 0,
    speedOutputTokens: 83_000,
    speedMs: 1_000_000,
  });
  await page.evaluate(() => window.setLanguage('en'));
  byRule('ko at the default width', korean);
  assert.ok(korean.worded, `worded at the default width: ${JSON.stringify(korean)}`);
  assert.match(korean.text, /900 토큰.*tok\/s.*캐시 히트 66\.7%/);
  // The panel's readout is spaced by a 4px gap: each `·` stands gap − 3px after its item.
  assert.equal(korean.gap, '4px');
  assert.ok(korean.sepMargins.length > 0);
  for (const margin of korean.sepMargins) assert.equal(margin, '1px');

  // A longer line ("123.4M tokens · 83 tok/s · Cache hit 100.0%") at the least width and the widest.
  const forms = [];
  for (const width of [SESSION_RAIL_MIN_WIDTH, SESSION_RAIL_MAX_WIDTH]) {
    const form = await formAt(width);
    byRule(`${width}px`, form);
    forms.push(form);
  }
  assert.ok(
    forms.some((form) => form.worded),
    'the longer line is worded where it fits'
  );
  assert.match(forms.find((form) => form.worded).text, /123\.4M.*tok\/s.*100\.0%/);

  // Context: the head's percent in the text ink while the gauge has no tone; a kind holding nothing muted; Free
  // space 6px below the rows above it.
  const context = await page.evaluate(() => window.contextFigures());
  assert.equal(context.tone, null);
  assert.equal(context.percent, context.ink, 'the percent in the text ink');
  assert.notEqual(context.ink, context.muted);
  const zero = context.rows.filter((row) => row.zero);
  assert.deepEqual(
    zero.map((row) => row.key),
    ['mcp']
  );
  for (const row of context.rows) {
    assert.equal(row.color, row.zero ? context.muted : context.ink, `${row.key}: its figure's ink`);
  }
  assert.ok(Math.abs(context.freeGap - 6) <= 0.5, `Free space stands 6px apart: ${context.freeGap}`);
  assert.deepEqual(errors, []);
});

test("the Agents' name column keeps one width in every state; the Shells' state column holds the clock under an hour and widens only for what it shows; every state read whole, at the panel's narrowest", async () => {
  const { page, errors } = await openFixture();
  // Every state an agent row can be in (agent-row-meta.ts), with its clock where it has one, and every shell case.
  const { agents, shells } = await page.evaluate(() => window.jobCases());
  const words = await page.evaluate(() => window.stateWords());
  const agentCases = [
    ...agents.map((state) => ({ state, clock: false })),
    { state: 'running', clock: true },
    { state: 'waiting', clock: true },
  ];
  const asked = new Set(['stopping', 'refused', 'stop-unconfirmed']);
  for (const width of [SESSION_RAIL_MIN_WIDTH]) {
    const seen = [];
    for (let round = 0; round < Math.max(agentCases.length, shells.length); round += 1) {
      const agent = agentCases[round % agentCases.length];
      const shell = shells[round % shells.length];
      await page.evaluate((props) => window.mountJobs(props), { width, agent, shell, round: `${width}-${round}` });
      await page.waitForSelector(`[data-category="shells"] .composer-island-row`);
      if (asked.has(shell)) {
        await page.evaluate(async (kind) => {
          window.stopAnswer = () =>
            kind === 'stopping'
              ? new Promise(() => {})
              : Promise.resolve(kind === 'refused' ? { stopped: false } : { unconfirmed: true });
          const stop = document.querySelector('[data-category="shells"] button[aria-label="Stop: npm run watch-0"]');
          if (!stop)
            throw new Error(
              `no Stop for ${kind}: ${document.querySelector('[data-category="shells"] .composer-island-row-actions').outerHTML}`
            );
          stop.click();
          await new Promise((resolve) => setTimeout(resolve, 50));
        }, shell);
      }
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      seen.push({ agentCase: agent, shellCase: shell, ...(await page.evaluate(() => window.jobState())) });
    }
    assert.deepEqual(errors, []);
    const name = (entry) =>
      `${width}px, agent ${entry.agentCase.state}${entry.agentCase.clock ? ' (clock)' : ''}, shell ${entry.shellCase}`;
    for (const entry of seen) {
      assert.ok(
        Math.abs(entry.agentName - seen[0].agentName) <= 0.5,
        `${name(entry)}: agent names ${entry.agentName} ≠ ${seen[0].agentName}`
      );
      if (entry.agent.text) assert.ok(entry.agent.whole, `${name(entry)}: "${entry.agent.text}" read whole`);
      assert.ok(entry.shell.whole && entry.shell.shown, `${name(entry)}: "${entry.shell.text}" read whole`);
      // A row's Stop or Dismiss in a fourth column, shown at rest; a worded button on its own line under the command.
      assert.equal(entry.shellColumns, 4, `${name(entry)}: the shells' columns`);
      // Each state dot on the head's left line; the last icon button's ink ends on the head's right line.
      for (const [index, dot] of entry.shellDots.entries()) {
        assert.ok(
          Math.abs(dot - entry.shellHead.left) <= 0.5,
          `${name(entry)}, shell ${index}: its dot ${dot} ≠ ${entry.shellHead.left}`
        );
        const end = entry.shellGlyphEnds[index];
        if (end !== null) {
          assert.ok(
            Math.abs(end - entry.shellHead.right) <= 1,
            `${name(entry)}, shell ${index}: its glyph ends ${end} ≠ ${entry.shellHead.right}`
          );
        }
      }
      for (const [index, action] of entry.shellActions.entries()) {
        const what = `${name(entry)}, shell ${index} [${action.labels}]`;
        assert.ok(action.shown, `${what}: shown at rest`);
        assert.ok(action.placed, `${what}: ${action.worded ? 'under the command' : 'in its column, beside the state'}`);
      }
    }
    // Shells: with only runs under an hour the state column holds that clock alone, so the commands keep the room; a
    // longer run or a long end state takes the room it reads, and only while it is shown.
    const command = (shellCase) => seen.find((entry) => entry.shellCase === shellCase).shellName;
    for (const wider of ['running', 'held']) {
      assert.ok(
        command('quick') > command(wider) + 0.5,
        `${width}px: commands beside short clocks ${command('quick')} > beside ${wider} ${command(wider)}`
      );
    }
    // Every word the code can put in either column was shown.
    const shown = (side) => new Set(seen.map((entry) => entry[side].text));
    assert.deepEqual(
      words.agents.filter((word) => !shown('agent').has(word)),
      [],
      `${width}px: agent states not shown`
    );
    assert.deepEqual(
      words.shells.filter((word) => !shown('shell').has(word)),
      [],
      `${width}px: shell states not shown`
    );
  }
});

test("an agent row is one line at the panel's narrowest in every language, its total in its tooltip; a kind's fold moves nothing sideways", async () => {
  const { page, errors } = await openFixture();
  const found = [];
  for (const language of ['en', 'ko', 'de', 'ru', 'es', 'fr', 'it', 'ja', 'pt-BR', 'vi', 'zh-CN', 'zh-TW']) {
    await page.evaluate((next) => window.setLanguage(next), language);
    for (const state of ['running', 'idle']) {
      await page.evaluate((props) => window.mountJobs(props), {
        width: SESSION_RAIL_MIN_WIDTH,
        agent: { state, clock: state === 'running' },
        shell: 'running',
        round: `${language}-${state}`,
      });
      await page.waitForSelector('[data-category="agents"] .agent-pool-row[title*="999.9M"]');
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const measured = await page.evaluate(async () => {
        const list = document.querySelector('[data-category="agents"] .composer-island-agents');
        const box = (node) => node.getBoundingClientRect();
        // Where the kind's name, the names and the state column stand.
        const columns = () => ({
          fold: box(list.querySelector('.composer-island-agent-fold-name')).left,
          state: [
            box(list.querySelector('.session-rail-state-col')).left,
            box(list.querySelector('.session-rail-state-col')).right,
          ],
        });
        const rows = [...list.querySelectorAll('.agent-pool-row')].map((row) => {
          const name = row.querySelector('.agent-pool-name');
          const state = row.querySelector(':scope > .agent-activity-status');
          return {
            title: row.title,
            height: box(row).height,
            nameCut: name.scrollWidth > name.clientWidth + 0.5,
            stateWhole: state.scrollWidth <= state.clientWidth + 0.5 && box(state).right <= box(row).right + 0.5,
          };
        });
        const open = columns();
        list.querySelector('.composer-island-agent-fold').click();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const folded = { ...columns(), rows: list.querySelectorAll('.agent-pool-row').length };
        list.querySelector('.composer-island-agent-fold').click();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { rows, open, folded, reopened: columns() };
      });
      for (const [index, row] of measured.rows.entries()) {
        const what = `${language} (${state}), row ${index}`;
        if (row.height > 37) found.push(`${what}: ${row.height}px, more than a line`);
        if (row.nameCut) found.push(`${what}: its short name cut`);
        if (!row.stateWhole) found.push(`${what}: its state not whole`);
        if (!row.title.includes('999.9M')) found.push(`${what}: no total in its tooltip: ${JSON.stringify(row.title)}`);
      }
      if (measured.folded.rows !== 0) found.push(`${language} (${state}): folded, ${measured.folded.rows} rows left`);
      for (const [at, columns] of [
        ['folded', measured.folded],
        ['unfolded again', measured.reopened],
      ]) {
        const moved =
          Math.abs(columns.fold - measured.open.fold) > 0.5 ||
          columns.state.some((edge, side) => Math.abs(edge - measured.open.state[side]) > 0.5);
        if (moved)
          found.push(`${language} (${state}) ${at}: ${JSON.stringify(columns)} ≠ ${JSON.stringify(measured.open)}`);
      }
    }
  }
  await page.evaluate(() => window.setLanguage('en'));
  assert.deepEqual(errors, []);
  assert.deepEqual(found, []);
});

test('a shell whose stop was not confirmed shows that state, its tooltip and its buttons together, pointed at or not', async () => {
  const { page, errors } = await openFixture();
  await page.evaluate(() =>
    window.mountJobs({ width: 300, agent: { state: 'running', clock: true }, shell: 'held', round: 0 })
  );
  await page.waitForSelector('[data-category="shells"] [data-state="unconfirmed"]');
  const read = () =>
    page.evaluate(() => {
      const row = document.querySelector('[data-category="shells"] .composer-island-row');
      const box = (node) => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      };
      // Shown: visible, and no box from it up to its row faded out.
      const shown = (node) => {
        if (getComputedStyle(node).visibility !== 'visible') return false;
        for (let at = node; at && at !== row.parentElement; at = at.parentElement) {
          if (getComputedStyle(at).opacity === '0') return false;
        }
        return true;
      };
      const word = row.querySelector('[data-state="unconfirmed"]');
      return {
        row: box(row),
        word: { text: word.textContent, title: word.title, shown: shown(word), box: box(word) },
        // An icon button by its glyph's ink: its press area and the mark's own margin reach past the row by design
        // (the ink on the head's line).
        buttons: [...row.querySelectorAll('.composer-island-row-actions button')].map((button) => {
          const svg = button.hasAttribute('data-icon') ? button.querySelector('svg') : null;
          return {
            label: button.getAttribute('aria-label'),
            shown: shown(button),
            box: svg ? { ...box(svg), right: window.inkRight(svg) } : box(button),
          };
        }),
      };
    });
  const apart = (a, b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
  const within = (inner, outer) =>
    inner.left >= outer.left - 1 &&
    inner.right <= outer.right + 1 &&
    inner.top >= outer.top - 1 &&
    inner.bottom <= outer.bottom + 1;
  for (const pointed of [false, true]) {
    if (pointed) await page.hover('[data-category="shells"] .composer-island-row');
    const held = await read();
    const label = pointed ? 'pointed at' : 'at rest';
    assert.equal(held.word.text, 'Termination unconfirmed');
    assert.ok(held.word.title, `${label}: the tooltip says why`);
    assert.ok(held.word.shown, `${label}: the state shows`);
    assert.deepEqual(
      held.buttons.map((button) => [button.label, button.shown]),
      [
        ['Release anyway: npm run watch-0', true],
        ['Stop: npm run watch-0', true],
      ],
      `${label}: both buttons show`
    );
    for (const button of held.buttons) {
      assert.ok(apart(held.word.box, button.box), `${label}: ${button.label} clear of the state`);
      assert.ok(within(button.box, held.row), `${label}: ${button.label} inside its row`);
    }
    assert.ok(within(held.word.box, held.row), `${label}: the state inside its row`);
  }
  const { out } = await page.evaluate(() => window.overflows());
  assert.deepEqual(out, []);
  assert.deepEqual(errors, []);
});

test("each section's head at the panel's minimum: its name at the rows' left edge with no icon before it, the fold's chevron right after it, its figures ending on the rows' right edge, nothing else in it and nothing overlapping, open or folded", async () => {
  const { page, errors } = await openFixture();
  const all = ['info', 'context', 'goal', 'todo', 'agents', 'shells', 'changes', 'git'];
  const near = (actual, expected, message) =>
    assert.ok(Math.abs(actual - expected) <= 0.5, `${message}: ${actual} ≠ ${expected}`);
  for (const folded of [[], all, ['context', 'agents', 'changes']]) {
    await page.evaluate((width, names) => window.mountFixture(width, names), SESSION_RAIL_MIN_WIDTH, folded);
    await page.waitForSelector('[data-category="changes"] .session-rail-tg');
    await page.waitForSelector('[data-category="git"] .session-rail-tg');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const heads = await page.evaluate(() => window.heads());
    assert.deepEqual(
      heads.map((head) => head.category),
      all
    );
    for (const head of heads) {
      const label = `${head.category} (${head.open ? 'open' : 'folded'})`;
      assert.equal(head.open, !folded.includes(head.category), label);
      assert.equal(head.marks, 0, `${label}: no icon before the name`);
      // A head holds its fold control alone, but for a category's one action while it is open: Git's Run.
      assert.deepEqual(
        head.extra,
        head.category === 'git' && head.open ? ['composer-island-button composer-island-git-run'] : [],
        `${label}: no other action or menu in the head`
      );
      assert.deepEqual(head.chevron, { size: 12, down: head.open }, `${label}: the fold's chevron`);
      const kinds = head.parts.map(([kind]) => kind);
      assert.deepEqual(kinds.slice(0, 2), ['name', 'chevron'], `${label}: the chevron right after the name`);
      const [, name] = head.parts[0];
      near(name.left, head.contentLeft, `${label}: the name at the section's left edge`);
      if (head.bodyLeft !== null) near(name.left, head.bodyLeft, `${label}: aligned with the rows under it`);
      for (let index = 1; index < head.parts.length; index += 1) {
        const [before, a] = head.parts[index - 1];
        const [after, b] = head.parts[index];
        assert.ok(a.right <= b.left + 0.5, `${label}: ${before} (${a.right}) clear of ${after} (${b.left})`);
      }
      // The figures (and a count after them) end on the rows' right edge, the panel's inset.
      const after = head.parts.slice(head.parts.findIndex(([kind]) => kind === 'chevron') + 1);
      if (after.length) near(after.at(-1)[1].right, head.contentRight, `${label}: its figures' end`);
    }
    // Every section with figures shows them, open or folded; Git's stand in its folded head (open, its Run stands
    // at the head's end).
    const withFigures = heads.filter((head) => head.parts.length > 2).map((head) => head.category);
    for (const category of ['context', 'todo', 'agents', 'shells', 'changes', 'git']) {
      if (category === 'git' && !folded.includes('git')) continue;
      assert.ok(withFigures.includes(category), `${category} shows its figures`);
    }
  }
  assert.deepEqual(errors, []);
});

const frames = (page) =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

test("a shell row's Stop and Dismiss at the panel's least and widest width: a 16px mark in the strong ink, washed pointed at, a whole press area of 24px or more, its ink ending on the head's right line and the agents' state words', its list scrolling or not, with a scrollbar's gutter or none", async () => {
  const { page, errors } = await openFixture();
  // Overlay scrollbars, as macOS and phones draw them: the list reserves no gutter.
  await page.addStyleTag({ content: 'html[data-overlay-scrollbars] .session-rail-bd { scrollbar-width: none; }' });
  const near = (actual, expected, message) =>
    assert.ok(Math.abs(actual - expected) <= 0.5, `${message}: ${actual} ≠ ${expected}`);
  const icons = new Set();
  try {
    for (const width of [SESSION_RAIL_MIN_WIDTH, SESSION_RAIL_MAX_WIDTH]) {
      for (const overlay of [false, true]) {
        await page.evaluate((on) => document.documentElement.toggleAttribute('data-overlay-scrollbars', on), overlay);
        for (const scene of ['short list', 'long list']) {
          if (scene === 'short list') {
            // One shell exited (Dismiss), one running (Stop): two rows, nothing to scroll.
            await page.evaluate((props) => window.mountJobs(props), {
              width,
              agent: { state: 'running', clock: false },
              shell: 'exited',
              round: `marks-${width}-${overlay}`,
            });
          } else {
            // Eight shells, six running and two ended: the list scrolls.
            await page.evaluate((next) => window.mountFixture(next), width);
            await page.waitForSelector('[data-category="shells"] .composer-island-row');
          }
          await page.evaluate(() => window.matchGutter());
          await frames(page);
          const marks = await page.evaluate(() => window.shellMarks());
          const what = `${width}px, ${scene}, ${overlay ? 'no gutter' : `a ${marks.gutter}px gutter`}`;
          assert.equal(marks.scrolls, scene === 'long list', `${what}: the list scrolls`);
          assert.equal(marks.gutter > 0, !overlay, `${what}: the gutter`);
          assert.notEqual(marks.text, marks.soft, 'the strong ink is not the soft one');
          assert.deepEqual(
            [...new Set(marks.marks.map((mark) => mark.icon))].sort(),
            ['close-small', 'stop'],
            `${what}: Stop and Dismiss`
          );
          for (const [index, mark] of marks.marks.entries()) {
            const label = `${what}, ${mark.icon} ${index}`;
            icons.add(mark.icon);
            // Stop's filled square at the 12px state marks' size, the X at the 16px mark size.
            const size = mark.icon === 'stop' ? 12 : 16;
            near(mark.size[0], size, `${label}: the mark's width`);
            near(mark.size[1], size, `${label}: the mark's height`);
            assert.ok(mark.press[0] >= 24 && mark.press[1] >= 24, `${label}: a press area of 24px: ${mark.press}`);
            assert.ok(
              mark.right <= marks.clip + 0.5,
              `${label}: the press area whole in the list: ${mark.right} > ${marks.clip}`
            );
            assert.equal(mark.color, marks.text, `${label}: the strong ink at rest`);
            if (mark.last) near(mark.ink, marks.figures, `${label}: its ink's end against the head's right line`);
          }
          assert.ok(marks.states.length > 0);
          for (const state of marks.states) near(state, marks.figures, `${what}: an agent's state word's end`);
        }
      }
    }
    assert.deepEqual([...icons].sort(), ['close-small', 'stop']);
    await page.evaluate(() => document.documentElement.removeAttribute('data-overlay-scrollbars'));
    await page.evaluate((props) => window.mountJobs(props), {
      width: SESSION_RAIL_MIN_WIDTH,
      agent: { state: 'running', clock: false },
      shell: 'exited',
      round: 'marks-pointed',
    });
    const dismiss = '[data-category="shells"] .composer-island-row-actions > [data-icon="close-small"]';
    await page.hover(dismiss);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const pointed = await page.$eval(dismiss, (button) => [
      getComputedStyle(button).color,
      getComputedStyle(button).backgroundColor,
    ]);
    assert.equal(pointed[0], (await page.evaluate(() => window.shellMarks())).text, 'the strong ink pointed at');
    assert.notEqual(pointed[1], 'rgba(0, 0, 0, 0)', "pointed at, the button's wash");
  } finally {
    await page.evaluate(() => document.documentElement.removeAttribute('data-overlay-scrollbars'));
  }
  assert.deepEqual(errors, []);
});

test("the panel's type on the island panels' tiers: each role (title, head figures, kind line, row at rest and its figures, agent name, command, state and clock, foot, button) one size, line height and weight token", async () => {
  const { page, errors } = await openFixture();
  await page.evaluate((width) => window.mountFixture(width), SESSION_RAIL_MIN_WIDTH);
  await page.waitForSelector('[data-category="changes"] .session-rail-ft .composer-island-button');
  const off = await page.evaluate(typeOffTier, PANEL_TYPE_ROLES, {
    title: '.session-rail-tt',
    figures: '.session-rail-sm',
    kind: '.session-rail .composer-island-agent-fold',
    name: '.session-rail .agent-pool-row:not([data-working]) .agent-pool-name',
    working: '.session-rail .agent-pool-row[data-working] .agent-pool-name',
    row:
      '.session-rail-group > .session-rail-row:not([data-status="in_progress"]) > .session-rail-cut, ' +
      '.session-rail-part > .session-rail-cut, [data-category="changes"] .session-rail-row .turn-review-files-name',
    rowFigures:
      '.session-rail-part > .session-rail-num, .session-rail-row > .diff-stats, .session-rail .agent-row-steps',
    command: '.session-rail .composer-island-shell-command',
    state: '.session-rail .composer-island-jobs .agent-activity-elapsed, .session-rail-goal-line',
    foot: '.session-rail-ft',
    button: '.session-rail-ft .composer-island-button',
  });
  assert.deepEqual(off, []);
  assert.deepEqual(errors, []);
});

test("every scroller in the panel fades its content out at an edge with more beyond it and not at an edge it is scrolled against, at its top, middle and end; a list's scrollbar is never faded", async () => {
  const { page, errors } = await openFixture();
  await page.evaluate((width) => window.mountFixture(width, [], 700), SESSION_RAIL_MIN_WIDTH);
  await page.waitForSelector('[data-category="changes"] .session-rail-row');
  await page.waitForSelector('[data-category="git"] .composer-island-git-row');
  await page.evaluate(() => {
    window.matchGutter();
    window.bindBody();
  });
  await frames(page);
  const scrollers = (await page.evaluate(() => window.fades())).map((fade) => fade.scroller);
  assert.deepEqual(scrollers, ['panel', 'agents', 'shells', 'changes']);
  for (const [index, scroller] of scrollers.entries()) {
    for (const at of ['top', 'middle', 'end']) {
      await page.evaluate(
        (which, where) => {
          const node = document.querySelectorAll('.session-rail-body, .session-rail-bd[data-scroll]')[which];
          const max = node.scrollHeight - node.clientHeight;
          node.scrollTop = where === 'top' ? 0 : where === 'end' ? max : Math.round(max / 2);
        },
        index,
        at
      );
      // scroll-progress.ts has written the position the list stands at.
      await page.waitForFunction(
        (which) => {
          const node = document.querySelectorAll('.session-rail-body, .session-rail-bd[data-scroll]')[which];
          return node.style.getPropertyValue('--mx-scroll-top') === String(node.scrollTop);
        },
        {},
        index
      );
      const fade = (await page.evaluate(() => window.fades()))[index];
      const what = `${scroller} at its ${at} (${fade.top} of ${fade.max})`;
      assert.ok(fade.max > 0, `${what}: it scrolls`);
      assert.ok(Number.isFinite(fade.topAlpha) && Number.isFinite(fade.bottomAlpha), `${what}: ${fade.mask}`);
      assert.equal(
        fade.topAlpha < 1,
        at !== 'top',
        `${what}: the top edge ${at === 'top' ? 'whole' : 'faded'}: ${fade.mask}`
      );
      assert.equal(
        fade.bottomAlpha < 1,
        at !== 'end',
        `${what}: the bottom edge ${at === 'end' ? 'whole' : 'faded'}: ${fade.mask}`
      );
      if (scroller !== 'panel') {
        assert.ok(fade.gutter > 0, `${what}: a gutter`);
        assert.equal(fade.layers, 2, `${what}: the gutter's layer and the fade`);
        assert.deepEqual(fade.gutterLayer, [`${fade.gutter}px 100%`, '100% 0%'], `${what}: the gutter kept whole`);
      }
    }
  }
  assert.deepEqual(errors, []);
});

test("the Branch row's tab opens again at the height its rows took: loading, it holds that height, and nothing moves when they land", async () => {
  const { page, errors } = await openFixture();
  await page.evaluate((next) => window.mountFixture(next), SESSION_RAIL_MIN_WIDTH);
  await page.waitForSelector('[data-category="git"] .composer-island-git-row');
  await frames(page);
  const { loading, heights, first } = await page.evaluate(
    (width) => window.branchTabLoad(width),
    SESSION_RAIL_MIN_WIDTH
  );
  assert.ok(loading, 'the tab showed its loading line');
  assert.ok(
    heights.some(([state]) => state === 'rows'),
    'the rows landed'
  );
  for (const [index, [state, height]] of heights.entries()) {
    assert.ok(Math.abs(height - first) <= 0.5, `frame ${index} (${state}): ${height} ≠ the rows' ${first}`);
  }
  assert.deepEqual(errors, []);
});

test("the panel's pressable rows, kind lines and heads answer as the left sidebar's: its wash and radius pointed at, its focus ring, never an underline; one-line Git rows on the 32px pitch", async () => {
  const { page, errors } = await openFixture();
  await page.evaluate((next) => window.mountFixture(next), SESSION_RAIL_MAX_WIDTH);
  await page.waitForSelector('[data-category="git"] .composer-island-git-row');
  await frames(page);
  // A left sidebar session row and heading, drawn by the app's own stylesheet.
  await page.evaluate(() => {
    const sidebar = document.createElement('aside');
    sidebar.className = 'session-sidebar';
    sidebar.id = 'sidebar-sample';
    sidebar.style.cssText = 'position: fixed; right: 0; top: 0; width: 260px;';
    sidebar.innerHTML =
      '<div class="session-row"><button type="button" class="session-row-main">Sample</button></div>' +
      '<button type="button" class="sidebar-recent-heading sidebar-heading-toggle"><span>Recent</span></button>';
    document.body.append(sidebar);
  });
  const look = (selector) =>
    page.$eval(selector, (node) => {
      const style = getComputedStyle(node);
      const underlined = [node, ...node.querySelectorAll('*')]
        .filter((part) => getComputedStyle(part).textDecorationLine !== 'none')
        .map((part) => part.getAttribute('class'));
      return { background: style.backgroundColor, radius: style.borderRadius, ring: style.boxShadow, underlined };
    });
  const pointAt = async (selector) => {
    await page.hover(selector);
    await new Promise((resolve) => setTimeout(resolve, 250));
    return look(selector);
  };
  // Keyboard focus (a key pressed first, so a scripted focus is a keyboard one).
  const focusOn = async (selector) => {
    await page.keyboard.press('Shift');
    const visible = await page.$eval(selector, (node) => {
      node.focus();
      return node.matches(':focus-visible');
    });
    assert.ok(visible, `${selector}: keyboard focus shows`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  };
  const sampleRow = '#sidebar-sample .session-row';
  const sidebarHover = await pointAt(sampleRow);
  await focusOn('#sidebar-sample .session-row-main');
  const sidebarRing = (await look(sampleRow)).ring;
  assert.notEqual(sidebarHover.background, 'rgba(0, 0, 0, 0)', "the sidebar row's wash");
  assert.notEqual(sidebarRing, 'none', "the sidebar row's ring");
  const pressable = [
    ['an Info row', '[data-category="info"] button.session-rail-row.session-rail-pick'],
    ['a kind line', '[data-category="agents"] .composer-island-agent-fold'],
    ['an agent at rest', '[data-category="agents"] .agent-pool-row:not([data-working])'],
  ];
  for (const [what, selector] of pressable) {
    const hovered = await pointAt(selector);
    assert.equal(hovered.background, sidebarHover.background, `${what}: the sidebar's wash pointed at`);
    assert.equal(hovered.radius, sidebarHover.radius, `${what}: the sidebar's radius`);
    assert.deepEqual(hovered.underlined, [], `${what}: no underline pointed at`);
    await focusOn(selector);
    const focused = await look(selector);
    assert.equal(focused.ring, sidebarRing, `${what}: the sidebar's focus ring`);
    assert.deepEqual(focused.underlined, [], `${what}: no underline focused`);
  }
  // A section head: no underline pointed at or focused, the same ring.
  const head = '[data-category="agents"] .session-rail-tg';
  assert.deepEqual((await pointAt(head)).underlined, [], 'a head: no underline pointed at');
  await focusOn(head);
  const headFocused = await look(head);
  assert.equal(headFocused.ring, sidebarRing, "a head: the sidebar's focus ring");
  assert.deepEqual(headFocused.underlined, [], 'a head: no underline focused');
  const gitRows = await page.$$eval('[data-category="git"] .composer-island-git-row', (rows) =>
    rows.map((row) => row.getBoundingClientRect().height)
  );
  assert.ok(gitRows.length > 0);
  for (const height of gitRows) assert.ok(Math.abs(height - 32) <= 0.5, `a Git row ${height}px, not 32`);
  await page.evaluate(() => document.getElementById('sidebar-sample').remove());
  assert.deepEqual(errors, []);
});

test("every menu an Info row opens (project, branch, model, workflow, delegation) stands under its row on the row's own left and right edges, at the panel's least and widest width", async () => {
  const { page, errors } = await openFixture();
  for (const width of [SESSION_RAIL_MIN_WIDTH, SESSION_RAIL_MAX_WIDTH]) {
    await page.evaluate((next) => window.mountFixture(next), width);
    await page.waitForSelector('[data-category="info"] .session-rail-select');
    await page.waitForSelector('[data-category="git"] .composer-island-git-row');
    await frames(page);
    const menus = await page.evaluate(() => window.rowMenus());
    assert.deepEqual(
      menus.map((menu) => menu.name),
      ['project', 'branch', 'model', 'workflow', 'delegation']
    );
    for (const { name, row, menu, viewport } of menus) {
      const what = `${width}px, ${name}`;
      assert.ok(row, `${what}: its row`);
      assert.ok(menu, `${what}: its menu opens`);
      assert.ok(menu.top >= row.bottom - 0.5, `${what}: under its row: ${menu.top} < ${row.bottom}`);
      assert.ok(Math.abs(menu.left - row.left) <= 1, `${what}: left edge ${menu.left} ≠ the row's ${row.left}`);
      assert.ok(Math.abs(menu.right - row.right) <= 1, `${what}: right edge ${menu.right} ≠ the row's ${row.right}`);
      assert.ok(menu.left >= 0 && menu.right <= viewport, `${what}: inside the window`);
    }
  }
  assert.deepEqual(errors, []);
});
