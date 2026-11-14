// The window IPC handlers whose work is the core's (`desktop/localLink/open`, `feedback/upload`, `desktop/userFile/write`,
// `desktop/attachment/write`, `desktop/attachment/thumbnail`): each sends its request to this PC's core connection, hands a file or folder
// to the operating system only as the core answered, and fails without one. The decisions themselves are the core's tests
// (mixdog-core-domains desktop_residual_b_tests.rs, feedback/tests.rs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { DESKTOP_IPC } from '../shared/contract';
import { registerFileDialogIpc } from './ipc-file-dialogs';
import { registerProjectIpc } from './ipc-projects';
import { registerSessionIpc } from './ipc-sessions';
import { registerSourceControlIpc } from './ipc-source-control';

const anything = new Proxy({}, { get: () => async () => null });

function fakeCore(answers = {}) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push([method, params]);
      const answer = answers[method];
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer(params) : answer;
    },
  };
}

const blobAnswers = { 'blob/put': (params) => ({ received: params.digest }) };

function register(registration, options) {
  const handlers = new Map();
  registration({ handle: (channel, listener) => handlers.set(channel, listener), ...options });
  return (channel, ...args) => handlers.get(channel)({}, ...args);
}

function projectIpc(core, openPath = async () => '') {
  const opened = [];
  const invoke = register(registerProjectIpc, {
    host: {},
    shell: {
      openPath: async (file) => {
        opened.push(file);
        return openPath(file);
      },
    },
    invokeDesktopOperation: async () => null,
    operations: anything,
    core,
  });
  return { invoke, opened };
}

test('a chat link asks the core and hands only an answered file or folder to the operating system', async () => {
  let answer = { result: 'file', path: '/p/out/scan.tif' };
  const core = fakeCore({ 'desktop/localLink/open': () => answer });
  const { invoke, opened } = projectIpc(core);
  assert.equal(await invoke(DESKTOP_IPC.openLocalFileLink, '/p', 'out/scan.tif'), 'file');
  assert.deepEqual(core.calls.at(-1), ['desktop/localLink/open', { projectPath: '/p', href: 'out/scan.tif' }]);
  answer = { result: 'folder', path: '/p/out' };
  assert.equal(await invoke(DESKTOP_IPC.openLocalFileLink, '/p', 'out/', '/p/out'), 'folder');
  assert.deepEqual(core.calls.at(-1)[1], { projectPath: '/p', href: 'out/', confirmedPath: '/p/out' });
  assert.deepEqual(opened, ['/p/out/scan.tif', '/p/out']);
  answer = { result: 'editor' };
  assert.equal(await invoke(DESKTOP_IPC.openLocalFileLink, '/p', 'a.ts'), 'editor');
  answer = { confirmationPath: '/p/setup.exe' };
  assert.deepEqual(await invoke(DESKTOP_IPC.openLocalFileLink, '/p', 'setup.exe'), { confirmationPath: '/p/setup.exe' });
  assert.equal(opened.length, 2, 'an editor answer and a confirmation request launch nothing');
});

test('a chat link reports the operating system failure and the core refusal, and fails without a core', async () => {
  const failing = projectIpc(
    fakeCore({ 'desktop/localLink/open': { result: 'file', path: '/p/a.zip' } }),
    async () => 'No application is associated with this file.'
  );
  await assert.rejects(failing.invoke(DESKTOP_IPC.openLocalFileLink, '/p', 'a.zip'), {
    message: 'Unable to open file: No application is associated with this file.',
  });
  const refused = projectIpc(fakeCore({ 'desktop/localLink/open': new Error('The file path escapes the project directory.') }));
  await assert.rejects(refused.invoke(DESKTOP_IPC.openLocalFileLink, '/p', '../'), /escapes the project directory/);
  assert.deepEqual(refused.opened, []);
  await assert.rejects(projectIpc(null).invoke(DESKTOP_IPC.openLocalFileLink, '/p', 'a'), /core connection is not available/);
});

test('feedback goes to the core with its attachment images as blobs and answers the core receipt', async () => {
  const receipt = { id: 'id-1', status: 'accepted' };
  const core = fakeCore({ ...blobAnswers, 'feedback/upload': receipt });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  const input = {
    id: 'id-1',
    kind: 'bug',
    message: 'it broke',
    replyTo: 'me@example.com',
    attachments: [
      { name: 'a.png', mimeType: 'image/png', data: png.toString('base64') },
      { name: 'b.png', mimeType: 'image/png', data: 'not base64!' },
    ],
  };
  assert.deepEqual(await projectIpc(core).invoke(DESKTOP_IPC.submitFeedback, input), receipt);
  const puts = core.calls.filter(([method]) => method === 'blob/put');
  assert.equal(puts.length, 1);
  assert.equal(Buffer.from(puts[0][1].bytesB64, 'base64').equals(png), true);
  const [method, params] = core.calls.at(-1);
  assert.equal(method, 'feedback/upload');
  assert.deepEqual(params.input.attachments[0], {
    name: 'a.png',
    mimeType: 'image/png',
    data: { $blobRef: puts[0][1].digest, as: 'base64' },
  });
  assert.equal(params.input.attachments[1].data, 'not base64!', 'data that is no canonical base64 is left for the core to refuse');
  assert.deepEqual({ ...params.input, attachments: undefined }, { ...input, attachments: undefined });
});

