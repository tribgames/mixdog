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
      'smoke:all': 'aggregate; its components run individually',
      'smoke:loop': 'long-running local endurance harness',
      'smoke:loop:final': 'endurance-harness gate, needs hours of loop data',
      'smoke:loop:report': 'report reader, not a suite',
      'test:release-critical': 'aggregate; the release gate owns it',
      'test:quick': 'aggregate; its components run individually',
      'test:office:live': 'drives real Office COM on a desktop machine',
      'test:embedding-runtime:warmup': 'downloads the embedding runtime',
      'test:spec-advisory': 'advisory by design (MIXDOG_TEST_ADVISORY)',
    },
  },
  {
    dir: 'apps/desktop',
    exclusions: {
      'test:renderer:full': 'aggregate; its components run individually',
      'test:fast-direct': 'dev-only deploy tool; real deploys are its verification',
      'test:office-approval': 'runs through the root test:office chain',
      'test:spec-advisory': 'advisory by design (MIXDOG_TEST_ADVISORY)',
      'test:browser-host:integration': 'live desktop integration harness',
      'test:browser-profile-import:integration': 'live desktop integration harness',
      'test:computer-host:integration': 'live desktop integration harness',
      'test:computer-host:scenarios': 'live desktop scenario harness',
      'test:computer-host:repeats': 'live desktop scenario harness',
    },
  },
];

export function selectSuiteScripts(scripts, exclusions) {
  const names = Object.keys(scripts).filter((name) => /^(test|smoke)(:|$)/.test(name));
  const stale = Object.keys(exclusions).filter((name) => !names.includes(name));
  if (stale.length) {
    throw new Error(`stale exclusions (script no longer exists): ${stale.join(', ')}`);
  }
  return names.filter((name) => !(name in exclusions));
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
      const args = ['run', name, ...(ws.dir === '.' ? [] : ['--prefix', ws.dir])];
      const child = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
        encoding: 'utf8',
        shell: process.platform === 'win32',
        maxBuffer: 64 * 1024 * 1024,
      });
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (child.status === 0) {
        reportLines.push(`- ${label}: OK (${seconds}s)`);
        console.log(`${label}: OK (${seconds}s)`);
      } else {
        const tail = `${child.stdout || ''}\n${child.stderr || ''}`
          .trim().split('\n').slice(-25).join('\n');
        failures.push(`- ${label}: FAILED (${seconds}s)\n\n\`\`\`\n${tail}\n\`\`\``);
        reportLines.push(`- ${label}: FAILED (${seconds}s)`);
        console.error(`${label}: FAILED (${seconds}s)\n${tail}`);
      }
    }
  }
  console.log(`\n${reportLines.join('\n')}`);
  if (failures.length > 0) {
    const runUrl = process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : '(local run)';
    const report = [
      '# Weekly suite health sweep failed',
      '',
      `Checked: ${new Date().toISOString()}`,
      `Workflow run: ${runUrl}`,
      '',
      ...reportLines,
      '',
      ...failures,
      '',
    ].join('\n');
    writeFileSync('suite-health-report.md', report);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSweep();
}
