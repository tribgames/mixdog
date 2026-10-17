import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import { CompletionStatus, completionActivityKey, hadLiveActivity } from './transcript-status.tsx';
import { appendLiveTranscriptRows, projectSettledTranscriptRows } from './transcript-rows.ts';
import {
  desktopToolActivityCategory,
  desktopToolActivityItemPresentation,
  flattenedToolActivityItems,
  formatTokenCount,
  LiveActivity,
  transcriptItemsEqual,
  ToolActivityGroup,
} from './TranscriptView.tsx';

function installToolActivityDom(userAgent) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  });
  Object.defineProperty(dom.window.navigator, 'userAgent', {
    configurable: true,
    value: userAgent,
  });
  Object.defineProperty(dom.window.navigator, 'maxTouchPoints', {
    configurable: true,
    value: /Mobile/.test(userAgent) ? 5 : 0,
  });
  Object.defineProperty(dom.window.screen, 'width', {
    configurable: true,
    value: /Mobile/.test(userAgent) ? 390 : 1440,
  });
  Object.defineProperty(dom.window.screen, 'height', {
    configurable: true,
    value: /Mobile/.test(userAgent) ? 844 : 900,
  });
  const previous = new Map(
    ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ])
  );
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return {
    window: dom.window,
    root: createRoot(dom.window.document.getElementById('root')),
    close() {
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

function project(items, turnKeys = items.map(() => 'turn')) {
  return projectSettledTranscriptRows({
    sessionKey: 'session',
    items,
    turnKeys,
    failedTurns: new Set(),
  });
}

test('the running logo animates its star on its own <svg>, never an SVG-internal transform', async () => {
  // A CSS transform animation on an element INSIDE an <svg> forced a layout
  // every animation frame for as long as a turn ran (measured: LayoutCount
  // equal to the frame count). On its own <svg> box it is a plain CSS transform.
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('./desktop/14-live-activity.css', import.meta.url), 'utf8');
  const tsx = await readFile(new URL('./transcript-status.tsx', import.meta.url), 'utf8');
  assert.match(css, /\.live-activity-star\s*\{[^}]*animation:\s*live-activity-logo-star/);
  assert.doesNotMatch(css, /\.live-activity-logo \.star\s*\{[^}]*animation:/);
  assert.match(tsx, /className="live-activity-logo live-activity-star"/);
});

test('transcript row memoization retains no value-copy signature', () => {
  const item = { kind: 'assistant', text: 'large tool output' };
  assert.equal(transcriptItemsEqual(item, item), true);
  assert.equal(transcriptItemsEqual(item, { ...item }), false);
});

test('a running tool shows its elapsed time from the transcript `at` start', async () => {
  const dom = installToolActivityDom('Mozilla/5.0 Electron/41.0.0');
  try {
    await act(async () => {
      dom.root.render(
        React.createElement(ToolActivityGroup, {
          disclosureScope: 'elapsed',
          // Transcript items carry their start as `at` (no `startedAt`).
          items: [{ kind: 'tool', id: 'sh', name: 'shell', args: { command: 'npm test' }, at: Date.now() - 12_000 }],
        })
      );
    });
    const elapsed = document.querySelector('.tool-activity-header .tool-working-elapsed');
    assert.ok(elapsed, 'elapsed time is shown once a call runs past 5s');
    assert.match(elapsed.textContent, /1[12]/);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('desktop and mobile tool groups share details and a plain summary line', async () => {
  const userAgents = [
    'Mozilla/5.0 Electron/41.0.0',
    'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36',
  ];
  for (const userAgent of userAgents) {
    const dom = installToolActivityDom(userAgent);
    try {
      await act(async () => {
        dom.root.render(
          React.createElement(ToolActivityGroup, {
            disclosureScope: userAgent,
            items: [
              {
                kind: 'tool',
                id: 'read',
                name: 'read',
                args: { file_path: 'src/a.ts' },
                startedAt: Date.now(),
              },
            ],
          })
        );
      });
      const group = document.querySelector('.tool-activity');
      assert.equal(group?.dataset.surface, 'desktop');
      // No leading glyph and no trailing dots: the title carries the state.
      assert.equal(group?.querySelector('.tool-activity-header .tool-icon'), null);
      assert.equal(group?.querySelector('.tool-working-dots'), null);
      assert.equal(group?.querySelector('.tool-activity-item-spinner'), null);
      assert.equal(group?.querySelector('.live-activity-logo'), null);

      await act(async () => {
        group
          ?.querySelector('.tool-activity-header')
          ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      });
      assert.equal(group?.querySelectorAll('.tool-activity-details').length, 1);
      assert.equal(group?.querySelectorAll('.tool-activity-item').length, 1);
      assert.equal(group?.querySelectorAll('.tool-card').length, 0);
    } finally {
      await act(async () => dom.root.unmount());
      dom.close();
    }
  }
});

test('desktop activity shows repeated tool counts in natural phrase summary', async () => {
  const dom = installToolActivityDom('Mozilla/5.0 Electron/41.0.0');
  try {
    await act(async () => {
      dom.root.render(
        React.createElement(ToolActivityGroup, {
          items: [
            { kind: 'tool', id: 'read', name: 'read', args: { file_path: 'src/a.ts' }, result: 'ok' },
            { kind: 'tool', id: 'grep-1', name: 'grep', args: { pattern: 'first' }, result: 'ok' },
            { kind: 'tool', id: 'grep-2', name: 'grep', args: { pattern: 'second' }, result: 'ok' },
          ],
        })
      );
    });

    const title = document.querySelector('.tool-activity-title')?.textContent?.trim() || '';
    assert.equal(title, 'Read file, Search 2 patterns');
    assert.doesNotMatch(title, /×/);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('formats desktop token counts with compact uppercase units', () => {
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(78_087), '78.1K');
  assert.equal(formatTokenCount(272_000), '272K');
  assert.equal(formatTokenCount(1_200_000), '1.2M');
});

test('groups consecutive mixed-category tools into one activity row', () => {
  const shell = { kind: 'tool', id: 'shell', name: 'shell', result: 'ok' };
  const search = { kind: 'tool', id: 'search', name: 'grep', result: 'ok' };
  const rows = project([shell, search]).rows;

  assert.equal(rows.length, 1);
  assert.equal(rows[0]._tag, 'ToolActivity');
  assert.deepEqual(rows[0].items, [shell, search]);
});

test('Goal and load control tools stay hidden while ordinary tools remain visible', () => {
  const visible = { kind: 'tool', id: 'read', name: 'read', result: 'ok' };
  const hiddenNames = ['goal', 'create_goal', 'get_goal', 'set_goal_tasks', 'update_goal', 'load_tool', 'tool_search'];
  const hidden = hiddenNames.map((name, index) => ({
    kind: 'tool',
    id: `hidden-${index}`,
    name,
    result: 'ok',
  }));
  // Built-in skill loads hide by their result stub; user/plugin skills show.
  const builtinSkill = {
    kind: 'tool',
    id: 'skill-builtin',
    name: 'Skill',
    args: { name: 'docx' },
    result: 'Loaded built-in skill: docx',
  };
  const userSkill = {
    kind: 'tool',
    id: 'skill-user',
    name: 'Skill',
    args: { name: 'mixdog-refs' },
    result: 'Loaded skill: mixdog-refs',
  };
  const rows = project([...hidden, builtinSkill, userSkill, visible]).rows;

  assert.equal(rows.length, 1);
  assert.equal(rows[0]._tag, 'ToolActivity');
  assert.deepEqual(rows[0].items, [userSkill, visible]);
  assert.equal(project(hidden).rows.length, 0);
});

test('a visible assistant message seals the current tool activity run', () => {
  const first = { kind: 'tool', id: 'first', name: 'read', result: 'ok' };
  const message = { kind: 'assistant', id: 'message', text: 'Next check.' };
  const second = { kind: 'tool', id: 'second', name: 'shell', result: 'ok' };
  const rows = project([first, message, second]).rows;

  assert.deepEqual(
    rows.map((row) => row._tag),
    ['ToolActivity', 'AssistantPart', 'ToolActivity']
  );
  assert.deepEqual(rows[0].items, [first]);
  assert.deepEqual(rows[2].items, [second]);
});

test('thinking row keeps its key when the optimistic prompt settles', () => {
  const id = 'sub-1';
  const pending = appendLiveTranscriptRows({
    sessionKey: 'session',
    settled: project([]),
    pendingItems: [{ kind: 'user', id, text: 'hi', submittedAt: 1_000 }],
    thinking: true,
  });
  const settled = appendLiveTranscriptRows({
    sessionKey: 'session',
    settled: project([{ kind: 'user', id, text: 'hi' }], [`turn:${id}`]),
    thinking: true,
  });
  const pendingKey = pending.find((row) => row._tag === 'Thinking')?.key;
  const settledKey = settled.find((row) => row._tag === 'Thinking')?.key;
  const next = appendLiveTranscriptRows({
    sessionKey: 'session',
    settled: project([{ kind: 'user', id: 'sub-2', text: 'next' }], ['turn:sub-2']),
    thinking: true,
  });

  assert.equal(pendingKey, 'session:thinking:sub-1');
  assert.equal(settledKey, pendingKey);
  assert.notEqual(next.find((row) => row._tag === 'Thinking')?.key, pendingKey);
});

test('turn gap keeps its key when the optimistic prompt settles', () => {
  const previous = [
    { kind: 'user', id: 'sub-0', text: 'first' },
    { kind: 'assistant', id: 'reply-0', text: 'done' },
  ];
  const previousTurns = ['turn:sub-0', 'turn:sub-0'];
  const pending = appendLiveTranscriptRows({
    sessionKey: 'session',
    settled: project(previous, previousTurns),
    pendingItems: [{ kind: 'user', id: 'sub-1', text: 'hi', submittedAt: 1_000 }],
    thinking: true,
  });
  const settled = appendLiveTranscriptRows({
    sessionKey: 'session',
    settled: project([...previous, { kind: 'user', id: 'sub-1', text: 'hi' }], [...previousTurns, 'turn:sub-1']),
    thinking: true,
  });
  const gapKeys = (rows) => rows.filter((row) => row._tag === 'TurnGap').map((row) => row.key);

  assert.deepEqual(gapKeys(pending), ['session:gap:sub-1']);
  assert.deepEqual(gapKeys(settled), gapKeys(pending));
});

test('the thinking clock keeps the submit time when the spinner arrives', async () => {
  const dom = installToolActivityDom('Mozilla/5.0 Electron/41.0.0');
  const secondsOf = (text) => Number((String(text || '').match(/\d+/) || [])[0] || 0);
  try {
    await act(async () => {
      dom.root.render(
        React.createElement(LiveActivity, {
          snapshot: {},
          optimisticStartedAt: Date.now() - 4_000,
        })
      );
    });
    const before = secondsOf(document.querySelector('.live-activity-meta')?.textContent);
    await act(async () => {
      dom.root.render(
        React.createElement(LiveActivity, {
          snapshot: { spinner: { active: true, startedAt: Date.now(), mode: 'requesting' } },
          optimisticStartedAt: 0,
        })
      );
    });
    const after = secondsOf(document.querySelector('.live-activity-meta')?.textContent);
    assert.ok(before >= 3);
    assert.ok(after >= 3);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('only the completion of a live activity turn in this view animates', async () => {
  const dom = installToolActivityDom('Mozilla/5.0 Electron/41.0.0');
  const item = { kind: 'turndone', status: 'complete', elapsedMs: 20_000 };
  const animated = () => document.querySelector('.turn-status')?.getAttribute('data-animate') === 'true';
  try {
    await act(async () => {
      dom.root.render(
        React.createElement(LiveActivity, {
          snapshot: { sessionId: 'live-s', spinner: { active: true, startedAt: Date.now(), mode: 'requesting' } },
          turnKey: 'live-t',
        })
      );
    });
    assert.equal(hadLiveActivity('live-s', 'live-t'), true);
    assert.equal(hadLiveActivity('live-s', 'old-t'), false);
    assert.equal(hadLiveActivity('other-s', 'live-t'), false);
    // The completion replaces the live band at once, with no unmount grace.
    await act(async () => {
      dom.root.render(
        React.createElement(CompletionStatus, {
          item,
          animateComplete: hadLiveActivity('live-s', 'live-t'),
          completionActivityKey: completionActivityKey('live-s', 'live-t'),
        })
      );
    });
    assert.equal(animated(), true);
    assert.equal(hadLiveActivity('live-s', 'live-t'), false, 'completion consumes the live turn');
    await act(async () => {
      dom.root.render(
        React.createElement(CompletionStatus, {
          key: 'reentered',
          item,
          animateComplete: true,
          completionActivityKey: completionActivityKey('live-s', 'live-t'),
        })
      );
    });
    assert.equal(animated(), false, 'even a stale animation prop cannot replay a completed turn');
    await act(async () => {
      dom.root.render(
        React.createElement(CompletionStatus, {
          key: 'history',
          item,
          animateComplete: hadLiveActivity('live-s', 'old-t'),
        })
      );
    });
    assert.equal(animated(), false);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('thinking remains a separate row after grouped tool activity', () => {
  const settled = project([{ kind: 'tool', id: 'tool', name: 'shell', result: 'ok' }]);
  const rows = appendLiveTranscriptRows({
    sessionKey: 'session',
    settled,
    thinking: true,
  });

  assert.deepEqual(
    rows.map((row) => row._tag),
    ['ToolActivity', 'Thinking']
  );
});

test('desktop activity expansion flattens aggregate members in call order', () => {
  const read = { kind: 'tool', id: 'read', name: 'read', args: { file_path: 'a.ts' }, result: 'A' };
  const search = { kind: 'tool', id: 'search', name: 'grep', args: { pattern: 'x' }, result: 'B' };
  const shell = { kind: 'tool', id: 'shell', name: 'shell', result: 'C' };
  const aggregate = {
    kind: 'tool',
    id: 'aggregate',
    aggregate: true,
    toolMembers: [read, search],
  };

  assert.deepEqual(flattenedToolActivityItems([aggregate, shell]), [read, search, shell]);
});

test('desktop activity uses concrete control, MCP server, and skill names', () => {
  assert.equal(
    desktopToolActivityItemPresentation({
      kind: 'tool',
      id: 'browser-item',
      name: 'browser',
      args: { action: 'open' },
      result: 'ok',
    }).title,
    'Browser Use'
  );
  assert.equal(
    desktopToolActivityItemPresentation({
      kind: 'tool',
      id: 'skill-item',
      name: 'Skill',
      args: { name: 'gamerscroll-article' },
      result: 'ok',
    }).title,
    'Skill gamerscroll-article'
  );
});

test('a bridged call presents as the tool it runs, with via call_tool', async () => {
  const { desktopToolActivitySummary } = await import('./transcript-tool-core.ts');
  const direct = {
    kind: 'tool',
    id: 'direct',
    name: 'web_fetch',
    args: { url: 'https://example.test/page' },
    result: 'page body',
  };
  const bridged = {
    ...direct,
    id: 'bridged',
    name: 'call_tool',
    args: { name: 'web_fetch', arguments: { url: 'https://example.test/page' } },
  };
  const directView = desktopToolActivityItemPresentation(direct);
  const bridgedView = desktopToolActivityItemPresentation(bridged);
  assert.equal(directView.via, undefined);
  assert.equal(bridgedView.via, 'call_tool');
  for (const key of ['category', 'title', 'verb', 'subject', 'resultLabel', 'outputText']) {
    assert.deepEqual(bridgedView[key], directView[key], key);
  }
  assert.equal(bridgedView.category, 'Web Research');
  assert.equal(desktopToolActivityCategory('call_tool', bridged.args), 'Web Research');
  assert.equal(desktopToolActivitySummary([bridged]), desktopToolActivitySummary([direct]));
  // The transcript item itself keeps the wire call.
  assert.equal(bridged.name, 'call_tool');
});

test('a bridge load_tool result reads as described / missing / blocked, never tool loading', async () => {
  const { desktopToolActivitySummary } = await import('./transcript-tool-core.ts');
  const describe = {
    kind: 'tool',
    id: 'describe',
    name: 'load_tool',
    args: { names: ['web_fetch', 'nope', 'shell'] },
    result: JSON.stringify({
      entries: [{ name: 'web_fetch', pointer: '', schemaRevision: 'r1', complete: true, document: {} }],
      missing: ['nope'],
      blocked: [{ name: 'shell', reason: 'readonly mode' }],
      nextCursor: null,
    }),
  };
  const view = desktopToolActivityItemPresentation(describe);
  assert.equal(view.title, 'Tool description');
  assert.equal(view.subject, 'web_fetch');
  assert.equal(view.resultLabel, 'Missing: nope · Blocked: shell');
  assert.equal(desktopToolActivitySummary([describe]), 'Tool description 3');
  const loader = {
    ...describe,
    id: 'loader',
    result: JSON.stringify({ selected: { tools: { added: ['web_fetch'] } }, loaded: ['web_fetch'] }),
  };
  assert.equal(desktopToolActivityItemPresentation(loader).title, 'Tool loading');
  assert.equal(desktopToolActivitySummary([loader]), 'Tool loading 3');
});

test('a continued bridge describe and a retired search_tools call from an old transcript still present', async () => {
  const { desktopToolActivitySummary } = await import('./transcript-tool-core.ts');
  // The rest of a large definition: names holds the continuation token.
  const continued = {
    kind: 'tool',
    id: 'continued',
    name: 'load_tool',
    args: { names: '@continue:eyJ2IjoxfQ' },
    result: JSON.stringify({
      entries: [{ name: 'mcp__big__configure', schemaRevision: 'r1', complete: true, offset: 100, jsonTextChunk: '}' }],
      missing: [],
      blocked: [],
      note: 'Run a deferred tool with call_tool {name, arguments}.',
      continueWith: null,
    }),
  };
  const continuedView = desktopToolActivityItemPresentation(continued);
  assert.equal(continuedView.title, 'Tool description');
  assert.equal(continuedView.subject, 'mcp__big__configure');
  const searchResult = JSON.stringify({
    tools: [{ name: 'web_fetch', description: 'Fetch a page.' }],
    nextCursor: null,
  });
  // Sessions written while search_tools existed keep their calls.
  const retired = {
    kind: 'tool',
    id: 'retired',
    name: 'search_tools',
    args: { query: 'fetch page' },
    result: searchResult,
  };
  const retiredView = desktopToolActivityItemPresentation(retired);
  assert.ok(retiredView.title);
  assert.ok(desktopToolActivitySummary([retired]));
  assert.equal(retired.name, 'search_tools');
});

test('desktop activity lists every call as one row under the summary, without category folders', async () => {
  const dom = installToolActivityDom('Mozilla/5.0 Electron/41.0.0');
  try {
    await act(async () => {
      dom.root.render(
        React.createElement(ToolActivityGroup, {
          items: [
            { kind: 'tool', id: 'grep-1', name: 'grep', args: { pattern: 'first' }, result: 'ok', completedAt: 1 },
            { kind: 'tool', id: 'grep-2', name: 'grep', args: { pattern: 'second' }, result: 'ok', completedAt: 1 },
            {
              kind: 'tool',
              id: 'shell',
              name: 'shell',
              args: { command: 'npm test' },
              result: 'Error: tests failed',
              isError: true,
              completedAt: 1,
            },
          ],
        })
      );
    });
    const group = document.querySelector('.tool-activity');
    assert.equal(group?.querySelector('.tool-activity-title')?.textContent?.trim(), 'Search 2 patterns, Run 1 command');
    assert.equal(group?.querySelector('.tool-activity-failed'), null);

    await act(async () => {
      group
        ?.querySelector('.tool-activity-header')
        ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(group?.querySelectorAll('.tool-activity-category').length, 0);
    assert.deepEqual(
      [...(group?.querySelectorAll('.tool-activity-item-title b') ?? [])].map((node) => node.textContent),
      ['Search', 'Search', 'Run']
    );
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('desktop activity counts batch targets on the row and lists them in the detail', () => {
  const read = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'read-batch',
    name: 'read',
    args: { file_path: ['src/a.ts', { file_path: 'src/b.ts', offset: 10, limit: 5 }] },
    result: 'ok',
    completedAt: 1,
  });
  assert.equal(read.title, 'File reading');
  assert.equal(read.subject, '2 files');
  assert.deepEqual(read.targets, ['src/a.ts', 'src/b.ts:10-14']);
  assert.equal(read.hasDetails, true);

  const window = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'read-window',
    name: 'read',
    args: { file_path: 'src/a.ts', offset: 3 },
    result: 'ok',
    completedAt: 1,
  });
  assert.equal(window.subject, 'src/a.ts:3+');
  assert.deepEqual(window.targets, []);

  const grep = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'grep-batch',
    name: 'grep',
    args: { pattern: ['foo', 'bar'], path: 'src' },
    result: 'ok',
    completedAt: 1,
  });
  assert.equal(grep.subject, '2 patterns · src');
  assert.deepEqual(grep.targets, ['"foo"', '"bar"']);

  const single = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'grep-single',
    name: 'grep',
    args: { pattern: 'foo', path: 'src' },
    result: 'ok',
    completedAt: 1,
  });
  assert.equal(single.subject, '"foo" · src');
  assert.deepEqual(single.targets, []);

  const git = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'git-batch',
    name: 'git',
    args: { command: ['git status', 'git diff'] },
    result: '## git status\nclean\n## git diff\n',
    completedAt: 1,
  });
  assert.equal(git.title, 'Git commands');
  assert.equal(git.subject, '2 commands');
  assert.deepEqual(git.targets, ['git status', 'git diff']);
  assert.equal(git.command, '');

  const graph = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'graph',
    name: 'code_graph',
    args: { mode: 'symbols', files: ['a.ts', 'b.ts'] },
    result: 'ok',
    completedAt: 1,
  });
  assert.equal(graph.title, 'Code structure');
  assert.equal(graph.subject, '2 files');
  assert.deepEqual(graph.targets, ['a.ts', 'b.ts']);
});

test('desktop activity normalizes common provider tool aliases', () => {
  assert.equal(desktopToolActivityCategory('write', { filePath: 'src/a.ts' }), 'Patch');
  assert.equal(desktopToolActivityCategory('patch', { patch: '*** Begin Patch' }), 'Patch');
  assert.equal(desktopToolActivityCategory('webfetch', { url: 'https://example.com' }), 'Web Research');
  assert.equal(desktopToolActivityCategory('websearch', { query: 'mixdog' }), 'Web Research');
  assert.equal(desktopToolActivityCategory('question', { questions: [] }), 'Setup');
  assert.equal(desktopToolActivityCategory('todowrite', { todos: [] }), 'Setup');
});

test('desktop git cards retain native output and label command failures', () => {
  for (const result of [
    '## main\n M a.txt\n',
    '{"keep": "spacing"}\n',
    '## git status\n## main\n\n## git show missing\nexit 128\nfatal: missing\nerror: command failed: git show missing',
  ]) {
    const card = desktopToolActivityItemPresentation({
      kind: 'tool',
      id: 'git-text',
      name: 'git',
      args: { command: 'git status' },
      result,
      completedAt: 1,
    });
    assert.equal(card.outputText, result.trimEnd());
    assert.equal(card.outputLanguage, '');
    if (result.includes('exit 128')) {
      assert.equal(card.resultLabel, 'Exit 128');
      assert.equal(card.tone, 'error');
    }
  }
});

test('desktop activity item headers remove atomic counts and represented argument keys', () => {
  const git = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'git',
    name: 'git',
    args: { command: 'git status --short' },
    result: 'clean',
    rawResult: 'clean',
    completedAt: 1,
  });
  assert.equal(git.title, 'Git commands');
  assert.equal(git.subject, 'git status --short');
  assert.equal(git.resultLabel, 'clean');
  assert.deepEqual(git.fields, []);
  assert.doesNotMatch(`${git.title} ${git.subject} ${git.resultLabel}`, /1 Git command|command=|Finished/);

  const edit = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'edit',
    name: 'edit',
    args: {
      file_path: 'src/a.ts',
      old_string: 'old',
      new_string: 'new',
      replace_all: false,
    },
    result: 'updated',
    completedAt: 1,
  });
  assert.equal(edit.title, 'File editing');
  assert.equal(edit.subject, 'src/a.ts');
  assert.equal(edit.beforeText, 'old');
  assert.equal(edit.afterText, 'new');
  assert.deepEqual(edit.fields, []);
});

test('desktop activity renders plans, todos, and questions as structured rows', () => {
  const plan = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'plan',
    name: 'update_plan',
    args: {
      plan: [
        { step: 'Check', status: 'completed' },
        { step: 'Ship', status: 'in_progress' },
      ],
    },
    result: 'Updated',
    completedAt: 1,
  });
  assert.equal(plan.structuredKind, 'plan');
  assert.equal(plan.resultLabel, '1/2');
  assert.deepEqual(
    plan.structuredRows.map(({ text, status }) => ({ text, status })),
    [
      { text: 'Check', status: 'completed' },
      { text: 'Ship', status: 'in_progress' },
    ]
  );

  const question = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'question',
    name: 'question',
    args: { questions: [{ question: 'Choose?' }] },
    result: 'A',
    completedAt: 1,
  });
  assert.equal(question.structuredKind, 'questions');
  assert.equal(question.resultLabel, '1/1');
  assert.equal(question.structuredRows[0].answer, 'A');
});

