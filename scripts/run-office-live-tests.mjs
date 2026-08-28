import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testPath = fileURLToPath(new URL('../src/runtime/office/office-live-runtime.test.mjs', import.meta.url));
const child = spawn(process.execPath, ['--test', testPath], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    MIXDOG_TEST_LIVE_OFFICE: '1',
  },
  stdio: ['inherit', 'pipe', 'pipe'],
  windowsHide: true,
});
let tapFailed = false;
let tail = '';
const forward = (stream, target) => {
  stream.on('data', (chunk) => {
    const text = chunk.toString();
    target.write(text);
    tail = `${tail}${text}`.slice(-16_384);
    if (/(?:^|\n)not ok \d+ -/m.test(tail)) tapFailed = true;
  });
};
forward(child.stdout, process.stdout);
forward(child.stderr, process.stderr);
child.once('error', (error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
child.once('close', (code) => {
  process.exit(tapFailed ? 1 : Number.isInteger(code) ? code : 1);
});
