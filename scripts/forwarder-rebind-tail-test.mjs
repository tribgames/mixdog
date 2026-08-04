// Regression: on channel connect/change/rebind, OutputForwarder.setContext must
// NOT pull the read cursor back to a prior/unrelated transcript's tail. Only a
// genuinely-unsynced tail of the SAME transcript (crash recovery) is recovered;
// a fresh binding to a DIFFERENT transcript stays at EOF so only outputs created
// after the new binding are forwarded (never the old tail).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutputForwarder } from '../src/runtime/channels/lib/output-forwarder.mjs';

function jsonl(...entries) {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

const USER = { type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } };
const ASSISTANT = { type: 'assistant', message: { content: [{ type: 'text', text: 'old reply tail' }] } };

function makeForwarder(persisted) {
  // statusState stub: setContext only reads via this.statusState.read().
  return new OutputForwarder(() => {}, { read: () => persisted });
}

test('rebind to a DIFFERENT transcript never recovers the old tail (cursor stays at EOF)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fwd-rebind-'));
  try {
    const bound = join(dir, 'new-session.jsonl');
    const prior = join(dir, 'prior-session.jsonl');
    writeFileSync(bound, jsonl(USER, ASSISTANT));
    const size = statSync(bound).size;
    // Persisted status points at a DIFFERENT (prior) transcript, no send evidence.
    const fwd = makeForwarder({
      transcriptPath: prior,
      lastFileSize: 0,
      sentCount: 0,
      lastSentTime: 0,
      lastSentHash: '',
    });
    fwd.setContext('chan-1', bound, { catchUpFromPersisted: true, recoverUnsyncedTail: true });
    assert.equal(fwd.lastFileSize, size, 'cursor must be at EOF — old tail of a fresh binding is not forwarded');
    assert.equal(fwd.readFileSize, size);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SAME-transcript unsynced tail (no send evidence) is still recovered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fwd-same-'));
  try {
    const bound = join(dir, 'session.jsonl');
    writeFileSync(bound, jsonl(USER, ASSISTANT));
    const size = statSync(bound).size;
    // Persisted status is the SAME transcript, fully synced size, no send evidence.
    const fwd = makeForwarder({
      transcriptPath: bound,
      lastFileSize: size,
      sentCount: 0,
      lastSentTime: 0,
      lastSentHash: '',
    });
    fwd.setContext('chan-1', bound, { catchUpFromPersisted: true, recoverUnsyncedTail: true });
    assert.ok(fwd.lastFileSize < size, 'same-session unsynced tail must be recovered (cursor before EOF)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
