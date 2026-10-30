import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentTodoMark } from './AgentTodoMark.tsx';
import { t } from './i18n.ts';

const markup = (todo) => renderToStaticMarkup(React.createElement(AgentTodoMark, { todo }));

test('an agent row shows its step list as a small ring and n/m', () => {
  const html = markup({ completed: 2, total: 5, current: 'Run tests' });
  assert.match(html, />2\/5</);
  assert.match(html, /session-goal-ring-track/);
  assert.match(html, /stroke-dasharray/);
  const label = t('To-do {{completed}} of {{total}} done', { completed: 2, total: 5 });
  assert.ok(html.includes(`aria-label="${label}: Run tests"`));
});

test('an agent without a step list shows nothing, and an unstarted one an empty ring', () => {
  assert.equal(markup(undefined), '');
  assert.equal(markup(null), '');
  const dropped = markup({ completed: 0, total: 0 });
  assert.match(dropped, />0\/0</, 'a list whose steps were all dropped keeps its count');
  assert.doesNotMatch(dropped, /stroke-dasharray/);
  const html = markup({ completed: 0, total: 3 });
  assert.match(html, />0\/3</);
  assert.doesNotMatch(html, /stroke-dasharray/);
});
