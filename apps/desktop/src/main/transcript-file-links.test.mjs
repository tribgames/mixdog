// The host's reading of what an assistant reply links: the provenance behind
// every out-of-project file a paired device may open or download.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  assistantItemLink,
  assistantLinkTargets,
  resolveLinkedPath,
  sessionLinkedPaths,
  settledAssistantItem,
} from './transcript-file-links.ts';

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
    toolApproval: { args: { preview: { images: [{ path: resolve('/tmp/preview-1.png') }], visualDiff: { images: [{ path: 'relative.png' }] } } } },
  };
  assert.equal(settledAssistantItem(snapshot, 'u'), null);
  assert.equal(settledAssistantItem(snapshot, 's'), null);
  const item = settledAssistantItem(snapshot, '1');
  assert.equal(assistantItemLink(item, './out/a.pdf:3', cwd), resolve(cwd, 'out/a.pdf'));
  assert.equal(assistantItemLink(item, 'out/user.pdf', cwd), null);
  const linked = sessionLinkedPaths(snapshot, cwd);
  assert.ok(linked.includes(resolve(cwd, 'out/a.pdf')));
  assert.ok(linked.includes(resolve('/tmp/preview-1.png')));
  assert.equal(linked.includes(resolve(cwd, 'out/user.pdf')), false);
  assert.equal(linked.includes(resolve(cwd, 'out/streaming.pdf')), false);
  assert.equal(linked.some((path) => path.endsWith('relative.png')), false);
});
