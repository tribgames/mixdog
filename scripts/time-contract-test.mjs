import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildCurrentTimeBlock,
  hasUserConversationMessage,
  isProtectedContextUserMessage as isManagerProtectedContextUserMessage,
  prefixSessionStartContent,
} from '../src/runtime/agent/orchestrator/session/manager/prompt-utils.mjs';
import {
  isProtectedContextUserMessage as isCompactProtectedContextUserMessage,
} from '../src/runtime/agent/orchestrator/session/compact/messages.mjs';
import { formatTs } from '../src/runtime/memory/lib/recall-format.mjs';
import { drainPathSync } from '../src/runtime/shared/buffered-appender.mjs';
import {
  formatLocalAndUtcTimestamp,
  formatRecallTimestamp,
  formatUtcTimestamp,
} from '../src/runtime/shared/time-format.mjs';
import { createTranscriptWriter } from '../src/runtime/shared/transcript-writer.mjs';

const instant = new Date('2026-08-13T11:43:30.000Z');

test('time displays pair local zone and UTC', () => {
  assert.equal(formatUtcTimestamp(instant), '2026-08-13T11:43:30.000Z');
  assert.equal(
    formatLocalAndUtcTimestamp(instant, { timeZone: 'Asia/Seoul' }),
    'Local: 2026-08-13 20:43:30 Asia/Seoul (UTC+09:00)\nUTC: 2026-08-13T11:43:30.000Z',
  );
  assert.equal(
    formatRecallTimestamp(instant, { timeZone: 'Asia/Seoul' }),
    '2026-08-13 20:43:30.000 Asia/Seoul (UTC+09:00; UTC 2026-08-13 11:43:30.000Z)',
  );
  assert.equal(
    formatTs(instant.getTime(), { timeZone: 'Asia/Seoul' }),
    '2026-08-13 20:43:30.000 Asia/Seoul (UTC+09:00; UTC 2026-08-13 11:43:30.000Z)',
  );
});

test('time-related prompts receive both local and UTC context', () => {
  const block = buildCurrentTimeBlock('지금 시간이 어떻게 돼?');
  assert.match(block, /^Local: .+ \(UTC[+-]\d{2}:\d{2}\)\nUTC: \d{4}-\d{2}-\d{2}T.+Z$/);
  assert.equal(buildCurrentTimeBlock('파일을 읽어줘'), '');
});

test('a time reminder prefix keeps the first human task visible to context accounting', () => {
  const prompt = '최근 오류를 분석해줘';
  const reminder = buildCurrentTimeBlock(prompt);
  const content = prefixSessionStartContent(
    prompt,
    `<system-reminder>\n# Current Time\n${reminder}\n</system-reminder>`,
  );
  const message = { role: 'user', content };
  const pureReminder = {
    role: 'user',
    content: '<system-reminder>\nSynthetic context\n</system-reminder>',
  };

  assert.equal(hasUserConversationMessage([message]), true);
  assert.equal(isManagerProtectedContextUserMessage(message), false);
  assert.equal(isCompactProtectedContextUserMessage(message), false);
  assert.equal(hasUserConversationMessage([pureReminder]), false);
  assert.equal(isManagerProtectedContextUserMessage(pureReminder), true);
  assert.equal(isCompactProtectedContextUserMessage(pureReminder), true);
});

test('new transcript rows store an explicit UTC timestamp', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-time-'));
  try {
    const writer = createTranscriptWriter({
      mixdogHome: dir,
      sessionId: 'time-contract',
      cwd: dir,
      pid: 123,
    });
    const before = Date.now();
    writer.appendUser('timestamp me');
    drainPathSync(writer.transcriptPath);
    const after = Date.now();
    const row = JSON.parse(readFileSync(writer.transcriptPath, 'utf8').trim());
    assert.match(row.timestamp, /^\d{4}-\d{2}-\d{2}T.+Z$/);
    assert.ok(Date.parse(row.timestamp) >= before && Date.parse(row.timestamp) <= after);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
