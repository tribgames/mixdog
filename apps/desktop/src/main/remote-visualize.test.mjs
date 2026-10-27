import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { open as openFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import test from 'node:test';

import { REMOTE_BROWSER_OPEN_EVENT } from '../shared/remote-browser.ts';
import {
  REMOTE_PAGE_MAX_BYTES,
  REMOTE_VISUALIZE_CHANGED_EVENT,
  REMOTE_VISUALIZE_LANE,
  VISUALIZE_REMOTE_DESKTOP_EVENT,
} from '../shared/visualize.ts';
import { leasedMediaFile } from './media-leases.ts';
import { authorizedFileDigest, REMOTE_PREVIEW_MAX_READ_BYTES } from './remote-file-preview.ts';
import { createRemoteMethods } from './remote-methods.ts';
import { createRelayClientLifecycle } from './remote-relay-client-lifecycle.ts';
import { clientViewsSessionLane } from './remote-relay-clients.ts';
import { createRelayPushLanes } from './remote-relay-push-lanes.ts';
import { createRemoteVisualizeMethods, createRemoteVisualizeMirror } from './remote-visualize.ts';

import { makeTempDirSync, redirectSystemTemp } from '../../../../scripts/lib/scoped-temp.mjs';

redirectSystemTemp('tmp-root');
function workspace() {
  const base = realpathSync(makeTempDirSync('remote-visualize'));
  const cwd = join(base, 'project');
  const outside = join(base, 'outside');
  mkdirSync(join(cwd, 'site', '.cache'), { recursive: true });
  mkdirSync(join(cwd, 'gen'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(cwd, 'site', 'index.html'), '<link rel="stylesheet" href="style.css"><img src="pic.png">');
  writeFileSync(join(cwd, 'site', 'style.css'), 'h1{}');
  writeFileSync(join(cwd, 'site', 'pic.png'), 'png');
  writeFileSync(join(cwd, 'site', '.cache', 'x.css'), 'hidden');
  writeFileSync(join(cwd, 'site', '.cache', 'image.png'), 'hidden-png');
  mkdirSync(join(cwd, '.private'), { recursive: true });
  writeFileSync(join(cwd, '.private', 'secret.pdf'), '%PDF-secret');
  // A non-web type (`.bin` is a served glTF buffer asset).
  writeFileSync(join(cwd, 'site', 'data.sqlite'), 'db');
  writeFileSync(join(cwd, 'chart.png'), '0123456789');
  writeFileSync(join(cwd, 'report.docx'), 'docx');
  writeFileSync(join(cwd, 'gen', 'a.png'), 'inside');
  writeFileSync(join(outside, 'a.png'), 'OUTSIDE');
  writeFileSync(join(outside, 'report.pdf'), '%PDF-converted');
  return { base, cwd, outside, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const pane = (kind, path) => ({ kind, label: basename(path), target: path, path, remoteTarget: basename(path) });

function hostSnapshot(cwd) {
  return [
    {
      sessionId: 's1',
      active: 'v1',
      tabs: [
        {
          id: 'v1',
          label: cwd,
          remoteLabel: 'page',
          revision: 0,
          cwd,
          panes: [pane('html', join(cwd, 'site', 'index.html'))],
        },
        {
          id: 'v2',
          label: cwd,
          remoteLabel: 'chart',
          revision: 3,
          cwd,
          panes: [pane('image', join(cwd, 'chart.png'))],
        },
        {
          id: 'v3',
          label: cwd,
          remoteLabel: 'doc',
          revision: 0,
          cwd,
          panes: [pane('document', join(cwd, 'report.docx'))],
        },
        {
          id: 'v4',
          label: cwd,
          remoteLabel: 'gen',
          revision: 0,
          cwd,
          panes: [pane('image', join(cwd, 'gen', 'a.png'))],
        },
      ],
    },
  ];
}

function fixture(cwd, outside) {
  const requests = [];
  const operations = [];
  const mirror = createRemoteVisualizeMirror();
  const methods = createRemoteVisualizeMethods({
    mirror,
    hostRequest: async (method, args) => {
      requests.push([method, args]);
      return method === 'visualizeState' ? hostSnapshot(cwd) : null;
    },
    invokeDesktopOperation: async (name, args) => {
      operations.push([name, args]);
      return { path: join(outside, 'report.pdf'), mtimeMs: 1, size: 14 };
    },
  });
  return { methods, mirror, requests, operations };
}

test('a change event carries a card picture only when it is new or changed; a snapshot carries all', () => {
  const mirror = createRemoteVisualizeMirror();
  const [state] = hostSnapshot(join(tmpdir(), 'w-project'));
  const picture = (text) => `data:image/png;base64,${Buffer.from(text).toString('base64')}`;
  const withPicture = (thumbnail) => ({
    ...state,
    tabs: state.tabs.map((tab, index) => (index === 0 ? { ...tab, thumbnail, thumbnailVersion: 1 } : tab)),
  });
  const first = mirror.apply({ sessionId: 's1', state: withPicture(picture('a')) });
  assert.equal(first.state.tabs[0].thumbnail, picture('a'));
  assert.equal(first.state.tabs[0].thumbnailVersion, 1);
  const repeated = mirror.apply({ sessionId: 's1', state: withPicture(picture('a')) });
  assert.equal('thumbnail' in repeated.state.tabs[0], false, 'an unchanged picture is not sent again');
  assert.equal('thumbnailVersion' in repeated.state.tabs[0], false);
  const changed = mirror.apply({ sessionId: 's1', state: withPicture(picture('b')) });
  assert.equal(changed.state.tabs[0].thumbnail, picture('b'));
  assert.equal(mirror.replace([withPicture(picture('b'))])[0].tabs[0].thumbnail, picture('b'));
});

test('the mirror forwards a path-free state and keeps the paths to itself', () => {
  const mirror = createRemoteVisualizeMirror();
  const cwd = join(tmpdir(), 'w-project');
  const [state] = hostSnapshot(cwd);
  const event = mirror.apply({ sessionId: 's1', state, reveal: true });
  assert.equal(event.reveal, true);
  assert.equal(JSON.stringify(event).includes('w-project'), false, 'no cwd or file path reaches a client');
  assert.deepEqual(event.state.tabs[1], {
    id: 'v2',
    label: 'chart',
    revision: 3,
    panes: [{ kind: 'image', label: 'chart.png', target: 'chart.png', url: '' }],
  });
  assert.equal(mirror.tab('s1', 'v2').cwd, cwd);
  assert.deepEqual(mirror.apply({ sessionId: 's1', openUrl: 'https://a.test/' }), {
    sessionId: 's1',
    openUrl: 'https://a.test/',
  });
  mirror.apply({ sessionId: 's1', state: { sessionId: 's1', tabs: [], active: null } });
  assert.equal(mirror.tab('s1', 'v2'), undefined, 'an empty state drops the session');
  assert.equal(mirror.apply({ state }), null);
  assert.equal(mirror.apply(null), null);
});

test('state and tab commands go to the window; commands are validated first', async () => {
  const { cwd, outside, cleanup } = workspace();
  const { methods, requests } = fixture(cwd, outside);
  try {
    const states = await methods.visualizeState([]);
    assert.deepEqual(
      states[0].tabs.map((tab) => [tab.id, tab.panes[0].url]),
      [
        ['v1', ''],
        ['v2', ''],
        ['v3', ''],
        ['v4', ''],
      ]
    );
    assert.equal(JSON.stringify(states).includes(cwd), false);
    await methods.visualizeCommand([{ sessionId: 's1', tabId: 'v2', action: 'close' }]);
    assert.deepEqual(requests.at(-1), ['visualizeCommand', [{ sessionId: 's1', tabId: 'v2', action: 'close' }]]);
    const before = requests.length;
    await assert.rejects(methods.visualizeCommand([{ sessionId: 's1', tabId: 'v2', action: 'open' }]), TypeError);
    assert.equal(requests.length, before, 'an invalid command never reaches the window');
    await assert.rejects(
      methods.visualizeCommand([{ sessionId: 's1', tabId: 'v2', action: 'network', allow: true }]),
      /only be allowed on the desktop/
    );
    assert.equal(requests.length, before, "a remote device cannot lift a page's network block");
  } finally {
    cleanup();
  }
});

test('the remote method table serves visualize only with a mirror and a window', async () => {
  const methods = createRemoteMethods({ host: { invokeDesktopOperation: async () => null } });
  for (const name of ['visualizeState', 'visualizeCommand', 'visualizePaneFile', 'visualizePaneRange']) {
    assert.equal(typeof methods[name], 'function', `${name} is a remote method`);
  }
  await assert.rejects(async () => methods.visualizeState([]), /unavailable/);
  const wired = createRemoteMethods({
    host: { invokeDesktopOperation: async () => null },
    visualize: createRemoteVisualizeMirror(),
    hostRequest: async () => [],
  });
  assert.deepEqual(await wired.visualizeState([]), []);
});

test('the handshake advertises the visualize panel', () => {
  const sent = [];
  const lifecycle = createRelayClientLifecycle({
    clients: { open: () => true },
    e2eeIdentity: {},
    pairing: {},
    relayBinaryFrames: () => false,
    viewSyncSupported: () => false,
    relayRoutingCapsPayload: () => ({}),
    sendEnvelope: (payload) => sent.push(payload),
    sendEncryptedFrame: async () => {},
    dispatchClientCall: async () => ({}),
    resyncClient: () => {},
  });
  lifecycle.open('route', 'cred');
  assert.equal(JSON.parse(sent[0].data).visualize, 1);
});

test('pane content: pages, their assets, media and converted documents', async () => {
  const { cwd, outside, cleanup } = workspace();
  const { methods, operations, requests } = fixture(cwd, outside);
  const text = (range) => Buffer.from(range.data, 'base64').toString();
  try {
    // An empty mirror (restarted daemon) re-reads the window once.
    const page = await methods.visualizePaneFile(['s1', 'v1', 0]);
    assert.equal(requests[0][0], 'visualizeState');
    assert.deepEqual(page, {
      kind: 'html',
      mime: 'text/html; charset=utf-8',
      size: 59,
      mtimeMs: page.mtimeMs,
      rel: 'site/index.html',
      contentId: `live:${createHash('sha256')
        .update(readFileSync(join(cwd, 'site', 'index.html')))
        .digest('hex')}`,
    });
    // A same-size edit within one mtime tick still changes the identity.
    const pagePath = join(cwd, 'site', 'index.html');
    const before = statSync(pagePath);
    writeFileSync(pagePath, readFileSync(pagePath, 'utf8').replace('stylesheet', 'STYLESHEET'));
    utimesSync(pagePath, before.atime, before.mtime);
    const edited = await methods.visualizePaneFile(['s1', 'v1', 0]);
    assert.equal(edited.size, page.size);
    assert.notEqual(edited.contentId, page.contentId);
    writeFileSync(pagePath, readFileSync(pagePath, 'utf8').replace('STYLESHEET', 'stylesheet'));
    assert.match(text(await methods.visualizePaneRange(['s1', 'v1', 'site/index.html', 0, 100])), /stylesheet/);
    // The page's relative assets are served for an HTML tab only.
    assert.equal(text(await methods.visualizePaneRange(['s1', 'v1', 'site/style.css', 0, 100])), 'h1{}');
    assert.equal((await methods.visualizePaneRange(['s1', 'v1', 'site/pic.png', 0, 100])).mime, 'image/png');
    await assert.rejects(
      methods.visualizePaneRange(['s1', 'v2', 'site/style.css', 0, 100]),
      /not part of the visualize tab/
    );
    await assert.rejects(methods.visualizePaneRange(['s1', 'v1', 'site/.cache/x.css', 0, 100]), /does not support/);
    // Previewable types get no pass around the page-asset policy: hidden
    // folders stay unreadable through an HTML tab.
    await assert.rejects(methods.visualizePaneRange(['s1', 'v1', 'site/.cache/image.png', 0, 100]), /does not support/);
    await assert.rejects(methods.visualizePaneRange(['s1', 'v1', '.private/secret.pdf', 0, 100]), /does not support/);
    await assert.rejects(methods.visualizePaneRange(['s1', 'v1', 'site/data.sqlite', 0, 100]), /does not support/);

    // Media: bounded ranges, clamped at EOF.
    const chart = await methods.visualizePaneFile(['s1', 'v2', 0]);
    assert.deepEqual([chart.kind, chart.mime, chart.size, chart.rel], ['image', 'image/png', 10, 'chart.png']);
    assert.equal(text(await methods.visualizePaneRange(['s1', 'v2', 'chart.png', 2, 3])), '234');
    assert.equal(text(await methods.visualizePaneRange(['s1', 'v2', 'chart.png', 8, 100])), '89');

    // Office: the converted PDF from the conversion cache (outside cwd).
    const doc = await methods.visualizePaneFile(['s1', 'v3', 0]);
    assert.deepEqual([doc.kind, doc.mime, doc.size, doc.rel], ['document', 'application/pdf', 14, 'report.docx']);
    // The conversion reads a private copy of the authorized bytes, not cwd.
    const [converted, [copyRoot, copyRel]] = operations.at(-1);
    assert.deepEqual([converted, copyRel], ['documentPreviewIn', 'report.docx']);
    assert.notEqual(copyRoot, cwd);
    assert.equal(text(await methods.visualizePaneRange(['s1', 'v3', 'report.docx', 0, 100])), '%PDF-converted');

    await assert.rejects(methods.visualizePaneFile(['s1', 'v9', 0]), /closed/);
    await assert.rejects(methods.visualizePaneFile(['s1', 'v2', 1]), /closed/);
    await assert.rejects(methods.visualizePaneFile(['s1', 'v2', 7]), /pane index/);
  } finally {
    cleanup();
  }
});

test('media panes carry a media-lane lease for their own file; pages and documents do not', async () => {
  const { cwd, outside, cleanup } = workspace();
  const { methods } = fixture(cwd, outside);
  try {
    const chart = await methods.visualizePaneFile(['s1', 'v2', 0]);
    assert.ok(chart.mediaAssetId, 'an image pane is streamable');
    // The lease names the authorized file and how the lane re-authorizes it.
    const identity = statSync(join(cwd, 'chart.png'), { bigint: true });
    assert.deepEqual(leasedMediaFile(chart.mediaAssetId), {
      path: join(cwd, 'chart.png'),
      mime: 'image/png',
      within: realpathSync(cwd),
      identity: { dev: identity.dev, ino: identity.ino },
    });
    // Each answer mints a fresh, unguessable lease.
    assert.notEqual((await methods.visualizePaneFile(['s1', 'v2', 0])).mediaAssetId, chart.mediaAssetId);
    assert.equal((await methods.visualizePaneFile(['s1', 'v1', 0])).mediaAssetId, undefined);
    assert.equal((await methods.visualizePaneFile(['s1', 'v3', 0])).mediaAssetId, undefined);
  } finally {
    cleanup();
  }
});

test('PDF and Office panes are rasterized to pages from their own file inside the root', async () => {
  const { cwd, outside, cleanup } = workspace();
  const { methods, operations } = fixture(cwd, outside);
  try {
    await methods.visualizePanePages(['s1', 'v3', 0, { pages: [1, 2], maxWidth: 900, extra: 'dropped' }]);
    const [rendered, [copyRoot, ...rest]] = operations.at(-1);
    assert.deepEqual([rendered, rest], ['documentPreviewPagesIn', ['report.docx', { pages: [1, 2], maxWidth: 900 }]]);
    assert.notEqual(copyRoot, cwd, 'pages are rendered from a private copy');
    await assert.rejects(methods.visualizePanePages(['s1', 'v2', 0, { pages: [1] }]), /Only PDF and Office panes/);
    await assert.rejects(methods.visualizePanePages(['s1', 'v3', 1, { pages: [1] }]), /closed/);
    await assert.rejects(methods.visualizePanePages(['s1', 'v3', 9, { pages: [1] }]), /pane index/);
  } finally {
    cleanup();
  }
});

test("a remote PNG/PDF export is rendered by the window and handed over as this device's download", async () => {
  const { cwd, outside, cleanup } = workspace();
  const requests = [];
  const handed = [];
  const methods = createRemoteVisualizeMethods({
    mirror: createRemoteVisualizeMirror(),
    hostRequest: async (method, args) => {
      requests.push([method, args]);
      if (method === 'visualizeState') return hostSnapshot(cwd);
      return method === 'visualizeExport' ? { path: join(outside, 'mixdog-visualize-export-1', 'chart.png') } : null;
    },
    invokeDesktopOperation: async () => null,
    exportDownload: async (file) => {
      handed.push(file);
      return { source: { kind: 'export', sessionId: file.sessionId, exportId: 'id-1' }, name: 'chart.png' };
    },
  });
  try {
    const result = await methods.visualizeExport(['s1', 'v2', 'png', 0]);
    assert.deepEqual(result, { source: { kind: 'export', sessionId: 's1', exportId: 'id-1' }, name: 'chart.png' });
    assert.deepEqual(requests.at(-1), [
      'visualizeExport',
      [{ sessionId: 's1', tabId: 'v2', action: 'export', format: 'png', pane: 0 }],
    ]);
    assert.deepEqual(handed, [
      { sessionId: 's1', path: join(outside, 'mixdog-visualize-export-1', 'chart.png'), mime: 'image/png' },
    ]);
    const before = requests.length;
    await assert.rejects(methods.visualizeExport(['s1', 'v2', 'project', 0]), /format is invalid/);
    await assert.rejects(methods.visualizeExport(['s1', 'v2', 'svg', 0]), TypeError);
    await assert.rejects(methods.visualizeExport(['s1', 'v9', 'png', 0]), /closed/);
    assert.equal(requests.filter(([method]) => method === 'visualizeExport').length, 1, 'nothing invalid is rendered');
    assert.ok(requests.length >= before);
    // The save-dialog form stays desktop-only.
    await assert.rejects(
      methods.visualizeCommand([{ sessionId: 's1', tabId: 'v2', action: 'export', format: 'png', pane: 0 }]),
      /only available in the desktop window/
    );
    // Without a download lane on this connection, nothing is rendered.
    const noLane = createRemoteVisualizeMethods({
      mirror: createRemoteVisualizeMirror(),
      hostRequest: async (method) => (method === 'visualizeState' ? hostSnapshot(cwd) : { path: 'x' }),
      invokeDesktopOperation: async () => null,
    });
    await assert.rejects(noLane.visualizeExport(['s1', 'v2', 'png', 0]), /Downloads are unavailable/);
  } finally {
    cleanup();
  }
});

test('render reports from a remote client pass validated to the window', async () => {
  const { cwd, outside, cleanup } = workspace();
  const { methods, requests } = fixture(cwd, outside);
  try {
    const report = { sessionId: 's1', tabId: 'v1', action: 'render', pane: 0, renderId: 'r-1', error: 'bad' };
    await methods.visualizeCommand([report]);
    assert.deepEqual(requests.at(-1), ['visualizeCommand', [report]]);
    await assert.rejects(methods.visualizeCommand([{ ...report, renderId: undefined }]), /render id/);
  } finally {
    cleanup();
  }
});

test('a kept version is served from its snapshot folder with the same containment and caps', async () => {
  const { base, cwd, outside, cleanup } = workspace();
  const snapshot = join(base, 'app-data', 'visualize-versions', 'abc', 'v9', '1');
  mkdirSync(join(snapshot, 'site', '.cache'), { recursive: true });
  writeFileSync(join(snapshot, 'site', 'index.html'), '<link rel="stylesheet" href="style.css">old');
  writeFileSync(join(snapshot, 'site', 'style.css'), 'old{}');
  writeFileSync(join(snapshot, 'site', '.cache', 'x.css'), 'hidden');
  const live = pane('html', join(cwd, 'site', 'index.html'));
  const kept = {
    ...pane('html', join(snapshot, 'site', 'index.html')),
    remoteTarget: 'site/index.html',
    root: snapshot,
    version: 1,
  };
  const state = {
    sessionId: 's1',
    active: 'v9',
    tabs: [
      {
        id: 'v9',
        label: 'page',
        remoteLabel: 'page',
        revision: 2,
        cwd,
        panes: [kept, live],
        versions: [
          { n: 1, at: 5 },
          { n: 2, at: 6 },
        ],
        version: 1,
        compare: true,
      },
    ],
  };
  const mirror = createRemoteVisualizeMirror();
  const methods = createRemoteVisualizeMethods({
    mirror,
    hostRequest: async (method) => (method === 'visualizeState' ? [state] : null),
    invokeDesktopOperation: async () => ({}),
  });
  const text = (range) => Buffer.from(range.data, 'base64').toString();
  try {
    const [remote] = await methods.visualizeState([]);
    assert.equal(JSON.stringify(remote).includes(base), false, 'the snapshot folder never reaches a client');
    assert.deepEqual(remote.tabs[0].versions, [
      { n: 1, at: 5 },
      { n: 2, at: 6 },
    ]);
    assert.deepEqual([remote.tabs[0].version, remote.tabs[0].compare], [1, true]);

    const meta = await methods.visualizePaneFile(['s1', 'v9', 0]);
    assert.equal(meta.rel, 'site/index.html');
    // Same path, different roots: each pane's identity names its version and its own bytes.
    const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
    assert.equal(meta.contentId, `v1:${digest(join(snapshot, 'site', 'index.html'))}`);
    const liveMeta = await methods.visualizePaneFile(['s1', 'v9', 1]);
    assert.equal(liveMeta.contentId, `live:${digest(join(cwd, 'site', 'index.html'))}`);
    assert.match(text(await methods.visualizePaneRange(['s1', 'v9', meta.rel, 0, 100, 0])), /old$/);
    // The pane index scopes page assets to that pane's root.
    assert.equal(text(await methods.visualizePaneRange(['s1', 'v9', 'site/style.css', 0, 100, 0])), 'old{}');
    assert.equal(text(await methods.visualizePaneRange(['s1', 'v9', 'site/style.css', 0, 100, 1])), 'h1{}');
    assert.equal(
      text(await methods.visualizePaneRange(['s1', 'v9', 'site/style.css', 0, 100])),
      'h1{}',
      'older clients read live'
    );

    // Containment and caps hold inside the snapshot folder too.
    await assert.rejects(
      methods.visualizePaneRange(['s1', 'v9', '../2/site/index.html', 0, 10, 0]),
      /outside the project/
    );
    await assert.rejects(
      methods.visualizePaneRange(['s1', 'v9', join(outside, 'a.png'), 0, 10, 0]),
      /outside the project/
    );
    await assert.rejects(methods.visualizePaneRange(['s1', 'v9', 'site/.cache/x.css', 0, 10, 0]), /does not support/);
    await assert.rejects(
      methods.visualizePaneRange(['s1', 'v9', 'site/style.css', 0, REMOTE_PREVIEW_MAX_READ_BYTES + 1, 0]),
      /length/
    );
    await assert.rejects(methods.visualizePaneRange(['s1', 'v9', 'site/style.css', 0, 10, 2]), /closed/);
    await assert.rejects(methods.visualizePaneRange(['s1', 'v9', 'site/style.css', 0, 10, 6]), /pane index/);
  } finally {
    cleanup();
  }
});

test('a page over the client page cap gets no content identity', async () => {
  const { cwd, outside, cleanup } = workspace();
  const { methods } = fixture(cwd, outside);
  try {
    writeFileSync(join(cwd, 'site', 'index.html'), Buffer.alloc(REMOTE_PAGE_MAX_BYTES + 1, 0x61));
    const page = await methods.visualizePaneFile(['s1', 'v1', 0]);
    assert.deepEqual([page.kind, page.size, page.contentId], ['html', REMOTE_PAGE_MAX_BYTES + 1, undefined]);
  } finally {
    cleanup();
  }
});

test('a page digest reads at most one byte past the cap, even from a file that grew after its open', async () => {
  const { cwd, cleanup } = workspace();
  const file = join(cwd, 'grow.html');
  writeFileSync(file, 'x'.repeat(64));
  const probe = await openFile(file);
  const handles = Object.getPrototypeOf(probe);
  await probe.close();
  const { stat, read } = handles;
  let readBytes = 0;
  handles.read = async function (...args) {
    const result = await read.apply(this, args);
    readBytes += result.bytesRead;
    return result;
  };
  try {
    // Larger than the cap when opened: no digest, nothing read.
    assert.equal((await authorizedFileDigest(file, cwd, 20)).sha256, null);
    assert.equal(readBytes, 0);
    // The opened handle says 16 bytes; the file has 64 by the time it is read.
    handles.stat = async function (options) {
      const info = await stat.call(this, options);
      return options?.bigint ? info : Object.assign(info, { size: 16 });
    };
    const grown = await authorizedFileDigest(file, cwd, 20);
    assert.deepEqual([grown.size, grown.sha256, readBytes], [16, null, 21]);
    readBytes = 0;
    const whole = await authorizedFileDigest(file, cwd, 64);
    assert.equal(whole.sha256, createHash('sha256').update('x'.repeat(64)).digest('hex'));
    assert.equal(readBytes, 64);
  } finally {
    handles.stat = stat;
    handles.read = read;
    cleanup();
  }
});

test('pane reads stay inside cwd and inside the read caps', async () => {
  const { cwd, outside, cleanup } = workspace();
  const { methods } = fixture(cwd, outside);
  try {
    await methods.visualizeState([]);
    await assert.rejects(methods.visualizePaneRange(['s1', 'v1', '../outside/a.png', 0, 4]), /outside the project/);
    await assert.rejects(methods.visualizePaneRange(['s1', 'v1', join(outside, 'a.png'), 0, 4]), /outside the project/);
    await assert.rejects(
      methods.visualizePaneRange(['s1', 'v2', 'chart.png', 0, REMOTE_PREVIEW_MAX_READ_BYTES + 1]),
      /length/
    );
    await assert.rejects(methods.visualizePaneRange(['s1', 'v2', 'chart.png', -1, 4]), /offset/);
    await assert.rejects(methods.visualizePaneRange(['s1', 'v2', 7, 0, 4]), TypeError);

    // A pane's folder swapped for a link to outside cwd: every later read fails closed.
    assert.equal(
      Buffer.from((await methods.visualizePaneRange(['s1', 'v4', 'gen/a.png', 0, 10])).data, 'base64').toString(),
      'inside'
    );
    renameSync(join(cwd, 'gen'), join(cwd, 'gen-old'));
    symlinkSync(outside, join(cwd, 'gen'), 'junction');
    await assert.rejects(methods.visualizePaneRange(['s1', 'v4', 'gen/a.png', 0, 10]), /outside the project/);
    await assert.rejects(methods.visualizePaneFile(['s1', 'v4', 0]), /outside the project/);
  } finally {
    cleanup();
  }
});

test('a pane of a secret-bearing file inside its root is served as on the desktop; outside the root it is not', async () => {
  const { cwd, outside, cleanup } = workspace();
  mkdirSync(join(cwd, '.ssh'));
  writeFileSync(join(cwd, '.ssh', 'key.png'), 'key-png');
  const [state] = hostSnapshot(cwd);
  const tab = { ...state.tabs[1], id: 'v5', panes: [pane('image', join(cwd, '.ssh', 'key.png'))] };
  const methods = createRemoteVisualizeMethods({
    mirror: createRemoteVisualizeMirror(),
    hostRequest: async (method) => (method === 'visualizeState' ? [{ ...state, tabs: [tab] }] : null),
    invokeDesktopOperation: async () => null,
  });
  try {
    await methods.visualizeState([]);
    // Before parity: refused as "credentials or secrets" for a remote device.
    const range = await methods.visualizePaneRange(['s1', 'v5', '.ssh/key.png', 0, 16]);
    assert.equal(Buffer.from(range.data, 'base64').toString(), 'key-png');
    await assert.rejects(methods.visualizePaneRange(['s1', 'v5', '../outside/a.png', 0, 4]), /outside the project/);
    await assert.rejects(methods.visualizePaneRange(['s1', 'v5', join(outside, 'a.png'), 0, 4]), /outside the project/);
  } finally {
    cleanup();
  }
});

test('a live pane outside cwd is served from its own folder, never above it', async () => {
  const { base, cwd, outside, cleanup } = workspace();
  const design = join(outside, 'design');
  mkdirSync(design, { recursive: true });
  writeFileSync(join(design, 'mockup.html'), '<link rel="stylesheet" href="style.css"><h1>away</h1>');
  writeFileSync(join(design, 'style.css'), 'h1{color:teal}');
  const state = {
    sessionId: 's1',
    active: 'v1',
    tabs: [
      {
        id: 'v1',
        label: 'mockup',
        remoteLabel: 'mockup',
        revision: 0,
        cwd,
        panes: [{ ...pane('html', join(design, 'mockup.html')), root: design }],
      },
    ],
  };
  const methods = createRemoteVisualizeMethods({
    mirror: createRemoteVisualizeMirror(),
    hostRequest: async (method) => (method === 'visualizeState' ? [state] : null),
    invokeDesktopOperation: async () => null,
  });
  const text = (range) => Buffer.from(range.data, 'base64').toString();
  try {
    const [remote] = await methods.visualizeState([]);
    assert.equal(JSON.stringify(remote).includes(base), false, 'no host path reaches a client');
    const meta = await methods.visualizePaneFile(['s1', 'v1', 0]);
    assert.deepEqual([meta.kind, meta.rel], ['html', 'mockup.html']);
    assert.match(text(await methods.visualizePaneRange(['s1', 'v1', 'mockup.html', 0, 100, 0])), /away/);
    assert.equal(text(await methods.visualizePaneRange(['s1', 'v1', 'style.css', 0, 100, 0])), 'h1{color:teal}');
    // Above the page's own folder (a sibling of it, or cwd) stays unreadable.
    await assert.rejects(methods.visualizePaneRange(['s1', 'v1', '../a.png', 0, 4, 0]), /outside the project/);
    await assert.rejects(
      methods.visualizePaneRange(['s1', 'v1', join(cwd, 'chart.png'), 0, 4, 0]),
      /outside the project/
    );
  } finally {
    cleanup();
  }
});

test('a tab from a host that records no pane root is served under its cwd and gains nothing outside it', async () => {
  const { cwd, outside, cleanup } = workspace();
  const state = {
    sessionId: 's1',
    active: 'v1',
    tabs: [
      {
        id: 'v1',
        label: 'old',
        remoteLabel: 'old',
        revision: 0,
        cwd,
        // Written before panes carried a root: no `root` field at all.
        panes: [pane('html', join(cwd, 'site', 'index.html')), pane('image', join(outside, 'a.png'))],
      },
    ],
  };
  const methods = createRemoteVisualizeMethods({
    mirror: createRemoteVisualizeMirror(),
    hostRequest: async (method) => (method === 'visualizeState' ? [state] : null),
    invokeDesktopOperation: async () => null,
  });
  const text = (range) => Buffer.from(range.data, 'base64').toString();
  try {
    assert.equal((await methods.visualizePaneFile(['s1', 'v1', 0])).rel, 'site/index.html');
    assert.equal(text(await methods.visualizePaneRange(['s1', 'v1', 'site/style.css', 0, 100, 0])), 'h1{}');
    // A root-less pane outside cwd is not served: its root falls back to cwd.
    await assert.rejects(methods.visualizePaneFile(['s1', 'v1', 1]), /outside the project/);
    await assert.rejects(methods.visualizePaneRange(['s1', 'v1', '../outside/a.png', 0, 4, 0]), /outside the project/);
  } finally {
    cleanup();
  }
});

test('visualize pushes reach only the clients reading the lane; web URLs use the browser handoff', (t) => {
  const broadcasts = [];
  let listener;
  const reader = { lanes: new Set([REMOTE_VISUALIZE_LANE]) };
  const other = { lanes: new Set(['terminal']) };
  const push = createRelayPushLanes({
    clients: new Map([
      ['a', reader],
      ['b', other],
    ]),
    subscribeDesktopEvents: (next) => {
      listener = next;
      return () => {};
    },
    broadcastEncrypted: (...args) => broadcasts.push(args),
  });
  t.after(() => push.dispose());
  const state = { sessionId: 's1', tabs: [], active: null };
  listener({ name: VISUALIZE_REMOTE_DESKTOP_EVENT, value: { sessionId: 's1', state, reveal: true } });
  listener({ name: VISUALIZE_REMOTE_DESKTOP_EVENT, value: { sessionId: 's1', openUrl: 'https://a.test/' } });
  assert.equal(broadcasts.length, 2);
  const [visualize, browser] = broadcasts;
  assert.deepEqual(visualize.slice(0, 2), [
    { event: REMOTE_VISUALIZE_CHANGED_EVENT, payload: { sessionId: 's1', state, reveal: true } },
    false,
  ]);
  assert.equal(visualize[2](reader), true);
  assert.equal(visualize[2](other), false);
  assert.deepEqual(browser, [{ event: REMOTE_BROWSER_OPEN_EVENT, payload: { sessionId: 's1', reveal: true } }, false]);
});

test('a remote visualize viewer is a live foreground client whose panel of the session is on screen', () => {
  // The lane is registered and the session delivered, but the panel is closed.
  const subscribed = {
    channel: {},
    background: false,
    lanes: new Set([REMOTE_VISUALIZE_LANE]),
    visibleSessionIds: new Set(['s1']),
  };
  assert.equal(
    clientViewsSessionLane(subscribed, 's1', REMOTE_VISUALIZE_LANE),
    false,
    'lane registration is not viewing'
  );
  const viewer = { ...subscribed, visualizePanelSessionIds: new Set(['s1']) };
  assert.equal(clientViewsSessionLane(viewer, 's1', REMOTE_VISUALIZE_LANE), true);
  assert.equal(clientViewsSessionLane(viewer, 's2', REMOTE_VISUALIZE_LANE), false);
  assert.equal(clientViewsSessionLane({ ...viewer, background: true }, 's1', REMOTE_VISUALIZE_LANE), false);
  assert.equal(clientViewsSessionLane({ ...viewer, channel: null }, 's1', REMOTE_VISUALIZE_LANE), false);
  assert.equal(
    clientViewsSessionLane({ ...viewer, visualizePanelSessionIds: new Set() }, 's1', REMOTE_VISUALIZE_LANE),
    false,
    'its panel closed again'
  );
  // Other lanes keep reading the registration and the delivery set.
  const terminal = { ...subscribed, lanes: new Set(['terminal']) };
  assert.equal(clientViewsSessionLane(terminal, 's1', 'terminal'), true);
  assert.equal(clientViewsSessionLane({ ...terminal, lanes: null }, 's1', 'terminal'), false);
});
