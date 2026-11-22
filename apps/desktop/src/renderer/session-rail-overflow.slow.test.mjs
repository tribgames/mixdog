import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
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
  import { initUiLanguage } from './i18n';
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
          <AgentsSection {...fold()} folds={folds} sessionId={SESSION} agents={islandAgentRows(pool, SESSION)} poolRows={pool}
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

  // The Agents card alone at the panel's narrowest, with the mockup's 46 agents (7 running, 6 waiting, 33
  // finished), in \`language\` (its catalog given).
  let cardRoot = null;
  window.mountAgents46 = async (language, catalog) => {
    // The page has no storage: the language comes the way the tests pin theirs (MIXDOG_UI_LANGUAGE).
    window.process.env.MIXDOG_UI_LANGUAGE = language;
    await initUiLanguage(async () => ({ default: catalog }));
    const owner = 'card-46-' + language;
    const agent = (i, state) => ({
      tag: 'agent-' + i, sessionId: owner + '-' + i, ownerSessionId: owner, parentSessionId: owner, agent: 'worker',
      provider: 'anthropic', model: 'claude-opus', effort: 'medium',
      ...(state === 'run' ? { status: 'running', stage: 'streaming', turnStartedAt: now - 61_000, todo: { completed: 1, total: 5 } }
        : state === 'wait' ? { status: 'running', stage: 'resource_wait' } : { status: 'completed', stage: 'completed' }),
    });
    const agents = [{ tag: 'lead:' + owner, sessionId: owner, ownerSessionId: owner, agent: 'lead', status: 'idle', stage: 'idle' },
      ...Array.from({ length: 46 }, (_, i) => agent(i, i < 7 ? 'run' : i < 13 ? 'wait' : 'done'))];
    function Card() {
      const folds = useSessionRailFolds(owner);
      return <aside className="session-rail" style={{ width: 300 }}>
        <div className="session-rail-body"><div className="session-rail-content">
          <AgentsSection open onToggle={noop} folds={folds} sessionId={owner} agents={islandAgentRows(agents, owner)}
            poolRows={agents} busy={false} shellKeys={null} />
        </div></div>
      </aside>;
    }
    cardRoot?.unmount();
    document.getElementById('root').replaceChildren();
    installScrollbarMetrics();
    cardRoot = createRoot(document.getElementById('root'));
    cardRoot.render(<Card />);
  };
  // The state tabs: one line, nothing past the card, every tab within the line's scroll, and the picked one in view.
  window.agentTabs = () => {
    const line = document.querySelector('[role="tablist"]');
    const card = line.closest('.session-rail-sec').getBoundingClientRect();
    const box = line.getBoundingClientRect();
    const tabs = [...line.querySelectorAll('[role="tab"]')].map((tab) => {
      const rect = tab.getBoundingClientRect();
      return { text: tab.textContent, selected: tab.getAttribute('aria-selected') === 'true', top: rect.top, left: rect.left, right: rect.right };
    });
    const style = getComputedStyle(line);
    return {
      tabs,
      overflowX: style.overflowX,
      scrollWidth: line.scrollWidth,
      clientWidth: line.clientWidth,
      scrollLeft: line.scrollLeft,
      // A visible bar would take height from the line's box.
      barHeight: line.offsetHeight - line.clientHeight - line.clientTop * 2,
      line: { left: box.left, right: box.right, padding: Number.parseFloat(style.paddingLeft) },
      card: { left: card.left, right: card.right },
      font: getComputedStyle(line.querySelector('[role="tab"]')).font,
    };
  };

  // Each working agent's step mark: its row's name and where the mark stands.
  window.stepMarks = () =>
    [...document.querySelectorAll('.session-rail-agent > .agent-todo-mark')].map((mark) => ({
      name: mark.parentElement.querySelector('.agent-pool-name').textContent,
      left: mark.getBoundingClientRect().left,
      nameRight: mark.parentElement.querySelector('.agent-pool-name').getBoundingClientRect().right,
    }));

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
        '.session-rail-gh, .session-rail-agent, .session-rail-agent-past, .session-rail-agent-fold'
    );
    // A head is 42px, a foot 38px over its 8px of padding, an island or agent row two lines.
    const tallest = (row) =>
      row.matches('.session-rail-hd, .session-rail-ft') ? 47 : row.matches('.composer-island-row, .session-rail-agent') ? 60 : 37;
    for (const row of rows) {
      const box = row.getBoundingClientRect();
      if (row.scrollWidth > row.clientWidth + 1) out.push('scrolls: ' + row.className + ' ' + row.textContent.slice(0, 40));
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

/** A page with the fixture's bundle and the app's styles loaded. */
async function openFixture(t) {
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
  return { page, errors };
}

test('the panel at 400px with a busy session: nothing overflows its row', async (t) => {
  const { page, errors } = await openFixture(t);
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
  // The step mark has a column of its own: it stands at one place in a row with a short name and with a long one.
  const marks = await page.evaluate(() => window.stepMarks());
  assert.ok(marks.some(({ name }) => name === 'a') && marks.some(({ name }) => name.length > 40), JSON.stringify(marks));
  assert.ok(marks.every(({ left }) => Math.abs(left - marks[0].left) < 0.5), JSON.stringify(marks));
  assert.ok(marks.every(({ left, nameRight }) => nameRight <= left), 'a long name ends before the mark');
});

test("the Agents card's state tabs stay on one line at 300px with 46 agents, in English and the widest locale", async (t) => {
  const { page, errors } = await openFixture(t);
  const keys = ['All {{count}}', 'Running {{count}}', 'Waiting {{count}}', 'Finished {{count}}'];
  const counts = [46, 7, 6, 33];
  const localeDir = new URL('./locales/', import.meta.url);
  const catalogs = Object.fromEntries(
    readdirSync(localeDir).map((file) => [file.replace(/\.json$/, ''), JSON.parse(readFileSync(new URL(file, localeDir), 'utf8'))])
  );
  const check = async (language) => {
    await page.evaluate((lang, catalog) => window.mountAgents46(lang, catalog), language, catalogs[language] ?? {});
    await page.waitForSelector('[role="tab"]');
    await page.evaluate(() => document.fonts.ready);
    const read = () => page.evaluate(() => window.agentTabs());
    const shown = await read();
    const where = `${language}: ${JSON.stringify(shown)}`;
    const words = keys.map((key, index) => (catalogs[language]?.[key] ?? key).replace('{{count}}', String(counts[index])));
    assert.deepEqual(shown.tabs.map(({ text }) => text), words, where);
    assert.ok(shown.tabs.every(({ top }) => Math.abs(top - shown.tabs[0].top) < 0.5), `one line: ${where}`);
    assert.ok(shown.line.right <= shown.card.right + 0.5 && shown.line.left >= shown.card.left - 0.5, `inside the card: ${where}`);
    assert.equal(shown.barHeight, 0, `no visible scrollbar: ${where}`);
    // Whatever does not fit is within the line's sideways scroll.
    const end = shown.line.left - shown.scrollLeft + shown.scrollWidth;
    assert.ok(shown.tabs.every(({ right }) => right <= end + 0.5), `reachable by the scroll: ${where}`);
    if (shown.scrollWidth > shown.clientWidth) assert.equal(shown.overflowX, 'auto', where);
    // The picked tab is brought into view, by keyboard and by pointer.
    const inView = (state) => {
      const tab = state.tabs.find(({ selected }) => selected);
      return tab.left >= state.line.left + state.line.padding - 0.5 && tab.right <= state.line.right - state.line.padding + 0.5;
    };
    await page.focus('[role="tab"][aria-selected="true"]');
    await page.keyboard.press('End');
    const atEnd = await read();
    assert.equal(atEnd.tabs.at(-1).selected, true, language);
    assert.ok(inView(atEnd), `the last tab in view: ${language}: ${JSON.stringify(atEnd)}`);
    await page.keyboard.press('Home');
    assert.ok(inView(await read()), `the first tab in view: ${language}`);
    // A press, from the line scrolled back to its start (a driver's click would scroll the tab in itself).
    await page.evaluate(() => {
      document.querySelector('[role="tablist"]').scrollLeft = 0;
      document.querySelector('[role="tab"][data-filter="finished"]').click();
    });
    const clicked = await read();
    assert.equal(clicked.tabs.at(-1).selected, true);
    assert.ok(inView(clicked), `a pressed tab in view: ${language}: ${JSON.stringify(clicked)}`);
    return shown;
  };
  const english = await check('en');
  // The locale whose four words, with the mockup's counts, run widest in the tabs' own type.
  const widths = await page.evaluate(
    (font, words) => {
      const context = document.createElement('canvas').getContext('2d');
      context.font = font;
      return Object.fromEntries(Object.entries(words).map(([language, list]) => [language, list.reduce((sum, word) => sum + context.measureText(word).width, 0)]));
    },
    english.font,
    Object.fromEntries(
      Object.entries(catalogs).map(([language, catalog]) => [language, keys.map((key, index) => catalog[key].replace('{{count}}', String(counts[index])))])
    )
  );
  const widest = Object.entries(widths).sort((a, b) => b[1] - a[1])[0][0];
  const wide = await check(widest);
  assert.ok(wide.scrollWidth > wide.clientWidth, `the widest locale (${widest}) scrolls sideways`);
  assert.deepEqual(errors, []);
});
