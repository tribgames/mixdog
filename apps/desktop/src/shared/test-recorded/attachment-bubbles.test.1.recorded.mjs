// Node b6f10295a2f698afc85332467192de28500bd146 (tree 332679f9c46ead536c500ab57a7580c0fb28d550) src/tui/session/queue-helpers.mjs, recorded from apps/desktop/src/renderer/attachment-bubbles.test.mjs of that commit run against an exact export of it (record/record.mjs).
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./attachment-bubbles.test.1.recorded.json', import.meta.url), 'utf8'));
export const STEERING_SUPPRESSED_DISPLAY = replay(table, "STEERING_SUPPRESSED_DISPLAY");
export const callCommitCallbacks = replay(table, "callCommitCallbacks");
export const defaultQueuePriority = replay(table, "defaultQueuePriority");
export const isGoalQueuedEntry = replay(table, "isGoalQueuedEntry");
export const isQueuedEntryEditable = replay(table, "isQueuedEntryEditable");
export const isQueuedEntryVisible = replay(table, "isQueuedEntryVisible");
export const isSlashQueuedEntry = replay(table, "isSlashQueuedEntry");
export const mergePastedImages = replay(table, "mergePastedImages");
export const mergePastedTexts = replay(table, "mergePastedTexts");
export const mergePromptContents = replay(table, "mergePromptContents");
export const notificationDisplayText = replay(table, "notificationDisplayText");
export const promptContentImageMeta = replay(table, "promptContentImageMeta");
export const promptContentText = replay(table, "promptContentText");
export const promptDisplayText = replay(table, "promptDisplayText");
export const queuePriorityValue = replay(table, "queuePriorityValue");
export const sessionActivityTimestamp = replay(table, "sessionActivityTimestamp");
export const shortTextFingerprint = replay(table, "shortTextFingerprint");
