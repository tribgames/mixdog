// Prices for the usage-ledger suites. Rates come from the external catalogs
// (LiteLLM, models.dev) the runtime caches in its data directory, so a clean
// machine prices nothing. This points the data directory at a scratch folder
// holding a models.dev catalog with the list rates those suites assert.
// Import it before any runtime module: the config path is fixed at load.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'mixdog-usage-pricing-'));
process.env.MIXDOG_DATA_DIR = directory;
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));

// Official list rates, $ per million tokens: Claude Opus 4.8, and Grok 4.20
// with every rate doubled past 200K prompt tokens.
const modelsdev = {
  anthropic: {
    models: { 'claude-opus-4-8': { cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 } } },
  },
  xai: {
    models: {
      'grok-4.20': {
        cost: {
          input: 1.25,
          output: 2.5,
          cache_read: 0.2,
          tiers: [{ input: 2.5, output: 5, cache_read: 0.4, tier: { type: 'context', size: 200000 } }],
        },
      },
    },
  },
};
writeFileSync(join(directory, 'modelsdev-catalog.json'), JSON.stringify({ fetchedAt: Date.now(), data: modelsdev }));
