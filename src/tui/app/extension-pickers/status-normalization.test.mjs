import assert from 'node:assert/strict';
import test from 'node:test';
import { readStatus } from './scope-note.mjs';

test('status reads supply an empty list for missing methods, responses, fields, and falsy list values', async () => {
  const stores = [
    {},
    { skillsStatus: async () => null },
    { skillsStatus: async () => ({}) },
    { skillsStatus: async () => ({ skills: 0 }) },
  ];
  for (const store of stores) {
    assert.deepEqual(await readStatus(store, 'skillsStatus', 'skills', 'skills status'), { skills: [] });
  }
});

test('status reads retain metadata and list identity while calling the store with its receiver', async () => {
  const skills = [{ name: 'pdf' }];
  const store = {
    count: 1,
    skillsStatus() {
      return { count: this.count, skills };
    },
  };
  const status = await readStatus(store, 'skillsStatus', 'skills', 'skills status');
  assert.deepEqual(status, { count: 1, skills: [{ name: 'pdf' }] });
  assert.equal(status.skills, skills);
});

test('failed status reads report the error and return null rather than an empty list', async () => {
  const notices = [];
  const store = {
    skillsStatus: async () => {
      throw new Error('offline');
    },
    pushNotice: (message, tone) => notices.push([message, tone]),
  };
  assert.equal(await readStatus(store, 'skillsStatus', 'skills', 'skills status'), null);
  assert.deepEqual(notices, [['skills status failed: offline', 'error']]);
});
