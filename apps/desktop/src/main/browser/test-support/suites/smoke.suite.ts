import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { type CoreHarnessSuite, progress } from '../core-harness';

/** Navigates and snapshots through `browser/command` (core -> host/browser/command), which works on the forward path today. */
const suite: CoreHarnessSuite = async (harness) => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<!doctype html><title>Core harness smoke</title><p>Core harness smoke evidence</p><button>Smoke action</button>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await harness.uiCommand('navigate', { url: `http://127.0.0.1:${address.port}/` });
    progress('navigated through browser/command');
    const snapshot = (await harness.uiCommand('snapshot')) as { text?: string };
    assert.match(String(snapshot?.text), /Core harness smoke evidence/);
    assert.match(String(snapshot?.text), /Smoke action/);
    progress('snapshot read through browser/command');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

export default suite;
