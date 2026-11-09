// Node b6f10295a src/session-runtime/lifecycle/session-catalog.mjs, recorded from the original test's run; replayed by call.
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./desktop-state-project.test.1.recorded.json', import.meta.url), 'utf8'));
export const leadSessionRow = replay(table, "leadSessionRow");
export const listLeadSessions = replay(table, "listLeadSessions");
