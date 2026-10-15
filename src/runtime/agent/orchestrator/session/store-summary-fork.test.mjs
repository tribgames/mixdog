import assert from 'node:assert/strict';
import test from 'node:test';
import { _normalizeSummaryIndex, _sessionSummary } from './store-summary-index.mjs';
import { normalizedRow } from './store-summary-catalog.mjs';
import { listLeadSessions } from '../../../../session-runtime/lifecycle/session-catalog.mjs';

const session = (extra = {}) => ({
  id: 'sess_fork',
  title: 'Original',
  preview: 'hello',
  messages: [{ role: 'user', content: 'hello' }],
  createdAt: 100,
  updatedAt: 200,
  ...extra,
});

test('the inherited-from id survives every summary projection', () => {
  const summary = _sessionSummary(session({ inheritedFromSessionId: 'sess_orig' }));
  assert.equal(summary.inheritedFromSessionId, 'sess_orig');
  assert.equal(_normalizeSummaryIndex({ rows: [summary] }).rows[0].inheritedFromSessionId, 'sess_orig');
  const row = normalizedRow(summary);
  assert.equal(row.inheritedFromSessionId, 'sess_orig');
  const lead = listLeadSessions({ listSessions: () => [summary] })[0];
  assert.equal(lead.inheritedFromSessionId, 'sess_orig');
  assert.equal(lead.createdAt, 100);
});

test('a session that was never forked carries no source id', () => {
  const summary = _sessionSummary(session());
  assert.equal(summary.inheritedFromSessionId, null);
  assert.equal(listLeadSessions({ listSessions: () => [summary] })[0].inheritedFromSessionId, null);
});
