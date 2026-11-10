import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateRawResult } from '../../../packages/protocol-client/src/rows/tool-result-status.mjs';
import { aggregateRawResultForDisplay } from './tool-result-status.mjs';
test('expanded aggregates rebuild numbered rows for read members only', () => {
  const joined = aggregateRawResult([
    { resolved: true, name: 'read', rawResultText: 'a.js [ok]\n[lines 1-2]\nconst a = 1;\n  b();' },
    { resolved: true, name: 'git', rawResultText: '[lines 1-1]\n12\t3\tsrc/a.js' },
  ]);
  assert.equal(
    aggregateRawResultForDisplay(joined),
    '1. read\na.js [ok]\n1→const a = 1;\n2→  b();\n\n2. git\n[lines 1-1]\n12\t3\tsrc/a.js'
  );
});

// Outcome taxonomy contract (user report: "Exit 0" rendered as if failed):
// - exit 0            → plain success ("Ok" bucket, success tone)
// - non-zero exit     → command failure (warning tone, never red)
// - envelope isError  → real call failure ("Failed", red)
