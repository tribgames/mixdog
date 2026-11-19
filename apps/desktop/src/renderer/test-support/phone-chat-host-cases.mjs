// Synthetic replies and expected page outcomes for the desktop's phone host adapter.
export const phoneSession = 'sess_phone';
const root = '/phone/project';
const task = '/phone/task';

function blank(cwd, projectPath, remoteSessionId = null) {
  return {
    sessionId: '',
    items: [],
    queued: [],
    busy: false,
    commandBusy: false,
    cwd,
    currentProject: projectPath,
    desktopSession: { classification: projectPath === null ? 'task' : 'project', projectPath },
    remoteEnabled: remoteSessionId !== null,
    remoteSessionId,
  };
}

export const starts = [
  { call: 'startTask', args: [], method: 'project/taskWorkspace', params: {}, reply: { path: task }, expected: blank(task, null) },
  { call: 'startProject', args: [` ${root}/ `], method: 'project/create', params: { path: `${root}/` }, reply: { project: { path: root } }, expected: blank(root, root), touched: root },
  { call: 'startProjectTask', args: [` ${root}/ `], method: 'project/directory', params: { path: `${root}/`, owner: true }, reply: { path: root }, expected: blank(root, root), touched: `${root}/` },
];

export const remoteStates = [
  { name: 'the host has not published the channel', state: undefined, expected: blank(task, null) },
  { name: 'the host has disabled the channel', state: { sessionId: null }, expected: blank(task, null) },
  { name: 'the channel names an active session', state: { sessionId: phoneSession }, expected: blank(task, null, phoneSession) },
  { name: 'the channel names a numeric session id', state: { sessionId: 731 }, expected: blank(task, null, '731') },
  { name: 'the channel names an invalid id', state: { sessionId: 'invalid id' }, expected: blank(task, null) },
];

export const historyPages = [
  { name: 'older page', request: { before: 'anchor', limit: 2 }, wire: { data: [], hasOlder: true, hasNewer: false }, expected: { items: [], hasOlder: true, hasNewer: false } },
  {
    name: 'newer page in reply order',
    request: { after: 'anchor', limit: 3, byteBudget: 1024 },
    wire: {
      data: [
        { type: 'agentMessage', id: 'z-reply', text: 'First reply after the anchor.', meta: {} },
        { type: 'agentMessage', id: 'a-reply', text: 'Second reply after the anchor.', meta: {} },
      ],
      hasOlder: false,
      hasNewer: true,
    },
    expected: {
      items: [
        { kind: 'assistant', id: 'z-reply', text: 'First reply after the anchor.' },
        { kind: 'assistant', id: 'a-reply', text: 'Second reply after the anchor.' },
      ],
      hasOlder: false,
      hasNewer: true,
    },
  },
  { name: 'invalidated cursor', request: { before: 'deleted', limit: 2 }, expected: { items: [], hasOlder: false, hasNewer: false, reset: true } },
];

const held = [{ id: 'first', kind: 'user', device: 'PC', text: 'First prompt' }];
const later = { id: 'later', kind: 'user', text: 'Later prompt' };

export const staleViews = [
  { name: 'a new prompt from another device', held, latest: [...held, { ...later, device: 'PC' }], stale: true },
  { name: 'a new prompt from the same device', held, latest: [...held, { ...later, device: 'Test phone' }], stale: false },
  { name: 'an unseen prompt before the held window', held, latest: [{ ...later, device: 'PC' }, ...held], stale: false },
  { name: 'a new assistant answer', held, latest: [...held, { ...later, kind: 'assistant' }], stale: false },
  { name: 'no held transcript', held: undefined, latest: [...held, { ...later, device: 'PC' }], stale: false },
];

export const secretRequest = 'secret_test-request';
export const secretInput = 'example value';
