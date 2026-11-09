// Node b6f10295a2f698afc85332467192de28500bd146 src/runtime/shared/review-diff.mjs, recorded from apps/desktop/src/renderer/session-diff-model.test.mjs of that commit run against an exact export of it (record/record.mjs).
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./session-diff-model.test.0.recorded.json', import.meta.url), 'utf8'));
export const PATCH_TOO_LARGE = replay(table, "PATCH_TOO_LARGE");
export const REVIEW_FILE_PATCH_MAX_BYTES = replay(table, "REVIEW_FILE_PATCH_MAX_BYTES");
export const REVIEW_FILE_PATCH_SHOW_MAX_BYTES = replay(table, "REVIEW_FILE_PATCH_SHOW_MAX_BYTES");
export const REVIEW_PATCH_MAX_BYTES = replay(table, "REVIEW_PATCH_MAX_BYTES");
export const boundReviewPatch = replay(table, "boundReviewPatch");
export const createReviewPatchBudget = replay(table, "createReviewPatchBudget");
export const filePatchReply = replay(table, "filePatchReply");
export const patchOmittedFile = replay(table, "patchOmittedFile");
export const reviewDiffTooLarge = replay(table, "reviewDiffTooLarge");
export const reviewSectionTruncated = replay(table, "reviewSectionTruncated");
