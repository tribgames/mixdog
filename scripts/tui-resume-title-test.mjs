import assert from 'node:assert/strict';
import test from 'node:test';

import { createResumePicker } from '../src/tui/app/resume-picker.mjs';

test('TUI resume picker and completion notice prefer the durable session title', async () => {
  let picker = null;
  const notices = [];
  const resumed = [];
  const store = {
    listSessions: () => [
      { id: 'named', title: '공통 백엔드 제목', preview: 'old preview', updatedAt: 2, messageCount: 6 },
      { id: 'legacy', preview: 'Legacy preview', updatedAt: 1, messageCount: 2 },
    ],
    resume: async (id) => {
      resumed.push(id);
      return true;
    },
    pushNotice: (...args) => notices.push(args),
  };
  const { openResumePicker } = createResumePicker({
    store,
    setPicker: (value) => { picker = value; },
    formatSessionUpdatedAt: () => 'now',
    formatSessionMessageCount: (count) => `${count} msg`,
  });

  openResumePicker();
  assert.deepEqual(picker.items.map((item) => item.description), [
    '공통 백엔드 제목',
    'Legacy preview',
  ]);
  picker.onSelect('named');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(resumed, ['named']);
  assert.deepEqual(notices, [['Resumed 공통 백엔드 제목', 'info']]);
});
