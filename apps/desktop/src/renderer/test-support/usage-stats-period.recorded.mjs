// Node b6f10295a `resolveUsageStatsPeriod` (src/standalone/usage-stats-period.mjs), recorded: every call the usage-statistics
// tests make, input -> output, from running them against Node. A call that was not recorded is an error, never a guess.
import { readFileSync } from 'node:fs';

const table = JSON.parse(readFileSync(new URL('./usage-stats-period.recorded.json', import.meta.url), 'utf8'));
const stable = (v) =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x
  );

export function resolveUsageStatsPeriod(input) {
  const key = stable(input);
  if (!Object.hasOwn(table, key)) throw new Error(`resolveUsageStatsPeriod(${key}) was not recorded from Node`);
  return structuredClone(table[key]);
}
