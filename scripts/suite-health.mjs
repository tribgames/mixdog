#!/usr/bin/env node
// Weekly opt-out sweep: run every test:*/smoke:* npm script in the repository
// so no locally-registered suite can rot silently (docs/testing.md, "A
// contract suite runs in CI or it drifts"). New scripts join automatically;
// exclusions are explicit, reasoned, and fail closed when they go stale.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export const WORKSPACES = [
  {
    dir: '.',
    exclusions: {
      test: 'the release gate runtime job runs the default lane on every gated push',
      'test:slow': 'the release gate runtime-slow job runs it on every gated push',
      'smoke:all': 'aggregate; its components run individually',
      'test:release-critical':
        'aggregate of test:release-assets, smoke:patch and test:providers, each swept on its own',
      'smoke:loop': 'long-running local endurance harness',
      'smoke:loop:final': 'endurance-harness gate, needs hours of loop data',
      'smoke:loop:report': 'report reader, not a suite',
      'test:office:live': 'drives real Office COM on a desktop machine',
      'test:embedding-runtime:warmup': 'downloads the embedding runtime',
      'test:spec-advisory': 'advisory by design (MIXDOG_TEST_ADVISORY)',
    },
  },
  {
    dir: 'apps/desktop',
    exclusions: {
      test: 'the release gate desktop-tests fast leg runs it on every gated push',
      'test:slow': 'the release gate desktop-tests slow leg runs it on every gated push',
      'test:all': 'aggregate of the fast, slow, live, and electron lanes',
      'test:electron': 'needs a real Electron window and graphics device, which the Linux sweep runner lacks',
      'test:live': 'needs built artifacts; the packaging workflow owns it',
      'test:daemon:e2e': 'needs the built daemon; the release gate desktop job owns it',
      'test:spec-advisory': 'advisory by design (MIXDOG_TEST_ADVISORY)',
      'test:browser-host:integration': 'live desktop integration harness',
      'test:browser-profile-import:integration': 'live desktop integration harness',
      'test:remote-webrtc-sender:integration':
        'live desktop integration harness; launches real Electron and has never run in the sweep, so it stays out until verified under Xvfb',
      'test:computer-host:integration': 'live desktop integration harness',
      'test:computer-host:scenarios': 'live desktop scenario harness',
      'test:computer-host:repeats': 'live desktop scenario harness',
    },
  },
];

// Swept scripts that launch a real Electron window. The headless Linux runner
// has no X server, so they run inside a virtual one (xvfb-run, as
// linux-desktop-verify.yml does). The runner also has no usable keyring (a
// keyring daemon there prompts for an unlock on a display it cannot open and
// stalls the entry), and these entries check Mixdog's own persistence and
// sign-out logic, not the OS keychain. So on Linux the sweep sets
// TEST_PLAINTEXT_SAFE_STORAGE_ENV and the test harness alone (never the app)
// switches Electron's safeStorage to its in-memory-password fallback.
export const DISPLAY_SUITES = [
  'test:browser-login-persistence:integration',
  'test:browser-login-popup:integration',
];
export const TEST_PLAINTEXT_SAFE_STORAGE_ENV = 'MIXDOG_TEST_PLAINTEXT_SAFE_STORAGE';

const runsUnderDisplay = (ws, name, platform) =>
  platform === 'linux' && ws.dir !== '.' && DISPLAY_SUITES.includes(name);

export function sweepCommand(ws, name, platform = process.platform) {
  const args = ['run', name, ...(ws.dir === '.' ? [] : ['--prefix', ws.dir])];
  if (runsUnderDisplay(ws, name, platform)) {
    return ['xvfb-run', ['-a', '--server-args=-screen 0 1440x900x24', 'npm', ...args]];
  }
  return [platform === 'win32' ? 'npm.cmd' : 'npm', args];
}

export function sweepEnv(ws, name, platform = process.platform, base = process.env) {
  return runsUnderDisplay(ws, name, platform) ? { ...base, [TEST_PLAINTEXT_SAFE_STORAGE_ENV]: '1' } : base;
}

export function selectSuiteScripts(scripts, exclusions) {
  const names = Object.keys(scripts).filter((name) => /^(test|smoke)(:|$)/.test(name));
  const stale = Object.keys(exclusions).filter((name) => !names.includes(name));
  if (stale.length) {
    throw new Error(`stale exclusions (script no longer exists): ${stale.join(', ')}`);
  }
  return names.filter((name) => !(name in exclusions));
}

