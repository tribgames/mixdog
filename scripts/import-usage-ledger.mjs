import { getUsageLedger, usageLedgerPath } from '../src/runtime/shared/llm/usage-ledger.mjs';
import { importUsageHistory } from '../src/runtime/shared/llm/usage-ledger-import.mjs';
import { resolvePluginData } from '../src/runtime/shared/plugin-paths.mjs';

const ledger = getUsageLedger();
if (!ledger) throw new Error('Usage ledger is unavailable');
try {
  const result = await importUsageHistory(ledger, resolvePluginData());
  console.log(JSON.stringify({ ledger: usageLedgerPath(), ...result }, null, 2));
} finally {
  ledger.close();
}
