// The host's decoding of the paths a conversation names: a link's href the
// way MarkdownLink decodes it, resolved against the session's folder.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import { requestedLinkPath, resolveLinkedPath, sessionAttachments } from './transcript-file-links.ts';

test('an href is decoded the way MarkdownLink decodes it; a web link names no file', () => {
  const cwd = resolve('/work/project');
  assert.equal(requestedLinkPath('file:///srv/out/deck.pptx', cwd), resolve('/srv/out/deck.pptx'));
  assert.equal(requestedLinkPath('out/shot%20one.png', cwd), resolve(cwd, 'out/shot one.png'));
  assert.equal(requestedLinkPath('out/report.pdf:12', cwd), resolve(cwd, 'out/report.pdf'));
  assert.equal(requestedLinkPath('src/app.ts#L4', cwd), resolve(cwd, 'src/app.ts'));
  assert.equal(requestedLinkPath('./notes.md.', cwd), resolve(cwd, 'notes.md'));
  assert.equal(requestedLinkPath('https://example.com/a/b.txt', cwd), null);
  assert.equal(requestedLinkPath('', cwd), null);
});

test('a link resolves against the session folder; network paths never resolve', () => {
  const cwd = resolve('/work/project');
  assert.equal(resolveLinkedPath('out/a.pdf', cwd), resolve(cwd, 'out/a.pdf'));
  assert.equal(resolveLinkedPath('../b.pdf', cwd), resolve(cwd, '../b.pdf'));
  assert.equal(resolveLinkedPath('out/a.pdf', ''), null);
  assert.equal(resolveLinkedPath('//server/share/a.pdf', cwd), null);
});

test("a task report's and a room speech's returned files are attachments; other notices carry none", () => {
  const id = 'a'.repeat(64);
  const record = { id, attachmentRef: id, kind: 'image', name: 'chart.png', mimeType: 'image/png', size: 3 };
  const snapshot = {
    items: [
      {
        kind: 'notice',
        routine: { kind: 'task', files: [{ path: resolve('/work/project/clip.mp4') }, { path: 'relative.txt' }] },
        attachments: [record],
      },
      // A notice that is no task report (or a room pass) lends nothing.
      {
        kind: 'notice',
        routine: { kind: 'schedule', files: [{ path: resolve('/etc/x') }] },
        attachments: [{ ...record, id: 'b'.repeat(64) }],
      },
      { kind: 'notice', room: { kind: 'speech' }, attachments: [{ ...record, id: 'c'.repeat(64) }] },
    ],
  };
  assert.deepEqual([...sessionAttachments(snapshot).keys()], [id, 'c'.repeat(64)]);
});
