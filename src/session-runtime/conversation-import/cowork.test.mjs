import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'mixdog-cowork-import-')));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
const { convertCandidateFile, getCandidate, listConversations, resetConversationDiscovery } = await import(
  './discovery.mjs'
);
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const SECRET = 'SYSTEM-PROMPT-SECRET';
const jsonl = (records) => `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;

// Mirrors %APPDATA%\Claude\local-agent-mode-sessions\<account>\<org>\.
function coworkFixture() {
  const appData = join(root, 'appdata');
  const org = join(appData, 'Claude', 'local-agent-mode-sessions', 'acct', 'org');
  mkdirSync(join(org, 'agent'), { recursive: true });
  const session = (dir, name, manifest, { transcript = true, age = 0 } = {}) => {
    writeFileSync(
      join(dir, `${name}.json`),
      JSON.stringify({ sessionId: name, systemPrompt: SECRET, emailAddress: 'a@b.c', ...manifest })
    );
    if (!transcript) return;
    const projects = join(dir, name, '.claude', 'projects', '-sessions-fixture');
    mkdirSync(projects, { recursive: true });
    const file = join(projects, `${manifest.cliSessionId}.jsonl`);
    const entry = (uuid, parentUuid, type, content) => ({
      uuid,
      parentUuid,
      type,
      isSidechain: false,
      sessionId: manifest.cliSessionId,
      cwd: '/sessions/fixture',
      message: { role: type, content },
    });
    writeFileSync(
      file,
      jsonl([
        entry('u1', null, 'user', `Question for ${name}`),
        entry('a1', 'u1', 'assistant', [{ type: 'text', text: 'Answer' }]),
      ])
    );
    const when = 1_700_000_000 - age;
    utimesSync(file, when, when);
    // Work files and the audit log sit beside the transcript and must never be listed.
    writeFileSync(join(dir, name, 'audit.jsonl'), jsonl([entry('x', null, 'user', 'audit')]));
    mkdirSync(join(dir, name, 'outputs'), { recursive: true });
    writeFileSync(join(dir, name, 'outputs', 'work.jsonl'), jsonl([entry('y', null, 'user', 'work file')]));
  };
  session(
    org,
    'local_old-starred',
    { cliSessionId: 'cli-starred', title: 'Pinned chat', isStarred: true },
    { age: 500 }
  );
  session(org, 'local_recent', { cliSessionId: 'cli-recent', title: 'Recent chat', isStarred: false }, { age: 10 });
  session(org, 'local_archived', { cliSessionId: 'cli-archived', isArchived: true }, { age: 100 });
  session(org, 'local_no-transcript', { cliSessionId: 'cli-missing', title: 'Gone' }, { transcript: false });
  session(org, 'local_traversal', { cliSessionId: '..\\..\\escape', title: 'Escape' }, { transcript: false });
  session(join(org, 'agent'), 'local_ditto_agent', { cliSessionId: 'cli-ditto', sessionType: 'agent' }, { age: 200 });
  return { env: { APPDATA: appData }, org };
}

async function listAll(env) {
  resetConversationDiscovery();
  for (let attempt = 0; attempt < 200; attempt++) {
    const page = await listConversations({ source: 'cowork', limit: 100 }, { imported: new Map(), env });
    if (page.complete) return page;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('discovery never completed');
}

test('Cowork discovery pairs manifests with transcripts, marks and sorts starred rows first', async () => {
  const { env } = coworkFixture();
  const page = await listAll(env);
  assert.ok(page.searchedRoot.endsWith('local-agent-mode-sessions'));
  assert.deepEqual(
    page.rows.map((row) => [row.title, row.starred, row.source, row.messageCount]),
    [
      ['Pinned chat', true, 'cowork', 2],
      ['Recent chat', false, 'cowork', 2],
      ['Question for local_archived', false, 'cowork', 2],
      ['Question for local_ditto_agent', false, 'cowork', 2],
    ]
  );
  const text = JSON.stringify(page);
  assert.ok(!text.includes(SECRET) && !text.includes('a@b.c'));
});

test('a Cowork row converts end to end through the Claude reducer', async () => {
  const { env } = coworkFixture();
  const page = await listAll(env);
  const starred = page.rows[0];
  const conversion = await convertCandidateFile(getCandidate(starred.id));
  assert.equal(conversion.source, 'cowork');
  assert.equal(conversion.foreignSessionId, 'cli-starred');
  assert.equal(conversion.cwd, '/sessions/fixture');
  assert.equal(conversion.messageCount, 2);
  assert.equal(conversion.errorCode ?? null, null);
});

test('without APPDATA there is no Cowork root and nothing is listed', async () => {
  const page = await listAll({});
  assert.equal(page.searchedRoot, '');
  assert.deepEqual(page.rows, []);
});
