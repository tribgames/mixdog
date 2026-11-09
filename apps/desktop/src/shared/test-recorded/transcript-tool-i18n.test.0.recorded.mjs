// Node b6f10295a src/runtime/agent/orchestrator/session/conversation-import/convert.mjs, recorded from the original test's run; replayed by call.
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
