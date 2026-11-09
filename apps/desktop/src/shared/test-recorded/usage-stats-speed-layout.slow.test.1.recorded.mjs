// Node b6f10295a2f698afc85332467192de28500bd146 src/session-runtime/usage-stats-api.mjs, recorded from apps/desktop/src/renderer/usage-stats-speed-layout.slow.test.mjs of that commit run against an exact export of it (record/record.mjs).
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./usage-stats-speed-layout.slow.test.1.recorded.json', import.meta.url), 'utf8'));
export const createUsageStatsApi = replay(table, "createUsageStatsApi");
