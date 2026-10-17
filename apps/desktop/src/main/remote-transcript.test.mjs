import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createRemoteMethods } from './remote-methods.ts';
import { encodeRelayClientSessionState } from './remote-relay-session-state.ts';
import {
  REMOTE_OUTPUT_TRUNCATED_FIELD,
  REMOTE_TOOL_OUTPUT_CAP_CHARS,
  remoteToolOutput,
  remoteTranscriptSnapshot,
  toolRecordPaths,
} from './remote-transcript.ts';
import { READ_NOT_HELD, READ_NOT_VIEWED } from './remote-session-methods.ts';

const SESSION = `sess_desktop_${'b'.repeat(64)}`;
const LONG = `HEAD-${'x'.repeat(30_000)}-TAIL exit code: 2`;

function toolSnapshot() {
  return {
    items: [
      { id: 'u1', kind: 'user', text: LONG },
      { id: 't1', kind: 'tool', name: 'shell', args: { command: 'build' }, result: LONG, rawResult: LONG },
      { id: 't2', kind: 'tool', name: 'read', result: 'short', rawResult: 'short' },
      {
        id: 'agg',
        kind: 'tool',
        aggregate: true,
        result: '',
        toolMembers: [
          { id: 'm1', name: 'read', result: LONG, rawResult: 'raw-short', uiDiff: LONG },
          { name: 'grep', result: 'ok' },
          { name: 'shell', result: LONG },
        ],
      },
    ],
  };
}

test('a tool output over the cap keeps its head and tail and says how long it was', () => {
  const projected = remoteTranscriptSnapshot(toolSnapshot());
  const shell = projected.items[1];
  assert.ok(shell.result.length < REMOTE_TOOL_OUTPUT_CAP_CHARS + 64);
  assert.ok(shell.result.startsWith('HEAD-xxx'));
  assert.ok(shell.result.endsWith('-TAIL exit code: 2'));
  assert.doesNotMatch(shell.result, /omitted/u, "the words are the phone's to write");
  const { at, omitted } = shell.remoteOutputNotes.result;
  assert.equal(shell.remoteOutputNotes.result.kind, 'omitted');
  assert.equal(shell.result.length, LONG.length - omitted);
  assert.equal(shell.result.slice(at), LONG.slice(at + omitted), 'the tail follows the cut');
  assert.equal(shell.rawResult, shell.result);
  assert.equal(shell[REMOTE_OUTPUT_TRUNCATED_FIELD], LONG.length);
  assert.deepEqual(shell.args, { command: 'build' });
});

test('the cap is structural: short outputs, other row kinds and diffs are untouched', () => {
  const snapshot = toolSnapshot();
  const projected = remoteTranscriptSnapshot(snapshot);
  assert.equal(projected.items[0], snapshot.items[0], 'a user row is never capped, however long');
  assert.equal(projected.items[2], snapshot.items[2], 'a row under the cap is the same object');
  assert.equal(REMOTE_OUTPUT_TRUNCATED_FIELD in projected.items[2], false);
  const [capped, plain, aggregateShell] = projected.items[3].toolMembers;
  assert.ok(capped.result.length < REMOTE_TOOL_OUTPUT_CAP_CHARS + 64);
  assert.equal(capped.rawResult, 'raw-short');
  assert.equal(capped.uiDiff, LONG, 'a diff the digest cannot stand in for (not one git-form file) is sent whole');
  assert.equal('uiDiffSummary' in capped, false);
  assert.equal(capped[REMOTE_OUTPUT_TRUNCATED_FIELD], LONG.length);
  assert.equal(plain, snapshot.items[3].toolMembers[1]);
  assert.equal(aggregateShell[REMOTE_OUTPUT_TRUNCATED_FIELD], LONG.length);
  assert.equal(snapshot.items[1].result, LONG, 'the host copy is never modified');
  assert.equal(remoteTranscriptSnapshot({ items: [{ kind: 'tool', result: 'short' }] }).items.length, 1);
});

