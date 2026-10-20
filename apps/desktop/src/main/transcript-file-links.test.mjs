// The host's reading of what an assistant reply links: the provenance behind
// every out-of-project file a paired device may open or download.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  assistantLinkedPath,
  assistantLinkTargets,
  resolveLinkedPath,
  sessionGeneratedAssetIds,
  sessionLinkedPaths,
  sessionReferencedPaths,
} from './transcript-file-links.ts';

test("only completed tool rows' output fields reference paths; tool inputs and streaming rows never do", () => {
  const cwd = resolve('/work/project');
  const at = (name) => resolve(`/host/${name}`).replace(/\\/g, '/');
  const referenced = sessionReferencedPaths(
    {
      items: [
        // Inputs: a prompt can make the model write any path here.
        { id: 1, kind: 'tool', name: 'shell', args: { path: at('args.txt') }, result: 'ok' },
        { id: 2, kind: 'tool', name: 'read', input: { file: at('input.txt') }, result: 'ok' },
        { id: 3, kind: 'tool', name: 'github', subject: at('subject.txt'), result: 'ok' },
        { id: 4, kind: 'tool', name: 'shell', detail: at('detail.txt'), result: 'ok' },
        // Not completed.
        { id: 5, kind: 'tool', name: 'shell', streaming: true, result: at('streaming.txt') },
        { id: 6, kind: 'tool', name: 'shell', status: 'running', result: at('running.txt') },
        { id: 7, kind: 'tool', name: 'shell', completedCount: 0, count: 1, result: at('partial.txt') },
        {
          id: 8,
          kind: 'tool',
          aggregate: true,
          toolMembers: [
            {
              name: 'shell',
              args: { command: `cat ${at('member-args.txt')}` },
              result: `wrote ${at('member-out.txt')}`,
            },
          ],
        },
        // Genuine, completed output.
        { id: 9, kind: 'tool', name: 'shell', result: `wrote ${at('result.txt')}` },
        { id: 10, kind: 'tool', name: 'shell', completedAt: 1, rawResult: JSON.stringify({ output: at('raw.txt') }) },
        { id: 11, kind: 'tool', name: 'screenshot', completedAt: 1, output: at('output.png') },
      ],
    },
    cwd
  );
  assert.deepEqual(
    referenced.map((path) => path.replace(/\\/g, '/')).sort(),
    ['member-out.txt', 'output.png', 'raw.txt', 'result.txt'].map(at).sort()
  );
});

test("generated assets come only from the built-in media tool's completed, successful results", () => {
  const result = (assetId, extra = {}) => JSON.stringify({ ok: true, status: 'done', assetId, ...extra });
  const tool = (id, assetId, row = {}, extra = {}) => ({
    id,
    kind: 'tool',
    name: 'media',
    result: result(assetId, extra),
    ...row,
  });
  const ids = sessionGeneratedAssetIds({
    items: [
      tool(1, 'own'),
      {
        id: 2,
        kind: 'tool',
        name: 'media',
        result: { structuredContent: { ok: true, assetId: 'structured', output: '/o.png' } },
      },
      { id: 3, kind: 'tool', aggregate: true, toolMembers: [{ name: 'media', result: result('member') }] },
      tool(4, 'output-only', {}, { status: undefined, output: '/x.png' }),
      // Counterexamples: none of these establish ownership.
      { id: 10, kind: 'tool', name: 'mcp__evil__media', result: result('mcp') },
      { id: 11, kind: 'tool', name: 'mcp__mixdog__media', result: result('mcp-mixdog') },
      { id: 12, kind: 'user', name: 'media', text: result('prompt'), result: result('prompt') },
      { id: 13, kind: 'assistant', text: result('prose') },
      { id: 14, kind: 'tool', name: 'shell', result: result('shell') },
      tool(15, 'errored', { isError: true }),
      tool(16, 'not-ok', {}, { ok: false }),
      tool(17, 'running', {}, { status: 'running' }),
      tool(18, 'canceled', {}, { status: 'canceled' }),
      tool(19, 'cancelled', {}, { status: 'cancelled' }),
      tool(20, 'failed', {}, { status: 'failed' }),
      tool(21, 'no-output', {}, { status: 'queued' }),
      tool(22, 'error-count', { errorCount: 1 }),
      tool(23, 'call-error', { callErrorCount: 1 }),
      tool(24, 'exit-error', { exitErrorCount: 2 }),
      tool(25, 'unfinished', { completedCount: 0, count: 1 }),
      { id: 26, kind: 'tool', name: 'media', args: { action: 'generate' } },
    ],
  });
  assert.deepEqual([...ids].sort(), ['member', 'output-only', 'own', 'structured']);
});

