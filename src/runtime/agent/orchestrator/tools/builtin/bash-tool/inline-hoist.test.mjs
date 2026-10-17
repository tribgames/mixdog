import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import test from 'node:test';

import { hoistInlineScript } from './inline-hoist.mjs';

test('inline scripts hoisted in the same millisecond keep separate files', (t) => {
  t.mock.method(Date, 'now', () => 1_792_183_386_056);
  const first = hoistInlineScript(`node -e "process.exit(5)"`, 'powershell');
  const second = hoistInlineScript(`node -e "console.log('second')"`, 'powershell');
  t.after(() => {
    for (const path of [first.hoistPath, second.hoistPath]) if (path) rmSync(path, { force: true });
  });
  assert.ok(first.hoistPath && second.hoistPath, 'both commands are hoisted');
  assert.notEqual(first.hoistPath, second.hoistPath);
  assert.equal(readFileSync(first.hoistPath, 'utf8'), 'process.exit(5)');
  assert.equal(readFileSync(second.hoistPath, 'utf8'), "console.log('second')");
});

test('a script that loads a package stays inline, where the working directory resolves it', (t) => {
  for (const command of [
    `node -e "const p = require('puppeteer-core'); console.log(p)"`,
    `node -e "console.log(require('electron/package.json').version)"`,
    `node --input-type=module -e "import { chromium } from 'playwright'; console.log(chromium)"`,
    `node -e "import('ws').then(console.log)"`,
    `node -e "console.log(require.resolve('typescript'))"`,
    `node -e "const name = 'typescript'; console.log(require(name).version)"`,
  ]) {
    const result = hoistInlineScript(command, 'powershell');
    t.after(() => result.hoistPath && rmSync(result.hoistPath, { force: true }));
    assert.equal(result.hoistPath, null, command);
    assert.equal(result.command, command);
  }
  const builtin = hoistInlineScript(
    `node -e "const fs = require('node:fs'); require('os'); console.log(fs)"`,
    'powershell'
  );
  t.after(() => builtin.hoistPath && rmSync(builtin.hoistPath, { force: true }));
  assert.ok(builtin.hoistPath, 'Node builtins resolve the same from any directory');
});
