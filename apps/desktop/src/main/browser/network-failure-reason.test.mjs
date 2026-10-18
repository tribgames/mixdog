import assert from 'node:assert/strict';
import test from 'node:test';

import { explainNetworkFailure } from './network.ts';

test('a network-policy reason with $ patterns is written into the failure text verbatim', () => {
  const reason = "blocked host $& ($$, $', $`, $1)";
  const out = explainNetworkFailure('GET https://a.test failed: net::ERR_BLOCKED_BY_CLIENT', reason);
  assert.equal(out, `GET https://a.test failed: net::ERR_BLOCKED_BY_CLIENT (Browser Use network policy: ${reason})`);
});
