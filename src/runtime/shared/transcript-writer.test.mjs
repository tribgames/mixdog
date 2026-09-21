import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { drainPathSync } from './buffered-appender.mjs';
import { createTranscriptWriter } from './transcript-writer.mjs';

function withHome(run) {
  const home = mkdtempSync(join(tmpdir(), 'mixdog-transcript-writer-'));
  try {
    return run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const rows = (writer) => {
  drainPathSync(writer.transcriptPath);
  return readFileSync(writer.transcriptPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

test('createTranscriptWriter requires home, session and cwd', () => {
  assert.throws(() => createTranscriptWriter({ sessionId: 's', cwd: 'c' }), /mixdogHome is required/);
  assert.throws(() => createTranscriptWriter({ mixdogHome: 'h', cwd: 'c' }), /sessionId is required/);
  assert.throws(() => createTranscriptWriter({ mixdogHome: 'h', sessionId: 's' }), /cwd is required/);
});

test('appended rows are stamped with the session cwd and a timestamp, blank text is skipped', () => {
  withHome((home) => {
    const cwd = join(home, 'project');
    const writer = createTranscriptWriter({ mixdogHome: home, sessionId: 'sess-1', cwd, pid: 42 });
    writer.appendUser('   ');
    writer.appendAssistant('');
    writer.appendUser('hello');
    writer.appendAssistant('world');
    writer.appendUser([
      { type: 'text', text: 'look at this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      'and this',
    ]);
    writer.appendUser([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]);
    writer.appendToolUse('read', { path: 'a.txt' });
    writer.appendToolUse('', { path: 'ignored' });
    writer.appendToolResult({ ok: true });
    writer.appendToolResult(null);
    const out = rows(writer);
    assert.deepEqual(
      out.map((row) => [row.type, row.sessionId, row.message.content[0].type]),
      [
        ['user', 'sess-1', 'text'],
        ['assistant', 'sess-1', 'text'],
        ['user', 'sess-1', 'text'],
        ['assistant', 'sess-1', 'tool_use'],
        ['user', 'sess-1', 'tool_result'],
      ]
    );
    assert.equal(out[2].message.content[0].text, 'look at this\nand this');
    assert.equal(out[3].message.content[0].name, 'read');
    assert.deepEqual(out[4].toolUseResult, { ok: true });
    for (const row of out) {
      assert.equal(row.cwd, cwd);
      assert.match(row.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    }
    assert.ok(writer.transcriptPath.startsWith(join(home, 'projects')));
    assert.equal(writer.sessionRecordPath, join(home, 'sessions', '42.json'));
  });
});

test('conversation backfill seeds an empty transcript once and never rewrites content', () => {
  withHome((home) => {
    const cwd = join(home, 'project');
    const writer = createTranscriptWriter({ mixdogHome: home, sessionId: 'sess-2', cwd });
    const seeded = writer.ensureConversationBackfill([
      { role: 'user', content: 'first', timestamp: '2026-01-01T00:00:00.000Z' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'reply' },
          { type: 'tool_use', name: 'x' },
        ],
        ts: 5,
      },
      { role: 'system', content: 'skipped' },
      { role: 'user', content: '   ' },
    ]);
    assert.equal(seeded, true);
    const out = rows(writer);
    assert.deepEqual(
      out.map((row) => [row.type, row.message.content[0].text, row.timestamp ?? row.ts]),
      [
        ['user', 'first', '2026-01-01T00:00:00.000Z'],
        ['assistant', 'reply', 5],
      ]
    );
    assert.equal(writer.ensureConversationBackfill([{ role: 'user', content: 'again' }]), false);
    assert.equal(rows(writer).length, 2, 'a non-empty transcript is authoritative');
  });
});

test('backfill without eligible rows leaves an empty file, and ensureTranscriptFile never truncates', () => {
  withHome((home) => {
    const writer = createTranscriptWriter({ mixdogHome: home, sessionId: 'sess-3', cwd: join(home, 'p') });
    assert.equal(writer.ensureConversationBackfill([{ role: 'system', content: 'x' }]), false);
    assert.equal(statSync(writer.transcriptPath).size, 0);
    writer.appendUser('kept');
    drainPathSync(writer.transcriptPath);
    writer.ensureTranscriptFile();
    assert.equal(rows(writer).length, 1);
  });
});

test('the session record names the transcript and is refreshed in place', () => {
  withHome((home) => {
    const cwd = join(home, 'project');
    const writer = createTranscriptWriter({ mixdogHome: home, sessionId: 'sess-4', cwd, pid: 7 });
    assert.equal(existsSync(writer.sessionRecordPath), false);
    writer.writeSessionRecord();
    const first = JSON.parse(readFileSync(writer.sessionRecordPath, 'utf8'));
    assert.equal(first.sessionId, 'sess-4');
    assert.equal(first.cwd, cwd);
    assert.equal(first.transcriptPath, writer.transcriptPath);
    assert.equal(first.kind, 'interactive');
    assert.equal(first.entrypoint, 'cli');
    writer.refresh();
    const second = JSON.parse(readFileSync(writer.sessionRecordPath, 'utf8'));
    assert.equal(second.startedAt, first.startedAt);
    assert.ok(second.updatedAt >= first.updatedAt);
  });
});