test('link targets are read the way MarkdownLink decodes them, outside fenced code', () => {
  const text = [
    'See [the deck](file:///C:/Out/deck.pptx), [img](C:%5COut%5Cshot.png) and <C:/Out/auto.pdf>.',
    'Report: `out/report.pdf:12`, also src/app.ts#L4 and ./notes.md.',
    '[ref]: </srv/out/My File.txt>',
    'Web links stay web: [site](https://example.com/a/b.txt).',
    '```',
    'C:/Secrets/key.pem',
    '```',
  ].join('\n');
  const targets = assistantLinkTargets(text);
  for (const expected of [
    'C:/Out/deck.pptx',
    'C:/Out/shot.png',
    'C:/Out/auto.pdf',
    'out/report.pdf',
    'src/app.ts',
    './notes.md',
    '/srv/out/My File.txt',
  ]) {
    assert.ok(targets.includes(expected), `${expected} in ${JSON.stringify(targets)}`);
  }
  assert.equal(
    targets.some((target) => target.includes('Secrets')),
    false,
    'a fenced code block links nothing'
  );
  assert.equal(
    targets.some((target) => target.includes('example.com')),
    false
  );
});

test('a link resolves against the session folder; network paths never resolve', () => {
  const cwd = resolve('/work/project');
  assert.equal(resolveLinkedPath('out/a.pdf', cwd), resolve(cwd, 'out/a.pdf'));
  assert.equal(resolveLinkedPath('../b.pdf', cwd), resolve(cwd, '../b.pdf'));
  assert.equal(resolveLinkedPath('out/a.pdf', ''), null);
  assert.equal(resolveLinkedPath('//server/share/a.pdf', cwd), null);
});

test('only settled assistant rows link; approval preview images are included', () => {
  const cwd = resolve('/work/project');
  const snapshot = {
    items: [
      { id: 'u', kind: 'user', text: 'out/user.pdf' },
      { id: 1, kind: 'assistant', text: 'Wrote out/a.pdf' },
      { id: 's', kind: 'assistant', streaming: true, text: 'out/streaming.pdf' },
    ],
    toolApproval: {
      args: {
        preview: {
          images: [{ path: resolve('/tmp/preview-1.png') }],
          visualDiff: { images: [{ path: 'relative.png' }] },
        },
      },
    },
  };
  assert.equal(assistantLinkedPath(snapshot, './out/a.pdf:3', cwd), resolve(cwd, 'out/a.pdf'));
  assert.equal(assistantLinkedPath(snapshot, 'out/user.pdf', cwd), null);
  assert.equal(assistantLinkedPath(snapshot, 'out/streaming.pdf', cwd), null);
  // An approval preview is no reply's link.
  assert.equal(assistantLinkedPath(snapshot, resolve('/tmp/preview-1.png'), cwd), null);
  const linked = sessionLinkedPaths(snapshot, cwd);
  assert.ok(linked.includes(resolve(cwd, 'out/a.pdf')));
  assert.ok(linked.includes(resolve('/tmp/preview-1.png')));
  assert.equal(linked.includes(resolve(cwd, 'out/user.pdf')), false);
  assert.equal(linked.includes(resolve(cwd, 'out/streaming.pdf')), false);
  assert.equal(
    linked.some((path) => path.endsWith('relative.png')),
    false
  );
});

test("a task report's returned files are linked paths and attachments; other notices name none", async () => {
  const { sessionAttachments } = await import('./transcript-file-links.ts');
  const cwd = resolve('/work/project');
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
  const linked = sessionLinkedPaths(snapshot, cwd);
  assert.ok(linked.includes(resolve('/work/project/clip.mp4')));
  assert.equal(linked.includes(resolve('/etc/x')), false);
  assert.equal(
    linked.some((path) => path.endsWith('relative.txt')),
    false
  );
  assert.deepEqual([...sessionAttachments(snapshot).keys()], [id, 'c'.repeat(64)]);
});