test('desktop activity masks secret fields and keeps routine load results collapsed', () => {
  const unknown = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'secret',
    name: 'unknown_tool',
    args: { foo: 'bar', api_key: 'secret' },
    result: 'ok',
    completedAt: 1,
  });
  assert.equal(unknown.subject, 'foo=bar · api_key=••••••');
  assert.equal(unknown.fields.find((field) => field.key === 'api_key')?.value, '••••••');

  const skill = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'skill',
    name: 'skill',
    args: { name: 'setup' },
    result: 'Loaded skill',
    completedAt: 1,
  });
  assert.equal(skill.title, 'Skill setup');
  assert.equal(skill.subject, '');
  assert.equal(skill.resultLabel, '');
  assert.equal(skill.hasDetails, false);
});

test('desktop activity keeps failures visible and suppresses image marker bodies', () => {
  const failed = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'failed',
    name: 'shell',
    args: { command: 'npm test' },
    result: 'Error: tests failed',
    rawResult: 'Error: tests failed',
    isError: true,
    completedAt: 1,
  });
  assert.equal(failed.tone, 'error');
  assert.match(failed.resultLabel, /tests failed/i);
  assert.equal(failed.outputText, 'Error: tests failed');

  const image = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'image',
    name: 'view_image',
    args: { path: 'shot.png' },
    result: '[image: shot.png]',
    completedAt: 1,
  });
  assert.equal(image.title, 'Image viewing');
  assert.equal(image.resultLabel, 'Image');
  assert.equal(image.hasDetails, false);
});

