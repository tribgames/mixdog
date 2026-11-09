// Node b6f10295a src/runtime/shared/task-notification-envelope.mjs, recorded from the original test's run; replayed by call.
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./transcript-tool-row-pairs.test.1.recorded.json', import.meta.url), 'utf8'));
export const backgroundTaskHeaderStatus = replay(table, "backgroundTaskHeaderStatus");
export const isBracketedShellNotificationEnvelope = replay(table, "isBracketedShellNotificationEnvelope");
export const isInternalRuntimeNotificationText = replay(table, "isInternalRuntimeNotificationText");
export const parseTaskNotification = replay(table, "parseTaskNotification");
export const renderAgentCompletionEnvelope = replay(table, "renderAgentCompletionEnvelope");
export const renderShellCompletionEnvelope = replay(table, "renderShellCompletionEnvelope");
export const renderShellCompletionNotice = replay(table, "renderShellCompletionNotice");
export const renderTaskCompletionEnvelope = replay(table, "renderTaskCompletionEnvelope");
export const shellCompletionInstruction = replay(table, "shellCompletionInstruction");
export const taskCompletionSummary = replay(table, "taskCompletionSummary");
export const taskNotificationHasBody = replay(table, "taskNotificationHasBody");
export const taskNotificationId = replay(table, "taskNotificationId");
