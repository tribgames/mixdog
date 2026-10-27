// Contract: every compaction setting a session record is seeded from, and every
// setting the config normalizer reads, is in the config-owned set that the
// config sync clears and the compaction commit leaves to the live session. A
// new config-owned setting that is not added there fails here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { COMPACTION_CONFIG_KEYS } from '../runtime-core/compaction-config-keys.mjs';
import { normalizeCompactionConfig } from '../runtime-core/config-helpers.mjs';
import { initialCompactionConfig } from './manager/session-record.mjs';

// A config section that records every setting read from it.
function recordingConfig() {
  const read = new Set();
  const config = new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key === 'string') read.add(key);
        return undefined;
      },
    }
  );
  return { config, read };
}

test('every setting a session record is seeded from is config-owned', () => {
  const { config, read } = recordingConfig();
  initialCompactionConfig(config, {});
  assert.ok(read.size > 0);
  const missing = [...read].filter((key) => !COMPACTION_CONFIG_KEYS.includes(key));
  assert.deepEqual(missing, []);
  const seeded = Object.keys(initialCompactionConfig({}, {})).filter((key) => key !== 'boundaryTokens');
  assert.deepEqual(
    seeded.filter((key) => !COMPACTION_CONFIG_KEYS.includes(key)),
    []
  );
});

test('every setting the compaction normalizer reads or emits is config-owned', () => {
  const { config, read } = recordingConfig();
  normalizeCompactionConfig(config);
  assert.ok(read.size > 0);
  const emitted = Object.keys(normalizeCompactionConfig({}));
  const missing = [...new Set([...read, ...emitted])].filter((key) => !COMPACTION_CONFIG_KEYS.includes(key));
  assert.deepEqual(missing, []);
});