test('desktop activity prefers display results and hides successful mutation envelopes', () => {
  const patch = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'patch',
    name: 'apply_patch',
    args: { patch: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch' },
    result: 'OK Modify src/a.ts — +1 -1',
    rawResult: 'apply_patch: applied 1 section(s)\nOK Modify src/a.ts — +1 -1',
    uiDiff: 'diff --git a/src/a.ts b/src/a.ts\n@@\n-old\n+new',
    completedAt: 1,
  });
  assert.equal(patch.outputText, '');
  assert.equal(patch.diffPatch.includes('src/a.ts'), true);
});

test('desktop activity keeps agent action and response subjects specific', () => {
  const spawn = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'agent-spawn',
    name: 'agent',
    args: { type: 'spawn', agent: 'worker', model: 'gpt-6', tag: 'review' },
    completedAt: 1,
  });
  assert.equal(spawn.title, 'Agent calls');
  assert.match(spawn.subject, /^Spawn Worker/);

  const response = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'agent-response',
    name: 'agent',
    args: { type: 'result', agent: 'worker' },
    result: 'Reviewed the change.',
    completedAt: 1,
  });
  assert.equal(response.subject, 'Response Worker');

  // A status/read check is never a response, whatever its result carries.
  const envelope = 'agent task: t\nstatus: completed\nagent: reviewer\n\n### finding';
  for (const [type, verb] of [
    ['status', 'Status'],
    ['read', 'Read'],
  ]) {
    const check = desktopToolActivityItemPresentation({
      kind: 'tool',
      id: `agent-${type}`,
      name: 'agent',
      args: { type, tag: 'review-x' },
      result: envelope,
      completedAt: 1,
    });
    assert.equal(check.subject, `${verb} Reviewer (review-x)`);
  }
});

