import assert from 'node:assert/strict';
import test from 'node:test';

import { agentLeadRows } from './agent-lead-rows.tsx';

const NOW = Date.UTC(2026, 0, 1, 12);
const MINUTE = 60_000;

function session(id, extra = {}) {
  return {
    id,
    title: id,
    messageCount: 3,
    archived: false,
    provider: 'anthropic-oauth',
    model: 'claude-opus-5-5',
    activityAt: NOW - MINUTE,
    updatedAt: NOW - MINUTE,
    ...extra,
  };
}

const kinds = (rows) => Object.fromEntries(rows.map((row) => [row.sessionId, row.kind]));

test('a waiting row wears the shared amber triangle with its spoken state, never a bare "!"', async (t) => {
  const { installTestDom } = await import('./test-support/test-dom.mjs');
  installTestDom(t, { rootId: false });
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { AgentLeadRows } = await import('./agent-lead-rows.tsx');
  const rows = agentLeadRows([], new Set(['sess_wait']), { now: NOW, sessions: [session('sess_wait')] });
  const markup = renderToStaticMarkup(React.createElement(AgentLeadRows, { rows, onOpen() {} }));
  assert.match(markup, /class="session-attention-glyph [^"]*" data-status="needs-you"/);
  assert.match(markup, /aria-label="sess_wait · Waiting for approval"/);
  assert.doesNotMatch(markup, /<span aria-hidden="true">!<\/span>/);
  // A question wait wears the question glyph and says so.
  const asked = renderToStaticMarkup(
    React.createElement(AgentLeadRows, { rows, asking: new Set(['sess_wait']), onOpen() {} })
  );
  assert.match(asked, /data-status="asking"/);
  assert.match(asked, /aria-label="sess_wait · Waiting for your answer"/);
});

test('a session waiting on the user shows "!" whether it works, rests or settled long ago', () => {
  const sessions = [
    session('sess_working_approval', { working: true }),
    session('sess_old_approval', { activityAt: NOW - 30 * 24 * 60 * MINUTE, updatedAt: NOW - 30 * 24 * 60 * MINUTE }),
    session('sess_idle'),
    session('sess_working', { working: true }),
  ];
  const rows = agentLeadRows([], new Set(['sess_working_approval', 'sess_old_approval']), { now: NOW, sessions });
  assert.deepEqual(kinds(rows), {
    sess_working_approval: 'attention',
    sess_old_approval: 'attention',
    sess_idle: 'idle',
  });
  assert.ok(
    rows.every((row) => row.kind !== 'attention' || row.expiresAt === Number.POSITIVE_INFINITY),
    'a waiting session never expires out of the list'
  );
});
