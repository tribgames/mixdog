// Node b6f10295a src/runtime/shared/llm/usage-ledger.mjs, recorded from the original test's run; replayed by call.
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./usage-request-log.test.0.recorded.json', import.meta.url), 'utf8'));
export const UsageLedger = replay(table, "UsageLedger");
export const closeUsageLedgers = replay(table, "closeUsageLedgers");
export const getUsageLedger = replay(table, "getUsageLedger");
export const makeUsageRecord = replay(table, "makeUsageRecord");
export const usageCostSource = replay(table, "usageCostSource");
export const usageLedgerIfOpen = replay(table, "usageLedgerIfOpen");
export const usageLedgerPath = replay(table, "usageLedgerPath");
export const usageLedgerWorkerRunning = replay(table, "usageLedgerWorkerRunning");
export const usageRouteKind = replay(table, "usageRouteKind");
