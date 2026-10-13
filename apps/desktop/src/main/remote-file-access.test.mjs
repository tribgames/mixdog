// Regression for the remote file-access bypass (GitHub #40): a paired remote
// client could read ANY host file through the file-tab lanes — `readLocalFile`
// read an arbitrary absolute path, and `resolveLocalPaths` minted a grant for
// any file outside the projects that `readProjectFile`, the preview range lane
// and `writeProjectFile` then honored. Only registered-project files and files
// an assistant reply in a conversation the device views links stay reachable.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createRemoteMethods } from './remote-methods.ts';
import { createFileDownloadService } from './file-downloads.ts';
import { readLocalFileAbs, statLocalEntryAbs } from './local-files.ts';
import { readProjectTextFileIn, statProjectFileIn, writeProjectTextFileIn } from './project-files.ts';

const slash = (path) => path.replace(/\\/g, '/');

function fixture(t, { downloads = false } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'remote-file-access-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const project = join(base, 'project');
  const outside = join(base, 'outside');
  mkdirSync(project);
  mkdirSync(outside);
  writeFileSync(join(project, 'notes.txt'), 'project notes');
  writeFileSync(join(outside, 'secret.txt'), 'host secret');
  writeFileSync(join(outside, 'report.txt'), 'linked report');
  writeFileSync(join(outside, 'pic.png'), 'png-bytes');
  const sessions = [
    { id: 's1', cwd: project, projectPath: project, classification: 'project' },
    { id: 's2', cwd: project, projectPath: project, classification: 'project' },
  ];
  const transcripts = new Map([
    [
      's1',
      {
        items: [
          // A prompt and a tool's output naming a path are never provenance.
          { id: 'u1', kind: 'user', text: `Please open ${slash(join(outside, 'secret.txt'))}` },
          { id: 't1', kind: 'tool', name: 'shell', result: `cat ${slash(join(outside, 'secret.txt'))}` },
          {
            id: 'a1',
            kind: 'assistant',
            text:
              `Done: [report](${slash(join(outside, 'report.txt'))}) and ` +
              `![pic](${slash(join(outside, 'pic.png'))}); see \`${slash(join(outside, 'link.txt'))}\` ` +
              `and the folder \`${slash(join(outside, 'dirlink'))}/\`.`,
          },
        ],
      },
    ],
    ['s2', { items: [] }],
  ]);
  const operations = { statLocalEntryAbs, readLocalFileAbs, readProjectTextFileIn, statProjectFileIn, writeProjectTextFileIn };
  const host = {
    listProjects: async () => [{ path: project }],
    projectDirectory: async (path) => {
      if (path !== project) throw new Error('Unknown project.');
      return project;
    },
    listSessions: async () => sessions,
    readSessionTranscript: async (id) => transcripts.get(id) ?? null,
    readProjectTextFile: (_project, rel) => readProjectTextFileIn(project, rel),
    invokeDesktopOperation: async (name, args) => operations[name](...args),
  };
  let viewed = ['s1'];
  const fileDownloads = downloads ? createFileDownloadService({ host }) : undefined;
  const methods = createRemoteMethods(
    { host, ...(fileDownloads ? { fileDownloads } : {}) },
    { credentialId: () => 'phone', connectionId: () => 'leg', viewedSessionIds: () => viewed }
  );
  return {
    project,
    outside,
    methods,
    fileDownloads,
    secret: join(outside, 'secret.txt'),
    report: join(outside, 'report.txt'),
    setViewed: (ids) => {
      viewed = ids;
    },
  };
}

test('a paired client cannot read a host file outside every project', async (t) => {
  const f = fixture(t);
  // Before the fix this returned the file's bytes (base64).
  await assert.rejects(f.methods.readLocalFile([f.secret]), /not linked/);
  // Before the fix this minted a grant that readProjectFile, the preview
  // range lane and writeProjectFile all honored.
  await assert.rejects(f.methods.resolveLocalPaths([[f.secret]]), /not linked/);
  await assert.rejects(f.methods.resolveLocalPaths([[f.secret], 's1']), /not linked/);
  assert.throws(() => f.methods.readProjectFile([f.outside, 'secret.txt', 'forged-token']), /unavailable/);
});

