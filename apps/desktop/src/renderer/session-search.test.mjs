import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['navigator'],
});

const { sessionSearchResults, mergeSessionContentMatches } = await import('./session-search.ts');

test('content hits follow title matches in rank order, skipping listed and unknown sessions', () => {
  const sessions = [session('a'), session('b'), session('c'), session('d', { classification: 'agent' }), session('e')];
  const rows = mergeSessionContentMatches(
    sessions,
    [sessions[1]],
    [
      { sessionId: 'c', rank: 0.9, snippet: 'see c' },
      { sessionId: 'b', rank: 0.8, snippet: 'dup' },
      { sessionId: 'missing', rank: 0.7, snippet: 'x' },
      { sessionId: 'd', rank: 0.6, snippet: 'y' },
      { sessionId: 'a', rank: 0.5, snippet: 'see a' },
      { sessionId: 'c', rank: 0.4, snippet: 'again' },
    ]
  );

  assert.deepEqual(
    rows.map(({ session: { id }, snippet }) => [id, snippet]),
    [
      ['b', undefined],
      ['c', 'see c'],
      ['a', 'see a'],
    ]
  );
});

function session(id, fields = {}) {
  return {
    id,
    title: `Session ${id}`,
    preview: '',
    updatedAt: 0,
    messageCount: 1,
    cwd: '',
    classification: 'task',
    projectPath: null,
    ...fields,
  };
}

test('an empty query lists the ten latest live sessions', () => {
  const sessions = Array.from({ length: 12 }, (_, index) => session(`s${index}`, { activityAt: index + 1 }));
  sessions.push(session('archived', { activityAt: 100, archived: true }));
  sessions.push(session('unclassified', { activityAt: 200, classification: null }));

  assert.deepEqual(
    sessionSearchResults(sessions, '  ').map(({ id }) => id),
    ['s11', 's10', 's9', 's8', 's7', 's6', 's5', 's4', 's3', 's2']
  );
});

test('a query returns every match, beyond the empty-query list', () => {
  const sessions = Array.from({ length: 80 }, (_, index) => session(`s${index}`, { title: `Login ${index}` }));

  assert.equal(sessionSearchResults(sessions, 'login').length, 80);
});

test('a query matches titles, folders and models case-insensitively with archived sessions last', () => {
  const sessions = [
    session('title', { title: 'Fix Login bug', activityAt: 1 }),
    session('folder', { cwd: 'C:\\Project\\login-service', activityAt: 2 }),
    session('model', { model: 'login-model', activityAt: 3 }),
    session('archived', { title: 'Login cleanup', activityAt: 9, archived: true }),
    session('other', { title: 'Unrelated', activityAt: 10 }),
  ];

  assert.deepEqual(
    sessionSearchResults(sessions, 'LOGIN').map(({ id }) => id),
    ['model', 'folder', 'title', 'archived']
  );
});
