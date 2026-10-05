import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { build } from 'esbuild';
import React from 'react';
import { render } from 'ink';
import stringWidth from 'string-width';
import { waitUntil } from '../runtime/shared/wait-until.test-support.mjs';

test('TUI inspector navigates metadata, fetches on Enter, and bounds narrow previews', async (context) => {
  // The bundle is written inside the project so its imports resolve against
  // the repository's own node_modules; a fresh checkout has no .tmp yet.
  mkdirSync(resolve('.tmp'), { recursive: true });
  const directory = mkdtempSync(resolve('.tmp/context-inspector-test-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'inspector.mjs');
  await build({
    entryPoints: [resolve('src/tui/components/ContextPanel.jsx')],
    outfile: output,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
  });
  const { ContextPanel } = await import(pathToFileURL(output).href);
  const stdout = new PassThrough();
  stdout.columns = 40;
  stdout.rows = 20;
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  let screen = '';
  // Ink's debug stream emits complete frames without a separating newline.
  stdout.on('data', (chunk) => {
    screen = String(chunk);
  });
  const calls = [];
  const inspection = {
    revision: 'tui-first',
    categories: [{ key: 'system', label: 'System prompt', tokens: 20, count: 1 }],
    entries: [{ id: 'message:0', category: 'system', label: 'Instructions', tokens: 20 }],
  };
  const view = render(
    React.createElement(ContextPanel, {
      columns: 40,
      panelRows: 22,
      detail: {
        type: 'context',
        inspection,
        usage: { usedTokens: 30, windowTokens: 100, rawWindowTokens: 120, measurementSource: 'last_api_request' },
      },
      onInspect: async (id, revision) => {
        calls.push({ id, revision });
        return { text: `PRIVATE_PREVIEW\n${'한글 내용 '.repeat(50)}` };
      },
    }),
    { stdout, stdin, stderr: stdout, debug: true, exitOnCtrlC: false, patchConsole: false }
  );
  context.after(() => {
    view.unmount();
    stdin.end();
    stdout.end();
  });
  const painted = (predicate, message) => waitUntil(() => predicate(screen), { message });
  await painted((frame) => frame !== '', 'first frame');
  assert.equal(calls.length, 0);
  assert.doesNotMatch(screen, /PRIVATE_PREVIEW/);
  stdin.write('\r');
  await painted((frame) => /Instructions/.test(frame), 'metadata frame');
  assert.match(screen, /Instructions/);
  assert.equal(calls.length, 0);
  screen = '';
  stdin.write('\r');
  await painted((frame) => /PRIVATE_PREVIEW/.test(frame), 'preview frame');
  assert.deepEqual(calls, [{ id: 'message:0', revision: 'tui-first' }]);
  assert.match(screen, /PRIVATE_PREVIEW/);
  const lines = stripVTControlCharacters(screen).split('\n');
  assert.deepEqual(
    lines.filter((line) => stringWidth(line) > 40),
    [],
    'preview stays within the available width'
  );
  screen = '';
  stdin.write('\x1b[D');
  await painted((frame) => /Instructions/.test(frame) && !/PRIVATE_PREVIEW/.test(frame), 'metadata frame again');
  assert.match(screen, /Instructions/);
  assert.doesNotMatch(screen, /PRIVATE_PREVIEW/);
});
