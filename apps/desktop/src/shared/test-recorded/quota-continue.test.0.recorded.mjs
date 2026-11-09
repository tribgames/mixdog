// Node b6f10295a src/tui/session/quota-resume.mjs, recorded from the original test's run; replayed by call.
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./quota-continue.test.0.recorded.json', import.meta.url), 'utf8'));
export const RETRY_CONTINUE_INSTRUCTION = replay(table, "RETRY_CONTINUE_INSTRUCTION");
export const createQuotaResumeLane = replay(table, "createQuotaResumeLane");
export const failedTurnRetryPrompt = replay(table, "failedTurnRetryPrompt");
export const latestQuotaFailure = replay(table, "latestQuotaFailure");
export const transcriptTurnKeys = replay(table, "transcriptTurnKeys");