const TAIL_LINES = 25;
const lastLines = (text, name) => {
  const lines = String(text || '')
    .trim()
    .split('\n');
  if (lines.length <= TAIL_LINES) return lines.join('\n');
  return [`[${name} truncated: last ${TAIL_LINES} of ${lines.length} lines]`, ...lines.slice(-TAIL_LINES)].join('\n');
};

// What a failed entry shows in the report: how it ended, every failure-summary
// and failed-test line from either stream (a long stderr must not hide them),
// then each stream's tail.
export function failureParts({ stdout, stderr, status, signal, error }) {
  const failedLines = `${stdout || ''}\n${stderr || ''}`
    .split('\n')
    .filter((line) => /^\[failure-summary\]|^\s*✖ /.test(line));
  const ended = error ? `spawn error: ${error.message}` : `exit ${status ?? 'none'}${signal ? `, signal ${signal}` : ''}`;
  const tails = [lastLines(stdout, 'stdout'), lastLines(stderr, 'stderr')].filter(Boolean).join('\n');
  return { ended, failedLines, tails };
}

const failureText = ({ ended, failedLines, tails }) =>
  [ended, failedLines.join('\n'), tails].filter(Boolean).join('\n').trim();

export const failureTail = (child) => failureText(failureParts(child));

// GitHub rejects an issue body over 65,536 characters (HTTP 422). Past the
// limit the tails go first, then failure lines from the end; the omission is
// always stated, and the full diagnostics stay in the workflow log.
export const ISSUE_BODY_LIMIT = 60_000;

export function buildReport({ checked, runUrl, reportLines, failures, limit = ISSUE_BODY_LIMIT }) {
  const render = (withTails, keep) => {
    let left = keep;
    let omitted = 0;
    const blocks = failures.map(({ title, parts }) => {
      const shown = parts.failedLines.slice(0, left);
      left -= shown.length;
      omitted += parts.failedLines.length - shown.length;
      const text = failureText({ ...parts, failedLines: shown, tails: withTails ? parts.tails : '' });
      return `${title}\n\n\`\`\`\n${text}\n\`\`\``;
    });
    const notes = [];
    if (!withTails) notes.push('Stdout/stderr tails omitted to fit the issue size limit; see the workflow log.');
    if (omitted) notes.push(`${omitted} more failure lines omitted — see the workflow log: ${runUrl}`);
    return [
      '# Weekly suite health sweep failed',
      '',
      `Checked: ${checked}`,
      `Workflow run: ${runUrl}`,
      '',
      ...reportLines,
      '',
      ...blocks,
      '',
      ...notes,
    ]
      .join('\n')
      .trimEnd()
      .concat('\n');
  };
  const total = failures.reduce((sum, { parts }) => sum + parts.failedLines.length, 0);
  if (render(true, total).length <= limit) return render(true, total);
  let low = 0;
  let high = total;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (render(false, mid).length <= limit) low = mid;
    else high = mid - 1;
  }
  return render(false, low);
}

function runSweep() {
  const failures = [];
  const reportLines = [];
  for (const ws of WORKSPACES) {
    const pkg = JSON.parse(readFileSync(join(ws.dir, 'package.json'), 'utf8'));
    const names = selectSuiteScripts(pkg.scripts || {}, ws.exclusions);
    for (const name of names) {
      const label = ws.dir === '.' ? name : `${ws.dir} ${name}`;
      const started = Date.now();
      const [command, args] = sweepCommand(ws, name);
      const child = spawnSync(command, args, {
        env: sweepEnv(ws, name),
        encoding: 'utf8',
        shell: process.platform === 'win32',
        maxBuffer: 64 * 1024 * 1024,
      });
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (child.status === 0) {
        reportLines.push(`- ${label}: OK (${seconds}s)`);
        console.log(`${label}: OK (${seconds}s)`);
      } else {
        // Tail each stream on its own: a long stderr (cargo build chatter) must
        // not push the test failure summary on stdout out of the report.
        const parts = failureParts(child);
        failures.push({ title: `- ${label}: FAILED (${seconds}s)`, parts });
        reportLines.push(`- ${label}: FAILED (${seconds}s)`);
        console.error(`${label}: FAILED (${seconds}s)\n${failureText(parts)}`);
      }
    }
  }
  console.log(`\n${reportLines.join('\n')}`);
  if (failures.length > 0) {
    const runUrl = process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : '(local run)';
    writeFileSync(
      'suite-health-report.md',
      buildReport({ checked: new Date().toISOString(), runUrl, reportLines, failures })
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSweep();
}
