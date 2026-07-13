import assert from 'node:assert/strict';
import test from 'node:test';

import {
  brightGreen,
  refreshColorSupport,
  rgb,
  rgbBg,
  rgbSgr,
  rgbToAnsi256,
  supportsTruecolor,
} from '../src/ui/ansi.mjs';
import {
  remapCanonicalStatuslineTruecolor,
  STATUSLINE_CANONICAL_TRUECOLOR,
} from '../src/tui/statusline-ansi-bridge.mjs';

const savedEnv = {
  COLORTERM: process.env.COLORTERM,
  FORCE_COLOR: process.env.FORCE_COLOR,
  NO_COLOR: process.env.NO_COLOR,
  TERM: process.env.TERM,
  TERM_PROGRAM: process.env.TERM_PROGRAM,
  WT_SESSION: process.env.WT_SESSION,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  refreshColorSupport();
}

test.after(restoreEnv);

test('truecolor capability detection preserves known positives and defaults unknown to truecolor', () => {
  assert.equal(supportsTruecolor({ TERM_PROGRAM: 'Apple_Terminal', COLORTERM: 'truecolor' }, 'darwin'), false);
  assert.equal(supportsTruecolor({ COLORTERM: 'truecolor' }, 'darwin'), true);
  assert.equal(supportsTruecolor({ COLORTERM: '24bit' }, 'linux'), true);
  assert.equal(supportsTruecolor({ WT_SESSION: 'abc' }, 'linux'), true);
  assert.equal(supportsTruecolor({ TERM_PROGRAM: 'iTerm.app' }, 'darwin'), true);
  assert.equal(supportsTruecolor({ TERM_PROGRAM: 'WezTerm' }, 'darwin'), true);
  assert.equal(supportsTruecolor({ TERM_PROGRAM: 'ghostty' }, 'darwin'), true);
  assert.equal(supportsTruecolor({ TERM_PROGRAM: 'vscode' }, 'darwin'), true);
  assert.equal(supportsTruecolor({ TERM: 'xterm-direct' }, 'linux'), true);
  assert.equal(supportsTruecolor({}, 'win32'), true);
  assert.equal(supportsTruecolor({}, 'linux'), true);
});

test('RGB helpers are byte-identical in truecolor mode and downsample foreground/background on Apple Terminal', () => {
  process.env.FORCE_COLOR = '1';
  delete process.env.NO_COLOR;
  process.env.COLORTERM = 'truecolor';
  delete process.env.TERM_PROGRAM;
  refreshColorSupport();

  assert.equal(rgb(215, 119, 87)('x'), '\x1b[38;2;215;119;87mx\x1b[0m');
  assert.equal(rgbBg(55, 55, 55)('x'), '\x1b[48;2;55;55;55mx\x1b[0m');

  process.env.TERM_PROGRAM = 'Apple_Terminal';
  assert.equal(rgbSgr(215, 119, 87), '\x1b[38;5;173m');
  assert.equal(rgb(215, 119, 87)('x'), '\x1b[38;5;173mx\x1b[0m');
  assert.equal(rgbBg(55, 55, 55)('x'), '\x1b[48;5;237mx\x1b[0m');
  assert.equal(brightGreen('x'), '\x1b[38;5;35mx\x1b[0m');
});

test('RGB to ANSI-256 conversion selects the nearest cube or grayscale entry', () => {
  assert.equal(rgbToAnsi256(0, 170, 75), 35);
  assert.equal(rgbToAnsi256(198, 198, 198), 251);
  assert.equal(rgbToAnsi256(136, 136, 136), 102);
  assert.equal(rgbToAnsi256(255, 255, 255), 231);
});

test('statusline theme remap recognizes canonical 256-color variants', () => {
  const colors = {
    STATUS: '<status>',
    SUBTLE: '<subtle>',
    SUCCESS: '<success>',
    WARNING: '<warning>',
    ERROR: '<error>',
  };
  const success256 = `\x1b[38;5;${rgbToAnsi256(...STATUSLINE_CANONICAL_TRUECOLOR.success)}m`;
  const warning256 = `\x1b[38;5;${rgbToAnsi256(...STATUSLINE_CANONICAL_TRUECOLOR.warningBright)}m`;
  const input = `${success256}ok ${warning256}warn`;
  assert.equal(
    remapCanonicalStatuslineTruecolor(input, colors),
    '<success>ok <warning>warn',
  );
});
