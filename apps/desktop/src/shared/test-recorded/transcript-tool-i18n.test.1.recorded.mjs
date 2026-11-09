// Node b6f10295a2f698afc85332467192de28500bd146 src/runtime/agent/orchestrator/session/conversation-import/imported-session.mjs, recorded from apps/desktop/src/renderer/transcript-tool-i18n.test.mjs of that commit run against an exact export of it (record/record.mjs).
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./transcript-tool-i18n.test.1.recorded.json', import.meta.url), 'utf8'));
export const buildImportOrigin = replay(table, "buildImportOrigin");
export const createImportedSession = replay(table, "createImportedSession");
export const importOriginKey = replay(table, "importOriginKey");
export const importedSessionOptions = replay(table, "importedSessionOptions");
export const importedTranscriptMessages = replay(table, "importedTranscriptMessages");
