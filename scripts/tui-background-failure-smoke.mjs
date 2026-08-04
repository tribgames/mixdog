#!/usr/bin/env node
import { backgroundTaskFailureStatusLabel, isBackgroundErrorOnlyBody } from '../src/runtime/shared/err-text.mjs';
import { parseBackgroundTaskEnvelope } from '../src/tui/engine.mjs';

function assertEq(label, got, want) {
  if (got !== want) throw new Error(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

assertEq('context overflow', backgroundTaskFailureStatusLabel('failed', 'AGENT_CONTEXT_OVERFLOW', { surface: 'agent' }), 'Failed · Context too large');
assertEq('first response timeout', backgroundTaskFailureStatusLabel('failed', 'agent first response stale (120000ms)', { surface: 'agent' }), 'Timeout · No first response 120s');
assertEq('task stale', backgroundTaskFailureStatusLabel('failed', 'agent task stale (1800000ms)', { surface: 'agent' }), 'Stale · No progress 30m');
assertEq('tool running stale', backgroundTaskFailureStatusLabel('failed', 'agent tool running stale (180000ms)', { surface: 'agent' }), 'Stale · No progress 3m');
assertEq(
  'normalized first response',
  backgroundTaskFailureStatusLabel('failed', 'No first response from the agent within 120s.', { surface: 'agent' }),
  'Timeout · No first response 120s',
);
assertEq(
  'normalized stale',
  backgroundTaskFailureStatusLabel('failed', 'The agent went stale after 30m without new stream/tool progress.', { surface: 'agent' }),
  'Stale · No progress 30m',
);

assertEq('error-only body', isBackgroundErrorOnlyBody('Error: Context too large.', 'Context too large.'), true);
assertEq('real body', isBackgroundErrorOnlyBody('found 3 files\nsrc/a.mjs', ''), false);

function showRawResultForBackgroundMetadata(expanded, isBackgroundMetadataResult, hasDisplayResult, hasRawResult) {
  return expanded && (hasDisplayResult || hasRawResult) && (!isBackgroundMetadataResult || hasRawResult);
}

function collapsedFailureUsesHeaderNotDetail(headerFailureStatus, showRawResult) {
  return Boolean(headerFailureStatus) && !showRawResult;
}

assertEq('metadata expand with raw', showRawResultForBackgroundMetadata(true, true, false, true), true);
assertEq('metadata blocked without raw', showRawResultForBackgroundMetadata(true, true, false, false), false);

const headerFailure = backgroundTaskFailureStatusLabel(
  'failed',
  'No first response from the agent within 120s.',
  { surface: 'agent' },
);
assertEq('header failure label', headerFailure, 'Timeout · No first response 120s');
assertEq('failure in header not detail', collapsedFailureUsesHeaderNotDetail(headerFailure, false), true);
assertEq('expanded raw keeps detail path', collapsedFailureUsesHeaderNotDetail(headerFailure, true), false);

const failedEnvelope = [
  'background task',
  'task_id: task_fail_smoke',
  'surface: explore',
  'operation: explore',
  'status: failed',
  'error: No first response from the agent within 120s.',
].join('\n');
const parsed = parseBackgroundTaskEnvelope(failedEnvelope);
if (!parsed?.rawResult || String(parsed.result || '').trim()) {
  throw new Error(`failed envelope should keep rawResult and empty display result: ${JSON.stringify(parsed)}`);
}
if (!parsed.args?.error) {
  throw new Error('failed envelope should preserve args.error');
}

const failedEnvelopeWithErrorBody = [
  failedEnvelope,
  '',
  'Error: No first response from the agent within 120s.',
].join('\n');
const parsedWithErrorBody = parseBackgroundTaskEnvelope(failedEnvelopeWithErrorBody);
if (!parsedWithErrorBody?.rawResult || String(parsedWithErrorBody.result || '').trim()) {
  throw new Error(`failed envelope with error-only body should keep rawResult and empty display result: ${JSON.stringify(parsedWithErrorBody)}`);
}

console.log('tui-background-failure-smoke: ok');