test('the cut never splits a surrogate pair and is stable for an unchanged row', () => {
  const emoji = '😀';
  const text = `${'a'.repeat(6_143)}${emoji}${'b'.repeat(20_000)}${emoji}${'c'.repeat(2_047)}`;
  const { result } = remoteTranscriptSnapshot({ items: [{ id: 't', kind: 'tool', result: text }] }).items[0];
  assert.doesNotMatch(result, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  const snapshot = toolSnapshot();
  assert.equal(remoteTranscriptSnapshot(snapshot).items[1], remoteTranscriptSnapshot(snapshot).items[1]);
});

test('the full output is found by row id, member id or the renderer member name', () => {
  const snapshot = toolSnapshot();
  assert.deepEqual(remoteToolOutput(snapshot, 't1'), { id: 't1', result: LONG, rawResult: LONG });
  assert.deepEqual(remoteToolOutput(snapshot, 'm1'), {
    id: 'm1',
    result: LONG,
    rawResult: 'raw-short',
    uiDiff: LONG,
  });
  assert.deepEqual(remoteToolOutput(snapshot, 'agg:member:2'), { id: 'agg:member:2', result: LONG });
  assert.equal(remoteToolOutput(snapshot, 'u1'), null, 'only tool rows are served');
  assert.equal(remoteToolOutput(snapshot, 'missing'), null);
  assert.equal(remoteToolOutput(null, 't1'), null);
});

const SESSION_B = `sess_desktop_${'c'.repeat(64)}`;

/** Methods for a connection that views `viewed` and was sent `held` for each. */
function connection(transcripts, { viewed = [SESSION], held = transcripts, cwd = '/work/app' } = {}) {
  const asked = [];
  const methods = createRemoteMethods(
    {
      host: {
        readSessionTranscript: async (sessionId) => {
          asked.push(sessionId);
          return transcripts[sessionId] ?? null;
        },
        listSessions: async () => Object.keys(transcripts).map((id) => ({ id, cwd })),
      },
    },
    {
      viewedSessionIds: () => viewed,
      heldTranscript: (sessionId) => remoteTranscriptSnapshot(held[sessionId], process.cwd()) ?? null,
    }
  );
  return { methods, asked };
}

test('readTranscriptItem returns the uncapped output the phone copy was cut from', async () => {
  const snapshot = toolSnapshot();
  const { methods, asked } = connection({ [SESSION]: snapshot });
  const phoneCopy = remoteTranscriptSnapshot(snapshot).items[1];
  assert.ok(phoneCopy.result.length < LONG.length);
  const full = await methods.readTranscriptItem([SESSION, phoneCopy.id]);
  assert.deepEqual(asked, [SESSION]);
  assert.equal(full.result, LONG);
  assert.equal(full.rawResult, LONG);
  assert.equal(await methods.readTranscriptItem([SESSION, 'gone']).catch((error) => error.message), READ_NOT_HELD);
  await assert.rejects(async () => methods.readTranscriptItem([SESSION, 7]), /itemId/u);
  await assert.rejects(async () => methods.readTranscriptItem(['not a session', 't1']), /session id/u);
});

test('a connection reads only a session it views and a row it was sent', async () => {
  const secret = { items: [{ id: 'b1', kind: 'tool', name: 'shell', args: { command: 'ls' }, result: LONG }] };
  const { methods, asked } = connection({ [SESSION]: toolSnapshot(), [SESSION_B]: secret });
  // Session B exists on the host but this connection views only A.
  await assert.rejects(async () => methods.readTranscriptItem([SESSION_B, 'b1']), new RegExp(READ_NOT_VIEWED));
  assert.deepEqual(asked, [], 'the host transcript is not even read');
  // A row id of B asked against session A is not a row of A's transcript.
  await assert.rejects(async () => methods.readTranscriptItem([SESSION, 'b1']), new RegExp(READ_NOT_HELD));
  // A viewed session whose row the host never sent this connection (a newer row).
  const newer = toolSnapshot();
  const sent = { items: newer.items.filter((item) => item.id !== 't1') };
  const behind = connection({ [SESSION]: newer }, { held: { [SESSION]: sent } });
  await assert.rejects(async () => behind.methods.readTranscriptItem([SESSION, 't1']), new RegExp(READ_NOT_HELD));
  // No connection record at all: nothing is served.
  const bare = createRemoteMethods({ host: { readSessionTranscript: async () => toolSnapshot() } });
  await assert.rejects(async () => bare.readTranscriptItem([SESSION, 't1']), new RegExp(READ_NOT_VIEWED));
});

test('a row that names a secret path is withheld, whatever field carries the name', async () => {
  const token = 'API_TOKEN=sk-live-0123456789';
  const withDiff = `diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-${token}\n+${token}2\n`;
  const snapshot = {
    items: [
      { id: 'read-env', kind: 'tool', name: 'read', args: { path: '.env' }, result: token, rawResult: token },
      { id: 'read-key', kind: 'tool', name: 'read', args: { file_path: 'deploy/id_ed25519' }, result: token },
      { id: 'edit-env', kind: 'tool', name: 'edit', args: {}, result: 'ok', uiDiff: withDiff },
      { id: 'read-ok', kind: 'tool', name: 'read', args: { path: 'src/app.ts' }, result: LONG },
      {
        id: 'agg',
        kind: 'tool',
        aggregate: true,
        args: {},
        result: '',
        toolMembers: [
          { id: 'am-ok', name: 'read', args: { path: 'src/app.ts' }, result: LONG },
          { id: 'am-env', name: 'read', args: { path: 'config/.env.production' }, result: token },
        ],
      },
    ],
  };
  const { methods } = connection({ [SESSION]: snapshot });
  for (const id of ['read-env', 'read-key', 'edit-env', 'am-env', 'agg']) {
    assert.deepEqual(await methods.readTranscriptItem([SESSION, id]), { id, withheld: true }, id);
  }
  assert.equal((await methods.readTranscriptItem([SESSION, 'read-ok'])).result, LONG);
  assert.equal((await methods.readTranscriptItem([SESSION, 'am-ok'])).result, LONG);
  // Nothing the host returns for a withheld row holds the secret.
  assert.doesNotMatch(JSON.stringify(await methods.readTranscriptItem([SESSION, 'agg'])), /sk-live/u);
  // A session folder inside a credential store withholds every row of it.
  const inSecretRoot = connection({ [SESSION]: toolSnapshot() }, { cwd: '/home/dev/.ssh/project' });
  assert.deepEqual(await inSecretRoot.methods.readTranscriptItem([SESSION, 't1']), {
    id: 't1',
    withheld: true,
  });
});

const SECRET = 'API_TOKEN=sk-live-0123456789';
const quotedDiff = `diff --git "a/caf\\303\\251/.env" "b/caf\\303\\251/.env"\n--- "a/caf\\303\\251/.env"\n+++ "b/caf\\303\\251/.env"\n@@ -1 +1 @@\n-${SECRET}\n+${SECRET}2\n`;
const bypassRows = [
  { id: 'array', kind: 'tool', name: 'read', args: { path: ['src/a.ts', '.env'] }, result: SECRET, rawResult: SECRET },
  {
    id: 'reads',
    kind: 'tool',
    name: 'read',
    args: { reads: [{ path: 'src/a.ts' }, { path: 'deploy/id_ed25519' }] },
    result: SECRET,
  },
  { id: 'json', kind: 'tool', name: 'read', args: '{"reads":[{"path":".env.production"}]}', result: SECRET },
  { id: 'quoted', kind: 'tool', name: 'edit', args: {}, result: SECRET, uiDiff: quotedDiff },
  {
    id: 'agg',
    kind: 'tool',
    aggregate: true,
    result: '',
    toolMembers: [
      { id: 'agg-ok', name: 'read', args: { path: 'src/a.ts' }, result: 'fine' },
      { id: 'agg-env', name: 'read', args: { path: '.env' }, result: SECRET },
    ],
  },
];
const ordinaryRow = { id: 'ok', kind: 'tool', name: 'read', args: { path: ['src/a.ts'] }, result: LONG };

test('every bypass shape is withheld in the snapshot and in full-output retrieval', async () => {
  const snapshot = { items: [...bypassRows, ordinaryRow] };
  const projected = remoteTranscriptSnapshot(snapshot, process.cwd());
  assert.doesNotMatch(JSON.stringify(projected), /sk-live|API_TOKEN/u);
  for (const row of projected.items.slice(0, 4)) {
    assert.equal(row.result, '', row.id);
    assert.deepEqual(row.remoteOutputNotes.result, { kind: 'withheld' }, row.id);
    assert.equal(row.remoteOutputWithheld, true, row.id);
    assert.equal('uiDiff' in row, false, row.id);
  }
  const [ok, env] = projected.items[4].toolMembers;
  assert.equal(ok.result, 'fine', 'a member that names no secret keeps its output');
  assert.equal(env.result, '');
  assert.equal(env.remoteOutputWithheld, true);
  assert.equal('uiDiff' in env, false);
  assert.doesNotMatch(JSON.stringify(projected), /Output withheld/u, "the words are the phone's to write");
  const ordinary = projected.items[5];
  assert.ok(
    ordinary.result.length < LONG.length && ordinary.result.startsWith('HEAD-'),
    'ordinary output is only capped'
  );
  assert.equal('remoteOutputWithheld' in ordinary, false);
  const { methods } = connection({ [SESSION]: snapshot });
  for (const id of ['array', 'reads', 'json', 'quoted', 'agg', 'agg-env']) {
    assert.deepEqual(await methods.readTranscriptItem([SESSION, id]), {
      id,
      withheld: true,
    });
  }
  assert.equal((await methods.readTranscriptItem([SESSION, 'ok'])).result, LONG);
});

test('writing a secret file does not leak its content through args', () => {
  const rows = [
    { id: 'w', kind: 'tool', name: 'write', args: { path: '.env', content: SECRET }, result: 'ok' },
    {
      id: 'e',
      kind: 'tool',
      name: 'edit',
      args: { file_path: '.env', old_string: 'A=1', new_string: SECRET },
      result: 'ok',
    },
    {
      id: 'p',
      kind: 'tool',
      name: 'apply_patch',
      args: JSON.stringify({ path: 'id_ed25519', patch: SECRET, edits: [{ path: 'id_ed25519', new_string: SECRET }] }),
      result: 'ok',
    },
    { id: 'plain', kind: 'tool', name: 'write', args: { path: 'src/a.ts', content: 'code' }, result: 'ok' },
  ];
  const projected = remoteTranscriptSnapshot({ items: rows }, process.cwd());
  assert.doesNotMatch(JSON.stringify(projected), /sk-live|API_TOKEN|A=1/u);
  assert.equal(projected.items[0].name, 'write');
  assert.deepEqual(projected.items[0].args, { path: '.env' });
  assert.deepEqual(projected.items[2].args, { path: 'id_ed25519', edits: [{ path: 'id_ed25519' }] });
  assert.equal(projected.items[3], rows[3], 'an ordinary write is untouched');
});

test('the initial session state is redacted before it is encoded', () => {
  const snapshot = { items: bypassRows };
  const wire = JSON.stringify(encodeRelayClientSessionState(new Map(), SESSION, snapshot));
  assert.doesNotMatch(wire, /sk-live/u);
  assert.match(wire, /remoteOutputWithheld/u);
});

/** A folder with a `.env`, an ordinary file and, where the host allows it, an
 *  innocently named link to each: `null` (the test skipped) where it does not. */
function linkFixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'remote-transcript-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  writeFileSync(join(base, '.env'), SECRET);
  writeFileSync(join(base, 'notes.txt'), 'plain notes');
  const fixture = { base, envLink: join(base, 'settings.txt'), notesLink: join(base, 'readme.txt') };
  try {
    symlinkSync(join(base, '.env'), fixture.envLink, 'file');
    symlinkSync(join(base, 'notes.txt'), fixture.notesLink, 'file');
  } catch (error) {
    if (error?.code === 'EPERM') {
      t.skip('file symlinks need elevated rights on this host');
      return null;
    }
    throw error;
  }
  return fixture;
}

