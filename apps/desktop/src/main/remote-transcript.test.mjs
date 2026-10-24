import assert from 'node:assert/strict';
import test from 'node:test';

import { createRemoteMethods } from './remote-methods.ts';
import { encodeRelayClientSessionState } from './remote-relay-session-state.ts';
import {
  REMOTE_OUTPUT_TRUNCATED_FIELD,
  REMOTE_PROMPT_HISTORY_BUDGET_CHARS,
  REMOTE_PROMPT_HISTORY_ENTRY_MAX_CHARS,
  REMOTE_TOOL_OUTPUT_CAP_CHARS,
  remotePromptHistory,
  remoteToolOutput,
  remoteTranscriptSnapshot,
} from './remote-transcript.ts';
import { createSnapshotDeltaDecoder } from './state-delta.ts';
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

test('the phone receives the approval outcome fields (expired, withdrawn, interrupted) untouched', () => {
  for (const toolApprovalResult of [
    { id: 'a1', approved: false, device: '', expired: true, at: 1 },
    { id: 'a2', approved: false, device: '', withdrawn: true, at: 2 },
    { id: 'a3', approved: false, device: '', interrupted: true, at: 3 },
  ]) {
    const sent = remoteTranscriptSnapshot({ ...toolSnapshot(), toolApproval: null, toolApprovalResult });
    assert.deepEqual(sent.toolApprovalResult, toolApprovalResult);
  }
});

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

