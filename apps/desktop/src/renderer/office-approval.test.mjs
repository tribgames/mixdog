import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApprovalCard } from './ApprovalCard';

test('Office transaction approval renders diff, preview, and direct decision labels', () => {
  const html = renderToStaticMarkup(React.createElement(ApprovalCard, {
    approval: {
      id: 'approval-1',
      name: 'office',
      reason: 'Review Office transaction.',
      args: {
        action: 'commit',
        document: 'C:\\Project\\report.pptx',
        transaction: {
          id: 'office_tx_123',
          diff: { summary: { total: 3, added: 1, removed: 0, modified: 2 } },
        },
        preview: {
          output: 'C:\\Temp\\review.pdf',
          images: [{ page: 1, path: 'C:\\Temp\\review page 1.png' }],
          visualDiff: {
            available: true,
            changedPercent: 1.25,
            images: [{ page: 1, kind: 'visual-diff', path: 'C:\\Temp\\review diff 1.png' }],
          },
        },
      },
    },
    resolve: async () => true,
  }));
  assert.match(html, /Office transaction review/);
  assert.match(html, /Commit changes/);
  assert.match(html, /Keep editing/);
  assert.match(html, /office_tx_123/);
  assert.match(html, /1\.25% changed pixels/);
  assert.match(html, /file:\/\/\/C:\/Temp\/review%20page%201\.png/);
  assert.match(html, /Visual diff page 1/);
});
