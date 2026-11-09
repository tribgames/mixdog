// Node b6f10295a2f698afc85332467192de28500bd146 src/runtime/agent/orchestrator/session/conversation-import/convert.mjs, recorded from apps/desktop/src/renderer/transcript-tool-i18n.test.mjs of that commit run against an exact export of it (record/record.mjs).
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./transcript-tool-i18n.test.0.recorded.json', import.meta.url), 'utf8'));
export const IMPORT_ERROR_TOO_LARGE = replay(table, "IMPORT_ERROR_TOO_LARGE");
export const IMPORT_MAX_FILE_BYTES = replay(table, "IMPORT_MAX_FILE_BYTES");
export const IMPORT_MAX_LINE_BYTES = replay(table, "IMPORT_MAX_LINE_BYTES");
export const IMPORT_MAX_METADATA_BYTES = replay(table, "IMPORT_MAX_METADATA_BYTES");
export const IMPORT_MAX_RETAINED_ENTRIES = replay(table, "IMPORT_MAX_RETAINED_ENTRIES");
export const IMPORT_MAX_TRANSCRIPT_CHARS = replay(table, "IMPORT_MAX_TRANSCRIPT_CHARS");
export const convertConversationText = replay(table, "convertConversationText");
export const createConversationConverter = replay(table, "createConversationConverter");
export const isImportSource = replay(table, "isImportSource");
