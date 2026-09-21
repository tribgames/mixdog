import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { build } from 'esbuild';
import React from 'react';
import { render } from 'ink';
import { AGENT_CALL_MARKER, AGENT_RESPONSE_MARKER } from '../../theme.mjs';

let directory;
let ToolExecution;
before(async () => {
  directory = mkdtempSync(resolve('.tmp-tool-execution-test-'));
  const output = join(directory, 'tool-execution.mjs');
  await build({
    entryPoints: [resolve('src/tui/components/ToolExecution.jsx')],
    outfile: output,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
  });
  ({ ToolExecution } = await import(pathToFileURL(output).href));
});
after(() => rmSync(directory, { recursive: true, force: true }));

function mountCard(context) {
  context.mock.method(Date, 'now', () => 20000);
  const stdout = new PassThrough();
  stdout.columns = 160;
  stdout.rows = 30;
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  let frame = '';
  stdout.on('data', (chunk) => {
    frame = String(chunk);
  });
  const view = render(React.createElement(ToolExecution, { name: 'read', columns: 160 }), {
    stdout,
    stdin,
    stderr: stdout,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  context.after(() => {
    view.unmount();
    stdin.end();
    stdout.end();
  });
  return async (props) => {
    view.rerender(React.createElement(ToolExecution, { columns: 160, ...props }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    return stripVTControlCharacters(frame);
  };
}

test('aggregate cards retain status, collapsed summaries and raw expansion across rerenders', async (context) => {
  const show = mountCard(context);
  const base = { aggregate: true, categories: { read: 2 }, count: 2, startedAt: 1000 };
  assert.match(await show({ ...base, completedCount: 0 }), /Running/);
  assert.match(await show({ ...base, completedCount: 2 }), /Finished/);

  const completed = {
    ...base,
    completedCount: 2,
    result: 'summary alpha\nsummary beta',
    rawResult: 'raw alpha\nraw beta',
  };
  const collapsed = await show(completed);
  assert.match(collapsed, /summary alpha summary beta/);
  assert.doesNotMatch(collapsed, /raw alpha/);
  assert.match(collapsed, /ctrl\+o expand/);
  const expanded = await show({ ...completed, expanded: true });
  assert.match(expanded, /raw alpha/);
  assert.match(expanded, /raw beta/);
  assert.doesNotMatch(expanded, /summary alpha/);
  assert.match(expanded, /ctrl\+o collapse/);
  assert.equal(await show(completed), collapsed);
});

test('normal cards preserve shell, agent and generic body selection and expansion hints', async (context) => {
  const show = mountCard(context);
  const shell = { name: 'shell', args: { command: 'echo output' }, result: 'first\nsecond' };
  const collapsedShell = await show(shell);
  assert.match(collapsedShell, /ctrl\+o expand/);
  assert.doesNotMatch(collapsedShell, /second/);
  const expandedShell = await show({ ...shell, expanded: true });
  assert.match(expandedShell, /first/);
  assert.match(expandedShell, /second/);
  assert.match(expandedShell, /ctrl\+o collapse/);
  assert.equal(await show(shell), collapsedShell);

  const request = await show({
    name: 'agent',
    args: { type: 'spawn', agent: 'worker' },
    startedAt: 1000,
  });
  assert.ok(request.trimStart().startsWith(`${AGENT_CALL_MARKER} `));
  assert.doesNotMatch(request, /ctrl\+o/);

  const response = await show({
    name: 'agent',
    args: { type: 'send', agent: 'worker', status: 'completed' },
    result: 'summary alpha\nsummary beta',
    rawResult: 'raw alpha\nraw beta',
    agentResponseAggregate: true,
    expanded: true,
  });
  assert.ok(response.trimStart().startsWith(`${AGENT_RESPONSE_MARKER} `));
  assert.match(response, /summary alpha/);
  assert.match(response, /summary beta/);
  assert.doesNotMatch(response, /raw alpha/);

  const rawOnly = await show({
    name: 'custom',
    completedCount: 1,
    rawResult: 'raw alpha\nraw beta',
    expanded: true,
  });
  assert.match(rawOnly, /raw alpha/);
  assert.match(rawOnly, /raw beta/);
  assert.doesNotMatch(await show({ name: 'load_tool', result: 'first\nsecond' }), /ctrl\+o/);
});
