// A transcript read of a session whose record is gone resolves the archived
// agent result from the parent that metadata names, and never scans the
// sessions directory: a deleted Lead record resolves to null even when some
// other session file happens to carry a completion notification for its id.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-archived-agent-'));
process.env.MIXDOG_DATA_DIR = root;
const sessionsDir = join(root, 'sessions');
mkdirSync(sessionsDir);

const { readStoredSessionTranscript, clearStoredSessionCatalog } = await import('./store-summary-reader.mjs');

test.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const notification = (childId, body) => ({
  role: 'user',
  content: [
    `Async agent task task_${childId} (completed) finished.`,
    '',
    'Result:',
    '> background task',
    `> sessionId: ${childId}`,
    '> surface: agent',
    '> status: completed',
    '> agent: worker',
    '> model: model-a',
    '> ',
    `> ${body}`,
  ].join('\n'),
});
const writeSession = (id, messages) =>
  writeFileSync(
    join(sessionsDir, `${id}.json`),
    JSON.stringify({ id, owner: 'user', agent: 'lead', closed: false, generation: 1, updatedAt: 1, messages })
  );

// Parents named by metadata.
writeSession('sess_parent_link', [notification('sess_child_link', 'linked parent body')]);
writeSession('sess_parent_row', [notification('sess_child_row', 'catalog parent body')]);
// A session no metadata links to any of the ids below. A directory scan
// would find (and prefer, being newer) these notifications.
writeSession('sess_unrelated', [
  notification('sess_child_link', 'unrelated body'),
  notification('sess_child_row', 'unrelated body'),
  notification('sess_deleted_lead', 'unrelated body'),
]);
writeFileSync(
  join(root, 'agent-workers.json'),
  JSON.stringify({
    workers: [
      { sessionId: 'sess_child_link', parentSessionId: 'sess_parent_link', ownerSessionId: 'sess_parent_link' },
    ],
  })
);
writeFileSync(
  join(root, 'session-summaries.json'),
  JSON.stringify({
    version: 2,
    rows: [
      { id: 'sess_child_row', owner: 'agent', agent: 'worker', ownerSessionId: 'sess_parent_row', updatedAt: 1 },
      { id: 'sess_deleted_lead', owner: 'user', agent: 'lead', updatedAt: 1, preview: 'gone' },
    ],
  })
);
clearStoredSessionCatalog();

const archivedText = async (id) => {
  const value = await readStoredSessionTranscript(id);
  return value && { text: value.items[0].text, archived: value.archivedAgentResult, model: value.model };
};

test('an archived agent child resolves through its agent-workers.json parent link', async () => {
  assert.deepEqual(await archivedText('sess_child_link'), {
    text: '# Archived agent result\n\nlinked parent body',
    archived: true,
    model: 'model-a',
  });
});

test('an archived agent child resolves through its summary-catalog owner', async () => {
  assert.deepEqual(await archivedText('sess_child_row'), {
    text: '# Archived agent result\n\ncatalog parent body',
    archived: true,
    model: 'model-a',
  });
});

test('a missing session with no parent link resolves to null without reading other session files', async () => {
  assert.equal(await readStoredSessionTranscript('sess_deleted_lead'), null);
  assert.equal(await readStoredSessionTranscript('sess_never_existed'), null);
});
