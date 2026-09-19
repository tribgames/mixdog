import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runGrepPatternFanout } from './lib/grep-pattern-fanout.mjs';

test('successful combined pattern fanout performs one broad scan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-grep-fanout-'));
  let scans = 0;
  let fallbacks = 0;
  try {
    const out = await runGrepPatternFanout({
      args: {},
      patterns: ['alpha', 'beta'],
      workDir: root,
      executeChildBuiltinTool: async () => '',
      readStateScope: null,
      options: {
        __runRgWindowedLines: async () => {
          scans += 1;
          return {
            lines: ['sample.txt:1:alpha beta'],
            complete: true,
            partial: false,
            cacheSafe: true,
          };
        },
      },
      callContextCharBudget: 4_096,
      patternCapNote: '',
      searchPath: '.',
      grepResolvedPath: root,
      normalizedGlobPatterns: [],
      outputMode: 'content',
      headLimit: 10,
      offset: 0,
      caseInsensitive: false,
      showLineNumbers: true,
      beforeN: null,
      afterN: null,
      contextN: 0,
      multilineMode: false,
      pcre2Mode: false,
      fileType: '',
      executeGrepTool: async () => {
        fallbacks += 1;
        return '';
      },
    });
    assert.equal(scans, 1);
    assert.equal(fallbacks, 0);
    assert.match(out, /# grep pattern:"alpha"/);
    assert.match(out, /# grep pattern:"beta"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('nested path fanout runs patterns serially and preserves result and error order', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-grep-nested-fanout-'));
  const events = [];
  try {
    const out = await runGrepPatternFanout({
      args: {},
      patterns: ['alpha', 'beta', 'gamma'],
      workDir: root,
      executeChildBuiltinTool: async () => '',
      readStateScope: null,
      options: {
        _grepPathFanout: true,
        __runRgWindowedLines: async () => ({
          lines: ['sample.txt'],
          complete: true,
          partial: false,
        }),
      },
      callContextCharBudget: 4_096,
      patternCapNote: '',
      searchPath: '.',
      grepResolvedPath: root,
      normalizedGlobPatterns: [],
      outputMode: 'content',
      headLimit: 10,
      offset: 0,
      caseInsensitive: false,
      showLineNumbers: true,
      beforeN: null,
      afterN: null,
      contextN: 0,
      multilineMode: true,
      pcre2Mode: false,
      fileType: '',
      executeGrepTool: async ({ pattern }) => {
        events.push(`start:${pattern}`);
        await new Promise((resolve) => setImmediate(resolve));
        events.push(`end:${pattern}`);
        if (pattern === 'beta') throw new Error('beta failed');
        return `${pattern} result`;
      },
    });
    assert.deepEqual(events, ['start:alpha', 'end:alpha', 'start:beta', 'end:beta', 'start:gamma', 'end:gamma']);
    assert.equal(
      out,
      '# grep pattern:"alpha"\nalpha result\n\n# grep pattern:"beta"\nError: beta failed\n\n# grep pattern:"gamma"\ngamma result'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
