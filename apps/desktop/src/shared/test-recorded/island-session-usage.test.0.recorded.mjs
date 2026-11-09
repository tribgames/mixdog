// Node b6f10295a src/session-runtime/usage-stats-api.mjs, recorded from the original test's run; replayed by call.
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./island-session-usage.test.0.recorded.json', import.meta.url), 'utf8'));
export const createUsageStatsApi = replay(table, "createUsageStatsApi");
