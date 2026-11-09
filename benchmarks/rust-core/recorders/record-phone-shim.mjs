#!/usr/bin/env node
// What Node's phone page (b6f10295a) did with the file-download and one-file-grant calls, recorded from an exact export: the page's own
// remote surface (`createRemoteApi`, remote-shim-api.ts) over its own relay connection (the shim test harness, remote-shim-test-harness.mjs)
// with a scripted host. The inputs (what the host advertised and answered) are listed here and kept in the recording; per scenario the
// recording holds what the page observed: availability, the refusal reason the UI shows, the params each call put on the wire, and the
// answer or error the caller got. The ported tests (remote-shim-file-downloads / remote-shim-file-grant) replay the same inputs over the
// protocol router and compare everything observed.
//
//   node --import apps/desktop/scripts/test-env.mjs --import apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-phone-shim.mjs --tree <git archive of b6f10295a with node_modules>
import { join } from 'node:path';
import { commitStage, exactProductIdentity, importFrom, parseArgs, REPO_ROOT, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const FIXTURES = join(REPO_ROOT, 'apps', 'mobile', 'fixtures', 'phone-shim');
const tree = resolveTree(parseArgs());

const { fileDownloadErrorReason } = await importFrom(tree, 'apps/desktop/src/shared/file-downloads.ts');
const { createRemoteApi } = await importFrom(tree, 'apps/desktop/src/renderer/remote-shim-api.ts');
const { publishedCeilings, withShim } = await importFrom(tree, 'apps/desktop/src/renderer/remote-shim-test-harness.mjs');

const nextCall = async (leg, method) => {
  let frame = await leg.nextPayload();
  while (frame.method !== method) frame = await leg.nextPayload();
  return frame;
};
const redial = (shim, flags) => {
  shim.ctx.connectionReady = false;
  shim.ctx.socket = null;
  shim.ctx.openPromise = null;
  return shim.dial({ remoteParity: true, ...flags, ready: publishedCeilings(4096, 4096) });
};
const open = async (run) =>
  withShim({}, async (shim) => {
    shim.ctx.updaterListeners = new Set();
    shim.ctx.settingsChangedListeners = new Set();
    return run(shim, createRemoteApi(shim.ctx));
  });

const downloadsInput = {
  request: { source: { kind: 'project', sessionId: 's1', relPath: 'out/report.pdf' }, purpose: 'save' },
  authorizeRefusal: { error: 'No reply in this conversation links that file.', errorCode: 'file-download:not-linked' },
  range: { args: ['t', 8, 16, 'v'], value: { length: 0 } },
};

async function downloads(input) {
  return open(async (shim, api) => {
    const seen = {};
    const leg = await shim.dial({ remoteParity: true, ready: publishedCeilings(4096, 4096) });
    const sentBefore = leg.ws.sent.length;
    seen.availableBeforeAdvertisement = api.fileDownloads.available();
    seen.reasonBeforeAdvertisement = fileDownloadErrorReason(await api.fileDownloads.authorize(input.request).catch((error) => error));
    seen.sentBeforeAdvertisement = leg.ws.sent.length - sentBefore;

    const current = await redial(shim, { fileDownloads: true });
    seen.availableAfterAdvertisement = api.fileDownloads.available();
    const pending = api.fileDownloads.authorize(input.request).catch((error) => error);
    const frame = await nextCall(current, 'fileDownloadAuthorize');
    seen.authorizeParams = frame.params;
    await current.deliver({ id: frame.id, ok: false, ...input.authorizeRefusal });
    seen.reasonAfterRefusal = fileDownloadErrorReason(await pending);

    const range = api.fileDownloads.readRange(...input.range.args);
    const rangeFrame = await nextCall(current, 'fileDownloadRange');
    seen.rangeParams = rangeFrame.params;
    await current.deliver({ id: rangeFrame.id, ok: true, value: input.range.value });
    seen.rangeResult = await range;

    await redial(shim, {});
    seen.availableAfterOlderHost = api.fileDownloads.available();
    return seen;
  });
}

const resolveInput = { paths: ['/x/a.pdf'], sessionId: 's1' };

async function resolveLocalPaths(input) {
  return open(async (shim, api) => {
    const seen = {};
    const leg = await shim.dial({ remoteParity: true, fileDownloads: true, ready: publishedCeilings(4096, 4096) });
    const named = api.resolveLocalPaths(input.paths, input.sessionId);
    const namedFrame = await nextCall(leg, 'resolveLocalPaths');
    seen.namedParams = namedFrame.params;
    await leg.deliver({ id: namedFrame.id, ok: true, value: [] });
    await named;
    const plain = api.resolveLocalPaths(input.paths);
    const plainFrame = await nextCall(leg, 'resolveLocalPaths');
    seen.plainParams = plainFrame.params;
    await leg.deliver({ id: plainFrame.id, ok: true, value: [] });
    await plain;
    return seen;
  });
}

const FILE = 'C:/outside/report.txt';
const grantInput = {
  read: ['C:/outside', 'report.txt', 'held'],
  regrant: [{ absolutePath: FILE, projectPath: 'C:/outside', relPath: 'report.txt', accessToken: 'fresh' }],
  retryValue: { content: 'linked report' },
  refusals: [
    { error: 'That link has lapsed.', errorCode: 'SELECTED_FILE_GRANT_UNAVAILABLE' },
    { error: 'The selected-file permission is unavailable.', errorCode: 'EACCES' },
  ],
};

async function grant(input, refusal) {
  return open(async (shim, api) => {
    const leg = await shim.dial({ remoteParity: true, ready: publishedCeilings(4096, 4096) });
    const pending = api.readProjectFile(...input.read).catch((error) => error);
    const first = await nextCall(leg, 'readProjectFile');
    await leg.deliver({ id: first.id, ok: false, ...refusal });
    const next = await Promise.race([nextCall(leg, 'resolveLocalPaths'), pending.then(() => null)]);
    if (!next) {
      const result = await pending;
      return { resolveParams: null, retryParams: null, result: { content: result.content ?? null, code: result.code ?? null } };
    }
    await leg.deliver({ id: next.id, ok: true, value: input.regrant });
    const retry = await nextCall(leg, 'readProjectFile');
    await leg.deliver({ id: retry.id, ok: true, value: input.retryValue });
    const result = await pending;
    return { resolveParams: next.params, retryParams: retry.params.slice(0, 3), result: { content: result.content ?? null, code: result.code ?? null } };
  });
}

const golden = {
  note: 'Node phone page: the file-download calls and the one-file-grant refresh over the page\'s own relay connection; inputs and what the page observed.',
  downloads: { input: downloadsInput, observed: await downloads(downloadsInput) },
  resolveLocalPaths: { input: resolveInput, observed: await resolveLocalPaths(resolveInput) },
  grant: { input: grantInput, observed: [] },
};
for (const refusal of grantInput.refusals) golden.grant.observed.push({ refusal, observed: await grant(grantInput, refusal) });

const out = stageSet(FIXTURES);
writeJson(join(out, 'golden.json'), golden);
writeSetManifest(out, {
  set: 'phone-shim',
  recorder: 'benchmarks/rust-core/recorders/record-phone-shim.mjs',
  command: `node benchmarks/rust-core/recorders/record-phone-shim.mjs --tree <git archive of ${REF} (src, apps) with node_modules>`,
  identity: exactProductIdentity(tree, REF),
  extra: { scenarios: 4 },
});
commitStage(out, FIXTURES);
console.log(JSON.stringify(golden.downloads.observed), JSON.stringify(golden.resolveLocalPaths.observed), JSON.stringify(golden.grant.observed.map((g) => g.observed)));
process.exit(0);
