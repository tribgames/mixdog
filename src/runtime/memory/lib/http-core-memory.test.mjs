import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpRouter } from './http-router.mjs';

test('HTTP session payload cannot reintroduce generated summaries', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-http-core-memory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.mixdog'));
  writeFileSync(join(root, '.mixdog', 'project.id'), 'common');
  const router = createHttpRouter({
    getDb: () => ({
      query: async (_sql, params) => ({
        rows: params?.length
          ? []
          : [
              { id: 1, summary: '  User-approved\tpreference\n' },
              { id: 2, summary: '\n\t ' },
              { id: 3, summary: null },
            ],
      }),
    }),
  });
  const payload = await router.buildSessionCoreMemoryPayload(root);
  assert.equal(payload.projectId, null);
  assert.deepEqual(payload.dbLines, []);
  assert.deepEqual(payload.userLines, ['User-approved preference']);
});
