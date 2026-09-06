import { spawn } from 'node:child_process';
import { buildLiveTestPlan, liveTestHelp } from './office-live-test-plan.mjs';

let plan;
try {
  plan = buildLiveTestPlan(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n${liveTestHelp}`);
  process.exit(1);
}
if (!plan) {
  process.stdout.write(liveTestHelp);
  process.exit(0);
}
process.stdout.write(`Office 라이브 검증 시작 — ${plan.label}\n`);
const child = spawn(process.execPath, plan.args, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    MIXDOG_TEST_LIVE_OFFICE: '1',
  },
  stdio: ['inherit', 'pipe', 'pipe'],
  windowsHide: true,
});
let tapFailed = false;
let emptySelection = false;
// Forward chunks immediately; retain only a bounded line prefix for TAP status,
// not the potentially large Office snapshots printed in assertion failures.
for (const [source, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
  source.setEncoding('utf8');
  let prefix = '';
  const inspect = () => {
    if (/^(?:not ok \d+ -|# fail [1-9]\d*)/u.test(prefix)) tapFailed = true;
    // Node can wrap a filtered-out file as one passing file test after a
    // top-level empty TAP plan, so "# tests" alone is not sufficient.
    if (/^(?:# tests 0\s*$|1\.\.0(?:\s|$))/u.test(prefix)) emptySelection = true;
  };
  source.on('data', (chunk) => {
    if (!destination.write(chunk)) {
      source.pause();
      destination.once('drain', () => source.resume());
    }
    const lines = chunk.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      prefix = (prefix + lines[i]).slice(0, 1024);
      if (i < lines.length - 1) {
        inspect();
        prefix = '';
      }
    }
  });
  source.on('end', inspect);
}
child.on('error', (error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
child.on('close', (code) => {
  if (emptySelection) process.stderr.write('선택한 범위에 실행할 테스트가 없습니다.\n');
  process.exitCode = tapFailed || emptySelection ? 1 : Number.isInteger(code) ? code : 1;
});
