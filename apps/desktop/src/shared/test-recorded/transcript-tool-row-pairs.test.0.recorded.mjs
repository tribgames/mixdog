// Node b6f10295a2f698afc85332467192de28500bd146 (tree 332679f9c46ead536c500ab57a7580c0fb28d550) src/runtime/shared/background-tasks.mjs, recorded from apps/desktop/src/renderer/transcript-tool-row-pairs.test.mjs of that commit run against an exact export of it (record/record.mjs).
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./transcript-tool-row-pairs.test.0.recorded.json', import.meta.url), 'utf8'));
export const TOOL_ASYNC_EXECUTION_CONTRACT = replay(table, "TOOL_ASYNC_EXECUTION_CONTRACT");
export const TOOL_MANUAL_CONTROL_CONTRACT = replay(table, "TOOL_MANUAL_CONTROL_CONTRACT");
export const TOOL_SYNC_EXECUTION_CONTRACT = replay(table, "TOOL_SYNC_EXECUTION_CONTRACT");
export const acknowledgeBackgroundTaskCompletion = replay(table, "acknowledgeBackgroundTaskCompletion");
export const activeBackgroundTaskSessionIds = replay(table, "activeBackgroundTaskSessionIds");
export const cancelBackgroundTask = replay(table, "cancelBackgroundTask");
export const cancelBackgroundTasks = replay(table, "cancelBackgroundTasks");
export const cleanupBackgroundTasks = replay(table, "cleanupBackgroundTasks");
export const completeBackgroundTask = replay(table, "completeBackgroundTask");
export const getBackgroundTask = replay(table, "getBackgroundTask");
export const hasActiveBackgroundTasks = replay(table, "hasActiveBackgroundTasks");
export const listBackgroundTasks = replay(table, "listBackgroundTasks");
export const notifyTaskCompletion = replay(table, "notifyTaskCompletion");
export const reconcileBackgroundTask = replay(table, "reconcileBackgroundTask");
export const registerBackgroundTask = replay(table, "registerBackgroundTask");
export const renderBackgroundTask = replay(table, "renderBackgroundTask");
export const renderBackgroundTaskList = replay(table, "renderBackgroundTaskList");
export const renderBackgroundTaskNotification = replay(table, "renderBackgroundTaskNotification");
export const sanitizeTaskMeta = replay(table, "sanitizeTaskMeta");
export const settleCancelledBackgroundTask = replay(table, "settleCancelledBackgroundTask");
export const startBackgroundTask = replay(table, "startBackgroundTask");
export const taskIdFromArgs = replay(table, "taskIdFromArgs");