test('feedback reports the core failure and fails without a core', async () => {
  const failing = projectIpc(fakeCore({ 'feedback/upload': new Error('Too many feedback requests. Please try again later.') }));
  await assert.rejects(failing.invoke(DESKTOP_IPC.submitFeedback, { id: 'x' }), /Too many feedback requests/);
  await assert.rejects(projectIpc(null).invoke(DESKTOP_IPC.submitFeedback, {}), /core connection is not available/);
});

function fileDialogIpc(core) {
  return register(registerFileDialogIpc, {
    window: {},
    app: {},
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: false, filePath: '/home/me/out.txt' }),
    },
    host: {},
    invokeDesktopOperation: async () => null,
    nativeT: (key) => key,
    describeLocalPaths: async () => [],
    core,
  });
}

test('"Save as" data is written by the core, as a blob, to the path the user chose', async () => {
  const core = fakeCore({ ...blobAnswers, 'desktop/userFile/write': { bytes: 2 } });
  assert.equal(await fileDialogIpc(core)(DESKTOP_IPC.saveFileAs, 'data:text/plain;base64,aGk=', 'out.txt'), true);
  const put = core.calls.find(([method]) => method === 'blob/put')[1];
  assert.equal(Buffer.from(put.bytesB64, 'base64').toString(), 'hi');
  assert.deepEqual(core.calls.at(-1), [
    'desktop/userFile/write',
    { path: '/home/me/out.txt', dataBase64: { $blobRef: put.digest, as: 'base64' } },
  ]);
});

test('"Save as" without a core fails before anything is written', async () => {
  await assert.rejects(
    fileDialogIpc(null)(DESKTOP_IPC.saveFileAs, 'data:text/plain;base64,aGk=', 'out.txt'),
    /core connection is not available/
  );
});

function sourceControlIpc(core, openPath = async () => '') {
  const opened = [];
  const invoke = register(registerSourceControlIpc, {
    app: {},
    operations: anything,
    shell: {
      openPath: async (file) => {
        opened.push(file);
        return openPath(file);
      },
      showItemInFolder() {},
    },
    grantedFile: async () => ({}),
    describeLocalPaths: async (paths) => paths.map((absolutePath) => ({ absolutePath })),
    core,
  });
  return { invoke, opened };
}

test('an attachment is written by the core (the data URL as a blob) and opened or staged from the path it answers', async () => {
  const core = fakeCore({ ...blobAnswers, 'desktop/attachment/write': { path: '/tmp/mixdog-attachments/report-1.pdf' } });
  const { invoke, opened } = sourceControlIpc(core);
  await invoke(DESKTOP_IPC.openAttachmentFile, 'data:application/pdf;base64,JVBERg==', 'report.pdf');
  assert.deepEqual(opened, ['/tmp/mixdog-attachments/report-1.pdf']);
  const put = core.calls.find(([method]) => method === 'blob/put')[1];
  assert.equal(Buffer.from(put.bytesB64, 'base64').toString(), 'data:application/pdf;base64,JVBERg==');
  assert.deepEqual(core.calls.at(-1), [
    'desktop/attachment/write',
    { dataUrl: { $blobRef: put.digest, as: 'text' }, name: 'report.pdf' },
  ]);
  assert.deepEqual(await invoke(DESKTOP_IPC.stageAttachmentFile, 'data:application/pdf;base64,JVBERg==', 'report.pdf'), {
    absolutePath: '/tmp/mixdog-attachments/report-1.pdf',
  });
  assert.equal(opened.length, 1, 'staging opens nothing');
});

test('an attachment the core refuses is not opened, and without a core nothing is written', async () => {
  const refusing = sourceControlIpc(
    fakeCore({ ...blobAnswers, 'desktop/attachment/write': new Error('This attachment type cannot be opened.') })
  );
  await assert.rejects(refusing.invoke(DESKTOP_IPC.openAttachmentFile, 'data:text/x-sh;base64,AA==', 'run.sh'), /cannot be opened/);
  assert.deepEqual(refusing.opened, []);
  await assert.rejects(
    sourceControlIpc(null).invoke(DESKTOP_IPC.openAttachmentFile, 'data:text/plain;base64,AA==', 'a.txt'),
    /core connection is not available/
  );
});

test('an attachment thumbnail is the core data URL for the content hash', async () => {
  const ref = 'a'.repeat(64);
  const core = fakeCore({ 'desktop/attachment/thumbnail': { dataUrl: 'data:image/jpeg;base64,AAAA' } });
  const invoke = register(registerSessionIpc, { host: {}, invokeDesktopOperation: async () => null, browserHost: null, core });
  assert.equal(await invoke(DESKTOP_IPC.readAttachmentThumbnail, ref), 'data:image/jpeg;base64,AAAA');
  assert.deepEqual(core.calls, [['desktop/attachment/thumbnail', { attachmentRef: ref }]]);
  const none = register(registerSessionIpc, { host: {}, invokeDesktopOperation: async () => null, browserHost: null, core: null });
  await assert.rejects(none(DESKTOP_IPC.readAttachmentThumbnail, ref), /core connection is not available/);
});
