import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const resolveDir = fileURLToPath(new URL('.', import.meta.url));
const loader = { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' };

// A busy session in the panel at its default 400px: every category open, long
// names everywhere, more rows than each list's first few.
const HARNESS = `
  import { createRoot } from 'react-dom/client';
  import { islandAgentRows } from './agent-activity-model';
  import { useSessionGoal } from './SessionGoalIsland';
  import { ContextSection, InfoSection } from './session-rail-info';
  import { GoalSection, TodoSection } from './session-rail-goal';
  import { AgentsSection, ShellsSection } from './session-rail-jobs';
  import { WorktreesSection } from './session-rail-worktrees';
  import { ChangesSection } from './session-rail-changes';
  import { useSessionRailFolds } from './session-rail-folds';
  import { installScrollbarMetrics } from './scrollbar-metrics';
  import './session-rail.css';

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
      return { value: null };
    },
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
  const pool = [lead, ...Array.from({ length: 7 }, (_, i) => ({
    tag: long('agent-' + i), sessionId: 'agent-' + i, ownerSessionId: SESSION, parentSessionId: SESSION,
    agent: 'worker', provider: 'anthropic', status: i % 3 ? 'running' : 'completed', stage: i % 3 ? 'streaming' : 'completed',
    startedAt: now - 3_600_000 * 9, settledAt: i % 3 ? 0 : now, todo: { completed: 12, total: 99, current: long('current step') },
  }))];
  const shells = Array.from({ length: 5 }, (_, i) => ({
    key: 'shell-' + i, kind: 'shell', label: 'npm run ' + long('script-' + i) + ' -- --watch --reporter=verbose',
    startedAt: now - 3_600_000 * 9, finished: i === 4, status: i === 4 ? 'completed' : undefined, exitCode: i === 4 ? 0 : undefined,
    taskId: 'task-' + i, cwd: PROJECT,
  }));
  const files = new Map(Array.from({ length: 8 }, (_, i) => [
    'src/' + long('deeply/nested/folder') + '/' + long('file-name-' + i) + '.tsx',
    { additions: 123456 - i, deletions: 98765, lineStats: true, status: 'M', binary: false, parts: [] },
  ]));
  const view = {
    label: 'Uncommitted', fileCount: files.size, files,
    headlineStats: { additions: 987654, deletions: 876543, hasLineStats: true },
    sessionId: SESSION, historyTurns: 3, busy: true, sourcePicker: true, emptyText: '', ready: true,
  };
  const noop = () => {};
  const model = {
    provider: 'anthropic', model: long('claude-model-with-a-long-name'), effort: 'high', fast: false, fastCapable: false,
    sessionId: SESSION, modelDisabled: false, tuningDisabled: false,
    invokeResult: async (action) => action(), applySnapshot: noop, onOpenSettings: noop,
  };
  const choice = (id, label, valueLabel) => ({ id, label, valueLabel, disabled: false, options: [], onSelect: noop });

  function Rail() {
    const folds = useSessionRailFolds(SESSION);
    const goal = useSessionGoal(snapshot);
    const fold = () => ({ open: true, onToggle: noop });
    return <aside className="session-rail" style={{ width: 400 }}>
      <div className="session-rail-body">
        <div className="session-rail-content">
          <InfoSection {...fold()} snapshot={snapshot} sessionId={SESSION} workspace={workspace}
            projectPath={PROJECT} projectLabel={long('Project label')} projects={[]} locked={false} agentMode={false}
            answersModelPickerRequests={false} model={model}
            sessionChoices={[choice('workflow', 'Workflow', long('Workflow value')), choice('mode', 'Delegation', long('Delegation value'))]}
            onFlash={noop} onOpenCommandSurface={noop} />
          <ContextSection {...fold()} snapshot={snapshot} onViewDetails={noop} />
          <GoalSection model={goal} {...fold()} />
          <TodoSection model={goal} folds={folds} {...fold()} />
          <AgentsSection {...fold()} sessionId={SESSION} agents={islandAgentRows(pool, SESSION)} poolRows={pool}
            busy shellKeys={null} />
          <ShellsSection {...fold()} sessionId={SESSION} shells={shells} shellKeys={null} />
          <WorktreesSection {...fold()} sessionId={SESSION} workspace={workspace} projectPath={PROJECT} locked={false}
            refreshKey="" onFlash={noop} />
          <ChangesSection {...fold()} view={view} onOpenChanges={noop} onOpenChangeFile={noop} />
        </div>
      </div>
    </aside>;
  }
  window.mountFixture = () => {
    // The app measures the scrollbar's reserve at start; the lists pay their inset with it.
    installScrollbarMetrics();
    createRoot(document.getElementById('root')).render(<Rail />);
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
      '.session-rail-row, .session-rail-hd, .session-rail-ft, .session-rail-goal-line, .session-rail .composer-island-row'
    );
    // A head is 42px, a foot 38px over its 8px of padding, an island row two lines.
    const tallest = (row) => (row.matches('.session-rail-hd, .session-rail-ft') ? 47 : row.matches('.composer-island-row') ? 60 : 37);
    for (const row of rows) {
      const box = row.getBoundingClientRect();
      if (row.scrollWidth > row.clientWidth + 1) out.push('scrolls: ' + row.className + ' ' + row.textContent.slice(0, 40));
      for (const child of row.querySelectorAll('*')) {
        const style = getComputedStyle(child);
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
        if (child.closest('.session-rail-act') && getComputedStyle(child.closest('.session-rail-act')).opacity === '0') continue;
        const rect = child.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        if (rect.right > box.right + 1 || rect.left < box.left - 1) {
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

test('the panel at 400px with a busy session: nothing overflows its row', async (t) => {
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
        contents: '@import "./font-faces.css"; @import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css";',
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
  t.after(() => browser.close());
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
  await page.evaluate(() => window.mountFixture());
  await page.waitForSelector('[data-category="worktrees"] .session-rail-row');
  await page.waitForSelector('[data-category="changes"] .session-rail-row');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const { count, out } = await page.evaluate(() => window.overflows());
  assert.deepEqual(errors, []);
  const categories = await page.evaluate(() =>
    [...document.querySelectorAll('.session-rail-sec')].map((section) => section.dataset.category)
  );
  assert.deepEqual(categories, ['info', 'context', 'goal', 'todo', 'agents', 'shells', 'worktrees', 'changes']);
  assert.ok(count > 30, `rows measured: ${count}`);
  assert.equal(out.length, 0, out.join('\n'));
});
