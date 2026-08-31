import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultTestPath = fileURLToPath(new URL('../src/runtime/office/office-live-runtime.test.mjs', import.meta.url));
const testPath = process.argv[2] ? resolve(process.argv[2]) : defaultTestPath;
const child = spawnSync(process.execPath, ['--test', testPath], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    MIXDOG_TEST_LIVE_OFFICE: '1',
  },
  stdio: ['inherit', 'pipe', 'pipe'],
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
  windowsHide: true,
});
const tapFailurePattern = /(?:^|[\r\n])not ok \d+ -|(?:^|[\r\n])# fail [1-9]\d*(?:[\r\n]|$)/m;
const stdout = child.stdout || '';
const stderr = child.stderr || '';
process.stdout.write(stdout);
process.stderr.write(stderr);
if (child.error) {
  process.stderr.write(`${child.error?.stack || child.error}\n`);
  process.exit(1);
}
const tapFailed = tapFailurePattern.test(`${stdout}\n${stderr}`);
process.exit(tapFailed ? 1 : Number.isInteger(child.status) ? child.status : 1);
