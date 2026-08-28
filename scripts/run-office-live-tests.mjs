import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testPath = fileURLToPath(new URL('../src/runtime/office/office-live-runtime.test.mjs', import.meta.url));
const child = spawn(process.execPath, ['--test', testPath], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    MIXDOG_TEST_LIVE_OFFICE: '1',
  },
  stdio: 'inherit',
  windowsHide: true,
});
child.once('error', (error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
child.once('close', (code) => {
  process.exit(Number.isInteger(code) ? code : 1);
});
