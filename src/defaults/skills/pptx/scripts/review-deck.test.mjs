import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runReview } from './review-deck.mjs';

test('runReview removes its review-input dir when the output already exists', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-'));
  try {
    const png = path.join(root, 'a.png');
    fs.writeFileSync(png, 'x');
    fs.writeFileSync(path.join(root, 's.md'), 'src');
    const input = path.join(root, 'in.json');
    fs.writeFileSync(
      input,
      JSON.stringify({
        task: 't',
        sources: ['s.md'],
        questions: [{ id: 'q1', question: 'q?' }],
        candidates: [{ id: 'c', pages: ['a.png'] }],
      })
    );
    const output = path.join(root, 'out.json');
    fs.writeFileSync(output, 'existing');
    await assert.rejects(runReview({ input, output, provider: 'p', model: 'm' }, { execute: async () => 0 }));
    assert.deepEqual(
      fs.readdirSync(root).filter((n) => n.startsWith('review-input-')),
      []
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
