// Node b6f10295a2f698afc85332467192de28500bd146 src/runtime/shared/turn-snapshot.mjs, recorded from apps/desktop/src/renderer/turn-preview-worker.test.mjs of that commit run against an exact export of it (record/record.mjs).
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./turn-preview-worker.test.0.recorded.json', import.meta.url), 'utf8'));
export const _diffTrackerForTest = replay(table, "_diffTrackerForTest");
export const _parkedWorkerReviewsForTest = replay(table, "_parkedWorkerReviewsForTest");
export const _resetTurnSnapshotForTest = replay(table, "_resetTurnSnapshotForTest");
export const _setTurnOpenedHookForTest = replay(table, "_setTurnOpenedHookForTest");
export const beginAgentTurnReview = replay(table, "beginAgentTurnReview");
export const beginTurnSnapshot = replay(table, "beginTurnSnapshot");
export const clearSessionChangeHistory = replay(table, "clearSessionChangeHistory");
export const completeAgentTurnReview = replay(table, "completeAgentTurnReview");
export const completeTurnSnapshot = replay(table, "completeTurnSnapshot");
export const forgetTurnSnapshotSession = replay(table, "forgetTurnSnapshotSession");
export const getSessionReviewDiff = replay(table, "getSessionReviewDiff");
export const getSessionReviewFilePatch = replay(table, "getSessionReviewFilePatch");
export const getTurnChanges = replay(table, "getTurnChanges");
export const getTurnReviewDiff = replay(table, "getTurnReviewDiff");
export const getTurnReviewFilePatch = replay(table, "getTurnReviewFilePatch");
export const reapplyTurnChanges = replay(table, "reapplyTurnChanges");
export const recordTurnDiffChanges = replay(table, "recordTurnDiffChanges");
export const revertTurnChanges = replay(table, "revertTurnChanges");
export const revertTurnReview = replay(table, "revertTurnReview");
export const revertTurnReviewFile = replay(table, "revertTurnReviewFile");
