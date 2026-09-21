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
import stringWidth from 'string-width';

const backendKey = Symbol.for('mixdog.status-panels.test.backend');
let directory;
let panels;
before(async () => {
  directory = mkdtempSync(resolve('.tmp-status-panels-test-'));
  const output = join(directory, 'tui', 'components', 'panels.mjs');
  await Promise.all([
    build({
      stdin: {
        contents: `
          export { StatusLine } from './StatusLine.jsx';
          export { Spinner } from './Spinner.jsx';
          export { UsagePanel } from './UsagePanel.jsx';
          export { ContextPanel } from './ContextPanel.jsx';
        `,
        resolveDir: resolve('src/tui/components'),
        loader: 'jsx',
      },
      outfile: output,
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'esm',
      jsx: 'automatic',
      plugins: [
        {
          name: 'preserve-model-catalog-module-url',
          setup(build) {
            build.onResolve({ filter: /\/model-catalog\.mjs$/ }, () => ({
              path: pathToFileURL(resolve('src/runtime/agent/orchestrator/providers/model-catalog.mjs')).href,
              external: true,
            }));
          },
        },
      ],
    }),
    build({
      stdin: {
        contents: `
          export function renderStatusline(args) {
            return globalThis[Symbol.for('mixdog.status-panels.test.backend')](args);
          }
        `,
      },
      outfile: join(directory, 'ui', 'statusline.mjs'),
      platform: 'node',
      format: 'esm',
    }),
  ]);
  panels = await import(pathToFileURL(output).href);
});
after(() => rmSync(directory, { recursive: true, force: true }));

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

