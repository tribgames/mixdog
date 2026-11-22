import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserProfileHostMethods } from './profile-host-methods.ts';

function methods(importProfile) {
  const logged = [];
  const host = createBrowserProfileHostMethods({
    profileImporter: { importProfile },
    cookieAutoImport: null,
    sendToRenderer: () => {},
    onDiagnostic: (event, data) => logged.push({ event, ...data }),
  });
  return { host, logged };
}

const REQUEST = {
  jobId: 'job-12345678',
  sourceId: 'chrome',
  profileId: 'Default',
  items: ['passwords', 'cookies', 'history'],
  administratorApproved: true,
};

test('each failed import kind and a refused import are written to the diagnostics log', async () => {
  const partial = methods(async () => ({
    jobId: REQUEST.jobId,
    counts: { passwords: 0, cookies: 3, history: 40 },
    errors: { passwords: 'Elevation was cancelled or failed.', cookies: 'Cookie import incomplete.' },
  }));
  await partial.host.browserImport(REQUEST);
  assert.deepEqual(partial.logged, [
    { event: 'browser-import-item-failed', item: 'passwords', count: 0, error: 'Elevation was cancelled or failed.' },
    { event: 'browser-import-item-failed', item: 'cookies', count: 3, error: 'Cookie import incomplete.' },
  ]);

  const refused = methods(async () => {
    throw new Error('Browser close request failed.');
  });
  await assert.rejects(refused.host.browserImport(REQUEST), /Browser close request failed/);
  assert.deepEqual(refused.logged, [
    { event: 'browser-import-failed', items: REQUEST.items, error: 'Browser close request failed.' },
  ]);
});
