import assert from 'node:assert/strict';
import test from 'node:test';
import { INJECTED_DISPLAY_BLOCK_TAGS, stripInjectedBlocks } from './injected-display-text.mjs';
import { isInternalTranscriptDisplayText } from './tool-execution-contract.mjs';
import { stripInjectedDisplayText } from '../../../apps/desktop/src/shared/session-title.mjs';

test('closed injected blocks are removed, user prose around them survives', () => {
  const text = '컨텍스트 창 실시간 반영하지말고\n\n<system-reminder>\nBatch: one call.\n</system-reminder>';
  assert.equal(stripInjectedBlocks(text).trim(), '컨텍스트 창 실시간 반영하지말고');
});

test('an unterminated tag the user typed never eats the rest of the message', () => {
  // Both cases are real desktop transcript losses: the stored message kept the
  // full text while the rendered row stopped at the tag name.
  const mentioned =
    '아니그냥 저거 카테고리분류하는게어때 <available-deferred-tools>도 애매하게 지금 따로분류되어있고 유저 메세지로 분류해서';
  assert.equal(stripInjectedBlocks(mentioned), mentioned);
  assert.equal(stripInjectedDisplayText(mentioned), mentioned);

  const quoted = '위에서부터하나씩 1부터\n\n<mixdog-runtime>과 <system-reminder> 블록은 제어 컨텍스트다\n\n이거 빼자';
  assert.equal(stripInjectedDisplayText(quoted), quoted);
  assert.ok(stripInjectedDisplayText(quoted).includes('이거 빼자'));
});

test('truncated sources opt into dropping the unterminated tail', () => {
  const truncated = '작업 계속해\n\n<system-reminder>\nTool batching: this round issued 2 read calls';
  assert.equal(stripInjectedBlocks(truncated, { dropUnterminated: true }).trim(), '작업 계속해');
});

test('orphan closing tags are always stripped', () => {
  assert.equal(stripInjectedBlocks('본문</system-reminder> 뒤').replace(/\s+/g, ' ').trim(), '본문 뒤');
});

test('every surface shares one tag list', () => {
  assert.deepEqual(INJECTED_DISPLAY_BLOCK_TAGS, [
    'system-reminder',
    'available-deferred-tools',
    'mcp-instructions',
    'memory-context',
    'skill',
    'event',
  ]);
});

test('lenientWrapper:false keeps a pasted completion-shaped prompt visible', () => {
  // Shape-only match: the quoted body is NOT an internal runtime notification.
  const pasted =
    'Async shell task job_7 (completed, exit 0) finished.\n\nResult:\n> 이 결과 왜 이런지 봐줘\n> 로그도 같이';
  assert.equal(isInternalTranscriptDisplayText(pasted), true);
  assert.equal(isInternalTranscriptDisplayText(pasted, { lenientWrapper: false }), false);
});

test('lenientWrapper:false still hides genuine runtime control rows', () => {
  const real =
    'Async shell task job_7 (completed, exit 0) finished.\n\nResult:\n> [task_id: job_7]\n> [status: completed]';
  assert.equal(isInternalTranscriptDisplayText(real, { lenientWrapper: false }), true);
  assert.equal(
    isInternalTranscriptDisplayText('<system-reminder>\nBatch\n</system-reminder>', { lenientWrapper: false }),
    true
  );
  assert.equal(isInternalTranscriptDisplayText('[Request interrupted by user]', { lenientWrapper: false }), true);
});
