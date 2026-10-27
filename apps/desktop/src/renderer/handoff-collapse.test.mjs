// Hand-offs to one target collapse into one counted line; an ended one and
// sends to other sessions do not join it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/', pretendToBeVisual: true },
  expose: ['navigator', 'Node', 'Element', 'HTMLElement', 'MutationObserver'],
  globals: {
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  },
});
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.HTMLElement.prototype.scrollIntoView = () => {};

const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { handoffLinesAt } = await import('./agent-chat-place.ts');
const { AgentHandoffBlock, HandoffQuestionsContext } = await import('./agent-task-line.tsx');

const DAY = new Date(2026, 9, 27, 10, 10).getTime();
const A = 'sess_daemon_a';
const B = 'sess_daemon_b';
const send = (id, sessionId, sendId) => ({
  kind: 'tool',
  id,
  name: 'session',
  args: { action: 'send', session_id: sessionId, prompt: id },
  result: JSON.stringify({ sessionId, accepted: true, sendId, reportsBack: true }),
  status: 'done',
  startedAt: DAY,
});
const round = (key, ...items) => ({ _tag: 'ToolActivity', key, turnKey: 't1', items });
const reply = {
  _tag: 'AssistantPart',
  key: 'a1',
  turnKey: 't1',
  item: { kind: 'assistant', id: 'a1', text: 'Sent', at: DAY },
};
const report = (sessionId, sendId) => ({
  _tag: 'AssistantPart',
  key: `r-${sendId}`,
  turnKey: 't2',
  item: { kind: 'notice', id: `r-${sendId}`, routine: { kind: 'task', sessionId, status: 'completed', sendId } },
});

function paint(rows) {
  const handoffs = handoffLinesAt(rows, rows.indexOf(reply));
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(React.createElement(AgentHandoffBlock, { handoffs })));
  const lines = [...host.querySelectorAll('.mx-handoff-line')].map((line) => line.textContent);
  act(() => root.unmount());
  host.remove();
  return { lines, handoffs };
}

test('two working sends to one session paint one line with a count', () => {
  const { lines, handoffs } = paint([round('r1', send('c1', A, 's1')), round('r2', send('c2', A, 's2')), reply]);
  assert.equal(handoffs.length, 2, 'both hand-offs stay in the data');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /×2/);
});

test('an ended send and a working one paint one line without a count', () => {
  const { lines, handoffs } = paint([
    round('r1', send('c1', A, 's1')),
    round('r2', send('c2', A, 's2')),
    reply,
    report(A, 's1'),
  ]);
  assert.equal(handoffs.length, 1);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /×/);
});

test('the merged line and its question card survive the first send ending', async () => {
  const pending = {
    id: 'q1',
    name: 'ask_user',
    kind: 'question',
    args: { questions: [{ question: 'Which?', options: [{ label: 'One' }] }] },
    sessionId: A,
  };
  const open = [round('r1', send('c1', A, 's1')), round('r2', send('c2', A, 's2')), reply];
  const rendered = (rows) =>
    React.createElement(
      HandoffQuestionsContext.Provider,
      { value: { chatSessionId: 'sess_home_bot', questions: [pending], agentMode: true } },
      React.createElement(AgentHandoffBlock, { handoffs: handoffLinesAt(rows, rows.indexOf(reply)) })
    );
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(rendered(open)));
  const line = host.querySelector('.mx-handoff-line');
  const input = host.querySelector('.question-other input');
  assert.match(line.textContent, /×2/);
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setValue.call(input, 'typed answer');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  assert.equal(input.value, 'typed answer');

  // The first send ends: same root, the group keeps its identity.
  await act(async () => root.render(rendered([...open, report(A, 's1')])));
  assert.equal(host.querySelectorAll('.mx-handoff-line').length, 1);
  assert.doesNotMatch(host.querySelector('.mx-handoff-line').textContent, /×/);
  assert.equal(host.querySelector('.mx-handoff-line'), line, 'the line node is kept');
  assert.equal(host.querySelector('.question-other input'), input, 'the question card is kept');
  assert.equal(input.value, 'typed answer');
  await act(async () => root.unmount());
  host.remove();
});

test('sends to different sessions paint separately', () => {
  const { lines } = paint([round('r1', send('c1', A, 's1')), round('r2', send('c2', B, 's2')), reply]);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => !/×/.test(line)));
});