function mountPanel(context) {
  const stdout = new PassThrough();
  stdout.columns = 120;
  stdout.rows = 40;
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  let frame = '';
  const write = stdout.write.bind(stdout);
  stdout.write = (chunk, ...args) => {
    frame = String(chunk);
    return write(chunk, ...args);
  };
  const view = render(React.createElement(React.Fragment), {
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
  const text = () => stripVTControlCharacters(frame).trimEnd();
  return {
    text,
    show: async (Component, props) => {
      if (props.columns) {
        stdout.columns = props.columns;
        stdout.emit('resize');
      }
      view.rerender(React.createElement(Component, props));
      await settle();
      return text();
    },
    key: async (input) => {
      stdin.write(input);
      await settle();
      return text();
    },
  };
}

test('context categories conserve token sums and retain raw-window percentages at both grid widths', async (context) => {
  const view = mountPanel(context);
  const detail = {
    type: 'context',
    usage: { usedTokens: 500, windowTokens: 1000, rawWindowTokens: 1200, measurementSource: 'last_api_request' },
    messages: {
      semantic: {
        system: { tokens: 100 },
        workflow: { tokens: 50 },
        workspace: { tokens: '25' },
        environment: { tokens: 'invalid' },
        memory: { tokens: 20 },
        chat: { tokens: 10 },
        assistant: { tokens: 15 },
        toolResults: { tokens: 5 },
        reasoning: { tokens: 40 },
      },
    },
    request: {
      toolSchemaBreakdown: {
        code: { tokens: 80 },
        web: { tokens: 20 },
        mcp: { tokens: 30 },
        agents: { tokens: 10 },
        memory: { tokens: 5 },
        skills: { tokens: 15 },
      },
    },
  };
  for (const columns of [80, 120]) {
    const text = await view.show(panels.ContextPanel, { detail, columns });
    assert.match(text, /50% used/);
    assert.match(text, /System pro…\s+14\.6%.*175/);
    assert.match(text, /System too…\s+8\.3%.*100/);
    assert.match(text, /Memory fil…\s+2\.1%.*25/);
    assert.match(text, /Messages\s+2\.5%.*30/);
    assert.match(text, /Free space\s+47\.9%.*575/);
    assert.ok(text.split('\n').every((line) => stringWidth(line) <= columns));
  }
});

test('usage panels preserve loading, quota priority, credit, clipping and scroll rows', async (context) => {
  const view = mountPanel(context);
  assert.match(
    await view.show(panels.UsagePanel, { dashboard: { checking: true }, columns: 80 }),
    /Checking providers/
  );
  assert.match(await view.show(panels.UsagePanel, { dashboard: { rows: [] }, columns: 80 }), /No providers configured/);
  const row = {
    id: 'first',
    label: 'Provider label that is much too long',
    remainingUsd: 2.5,
    windows: [
      { label: '5h', usedPct: 17, source: 'provider' },
      { label: '7d', usedPct: 0, source: 'provider' },
      { label: '30d', usedPct: 41, source: 'provider' },
    ],
  };
  const wide = await view.show(panels.UsagePanel, { dashboard: { rows: [row] }, columns: 120 });
  assert.match(wide, /5H 17%.*7D 0%.*30D 41%.*Credit \$2\.50/);
  const narrow = await view.show(panels.UsagePanel, { dashboard: { rows: [row] }, columns: 40 });
  assert.match(narrow, /Provider label th…/);
  assert.match(narrow, /30D 41%/);
  assert.doesNotMatch(narrow, /5H 17%|Credit/);
  assert.ok(narrow.split('\n').every((line) => stringWidth(line) <= 40));
  await view.show(panels.UsagePanel, {
    dashboard: { rows: [row, { id: 'second', label: 'Second' }, { id: 'third', label: 'Third' }] },
    columns: 80,
    panelRows: 8,
  });
  const scrolled = await view.key('\x1b[B');
  assert.match(scrolled, /Second/);
  assert.match(scrolled, /Third/);
  assert.doesNotMatch(scrolled, /Provider label/);
});

test('spinner separators, pause accounting and width gating retain their output', async (context) => {
  const previousMotion = process.env.MIXDOG_REDUCED_MOTION;
  context.after(() => {
    if (previousMotion === undefined) delete process.env.MIXDOG_REDUCED_MOTION;
    else process.env.MIXDOG_REDUCED_MOTION = previousMotion;
  });
  process.env.MIXDOG_REDUCED_MOTION = '1';
  let now = 10000;
  context.mock.method(Date, 'now', () => now);
  const view = mountPanel(context);
  const props = {
    startedAt: 1000,
    outputTokens: 12,
    thinking: true,
    effort: 'high',
    interruptible: true,
    mode: 'requesting',
    columns: 160,
    marginTop: 0,
  };
  assert.ok(
    (await view.show(panels.Spinner, props)).endsWith('(9s · ↑ 12 tokens · thinking (high) · esc to interrupt)')
  );
  await view.show(panels.Spinner, { ...props, paused: true });
  now = 15000;
  assert.match(await view.show(panels.Spinner, { ...props, paused: true }), /\(9s ·/);
  await view.show(panels.Spinner, { ...props, paused: false });
  now = 16000;
  const resumed = await view.show(panels.Spinner, {
    ...props,
    mode: 'responding',
    thinking: false,
    thinkingMs: 4000,
  });
  assert.ok(resumed.endsWith('(10s · ↓ 12 tokens · thought for 4s · esc to interrupt)'));
  const narrow = await view.show(panels.Spinner, {
    ...props,
    mode: 'compacting',
    thinking: false,
    columns: 52,
  });
  assert.ok(narrow.endsWith('(10s · esc to interrupt)'));
  assert.doesNotMatch(narrow, /tokens/);
  process.env.MIXDOG_REDUCED_MOTION = '0';
  assert.match(await view.show(panels.Spinner, { ...props, mode: 'responding' }), /thinking \(high\)/);
});

test('statusline retains measured context, cached quotas, route updates and stale-result rejection', async (context) => {
  let now = 10000;
  context.mock.method(Date, 'now', () => now);
  const calls = [];
  let completeOld;
  globalThis[backendKey] = (args) => {
    calls.push(args);
    if (args.model === 'old-request') {
      return new Promise((resolve) => {
        completeOld = resolve;
      });
    }
    return `FULL ${args.model} │ 5H 17%`;
  };
  context.after(() => delete globalThis[backendKey]);
  const view = mountPanel(context);
  const base = {
    sessionId: 'status-panels-test',
    provider: 'openai',
    model: 'model-one',
    stats: { currentContextTokens: 800, currentContextSource: 'last_api_request', inputTokens: 999999 },
    contextWindow: 1000,
    displayContextWindow: 2000,
    rawContextWindow: 5000,
    compactBoundaryTokens: 100,
    autoCompactTokenLimit: 90,
  };
  assert.match(await view.show(panels.StatusLine, base), /80%/);
  now = 13000;
  await settle(250);
  assert.match(view.text(), /FULL model-one.*5H 17%/);
  const changed = { ...base, compactBoundaryTokens: 500, agentRevision: 'changed' };
  assert.match(await view.show(panels.StatusLine, changed), /FULL model-one.*5H 17%/);
  await settle(120);
  assert.equal(calls.at(-1).compactBoundaryTokens, 500);
  const routed = { ...changed, model: 'model-two', contextWindow: 0 };
  assert.match(await view.show(panels.StatusLine, routed), /40%/);
  await settle(120);
  assert.match(view.text(), /FULL model-two.*5H 17%/);
  await view.show(panels.StatusLine, { ...routed, model: 'old-request' });
  await settle(120);
  await view.show(panels.StatusLine, { ...routed, model: 'new-request' });
  completeOld('STALE FOOTER');
  await settle(20);
  assert.doesNotMatch(view.text(), /STALE FOOTER/);
  assert.ok(view.text().split('\n').length <= 2);
});
