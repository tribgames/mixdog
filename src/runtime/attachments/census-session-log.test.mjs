import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  encodeCompacted,
  encodeSessionRecord,
} from '../agent/orchestrator/session/store/session-log-format.mjs';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-attachment-census-log-'));
process.env.MIXDOG_DATA_DIR = dataDir;

const { collectPromptAttachments } = await import('./store.mjs');

const DAY = 24 * 60 * 60 * 1000;
const shaDir = join(dataDir, 'prompt-attachments', 'sha256');
const sessionsDir = join(dataDir, 'sessions');
mkdirSync(sessionsDir, { recursive: true });

function blob(name) {
  const ref = createHash('sha256').update(name).digest('hex');
  const path = join(shaDir, ref.slice(0, 2), ref);
  mkdirSync(join(shaDir, ref.slice(0, 2)), { recursive: true });
  writeFileSync(path, name);
  const at = new Date(Date.now() - 2 * DAY);
  utimesSync(path, at, at);
  return ref;
}

const present = (ref) => fs.existsSync(join(shaDir, ref.slice(0, 2), ref));
const imageMessage = (ref) => JSON.stringify({ role: 'user', content: [{ type: 'image', attachmentRef: ref }] });
const sessionLog = (id, ref) =>
  encodeSessionRecord({ logId: `log-${id}`, id, header: { id } }) + encodeCompacted(1, [imageMessage(ref)]);

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

test('an image referenced only from a compaction archive is not swept', async () => {
  const archived = blob('archived-image');
  const orphan = blob('orphan-image');
  writeFileSync(
    join(sessionsDir, 'sess_a.compaction-archive.jsonl'),
    `${JSON.stringify({ segment: 1, items: [{ kind: 'user', attachments: [{ attachmentRef: archived }] }] })}\n`
  );
  const result = await collectPromptAttachments({ now: Date.now(), minAgeMs: DAY });
  assert.equal(result.incomplete, undefined);
  assert.ok(present(archived), 'the archived image survives');
  assert.ok(!present(orphan), 'an unreferenced image is swept');
});

test('images referenced from session logs and set-aside logs are not swept', async () => {
  const inLog = blob('log-image');
  const inDamaged = blob('damaged-image');
  const inDiverged = blob('diverged-image');
  const inTorn = blob('torn-image');
  const inInvalid = blob('invalid-image');
  const inTemp = blob('temp-only-image');
  writeFileSync(join(sessionsDir, 'sess_b.log.jsonl'), sessionLog('sess_b', inLog));
  writeFileSync(join(sessionsDir, 'sess_c.log.jsonl.damaged-1700000000000-0a1b2c3d'), sessionLog('sess_c', inDamaged));
  writeFileSync(join(sessionsDir, 'sess_d.log.jsonl.diverged-1700000000000-4e5f6a7b'), sessionLog('sess_d', inDiverged));
  writeFileSync(join(sessionsDir, 'sess_f.log.jsonl.torn-1700000000000-1a2b3c4d'), sessionLog('sess_f', inTorn));
  writeFileSync(join(sessionsDir, 'sess_g.log.jsonl.invalid-1700000000000-5e6f7a8b'), sessionLog('sess_g', inInvalid));
  // A temp file is the proven replacement mid-swap: the record it replaces
  // may already be gone, so what it names must survive.
  writeFileSync(join(sessionsDir, 'sess_e.log.jsonl.0a1b2c3d4e5f.tmp'), sessionLog('sess_e', inTemp));
  const result = await collectPromptAttachments({ now: Date.now(), minAgeMs: DAY });
  assert.equal(result.incomplete, undefined);
  assert.ok(present(inLog), 'a log reference survives');
  assert.ok(present(inDamaged), 'a damaged set-aside reference survives');
  assert.ok(present(inDiverged), 'a diverged set-aside reference survives');
  assert.ok(present(inTorn), 'a torn-tail set-aside reference survives');
  assert.ok(present(inInvalid), 'an invalid set-aside reference survives');
  assert.ok(present(inTemp), 'a mid-swap temp reference survives');
});