const linkRows = (f) => [
  { id: 'read-link', kind: 'tool', name: 'read', args: { path: f.envLink }, result: SECRET, rawResult: SECRET },
  {
    id: 'write-link',
    kind: 'tool',
    name: 'write',
    args: { file_path: f.envLink, content: SECRET },
    result: 'ok',
    uiDiff: `--- a/x\n+++ b/x\n@@ -1 +1 @@\n-${SECRET}\n+${SECRET}2\n`,
  },
  {
    id: 'agg-link',
    kind: 'tool',
    aggregate: true,
    result: '',
    toolMembers: [
      { id: 'agg-plain', name: 'read', args: { path: f.notesLink }, result: 'fine' },
      { id: 'agg-env', name: 'read', args: { path: f.envLink }, result: SECRET },
    ],
  },
];
const linkedPlainRow = (f) => ({
  id: 'read-plain',
  kind: 'tool',
  name: 'read',
  args: { path: f.notesLink },
  result: 'plain notes',
});

test('a symlink to .env is withheld in the snapshot; an ordinary file still passes through', (t) => {
  const f = linkFixture(t);
  if (!f) return;
  const plain = linkedPlainRow(f);
  const projected = remoteTranscriptSnapshot({ items: [...linkRows(f), plain] });
  assert.doesNotMatch(JSON.stringify(projected), /sk-live|API_TOKEN/u);
  for (const row of projected.items.slice(0, 2)) {
    assert.equal(row.result, '', row.id);
    assert.deepEqual(row.remoteOutputNotes.result, { kind: 'withheld' }, row.id);
    assert.equal(row.remoteOutputWithheld, true, row.id);
    assert.equal('uiDiff' in row, false, row.id);
  }
  assert.deepEqual(projected.items[0].args, { path: f.envLink });
  assert.deepEqual(projected.items[1].args, { file_path: f.envLink }, 'a write keeps its path, not its content');
  const [ok, env] = projected.items[2].toolMembers;
  assert.equal(ok.result, 'fine', 'a member that links to an ordinary file keeps its output');
  assert.equal(env.result, '');
  assert.equal(env.remoteOutputWithheld, true);
  assert.deepEqual(projected.items[3], plain, 'a link to an ordinary file is untouched');
  assert.equal('remoteOutputWithheld' in projected.items[3], false);
});

