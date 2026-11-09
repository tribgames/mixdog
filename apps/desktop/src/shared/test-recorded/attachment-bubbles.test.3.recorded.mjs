// Node b6f10295a2f698afc85332467192de28500bd146 src/runtime/attachments/store.mjs, recorded from apps/desktop/src/renderer/attachment-bubbles.test.mjs of that commit run against an exact export of it (record/record.mjs).
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./attachment-bubbles.test.3.recorded.json', import.meta.url), 'utf8'));
export const attachmentBlobSize = replay(table, "attachmentBlobSize");
export const attachmentFilePath = replay(table, "attachmentFilePath");
export const attachmentRefForBuffer = replay(table, "attachmentRefForBuffer");
export const attachmentStoreCacheStats = replay(table, "attachmentStoreCacheStats");
export const attachmentTextForPart = replay(table, "attachmentTextForPart");
export const attachmentsForIntake = replay(table, "attachmentsForIntake");
export const clearAttachmentBufferCache = replay(table, "clearAttachmentBufferCache");
export const collectPromptAttachments = replay(table, "collectPromptAttachments");
export const hydratePastedAttachments = replay(table, "hydratePastedAttachments");
export const hydrateRestorableFileParts = replay(table, "hydrateRestorableFileParts");
export const isAttachmentReference = replay(table, "isAttachmentReference");
export const isPermanentAttachmentError = replay(table, "isPermanentAttachmentError");
export const materializePromptSubmission = replay(table, "materializePromptSubmission");
export const namedAttachmentFile = replay(table, "namedAttachmentFile");
export const preparePromptSubmissionForProvider = replay(table, "preparePromptSubmissionForProvider");
export const providerTakesNativePdf = replay(table, "providerTakesNativePdf");
export const readAttachmentBase64 = replay(table, "readAttachmentBase64");
export const readAttachmentBuffer = replay(table, "readAttachmentBuffer");
export const readAttachmentTextWithin = replay(table, "readAttachmentTextWithin");
export const removeAttachmentBlob = replay(table, "removeAttachmentBlob");
export const startAttachmentGc = replay(table, "startAttachmentGc");
export const storeAttachmentBuffer = replay(table, "storeAttachmentBuffer");
export const storeInlineDocumentPart = replay(table, "storeInlineDocumentPart");
export const storeInlineImagePart = replay(table, "storeInlineImagePart");
