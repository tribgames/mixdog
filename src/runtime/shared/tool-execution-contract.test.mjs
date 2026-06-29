import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isInternalRuntimeNotificationText,
  isModelVisibleToolCompletionWrapper,
  modelVisibleToolCompletionMessage,
  shouldPersistModelVisibleToolCompletion,
  toolCompletionMeta,
  toolCompletionInstruction,
} from './tool-execution-contract.mjs';
import { _isInternalRuntimeNotificationText } from '../agent/orchestrator/session/manager.mjs';

const completedBackgroundTask = [
  'background task',
  'task_id: task_agent_abc123',
  'surface: agent',
  'operation: run',
  'status: completed',
  'started: 2026-03-28T00:00:00.000Z',
  'finished: 2026-03-28T00:00:05.000Z',
  '',
  'worker finished successfully',
].join('\n');

const runningBackgroundTask = [
  'background task',
  'task_id: task_agent_abc123',
  'surface: agent',
  'operation: run',
  'status: running',
  'started: 2026-03-28T00:00:00.000Z',
  'notification: completion will be delivered to the owner session; use status/read only for manual recovery.',
].join('\n');

test('terminal background task with body should persist as model-visible wrapper', () => {
  const meta = toolCompletionMeta({
    surface: 'agent',
    id: 'task_agent_abc123',
    status: 'completed',
    context: { callerSessionId: 'sess_owner' },
  });
  assert.equal(shouldPersistModelVisibleToolCompletion(completedBackgroundTask, meta), true);
  const visible = modelVisibleToolCompletionMessage(completedBackgroundTask, meta);
  assert.ok(visible);
  assert.equal(isInternalRuntimeNotificationText(visible), false);
  assert.equal(_isInternalRuntimeNotificationText(visible), false);
  assert.equal(isModelVisibleToolCompletionWrapper(visible), true);
  assert.match(visible, /worker finished successfully/);
});

test('model-visible completion wrapper is not a human transcript item', () => {
  const meta = toolCompletionMeta({
    surface: 'agent',
    id: 'task_agent_abc123',
    status: 'completed',
    instruction: toolCompletionInstruction({
      surface: 'agent',
      id: 'task_agent_abc123',
      status: 'completed',
    }),
    context: { callerSessionId: 'sess_owner' },
  });
  const visible = modelVisibleToolCompletionMessage(completedBackgroundTask, meta);
  assert.ok(visible);
  assert.match(visible, /^The async agent task/);
  assert.match(visible, /\n\nResult:\n/);
  assert.equal(isModelVisibleToolCompletionWrapper(visible), true);
  assert.equal(isModelVisibleToolCompletionWrapper('please fix the leak in engine.mjs'), false);
  assert.equal(isModelVisibleToolCompletionWrapper(completedBackgroundTask), false);
});

test('running background task stays hidden from model-visible pending drain', () => {
  const meta = toolCompletionMeta({
    surface: 'agent',
    id: 'task_agent_abc123',
    status: 'running',
    context: { callerSessionId: 'sess_owner' },
  });
  assert.equal(shouldPersistModelVisibleToolCompletion(runningBackgroundTask, meta), false);
  assert.equal(modelVisibleToolCompletionMessage(runningBackgroundTask, meta), '');
});

test('terminal background task persists when result body mentions task-notification', () => {
  const taskWithTagInBody = [
    ...completedBackgroundTask.split('\n').slice(0, -1),
    'log line: saw <task-notification status="completed"> in worker output',
  ].join('\n');
  const meta = toolCompletionMeta({
    surface: 'agent',
    id: 'task_agent_abc123',
    status: 'completed',
    context: { callerSessionId: 'sess_owner' },
  });
  assert.equal(shouldPersistModelVisibleToolCompletion(taskWithTagInBody, meta), true);
  const visible = modelVisibleToolCompletionMessage(taskWithTagInBody, meta);
  assert.ok(visible);
  assert.match(visible, /<task-notification/);
  assert.equal(isInternalRuntimeNotificationText(visible), false);
  assert.equal(_isInternalRuntimeNotificationText(visible), false);
});

test('internal task-notification envelope does not persist', () => {
  const internalEnvelope = [
    '<task-notification>',
    '<status>completed</status>',
    '<summary>Agent completed</summary>',
    '<task-id>task_agent_internal</task-id>',
    '</task-notification>',
  ].join('\n');
  const meta = toolCompletionMeta({
    surface: 'agent',
    id: 'task_agent_internal',
    status: 'completed',
    context: { callerSessionId: 'sess_owner' },
  });
  assert.equal(shouldPersistModelVisibleToolCompletion(internalEnvelope, meta), false);
  assert.equal(modelVisibleToolCompletionMessage(internalEnvelope, meta), '');
  assert.equal(isInternalRuntimeNotificationText(internalEnvelope), true);
  assert.equal(_isInternalRuntimeNotificationText(internalEnvelope), true);
});

test('raw running background task remains internal for manager pending drain', () => {
  assert.equal(isInternalRuntimeNotificationText(runningBackgroundTask), true);
  assert.equal(_isInternalRuntimeNotificationText(runningBackgroundTask), true);
});



const bracketedShellCompleted = [
  "[task_id: shell_job_1]",
  "[status: completed]",
  "[exit: 0]",
  "",
  "done output",
].join("\n");

const bracketedShellRunning = [
  "[task_id: shell_job_1]",
  "[status: running]",
  "[command: npm test]",
].join("\n");

test("bracketed shell completed raw envelope is internal", () => {
  assert.equal(isInternalRuntimeNotificationText(bracketedShellCompleted), true);
  assert.equal(_isInternalRuntimeNotificationText(bracketedShellCompleted), true);
});

test("bracketed shell running raw envelope is internal", () => {
  assert.equal(isInternalRuntimeNotificationText(bracketedShellRunning), true);
  assert.equal(_isInternalRuntimeNotificationText(bracketedShellRunning), true);
});

test("wrapped shell completion stays model-visible and not internal", () => {
  const meta = toolCompletionMeta({
    surface: "shell",
    id: "shell_job_1",
    status: "completed",
    context: { callerSessionId: "sess_owner" },
  });
  const visible = modelVisibleToolCompletionMessage(bracketedShellCompleted, meta);
  assert.ok(visible);
  assert.match(visible, /done output/);
  assert.equal(isInternalRuntimeNotificationText(visible), false);
  assert.equal(_isInternalRuntimeNotificationText(visible), false);
});

test("model-visible wrapper bounds large completion bodies", () => {
  const hugeBody = "x".repeat(20_000);
  const hugeTask = [
    ...completedBackgroundTask.split("\n").slice(0, -1),
    hugeBody,
  ].join("\n");
  const meta = toolCompletionMeta({
    surface: "agent",
    id: "task_agent_abc123",
    status: "completed",
    context: { callerSessionId: "sess_owner" },
  });
  const visible = modelVisibleToolCompletionMessage(hugeTask, meta);
  assert.ok(visible);
  assert.match(visible, /\[result truncated for model context\]/);
  assert.ok(visible.length < hugeBody.length);
});
