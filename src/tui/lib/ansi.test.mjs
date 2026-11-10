import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

function renderColors(environment) {
  const env = { ...process.env, FORCE_COLOR: '1', ...environment };
  delete env.NO_COLOR;
  const script = `
    import { rgb, rgbSgr } from ${JSON.stringify(new URL('./ansi.mjs', import.meta.url).href)};
    process.stdout.write(JSON.stringify([
      rgbSgr(255, 0, 0),
      rgbSgr(255, 0, 0, true),
      rgb(255, 0, 0)('text'),
    ]));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' }));
}

test('Apple Terminal uses the xterm palette even when other environment signals advertise truecolor', () => {
  assert.deepEqual(
    renderColors({
      TERM_PROGRAM: ' Apple_Terminal ',
      COLORTERM: 'truecolor',
      WT_SESSION: 'session',
      TERM: 'xterm-direct',
    }),
    ['\x1b[38;5;196m', '\x1b[48;5;196m', '\x1b[38;5;196mtext\x1b[0m']
  );
});

test('unknown terminals retain truecolor without positive capability signals', () => {
  assert.deepEqual(renderColors({ TERM_PROGRAM: 'unknown', COLORTERM: '', WT_SESSION: '', TERM: '' }), [
    '\x1b[38;2;255;0;0m',
    '\x1b[48;2;255;0;0m',
    '\x1b[38;2;255;0;0mtext\x1b[0m',
  ]);
});