test("a phone's session baseline carries a bounded prompt history, and a submit still patches it", () => {
  // Pasted briefs: 48 prompts of ~24 KB behind two typed ones, newest first.
  const pasted = Array.from({ length: 48 }, (_, index) => `brief ${index} ${'z'.repeat(24_000)}`);
  const history = ['typed newest', ...pasted.slice(0, 20), 'typed older', ...pasted.slice(20)];
  const snapshot = { sessionId: SESSION, items: [{ id: 'u1', kind: 'user', text: 'hi' }], promptHistoryList: history };
  const encoders = new Map();
  const baseline = encodeRelayClientSessionState(encoders, SESSION, snapshot, false, true, true);
  const baselineBytes = JSON.stringify(baseline).length;
  assert.ok(
    baselineBytes < REMOTE_PROMPT_HISTORY_BUDGET_CHARS + 4_096,
    `baseline ${baselineBytes} bytes (whole history ${JSON.stringify(history).length})`
  );
  const decoder = createSnapshotDeltaDecoder();
  const first = decoder.decode(JSON.parse(JSON.stringify(baseline)));
  assert.equal(first.ok, true);
  // Newest first, oversized entries skipped: what a phone keyboard recalls.
  assert.deepEqual(first.snapshot.promptHistoryList, ['typed newest', 'typed older']);
  assert.equal(snapshot.promptHistoryList, history, 'the host copy is never modified');

  // A budget cut keeps the newest entries that fit.
  const typed = Array.from({ length: 50 }, (_, index) => `typed ${index} ${'y'.repeat(1_300)}`);
  const kept = remotePromptHistory(typed);
  assert.deepEqual(kept, typed.slice(0, kept.length));
  assert.ok(kept.length >= 20 && JSON.stringify(kept).length <= REMOTE_PROMPT_HISTORY_BUDGET_CHARS + 4 * kept.length);
  assert.ok(kept.every((entry) => entry.length <= REMOTE_PROMPT_HISTORY_ENTRY_MAX_CHARS));
  assert.equal(remotePromptHistory(typed), kept, 'the same projection for the same list');
  const short = ['b', 'a'];
  assert.equal(remotePromptHistory(short), short, 'a list within the bounds is sent as it is');

  // A short submit travels as a head patch against the bounded copy.
  const next = { ...snapshot, promptHistoryList: ['typed submit', ...history].slice(0, 50) };
  const patch = encodeRelayClientSessionState(encoders, SESSION, next, false, true, true);
  assert.ok(JSON.stringify(patch).length < 1_024, `submit frame ${JSON.stringify(patch).length} bytes`);
  const decoded = decoder.decode(JSON.parse(JSON.stringify(patch)));
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.snapshot.promptHistoryList, ['typed submit', 'typed newest', 'typed older']);
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
      heldTranscript: (sessionId) => remoteTranscriptSnapshot(held[sessionId]) ?? null,
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

const SECRET = 'API_TOKEN=sk-live-0123456789';
const quotedDiff = `diff --git "a/caf\\303\\251/.env" "b/caf\\303\\251/.env"\n--- "a/caf\\303\\251/.env"\n+++ "b/caf\\303\\251/.env"\n@@ -1 +1 @@\n-${SECRET}\n+${SECRET}2\n`;
/** Rows that name secret-bearing files in every field a row can carry a path
 *  in; before parity each was withheld from a paired device. */
const secretRows = [
  { id: 'read-env', kind: 'tool', name: 'read', args: { path: '.env' }, result: SECRET, rawResult: SECRET },
  { id: 'array', kind: 'tool', name: 'read', args: { path: ['src/a.ts', '.env'] }, result: SECRET },
  {
    id: 'reads',
    kind: 'tool',
    name: 'read',
    args: { reads: [{ path: 'src/a.ts' }, { path: 'deploy/id_ed25519' }] },
    result: SECRET,
  },
  { id: 'json', kind: 'tool', name: 'read', args: '{"reads":[{"path":".env.production"}]}', result: SECRET },
  { id: 'quoted', kind: 'tool', name: 'edit', args: {}, result: SECRET, uiDiff: quotedDiff },
  { id: 'write', kind: 'tool', name: 'write', args: { path: '.env', content: SECRET }, result: 'ok' },
  { id: 'abs', kind: 'tool', name: 'read', args: { path: '/home/dev/.ssh/id_rsa' }, result: SECRET },
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

test('a row naming a secret-bearing file reaches the phone as the desktop shows it', () => {
  const projected = remoteTranscriptSnapshot({ items: secretRows });
  // Short rows are the host's own objects: nothing emptied, nothing noted.
  for (const [index, row] of projected.items.entries()) {
    assert.equal(row, secretRows[index], row.id);
    assert.equal('remoteOutputNotes' in row, false, row.id);
  }
  assert.deepEqual(projected.items[5].args, { path: '.env', content: SECRET }, 'a write keeps its content');
  assert.equal(projected.items[4].uiDiff, quotedDiff);
  // A long one is capped like any other, never withheld.
  const long = { id: 'long-env', kind: 'tool', name: 'read', args: { path: '.env' }, result: `${SECRET}${LONG}` };
  const [capped] = remoteTranscriptSnapshot({ items: [long] }).items;
  assert.ok(capped.result.startsWith(SECRET));
  assert.equal(capped.remoteOutputNotes.result.kind, 'omitted');
});

test('the full output of a secret-bearing row is read like any other, from any session folder', async () => {
  for (const cwd of ['/work/app', '/home/dev/.ssh/project']) {
    const { methods } = connection({ [SESSION]: { items: secretRows } }, { cwd });
    for (const id of ['read-env', 'array', 'reads', 'json', 'abs', 'agg-env']) {
      assert.equal((await methods.readTranscriptItem([SESSION, id])).result, SECRET, `${cwd} ${id}`);
    }
    assert.equal((await methods.readTranscriptItem([SESSION, 'quoted'])).uiDiff, quotedDiff);
  }
});

test('the session state a phone is sent carries secret-bearing rows whole, baseline and delta', () => {
  const encoders = new Map();
  const held = [{ id: 'u1', kind: 'user', text: 'read the settings' }];
  const baseline = encodeRelayClientSessionState(encoders, SESSION, { items: held });
  const delta = encodeRelayClientSessionState(encoders, SESSION, { items: [...held, ...secretRows] });
  assert.ok(Object.hasOwn(delta, '__itemsPatch'), 'the second frame is a delta over the first');
  const decoder = createSnapshotDeltaDecoder();
  assert.equal(decoder.decode(JSON.parse(JSON.stringify(baseline))).ok, true);
  const decoded = decoder.decode(JSON.parse(JSON.stringify(delta)));
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.snapshot.items.slice(1), secretRows);
});

test('a relative path is projected at once, whatever folder the session runs in', () => {
  // Before parity it was withheld until the session folder was known.
  const row = { id: 'rel', kind: 'tool', name: 'read', args: { path: 'src/a.ts' }, result: 'code' };
  assert.equal(remoteTranscriptSnapshot({ items: [row] }).items[0], row);
});
