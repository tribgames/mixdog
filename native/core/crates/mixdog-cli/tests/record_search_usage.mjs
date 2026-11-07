// Records what Node's headless exec folds when a turn's native web search spends tokens:
// the turn registers its sink (turn-run.mjs), the search reports (native-web-search.mjs),
// headless-exec.mjs `recordUsage` applies it to the stats and the observed models.
// usage: node record_search_usage.mjs <product tree> <golden out>   (run with a temp MIXDOG_DATA_DIR/HOME, MIXDOG_SKIP_USER_DATA_BACKUP=1)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [tree, out] = process.argv.slice(2);
const load = (path) => import(pathToFileURL(join(tree, 'src', path)).href);
const { registerNativeWebSearchUsageSink, reportNativeWebSearchUsage } = await load('session-runtime/native-web-search-usage.mjs');
const { usageDeltaEvent } = await load('runtime/agent/orchestrator/session/loop/usage.mjs');
const { applyUsageDelta, createSessionStats } = await load('ui/session-stats.mjs');

Date.now = () => 1700000000000;
const stats = createSessionStats();
const observed = new Set(['gpt-test']);
const recordUsage = (delta) => {
  const model = String(delta?.model ?? '').trim();
  if (model) observed.add(model);
  applyUsageDelta(stats, delta);
};
const heard = [];
const main = usageDeltaEvent({ sessionId: 'sess_exec_test', iterationIndex: 0, requestedModel: 'gpt-test', model: 'gpt-test', usage: { inputTokens: 11, outputTokens: 5, cachedTokens: 7, cacheWriteTokens: 3, promptTokens: 21 } });
recordUsage(main);
const release = registerNativeWebSearchUsageSink('sess_exec_test', (delta) => { heard.push(delta); recordUsage(delta); });
reportNativeWebSearchUsage({ ownerSessionId: 'sess_exec_test', sessionId: 'sess_exec_test:native-web-search:abc', requestedModel: 'gpt-search', model: 'gpt-search-2', usage: { inputTokens: 40, outputTokens: 9, cachedTokens: 12, cacheWriteTokens: 2, promptTokens: 54 } });
release();
// After the release nobody listens: the report is dropped.
reportNativeWebSearchUsage({ ownerSessionId: 'sess_exec_test', sessionId: 'x', model: 'm', usage: { inputTokens: 1000 } });
const { inputTokens, outputTokens, cachedTokens, cacheWriteTokens } = stats;
writeFileSync(out, JSON.stringify({ main, search: heard, stats: { inputTokens, outputTokens, cachedTokens, cacheWriteTokens }, models: [...observed] }, null, 2) + '\n');
