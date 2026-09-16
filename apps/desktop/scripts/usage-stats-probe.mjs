import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { UsageLedger, makeUsageRecord } from '../../../src/runtime/shared/llm/usage-ledger.mjs';
import { resolveUsageStatsPeriod } from '../../../src/standalone/usage-stats-period.mjs';
import { usageStatsSnapshot } from '../../../src/standalone/usage-stats-model.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Synthetic, memory-only records exercise the real calendar and accounting
// pipeline without opening or importing the user's ledger.
const ledger = new UsageLedger(':memory:');
const providers = ['cursor-oauth', 'openai-oauth', 'anthropic-oauth', 'grok-oauth', 'opencode-go', 'mixdog-local'];
const rows = [];
const clock = new Date();
for (let day = 0; day < 400; day++)
  for (const [p, provider] of providers.entries()) {
    for (let model = 0; model < 2; model++) {
      const date = new Date(clock);
      date.setDate(date.getDate() - day);
      date.setHours(
        day === 0 ? Math.min(model, clock.getHours()) : 9 + ((p + model) % 10),
        day === 0 ? Math.min(clock.getMinutes(), model * 10) : 10,
        0,
        0
      );
      const input = 1000 + ((day + p) % 7) * 400;
      const output = 200 + model * 50;
      const local = provider === 'mixdog-local';
      rows.push({
        ...makeUsageRecord({
          id: `fixture-${day}-${p}-${model}`,
          ts: date.getTime(),
          provider,
          model: model === 0 ? 'synthetic-model-one' : 'synthetic-model-two',
          inputTokens: input + 10000,
          inputTokensInclusive: true,
          cacheReadTokens: 10000,
          outputTokens: output,
          sessionId: `synthetic-${day}-${p}`,
          sourceType: 'lead',
        }),
        costUsd: local ? 0 : (input * 2 + output * 10 + 2000) / 1_000_000,
        costSource: local ? 'local' : 'subscription',
        rates: { inputCostPerM: 2, outputCostPerM: 10, cacheReadCostPerM: 0.2, cacheWriteCostPerM: 0 },
      });
    }
  }
ledger.record(rows);
const server = await createServer({
  configFile: false,
  root,
  esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'usage-layout-fixture',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.startsWith('/usage-stats?')) {
            try {
              const url = new URL(req.url, 'http://127.0.0.1');
              const now = Date.now();
              const period = resolveUsageStatsPeriod({
                view: url.searchParams.get('view') || 'hour',
                anchor: url.searchParams.get('anchor') || undefined,
                now,
              });
              res.setHeader('Content-Type', 'application/json');
              res.end(
                JSON.stringify(
                  usageStatsSnapshot({
                    rollup: ledger.rollup({ hourlyDay: period.view === 'hour' ? period.startDay : null }),
                    period,
                    source: 'all',
                    now,
                  })
                )
              );
            } catch (error) {
              res.statusCode = 400;
              res.end(String(error.message));
            }
            return;
          }
          if (req.url !== '/') return next();
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(
            '<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/scripts/usage-stats-probe.tsx"></script></body></html>'
          );
        });
      },
    },
  ],
});
await server.listen();
console.log(`Usage layout fixture: http://127.0.0.1:${server.httpServer.address().port}`);