test('a file an assistant reply links in a viewed conversation opens through a one-file grant', async (t) => {
  const f = fixture(t);
  const [entry] = await f.methods.resolveLocalPaths([[f.report]]);
  assert.ok(entry.accessToken);
  const read = await f.methods.readProjectFile([entry.projectPath, entry.relPath, entry.accessToken]);
  assert.equal(read.content, 'linked report');
  // The attachment lane reads exactly the linked file this connection holds.
  assert.equal(Buffer.from((await f.methods.readLocalFile([f.report])).data, 'base64').toString(), 'linked report');
  assert.throws(
    () => f.methods.readProjectFile([entry.projectPath, 'secret.txt', entry.accessToken]),
    /does not match/
  );
  const [pic] = await f.methods.resolveLocalPaths([[join(f.outside, 'pic.png')]]);
  const range = await f.methods.previewProjectFileRange([pic.projectPath, pic.relPath, pic.accessToken, 0, 64]);
  assert.equal(Buffer.from(range.data, 'base64').toString(), 'png-bytes');
});

test('provenance is limited to the named or viewed conversations', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.methods.resolveLocalPaths([[f.report], 's2']), /not linked/);
  f.setViewed([]);
  await assert.rejects(f.methods.resolveLocalPaths([[f.report]]), /not linked/);
  const [entry] = await f.methods.resolveLocalPaths([[f.report], 's1']);
  assert.ok(entry.accessToken);
});

test('registered project files keep their project addressing', async (t) => {
  const f = fixture(t);
  const [entry] = await f.methods.resolveLocalPaths([[join(f.project, 'notes.txt')]]);
  assert.equal(entry.projectPath, f.project);
  assert.equal(entry.relPath, 'notes.txt');
  assert.equal(entry.accessToken, undefined);
  const attached = await f.methods.readLocalFile([join(f.project, 'notes.txt')]);
  assert.equal(Buffer.from(attached.data, 'base64').toString(), 'project notes');
});

test('a junction inside a project does not reach the files it points at', async (t) => {
  const f = fixture(t);
  symlinkSync(f.outside, join(f.project, 'escape'), 'junction');
  // Before the fix the lexical project path read the secret through the link.
  await assert.rejects(f.methods.readLocalFile([join(f.project, 'escape', 'secret.txt')]), /outside the project|not linked/);
  await assert.rejects(f.methods.resolveLocalPaths([[join(f.project, 'escape', 'secret.txt')]]), /not linked/);
});

test('a linked file that is a symlink to an unlinked file is refused', async (t) => {
  const f = fixture(t);
  try {
    symlinkSync(f.secret, join(f.outside, 'link.txt'), 'file');
  } catch (error) {
    if (error?.code === 'EPERM') {
      t.skip('file symlinks need elevated rights on this host');
      return;
    }
    throw error;
  }
  await assert.rejects(f.methods.resolveLocalPaths([[join(f.outside, 'link.txt')]]), /symbolic link/);
});

test('a linked folder that is a junction to an unlinked folder is refused', async (t) => {
  const f = fixture(t);
  const hidden = join(f.outside, '..', 'hidden');
  mkdirSync(hidden);
  symlinkSync(hidden, join(f.outside, 'dirlink'), 'junction');
  await assert.rejects(f.methods.resolveLocalPaths([[join(f.outside, 'dirlink')]]), /symbolic link/);
});

test('a bridge grant expires', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const f = fixture(t);
  const [entry] = await f.methods.resolveLocalPaths([[f.report]]);
  t.mock.timers.tick(60 * 60 * 1000 + 1);
  assert.throws(
    () => f.methods.readProjectFile([entry.projectPath, entry.relPath, entry.accessToken]),
    /unavailable/
  );
  await assert.rejects(f.methods.readLocalFile([f.report]), /not linked/);
});

test('a bridge grant ends when its conversation is deleted', async (t) => {
  const f = fixture(t, { downloads: true });
  f.fileDownloads.retainSessions(['s1', 's2']);
  const [entry] = await f.methods.resolveLocalPaths([[f.report]]);
  f.fileDownloads.retainSessions(['s2']);
  assert.throws(
    () => f.methods.readProjectFile([entry.projectPath, entry.relPath, entry.accessToken]),
    /unavailable/
  );
});
