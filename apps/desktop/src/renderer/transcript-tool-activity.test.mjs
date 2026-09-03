import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import {
  appendLiveTranscriptRows,
  projectSettledTranscriptRows,
} from './transcript-rows.ts';
import {
  desktopToolActivityCategory,
  desktopToolActivityCategoryGroups,
  desktopToolActivityItemPresentation,
  flattenedToolActivityItems,
  formatTokenCount,
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
  const previous = new Map(['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT']
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
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

test('transcript row memoization retains no value-copy signature', () => {
  const item = { kind: 'assistant', text: 'large tool output' };
  assert.equal(transcriptItemsEqual(item, item), true);
  assert.equal(transcriptItemsEqual(item, { ...item }), false);
});

test('desktop and mobile tool groups share details and a static task icon', async () => {
  const userAgents = [
    'Mozilla/5.0 Electron/41.0.0',
    'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36',
  ];
  for (const userAgent of userAgents) {
    const dom = installToolActivityDom(userAgent);
    try {
      await act(async () => {
        dom.root.render(React.createElement(ToolActivityGroup, {
          disclosureScope: userAgent,
          items: [{
            kind: 'tool',
            id: 'read',
            name: 'read',
            args: { file_path: 'src/a.ts' },
            startedAt: Date.now(),
          }],
        }));
      });
      const group = document.querySelector('.tool-activity');
      assert.equal(group?.dataset.surface, 'desktop');
      assert.ok(group?.querySelector('.tool-activity-header .lucide-list-tree'));
      assert.equal(group?.querySelector('.live-activity-glyph'), null);

      await act(async () => {
        group?.querySelector('.tool-activity-header')
          ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      });
      assert.equal(group?.querySelectorAll('.tool-activity-details').length, 1);
      assert.equal(group?.querySelectorAll('.tool-activity-category').length, 1);
      assert.equal(group?.querySelectorAll('.tool-activity-item').length, 0);
      await act(async () => {
        group?.querySelector('.tool-activity-category-header')
          ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      });
      assert.equal(group?.querySelectorAll('.tool-activity-item').length, 1);
      assert.equal(group?.querySelectorAll('.tool-card').length, 0);
    } finally {
      await act(async () => dom.root.unmount());
      dom.close();
    }
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
  const hiddenNames = [
    'goal',
    'create_goal',
    'get_goal',
    'set_goal_tasks',
    'update_goal',
    'load_tool',
    'tool_search',
  ];
  const hidden = hiddenNames.map((name, index) => ({
    kind: 'tool',
    id: `hidden-${index}`,
    name,
    result: 'ok',
  }));
  // Built-in skill loads hide by their result stub; user/plugin skills show.
  const builtinSkill = { kind: 'tool', id: 'skill-builtin', name: 'Skill', args: { name: 'docx' }, result: 'Loaded built-in skill: docx' };
  const userSkill = { kind: 'tool', id: 'skill-user', name: 'Skill', args: { name: 'mixdog-refs' }, result: 'Loaded skill: mixdog-refs' };
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

  assert.deepEqual(rows.map((row) => row._tag), [
    'ToolActivity',
    'AssistantPart',
    'ToolActivity',
  ]);
  assert.deepEqual(rows[0].items, [first]);
  assert.deepEqual(rows[2].items, [second]);
});

test('thinking remains a separate row after grouped tool activity', () => {
  const settled = project([
    { kind: 'tool', id: 'tool', name: 'shell', result: 'ok' },
  ]);
  const rows = appendLiveTranscriptRows({
    sessionKey: 'session',
    settled,
    thinking: true,
  });

  assert.deepEqual(rows.map((row) => row._tag), ['ToolActivity', 'Thinking']);
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

test('desktop activity drills through repeated categories but keeps singleton tools direct', () => {
  const groups = desktopToolActivityCategoryGroups([
    { kind: 'tool', id: 'git-1', name: 'git', args: { command: 'git status' }, result: 'clean' },
    { kind: 'tool', id: 'shell-1', name: 'shell', args: { command: 'npm test' }, result: 'ok' },
    { kind: 'tool', id: 'git-2', name: 'git', args: { command: 'git diff' }, result: 'diff' },
  ]);

  assert.deepEqual(groups.map(({ category, count, items }) => ({
    category,
    count,
    ids: items.map((item) => item.id),
  })), [
    { category: 'Git', count: 2, ids: ['git-1', 'git-2'] },
    { category: 'Shell', count: 1, ids: ['shell-1'] },
  ]);
});

test('desktop activity groups by work unit, not by shared category', () => {
  const groups = desktopToolActivityCategoryGroups([
    { kind: 'tool', id: 'git-1', name: 'git', args: { command: 'git status' }, result: 'clean' },
    { kind: 'tool', id: 'stage-1', name: 'git_stage', args: { diff_id: 'd1', change_ids: ['c1'] }, result: 'staged' },
    { kind: 'tool', id: 'graph-1', name: 'code_graph', args: { mode: 'overview', files: ['a.ts'] }, result: 'ok' },
    { kind: 'tool', id: 'read-1', name: 'read', args: { file_path: 'a.ts' }, result: 'ok' },
    // External MCP calls keep separate server-name buckets.
    { kind: 'tool', id: 'mcp-1', name: 'mcp__srv__a', args: { q: 'x' }, result: 'ok' },
    { kind: 'tool', id: 'mcp-2', name: 'mcp__other__b', args: { q: 'y' }, result: 'ok' },
  ]);

  assert.deepEqual(groups.map(({ unitKey, category, label, count }) => ({ unitKey, category, label, count })), [
    { unitKey: 'Git|Ran|Git command', category: 'Git', label: 'Git commands', count: 1 },
    { unitKey: 'Git|Staged|change', category: 'Git', label: 'Git staging', count: 1 },
    { unitKey: 'Read|Read|code map', category: 'Read', label: 'Code structure', count: 1 },
    { unitKey: 'Read|Read|file', category: 'Read', label: 'File reading', count: 1 },
    { unitKey: 'MCP|srv', category: 'MCP', label: 'MCP Srv', count: 1 },
    { unitKey: 'MCP|other', category: 'MCP', label: 'MCP Other', count: 1 },
  ]);
});

test('desktop activity uses concrete control, MCP server, and skill names', () => {
  const groups = desktopToolActivityCategoryGroups([
    { kind: 'tool', id: 'browser', name: 'browser', args: { action: 'open' }, result: 'ok' },
    { kind: 'tool', id: 'computer', name: 'computer', args: { action: 'click' }, result: 'ok' },
    { kind: 'tool', id: 'office', name: 'office', args: { action: 'inspect' }, result: 'ok' },
    { kind: 'tool', id: 'unity', name: 'mcp__UnityMCP__manage_scene', args: { action: 'get' }, result: 'ok' },
    { kind: 'tool', id: 'skill', name: 'Skill', args: { name: 'gamerscroll-article' }, result: 'ok' },
    { kind: 'tool', id: 'media-image', name: 'media', args: { action: 'generate', kind: 'image', prompt: 'x', path: 'a.png' }, result: 'ok' },
    { kind: 'tool', id: 'media-video', name: 'media', args: { action: 'generate', kind: 'video', prompt: 'x', path: 'a.mp4' }, result: 'ok' },
    { kind: 'tool', id: 'media-list', name: 'media', args: { action: 'list', kind: 'image' }, result: 'ok' },
  ]);

  assert.deepEqual(groups.map(({ unitKey, category, label, count }) => ({ unitKey, category, label, count })), [
    { unitKey: 'Browser', category: 'Browser', label: 'Browser Use', count: 1 },
    { unitKey: 'Computer', category: 'Computer', label: 'Computer Use', count: 1 },
    { unitKey: 'Office', category: 'Office', label: 'Document work', count: 1 },
    { unitKey: 'MCP|UnityMCP', category: 'MCP', label: 'MCP UnityMCP', count: 1 },
    { unitKey: 'Skill|gamerscroll-article', category: 'Skill', label: 'Skill gamerscroll-article', count: 1 },
    { unitKey: 'Media|image', category: 'Media', label: 'Image generation', count: 1 },
    { unitKey: 'Media|video', category: 'Media', label: 'Video generation', count: 1 },
    { unitKey: 'Media|lookup', category: 'Media', label: 'Media lookup', count: 1 },
  ]);

  assert.equal(desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'browser-item',
    name: 'browser',
    args: { action: 'open' },
    result: 'ok',
  }).title, 'Browser Use');
  assert.equal(desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'skill-item',
    name: 'Skill',
    args: { name: 'gamerscroll-article' },
    result: 'ok',
  }).title, 'gamerscroll-article');
});

test('desktop activity normalizes common provider tool aliases', () => {
  assert.equal(desktopToolActivityCategory('write', { filePath: 'src/a.ts' }), 'Patch');
  assert.equal(desktopToolActivityCategory('patch', { patch: '*** Begin Patch' }), 'Patch');
  assert.equal(desktopToolActivityCategory('webfetch', { url: 'https://example.com' }), 'Web Research');
  assert.equal(desktopToolActivityCategory('websearch', { query: 'mixdog' }), 'Web Research');
  assert.equal(desktopToolActivityCategory('question', { questions: [] }), 'Setup');
  assert.equal(desktopToolActivityCategory('todowrite', { todos: [] }), 'Setup');
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
  assert.equal(git.title, 'Git');
  assert.equal(git.subject, 'git status --short');
  assert.equal(git.resultLabel, '');
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
  assert.equal(edit.title, 'Edit');
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
  assert.deepEqual(plan.structuredRows.map(({ text, status }) => ({ text, status })), [
    { text: 'Check', status: 'completed' },
    { text: 'Ship', status: 'in_progress' },
  ]);

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
  assert.equal(skill.title, 'setup');
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
  assert.equal(image.title, 'Image');
  assert.equal(image.resultLabel, 'Image');
  assert.equal(image.hasDetails, false);
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
  assert.equal(write.title, 'Write');
  // Detail labels are literals, never catalog keys: the body must read as the
  // tool reported it even when the collapsed row is localized.
  assert.equal(write.previewLabel, 'Content');
  assert.equal(write.previewLanguage, 'ts');

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