test('a symlink to .env is withheld in the delta a connected phone is sent', (t) => {
  const f = linkFixture(t);
  if (!f) return;
  const encoders = new Map();
  const held = [{ id: 'u1', kind: 'user', text: 'read the settings' }, linkedPlainRow(f)];
  const baseline = encodeRelayClientSessionState(encoders, SESSION, { items: held });
  assert.match(JSON.stringify(baseline), /plain notes/u);
  const delta = encodeRelayClientSessionState(encoders, SESSION, { items: [...held, ...linkRows(f)] });
  assert.ok(Object.hasOwn(delta, '__itemsPatch'), 'the second frame is a delta over the first');
  const wire = JSON.stringify(delta);
  assert.doesNotMatch(wire, /sk-live|API_TOKEN/u);
  assert.match(wire, /remoteOutputWithheld/u);
});

test('a junction to a credential folder withholds what is read or written under it', (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'remote-transcript-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, '.ssh'));
  writeFileSync(join(base, '.ssh', 'known_hosts'), SECRET);
  const link = join(base, 'shortcut');
  try {
    symlinkSync(join(base, '.ssh'), link, 'junction');
  } catch (error) {
    if (error?.code === 'EPERM') {
      t.skip('links need elevated rights on this host');
      return;
    }
    throw error;
  }
  const projected = remoteTranscriptSnapshot({
    items: [
      { id: 'read', kind: 'tool', name: 'read', args: { path: join(link, 'known_hosts') }, result: SECRET },
      // A file that does not exist yet is judged by the folder it would be created in.
      {
        id: 'write',
        kind: 'tool',
        name: 'write',
        args: { path: join(link, 'new.txt'), content: SECRET },
        result: 'ok',
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(projected), /sk-live|API_TOKEN/u);
  for (const row of projected.items) assert.equal(row.remoteOutputWithheld, true, row.id);
});

test('a relative path is withheld until the session folder is known, then re-projected', () => {
  const row = { id: 'rel', kind: 'tool', name: 'read', args: { path: 'src/a.ts' }, result: 'code' };
  const snapshot = { items: [row] };
  const unknown = remoteTranscriptSnapshot(snapshot).items[0];
  assert.equal(unknown.result, '');
  assert.equal(unknown.remoteOutputWithheld, true);
  const known = remoteTranscriptSnapshot(snapshot, process.cwd()).items[0];
  assert.equal(known.result, 'code');
  const absolute = { id: 'abs', kind: 'tool', name: 'read', args: { path: join(tmpdir(), 'a.txt') }, result: 'x' };
  assert.equal(remoteTranscriptSnapshot({ items: [absolute] }).items[0].result, 'x');
});

test('a relative symlink to .env is resolved under the session folder, not the process folder', (t) => {
  const f = linkFixture(t);
  if (!f) return;
  const rows = [
    { id: 'rel', kind: 'tool', name: 'read', args: { path: 'settings.txt' }, result: SECRET },
    { id: 'rel-ok', kind: 'tool', name: 'read', args: { path: 'readme.txt' }, result: 'plain notes' },
  ];
  const withheld = (items) =>
    items[0].remoteOutputWithheld === true && items[0].result === '' && items[1].result === 'plain notes';
  assert.ok(withheld(remoteTranscriptSnapshot({ items: rows }, f.base).items));
  assert.ok(withheld(remoteTranscriptSnapshot({ items: rows, workspace: { cwd: f.base } }).items));
  const wire = JSON.stringify(
    encodeRelayClientSessionState(new Map(), SESSION, { items: rows }, false, false, false, f.base)
  );
  assert.doesNotMatch(wire, /sk-live/u);
});

test('a relative path through a junction is resolved under the session folder', (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'remote-transcript-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, '.ssh'));
  writeFileSync(join(base, '.ssh', 'known_hosts'), SECRET);
  try {
    symlinkSync(join(base, '.ssh'), join(base, 'shortcut'), 'junction');
  } catch (error) {
    if (error?.code === 'EPERM') {
      t.skip('links need elevated rights on this host');
      return;
    }
    throw error;
  }
  const rows = [{ id: 'rel', kind: 'tool', name: 'read', args: { path: 'shortcut/known_hosts' }, result: SECRET }];
  const wire = JSON.stringify(
    encodeRelayClientSessionState(new Map(), SESSION, { items: rows }, false, false, false, base)
  );
  assert.doesNotMatch(wire, /sk-live/u);
  assert.match(wire, /remoteOutputWithheld/u);
});

test('a path that cannot be resolved is judged by its own name', (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'remote-transcript-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const projected = remoteTranscriptSnapshot({
    items: [
      { id: 'deleted-env', kind: 'tool', name: 'read', args: { path: join(base, 'gone', '.env') }, result: SECRET },
      { id: 'deleted-ok', kind: 'tool', name: 'read', args: { path: join(base, 'gone', 'notes.txt') }, result: 'x' },
    ],
  });
  assert.equal(projected.items[0].remoteOutputWithheld, true);
  assert.equal(projected.items[1].result, 'x');
});

test('a quoted diff header names its decoded file', () => {
  assert.ok(toolRecordPaths({ uiDiff: quotedDiff }).includes('café/.env'));
});

test('a digest row names its files in the sensitive-path check too', () => {
  const found = toolRecordPaths({
    uiDiffSummary: { sections: [{ names: ['.env', '.env'] }] },
    args: '{"path":"a.ts"}',
  });
  assert.deepEqual(found.sort(), ['.env', 'a.ts']);
});
