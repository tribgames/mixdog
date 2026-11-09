// Node b6f10295a src/standalone/usage-stats-period.mjs, recorded from the original test's run; replayed by call.
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./usage-stats-speed-layout.slow.test.2.recorded.json', import.meta.url), 'utf8'));
export const resolveUsageStatsPeriod = replay(table, "resolveUsageStatsPeriod");