test('expanded tool detail stays in the runtime English while chips localize', () => {
  const write = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'write',
    name: 'write',
    args: { file_path: 'src/a.ts', content: 'export const a = 1;\n' },
    result: 'written',
    completedAt: 1,
  });
  assert.equal(write.title, 'File editing');
  // A written file opens as one numbered section in its own language.
  assert.equal(write.sections[0].path, 'src/a.ts');
  assert.equal(write.sections[0].language, 'ts');

  // English UI: a runtime-composed chip keeps its own (grammatical) plural.
  const read = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'read',
    name: 'read',
    args: { file_path: 'a.ts' },
    result: 'one\ntwo\nthree',
    rawResult: 'one\ntwo\nthree',
    completedAt: 1,
  });
  assert.equal(read.resultLabel, '3 lines');

  const single = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'single',
    name: 'read',
    args: { file_path: 'a.ts' },
    result: 'one',
    rawResult: 'one',
    completedAt: 1,
  });
  assert.equal(single.resultLabel, '1 line');
});

test('desktop activity tags structured bodies with a highlighting language', () => {
  const replacement = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'edit',
    name: 'edit',
    args: { file_path: 'src/theme.css', old_string: 'a', new_string: 'b' },
    result: 'updated',
    completedAt: 1,
  });
  assert.equal(replacement.replacementLanguage, 'css');

  const payload = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'payload',
    name: 'unknown_tool',
    args: { q: 'x' },
    result: '{"a":1}',
    rawResult: '{"a":1}',
    completedAt: 1,
  });
  assert.equal(payload.outputLanguage, 'json');
  assert.equal(payload.outputText, '{\n  "a": 1\n}');

  const readRows = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'read-rows',
    name: 'read',
    args: { file_path: 'src/a.js' },
    result: '[lines 1-2]\nconst a = 1;\n  b();\n[lines 1-2 of 2]',
    completedAt: 1,
  });
  assert.equal(readRows.outputText, '1→const a = 1;\n2→  b();\n[lines 1-2 of 2]');

  const log = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'log',
    name: 'unknown_tool',
    args: { q: 'x' },
    result: 'plain log line',
    rawResult: 'plain log line',
    completedAt: 1,
  });
  assert.equal(log.outputLanguage, '');
});

