// Node b6f10295a2f698afc85332467192de28500bd146 src/tui/session/quota-resume.mjs, recorded from apps/desktop/src/renderer/quota-continue.test.mjs of that commit run against an exact export of it (record/record.mjs).
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./quota-continue.test.0.recorded.json', import.meta.url), 'utf8'));
export const RETRY_CONTINUE_INSTRUCTION = replay(table, "RETRY_CONTINUE_INSTRUCTION");
export const createQuotaResumeLane = replay(table, "createQuotaResumeLane");
export const failedTurnRetryPrompt = replay(table, "failedTurnRetryPrompt");
export const latestQuotaFailure = replay(table, "latestQuotaFailure");
export const transcriptTurnKeys = replay(table, "transcriptTurnKeys");
