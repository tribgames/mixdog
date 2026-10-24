import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResourceRow } from './capability-controls.tsx';
import { credentialNote } from './provider-panel.tsx';

test('the settings storage note follows the structured credential source', () => {
  assert.equal(credentialNote({ credentialSource: 'private-file' }), 'Stored in a private file');
  assert.equal(
    credentialNote({ credentialSource: 'environment', envName: 'GROK_API_KEY' }),
    'From an environment variable · GROK_API_KEY'
  );
  assert.equal(credentialNote({ credentialSource: 'keychain' }), undefined);
  assert.equal(credentialNote({ detail: 'stored in private file' }), undefined, 'no guessing from the detail string');
  const html = renderToStaticMarkup(
    React.createElement(ResourceRow, { title: 'xAI', meta: credentialNote({ credentialSource: 'private-file' }) })
  );
  assert.match(html, /settings-resource-meta[^>]*>Stored in a private file</);
});