test('desktop activity cuts read and grep results into per-file sections', () => {
  const read = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'read-gutter',
    name: 'read',
    args: { file_path: 'src/app/a.ts', offset: 7, limit: 2 },
    result: '[lines 7-8]\nconst a = 1;\n\n[lines 7-8 of 20]',
    completedAt: 1,
  });
  assert.equal(read.subject, 'src/app/a.ts:7-8');
  assert.equal(read.headerSubject, 'a.ts:7-8');
  assert.equal(read.subjectKind, 'target');
  assert.deepEqual(read.sections, [
    {
      title: '',
      path: 'src/app/a.ts',
      line: 7,
      meta: '7–8',
      language: 'ts',
      rows: [
        { line: 7, text: 'const a = 1;' },
        { line: 8, text: '' },
      ],
    },
  ]);
  assert.equal(read.sectionCopyText, 'const a = 1;\n');

  const batch = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'read-batch-sections',
    name: 'read',
    args: { file_path: ['a.ts', 'b.css'] },
    result: 'read 2\na.ts [ok]\n[lines 1-1]\nconst a = 1;\n\nb.css [ok]\n[lines 4-5]\n.a {\n}',
    completedAt: 1,
  });
  assert.deepEqual(
    batch.sections.map(({ path, meta, language, rows }) => ({ path, meta, language, rows: rows.length })),
    [
      { path: 'a.ts', meta: '1', language: 'ts', rows: 1 },
      { path: 'b.css', meta: '4–5', language: 'css', rows: 2 },
    ]
  );

  const grep = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'grep-sections',
    name: 'grep',
    args: { pattern: 'x', path: 'src' },
    result: '# grep src/a.ts\n74:  x: true,\n\nsrc/b.ts (2 hits)\n  3: x()\n  9: x()\n\n(no matches) paths=["c.ts"]',
    completedAt: 1,
  });
  assert.equal(grep.subjectKind, 'code');
  assert.deepEqual(
    grep.sections.map(({ path, meta, rows }) => ({ path, meta, rows: rows.map((row) => row.line) })),
    [
      { path: 'src/a.ts', meta: '1 match', rows: [74] },
      { path: 'src/b.ts', meta: '2 matches', rows: [3, 9, null, null] },
    ]
  );

  // A result with no numbered rows (an error, a bare status) is not sectioned.
  const failed = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'read-missing',
    name: 'read',
    args: { file_path: 'src/missing.ts' },
    result: 'Error: file not found',
    isError: true,
    completedAt: 1,
  });
  assert.deepEqual(failed.sections, []);
});

test('desktop activity lists found files as rows and renders git diff as a patch', () => {
  const list = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'list',
    name: 'list',
    args: { path: 'data', limit: 80 },
    result: 'agents\tdir\ncache.json\tfile',
    completedAt: 1,
  });
  assert.equal(list.subject, 'data');
  assert.deepEqual(list.entries, [
    { path: 'data/agents', name: 'agents', dir: '', kind: 'dir' },
    { path: 'data/cache.json', name: 'cache.json', dir: '', kind: 'file' },
  ]);
  assert.equal(list.fieldsInline, true);

  const find = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'find',
    name: 'find',
    args: { query: 'a' },
    result: 'src/app/a.ts\nsrc/a.css',
    completedAt: 1,
  });
  assert.deepEqual(
    find.entries.map(({ name, dir }) => `${dir}|${name}`),
    ['src/app|a.ts', 'src|a.css']
  );

  const git = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'git-diff',
    name: 'git',
    args: { command: 'git diff' },
    result: 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new',
    completedAt: 1,
  });
  assert.equal(git.diffPatch.startsWith('diff --git'), true);
  assert.equal(git.outputText, '');
});

test('desktop activity treats only parseable output as JSON and surfaces the agent prompt', () => {
  const log = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'bracket-log',
    name: 'unknown_tool',
    args: { q: 'x' },
    result: '[warn] retrying\n[info] done',
    completedAt: 1,
  });
  assert.equal(log.outputLanguage, '');

  const spawn = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'agent-prompt',
    name: 'agent',
    args: { type: 'spawn', agent: 'worker', prompt: 'Review the diff.' },
    completedAt: 1,
  });
  assert.equal(spawn.promptText, 'Review the diff.');
  assert.equal(spawn.hasDetails, true);

  // A write that already carries a diff shows the diff alone.
  const write = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'write-diff',
    name: 'write',
    args: { file_path: 'src/a.ts', content: 'export const a = 1;\n' },
    uiDiff: 'diff --git a/src/a.ts b/src/a.ts\n@@\n+export const a = 1;',
    result: 'written',
    completedAt: 1,
  });
  assert.deepEqual(write.sections, []);
  assert.equal(write.diffPatch.includes('src/a.ts'), true);

  // An edit landing in a batch can carry the whole batch's patch: its body
  // shows its own file, matched by relative or absolute path.
  const batchPatch = [
    'diff --git a/C:/tmp/out/outside-note.txt b/C:/tmp/out/outside-note.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/C:/tmp/out/outside-note.txt',
    '@@ -0,0 +1,1 @@',
    '+Single line of text',
    'diff --git a/note.txt b/note.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/note.txt',
    '@@ -0,0 +1,1 @@',
    '+First line',
  ].join('\n');
  const edit = (filePath) =>
    desktopToolActivityItemPresentation({
      kind: 'tool',
      id: `edit-${filePath}`,
      name: 'edit',
      args: { file_path: filePath, old_string: '', new_string: 'x' },
      uiDiff: batchPatch,
      result: 'Created',
      completedAt: 1,
    });
  const outside = edit('C:\\tmp\\out\\outside-note.txt').diffPatch;
  assert.equal(outside.includes('outside-note.txt'), true);
  assert.equal(outside.includes('b/note.txt'), false);
  const note = edit('note.txt').diffPatch;
  assert.equal(note.startsWith('diff --git a/note.txt b/note.txt'), true);
  assert.equal(note.includes('outside-note.txt'), false);
  // No section for the target: the patch stays whole.
  assert.equal(edit('other.txt').diffPatch, batchPatch);
  // Exact path identity: `x.ts` never keeps `nested/x.ts`, in either direction.
  const nested = ['x.ts', 'nested/x.ts']
    .map((name) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-1\n+2`)
    .join('\n');
  const pick = (filePath, extra = {}) =>
    desktopToolActivityItemPresentation({
      kind: 'tool',
      id: `twin-${filePath}`,
      name: 'edit',
      args: { file_path: filePath, old_string: '1', new_string: '2', ...extra },
      uiDiff: nested,
      result: 'ok',
      completedAt: 1,
    }).diffPatch;
  assert.equal(pick('x.ts').includes('nested/x.ts'), false);
  assert.equal(pick('x.ts').includes('a/x.ts'), true);
  assert.equal(pick('./nested\\x.ts').includes('a/x.ts'), false);
  assert.equal(pick('nested/x.ts').includes('nested/x.ts'), true);
  assert.equal(pick('C:\\repo\\x.ts', { cwd: 'C:\\repo' }).includes('nested/x.ts'), false);
  assert.equal(pick('C:/repo/nested/x.ts', { cwd: 'C:/repo' }).includes('a/x.ts'), false);
  // Relative `..`/`.` segments resolve without a root.
  assert.equal(pick('a/../x.ts').includes('nested/x.ts'), false);
  assert.equal(pick('a/../x.ts').includes('a/x.ts'), true);
  assert.equal(pick('nested/./sub/../x.ts').includes('a/x.ts'), false);
  // Windows-style paths ignore filename case.
  const win = (name, filePath, cwd) =>
    desktopToolActivityItemPresentation({
      kind: 'tool',
      id: `win-${filePath}`,
      name: 'edit',
      args: { file_path: filePath, old_string: '1', new_string: '2', cwd },
      uiDiff: [name, 'other.ts']
        .map((n) => `diff --git a/${n} b/${n}\n--- a/${n}\n+++ b/${n}\n@@ -1 +1 @@\n-1\n+2`)
        .join('\n'),
      result: 'ok',
      completedAt: 1,
    }).diffPatch;
  assert.equal(win('C:/Repo/X.ts', 'c:\\repo\\x.ts').includes('other.ts'), false);
  assert.equal(win('src/X.ts', 'SRC\\x.ts').includes('other.ts'), false);
  assert.equal(win('src/X.ts', 'SRC/x.ts', 'C:\\Repo').includes('other.ts'), false);
  // POSIX paths compare exactly, so differing case never merges.
  const posix = (filePath) => win('/Repo/x.ts', filePath);
  assert.equal(posix('/Repo/x.ts').includes('other.ts'), false);
  assert.equal(posix('/repo/x.ts').includes('other.ts'), true);
  // A change counts the lines its own diff adds and removes.
  assert.deepEqual(edit('note.txt').diffCounts, { additions: 1, deletions: 0 });
});

test('a clean empty command run shows its command alone; a failed one keeps what it printed', () => {
  const run = (rawResult, extra = {}) =>
    desktopToolActivityItemPresentation({
      kind: 'tool',
      id: `shell-${rawResult}`,
      name: 'shell',
      args: { command: 'python make.py' },
      result: rawResult,
      rawResult,
      completedAt: 1,
      ...extra,
    });
  const clean = run('(no output)');
  assert.equal(clean.outputText, '');
  assert.equal(clean.command, 'python make.py');
  assert.equal(clean.hasDetails, true);
  const failed = run('[exit code: 2]\n(no output)', { isError: true });
  assert.equal(failed.tone, 'error');
  assert.notEqual(failed.outputNote, '');
});

test('desktop labels name the operation actually called and its real outcome', async () => {
  const { desktopToolActivitySummary, desktopToolActivityRowVerb } = await import('./transcript-tool-core.ts');
  const item = (name, args, result = 'ok', extra = {}) => ({
    kind: 'tool',
    id: name,
    name,
    args,
    result,
    completedAt: 1,
    ...extra,
  });

  // Media: a failed job read shows the job error, and actions have their own unit.
  const failedJob = desktopToolActivityItemPresentation(
    item('media', { action: 'status', job: 'j' }, '{"ok":false,"job":"j","status":"failed","error":"quota"}')
  );
  assert.equal(failedJob.tone, 'error');
  assert.equal(failedJob.resultLabel, 'quota');
  assert.equal(failedJob.title, 'Media status');
  assert.equal(
    desktopToolActivityItemPresentation(item('media', { action: 'cancel', job: 'j' })).title,
    'Media cancellation'
  );

  // Batch read entries keep their own window and do not gain the call's.
  const batch = desktopToolActivityItemPresentation(
    item('read', { file_path: [{ file_path: 'a.ts', offset: 10, limit: 2 }], limit: 5 }, 'x')
  );
  assert.equal(batch.subject, 'a.ts:10-11');

  // code_graph keeps the callers/callees direction and the file in an overview.
  const callers = desktopToolActivityItemPresentation(item('code_graph', { mode: 'callers', symbols: ['run'] }));
  assert.equal(callers.subject, 'callers · run');
  const overview = desktopToolActivityItemPresentation(item('code_graph', { mode: 'overview', files: 'src/a.ts' }));
  assert.equal(overview.subject, 'src/a.ts');
  assert.equal(overview.title, 'Code structure');
  assert.equal(
    desktopToolActivityItemPresentation(item('code_graph', { mode: 'symbol_search', symbols: 'run' })).category,
    'Search'
  );

  // Group summaries use the canonical work-unit counts and categories.
  assert.equal(desktopToolActivitySummary([item('read', { file_path: ['a.ts', 'b.ts', 'c.ts'] })]), 'Read 3 files');
  assert.equal(desktopToolActivitySummary([item('task', { action: 'cancel', task_id: 't' })]), 'Cancel task');
  assert.equal(desktopToolActivitySummary([item('code_graph', { mode: 'overview', files: 'a.ts' })]), 'Code structure');
  assert.equal(
    desktopToolActivitySummary([item('agent', { type: 'result', agent: 'worker', status: 'completed' })]),
    'Agent response'
  );

  // GitHub calls of any action count as one unit, named apart from local Git.
  assert.equal(
    desktopToolActivitySummary([
      item('github', { action: 'pr.list', state: 'open' }),
      item('github', { action: 'pr.comments', number: 11 }),
      item('github', { action: 'pr.comments', number: 9 }),
      item('github', { action: 'pr.view', number: 7 }),
    ]),
    'GitHub 4'
  );

  // Visualize, Browser and Computer calls of any action count as one unit each.
  assert.equal(
    desktopToolActivitySummary([
      item('visualize', { action: 'close' }),
      item('visualize', { action: 'open', input: { targets: ['a.html'] } }),
      item('visualize', { action: 'capture', input: { tab: 'v1' } }),
    ]),
    'Visualize 3'
  );
  assert.equal(
    desktopToolActivitySummary([
      item('browser', { action: 'navigate', url: 'https://example.com' }),
      item('browser', { action: 'click', ref: 'e1' }),
    ]),
    'Browser 2 actions'
  );
  assert.equal(
    desktopToolActivitySummary([item('browser', { action: 'navigate', url: 'https://a.b' })]),
    'Browser action'
  );

  // Terminal is its own category with action verbs, never "External tools".
  const list = item('terminal', { action: 'list' });
  assert.equal(desktopToolActivityItemPresentation(list).category, 'Terminal');
  assert.equal(desktopToolActivityItemPresentation(list).title, 'Terminal tabs');
  assert.equal(desktopToolActivityRowVerb('terminal', { action: 'list' }), 'List tabs');
  assert.equal(desktopToolActivityRowVerb('terminal', { action: 'read', tab: 1 }), 'Read output');

  // Visualize rows name the tab's title (the call's `input` arrives
  // unwrapped), never a raw "Label" field.
  const visualize = (input) => desktopToolActivityItemPresentation(item('visualize', { action: 'open', input }));
  const diagram = visualize({
    content: { kind: 'mermaid', source: 'graph TD', title: '주문 처리 흐름' },
    label: '주문 처리 흐름',
  });
  assert.equal(diagram.subject, 'Showed tab · 주문 처리 흐름');
  assert.deepEqual(diagram.fields, []);
  assert.equal(visualize({ content: { kind: 'chart', source: '{}', title: 'Orders' } }).subject, 'Showed tab · Orders');
  assert.equal(visualize({ content: { kind: 'mermaid', source: 'graph TD' } }).subject, 'Showed tab · Mermaid diagram');
  assert.equal(visualize({ targets: ['site/index.html'], label: 'Home' }).subject, 'Showed tab · Home');
  assert.deepEqual(visualize({ targets: ['site/index.html'], label: 'Home' }).fields, []);
  assert.equal(visualize({ targets: ['site/index.html'] }).subject, 'Showed tab · site/index.html');

  // Public-schema subjects instead of first-field fallbacks.
  assert.equal(
    desktopToolActivityItemPresentation(item('github', { action: 'issue.create', repo: 'owner/repo', title: 'Bug' }))
      .subject,
    'Create issue · owner/repo · Bug'
  );
  assert.equal(
    desktopToolActivityItemPresentation(item('git', { action: 'stage', change_ids: ['a', 'b'] })).subject,
    '2 changes'
  );
});

test('the tool activity expansion setting opens command rows as previews and Ctrl+O opens everything', async () => {
  const { setToolActivityExpansion, toggleToolActivityExpandAll } = await import('./tool-activity-expansion.ts');
  const dom = installToolActivityDom('Mozilla/5.0 Electron/41.0.0');
  const items = [
    {
      kind: 'tool',
      id: 'sh',
      name: 'shell',
      args: { command: 'npm test' },
      result: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8'].join('\n'),
      completedAt: 2,
    },
    { kind: 'tool', id: 'rd', name: 'read', args: { path: 'a.txt' }, result: 'one\ntwo', completedAt: 2 },
  ];
  const rowOpen = () =>
    [...document.querySelectorAll('.tool-activity-item')].map((row) => row.getAttribute('data-open') === 'true');
  try {
    setToolActivityExpansion('commands');
    await act(async () => {
      dom.root.render(React.createElement(ToolActivityGroup, { disclosureScope: 'expansion', items }));
    });
    assert.equal(document.querySelector('.tool-activity-header').getAttribute('aria-expanded'), 'true');
    assert.deepEqual(rowOpen(), [true, false], 'only the command run opens');
    assert.equal(document.querySelector('.tool-activity-preview').getAttribute('data-clamped'), 'lines');
    assert.equal(document.querySelector('.tool-terminal-output').textContent, 'l1\nl2\nl3\nl4\nl5');
    const more = document.querySelector('.tool-activity-preview-more');
    assert.equal(more.textContent, '… +3 lines', 'the preview counts the lines it hides');
    await act(async () => more.click());
    assert.equal(document.querySelector('.tool-terminal-output').textContent.split('\n').length, 8);
    assert.equal(document.querySelector('.tool-activity-preview-more'), null);

    await act(async () => toggleToolActivityExpandAll());
    assert.deepEqual(rowOpen(), [true, true], 'Ctrl+O opens every call');
    await act(async () => document.querySelectorAll('.tool-activity-item-toggle')[1].click());
    assert.deepEqual(rowOpen(), [true, false], 'a call closes by hand');
    await act(async () => toggleToolActivityExpandAll());
    assert.deepEqual(rowOpen(), [true, false], 'Ctrl+O again returns to the saved setting');
    await act(async () => toggleToolActivityExpandAll());
    assert.deepEqual(rowOpen(), [true, true], 'a new Ctrl+O opens calls closed in an earlier one');
    await act(async () => toggleToolActivityExpandAll());

    await act(async () => setToolActivityExpansion('collapsed'));
    assert.equal(document.querySelector('.tool-activity-header').getAttribute('aria-expanded'), 'false');
  } finally {
    await act(async () => dom.root.unmount());
    setToolActivityExpansion('collapsed');
    dom.close();
  }
});

test('a height-clamped preview builds only a bounded part, still offers show more, and copies the full text', async () => {
  const { setToolActivityExpansion } = await import('./tool-activity-expansion.ts');
  const dom = installToolActivityDom('Mozilla/5.0 Electron/41.0.0');
  const copied = [];
  Object.defineProperty(dom.window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (value) => void copied.push(value) },
  });
  const result = Array.from({ length: 40 }, (_, index) => `- item ${index + 1} of the list`).join('\n');
  try {
    setToolActivityExpansion('all');
    await act(async () => {
      dom.root.render(
        React.createElement(ToolActivityGroup, {
          disclosureScope: 'bounded-preview',
          items: [
            {
              kind: 'tool',
              id: 'rd',
              name: 'edit',
              args: { path: 'a.ts', old_string: result, new_string: 'x' },
              result: 'ok',
              completedAt: 2,
            },
          ],
        })
      );
    });
    const preview = document.querySelector('.tool-activity-preview');
    assert.equal(preview.getAttribute('data-clamped'), 'height');
    assert.ok(preview.textContent.includes('item 1 of'), 'the head of the output renders');
    assert.ok(!preview.textContent.includes('item 40 of'), 'the tail is not built while collapsed');
    const more = document.querySelector('.tool-activity-preview-more');
    assert.ok(more, 'a truncated preview still offers show more without any DOM overflow');

    await act(async () => document.querySelector('.tool-activity-copy').click());
    assert.ok(copied[0].includes('item 40 of'), 'copy keeps the full text');

    await act(async () => more.click());
    assert.ok(document.querySelector('.tool-activity-item-body').textContent.includes('item 40 of'));
    assert.equal(document.querySelector('.tool-activity-preview-more'), null);
  } finally {
    await act(async () => dom.root.unmount());
    setToolActivityExpansion('collapsed');
    dom.close();
  }
});

test('a finished background task with nothing to read cannot open and shows its status and id', async () => {
  const dom = installToolActivityDom('Mozilla/5.0 Electron/41.0.0');
  try {
    const notice = [
      '<task-notification>',
      '<task-id>job_1790959235138_971b88</task-id>',
      '<status>completed</status>',
      '<exit-code>0</exit-code>',
      '<summary>Shell task completed (exit 0): sleep 1</summary>',
      '</task-notification>',
    ].join('\n');
    await act(async () => {
      dom.root.render(
        React.createElement(ToolActivityGroup, {
          disclosureScope: 'meta-only',
          items: [
            { kind: 'tool', id: 'sh', name: 'shell', args: { command: 'sleep 1' }, result: notice, completedAt: 1 },
          ],
        })
      );
    });
    await act(async () => {
      document
        .querySelector('.tool-activity-header')
        ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    const row = document.querySelector('.tool-activity-item');
    assert.ok(row, 'the group opened onto its row');
    assert.equal(row.querySelector('.tool-chevron'), null);
    assert.equal(row.querySelector('.tool-activity-item-toggle[aria-expanded]'), null);
    assert.equal(row.querySelector('.tool-activity-item-result')?.textContent, 'Completed · 971b88');
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('the thinking spinner shows the runtime-resolved turn effort, falling back to the saved level', async () => {
  const dom = installToolActivityDom('Mozilla/5.0 Electron/41.0.0');
  const thinkingText = async (snapshot) => {
    await act(async () => {
      dom.root.render(
        React.createElement(LiveActivity, {
          snapshot: { thinking: true, spinner: { active: true, startedAt: Date.now(), mode: 'thinking' }, ...snapshot },
        })
      );
    });
    return document.querySelector('.live-activity-meta')?.textContent || '';
  };
  try {
    const { writeCachedModelCatalog } = await import('./model-catalog-cache.ts');
    const { publishAutoEffort } = await import('./auto-effort-store.ts');
    const effortOptions = ['low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ value, label: value }));
    const option = (model, autoEffortCapable) => ({
      provider: 'alpha',
      model,
      display: model,
      effortOptions,
      fastCapable: false,
      ...(autoEffortCapable ? { autoEffortCapable: true } : {}),
    });
    writeCachedModelCatalog([option('capable', true), option('plain', false)]);
    const setAuto = (enabled) =>
      act(async () => publishAutoEffort({ autoEffort: { installed: true, enabled, supported: true } }));
    const capable = { provider: 'alpha', model: 'capable' };
    const plain = { provider: 'alpha', model: 'plain' };

    // Auto off: the resolved effort, else the saved level — spelled like the model chip.
    await setAuto(false);
    assert.match(await thinkingText({ ...capable, effort: 'high', turnEffort: 'medium' }), /Thinking \(Medium\)/);
    assert.match(
      await thinkingText({ ...capable, effort: 'high', turnEffort: 'low' }),
      /Thinking \(Low\)/,
      're-judged step'
    );
    assert.match(await thinkingText({ ...capable, effort: 'high', turnEffort: null }), /Thinking \(High\)/);
    assert.match(await thinkingText({ effort: 'xhigh' }), /Thinking \(XHigh\)/);

    // Auto on + capable: no saved-level stand-in before the turn effort resolves.
    await setAuto(true);
    assert.match(await thinkingText({ ...capable, effort: 'high', turnEffort: 'medium' }), /Thinking \(Medium\)/);
    assert.match(await thinkingText({ ...capable, effort: 'high', turnEffort: null }), /Thinking$/);
    assert.match(await thinkingText({ ...capable, effort: 'high' }), /Thinking$/);
    // A saved max/ultra is respected by the runtime, so it stays shown.
    assert.match(await thinkingText({ ...capable, effort: 'max' }), /Thinking \(Max\)/);
    // Auto on but the model is not capable: the saved level stands.
    assert.match(await thinkingText({ ...plain, effort: 'high' }), /Thinking \(High\)/);
    await setAuto(false);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('the spinner byline is translated on the desktop', async () => {
  const { initUiLanguage, setUiLanguagePreference } = await import('./i18n.ts');
  const dom = installToolActivityDom('Mozilla/5.0 Electron/41.0.0');
  setUiLanguagePreference('ko');
  await initUiLanguage();
  const bylineFor = async (snapshot) => {
    await act(async () => {
      dom.root.render(
        React.createElement(LiveActivity, {
          snapshot: {
            spinner: { active: true, startedAt: Date.now(), mode: 'thinking', outputTokens: 340 },
            ...snapshot,
          },
        })
      );
    });
    return document.querySelector('.live-activity-meta')?.textContent || '';
  };
  try {
    const live = await bylineFor({ thinking: true, effort: 'high', turnEffort: 'medium' });
    assert.match(live, /토큰 340개/);
    assert.match(live, /생각 중 \(Medium\)/);
    assert.doesNotMatch(live, /tokens|thinking/);
    assert.match(await bylineFor({ thinking: true }), /생각 중$/);
    assert.match(
      await bylineFor({
        thinking: false,
        spinner: { active: true, startedAt: Date.now(), thinkingAccumulatedMs: 5000 },
      }),
      /5초 동안 생각함/
    );
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
    setUiLanguagePreference('en');
    await initUiLanguage();
  }
});

const createdPatch =
  'diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,1 @@\n+x';
const editedPatch = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-a\n+b';
const deletedPatch =
  'diff --git a/src/old.ts b/src/old.ts\ndeleted file mode 100644\n--- a/src/old.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-x';

test('a change opens the session diff on the file its own diff names', async () => {
  const { diffTargetPath } = await import('./transcript-tool-model.ts');
  assert.equal(diffTargetPath(editedPatch), 'src/a.ts');
  assert.equal(diffTargetPath(createdPatch), 'src/new.ts');
  assert.equal(diffTargetPath(deletedPatch), 'src/old.ts');
});

test('a file change row says what happened to the file, in progress then by its diff', () => {
  const row = (name, args, extra) =>
    desktopToolActivityItemPresentation({
      kind: 'tool',
      id: `${name}-${Object.keys(extra).join('')}`,
      name,
      args,
      ...extra,
    });
  const editArgs = { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' };
  assert.equal(row('edit', editArgs, { startedAt: 1 }).verb, 'Editing');
  assert.equal(row('write', { file_path: 'src/new.ts', content: 'x' }, { startedAt: 1 }).verb, 'Writing file');
  assert.equal(
    row('edit', { ...editArgs, file_path: 'src/new.ts' }, { uiDiff: createdPatch, result: 'ok', completedAt: 1 }).verb,
    'Created file'
  );
  assert.equal(row('edit', editArgs, { uiDiff: editedPatch, result: 'ok', completedAt: 1 }).verb, 'Edited file');
  assert.equal(
    row(
      'apply_patch',
      { patch: '*** Begin Patch\n*** Delete File: src/old.ts\n*** End Patch' },
      { uiDiff: deletedPatch, result: 'ok', completedAt: 1 }
    ).verb,
    'Deleted file'
  );
  // A failed change keeps the plain verb and claims no lines.
  const failed = row('edit', editArgs, { result: 'Error: old_string not found', isError: true, completedAt: 1 });
  assert.equal(failed.verb, 'Edit');
  assert.equal(failed.tone, 'error');
  assert.equal(failed.diffCounts, null);
});

test('the group line says when a command failed, and a stop is not a failure', async () => {
  const { desktopToolActivitySummary } = await import('./transcript-tool-core.ts');
  const shell = (id, result, extra = {}) => ({
    kind: 'tool',
    id,
    name: 'shell',
    args: { command: id },
    result,
    completedAt: 1,
    ...extra,
  });
  assert.equal(
    desktopToolActivitySummary([shell('a', '[exit code: 2]\nboom', { isError: true, exitErrorCount: 1 })]),
    'Command failed'
  );
  assert.equal(
    desktopToolActivitySummary([
      shell('a', 'ok'),
      shell('b', '[exit code: 2]\nboom', { isError: true, exitErrorCount: 1 }),
    ]),
    'Run 2 commands, 1 failed'
  );
  assert.equal(
    desktopToolActivitySummary([shell('a', 'ok'), shell('b', 'cancelled', { isError: true })]),
    'Run 2 commands'
  );
  // Still running: nothing has failed yet.
  assert.equal(
    desktopToolActivitySummary([{ kind: 'tool', id: 'r', name: 'shell', args: { command: 'r' }, startedAt: 1 }]),
    'Run 1 command'
  );
});

test('running, failed, stopped and other rows keep their states; read, search, web and agent rows stay one-liners', () => {
  const row = (name, args, extra) =>
    desktopToolActivityItemPresentation({ kind: 'tool', id: name, name, args, ...extra });
  const running = row('shell', { command: 'npm test' }, { startedAt: Date.now() });
  assert.equal(running.pending, true);
  assert.equal(running.outputText, '');
  const failed = row(
    'shell',
    { command: 'false' },
    { result: '[exit code: 1]\nnope', isError: true, exitErrorCount: 1, completedAt: 1 }
  );
  assert.equal(failed.tone, 'error');
  assert.match(failed.outputText, /nope/);
  const stopped = row('shell', { command: 'sleep 9' }, { result: 'cancelled', completedAt: 1 });
  assert.equal(stopped.tone, 'warning');
  assert.equal(stopped.resultLabel, 'Stopped');
  assert.equal(stopped.outputText, '');
  for (const [name, args, verb] of [
    ['read', { file_path: 'src/a.ts' }, 'Read'],
    ['grep', { pattern: 'TODO' }, 'Search'],
    ['web_search', { query: 'mixdog' }, 'Web search'],
    ['agent', { prompt: 'Review', description: 'Reviewer' }, 'Agent'],
  ]) {
    const done = row(name, args, { result: 'ok', completedAt: 1 });
    assert.equal(done.verb, verb, name);
    assert.equal(done.diffCounts, null, name);
  }
});

test('a group counts its settled changes while another call still runs', async () => {
  const dom = installToolActivityDom('Mozilla/5.0 Electron/41.0.0');
  try {
    const items = [
      {
        kind: 'tool',
        id: 'e1',
        name: 'edit',
        args: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' },
        uiDiff: editedPatch,
        result: 'ok',
        completedAt: 1,
      },
      {
        kind: 'tool',
        id: 'e2',
        name: 'edit',
        args: { file_path: 'src/b.ts', old_string: 'a', new_string: 'b' },
        startedAt: Date.now(),
      },
      { kind: 'tool', id: 'r1', name: 'shell', args: { command: 'npm test' }, startedAt: Date.now() },
    ];
    await act(async () => {
      dom.root.render(React.createElement(ToolActivityGroup, { disclosureScope: 'pending-counts', items }));
    });
    const header = document.querySelector('.tool-activity-header');
    assert.equal(header.querySelector('.tool-diff-counts')?.textContent, '+1−1');
    // The running readout stays its own part of the line.
    assert.ok(header.querySelector('[role="status"]'));
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('an edit row opens in place under its path line; the path opens the side diff pane where there is one', async () => {
  const { TurnChangesContext } = await import('./TurnChangesCard.tsx');
  const items = [
    {
      kind: 'tool',
      id: 'e1',
      name: 'edit',
      args: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' },
      uiDiff: editedPatch,
      result: 'ok',
      completedAt: 1,
    },
  ];
  for (const withPane of [true, false]) {
    const dom = installToolActivityDom('Mozilla/5.0 Electron/41.0.0');
    let opened = 0;
    try {
      const group = React.createElement(ToolActivityGroup, { disclosureScope: `pane-${withPane}`, items });
      await act(async () => {
        dom.root.render(
          withPane
            ? React.createElement(
                TurnChangesContext.Provider,
                { value: { sessionId: 's1', busy: false, turnRunning: false, onOpenSessionDiff: () => (opened += 1) } },
                group
              )
            : group
        );
      });
      await act(async () => document.querySelector('.tool-activity-header').click());
      const article = document.querySelector('.tool-activity-item');
      assert.equal(article.querySelector('.tool-activity-item-header').textContent.includes('+1−1'), true);
      await act(async () => article.querySelector('.tool-activity-item-toggle').click());
      assert.equal(article.dataset.open, 'true');
      const path = article.querySelector('.tool-diff-path');
      assert.equal(path.textContent, 'src/a.ts');
      assert.ok(path.querySelector('.tool-detail-copy'));
      assert.ok(article.querySelector('.tool-diff-frame .code-diff'));
      // The diff of the row's own file draws no second caption.
      assert.equal(article.querySelector('.diff-file > header'), null);
      if (withPane) {
        await act(async () => article.querySelector('.tool-diff-path-link').click());
        assert.equal(opened, 1);
      } else {
        assert.equal(article.querySelector('.tool-diff-path-link'), null);
        assert.ok(article.querySelector('.tool-diff-path-text'));
      }
    } finally {
      await act(async () => dom.root.unmount());
      dom.close();
    }
  }
});

test('toolRowRevision changes when output or diff text changes at the same length', async () => {
  const { toolRowRevision } = await import('./transcript-tool-core.ts');
  const row = (result, uiDiff) => ({ kind: 'tool', id: 'r', name: 'shell', result, uiDiff });
  assert.notEqual(toolRowRevision(row('aaaa', 'x')), toolRowRevision(row('aaab', 'x')));
  assert.notEqual(toolRowRevision(row('aaaa', 'x')), toolRowRevision(row('aaaa', 'y')));
  assert.equal(toolRowRevision(row('aaaa', 'x')), toolRowRevision(row('aaaa', 'x')));
});
