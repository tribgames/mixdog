// The phone page's adapter table as the bundler builds it: vite resolves the `remote-protocol-*.ts` glob in remote-shim-adapters.ts,
// and every file the glob matches must hand the router an adapter (a file without one made createProtocolRouter throw at start).
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
globalThis.window ??= { setTimeout: () => 0, clearTimeout() {}, addEventListener() {}, location: { href: 'http://localhost/' } };

async function bundledTable() {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    root: here,
    build: {
      write: false,
      minify: false,
      lib: { entry: resolve(here, 'remote-shim-adapters.ts'), formats: ['es'], fileName: 'adapters' },
      rollupOptions: { external: [/^node:/] },
    },
  });
  const output = (Array.isArray(result) ? result[0] : result).output.find((chunk) => chunk.type === 'chunk' && chunk.isEntry);
  const dir = mkdtempSync(join(tmpdir(), 'phone-adapters-'));
  try {
    const file = join(dir, 'adapters.mjs');
    writeFileSync(file, output.code);
    return (await import(pathToFileURL(file).href)).bundledPhoneAdapters();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('every file the adapter glob matches yields an adapter', async () => {
  const adapters = await bundledTable();
  const groups = adapters.map((adapter) => adapter?.group);
  assert.ok(adapters.every((adapter) => adapter && typeof adapter.group === 'string'), `adapters: ${JSON.stringify(groups)}`);
  const matched = readdirSync(here).filter(
    (name) => /^remote-protocol-.*\.ts$/.test(name) && name !== 'remote-protocol-queue.ts' && readFileSync(join(here, name), 'utf8').includes('export const adapter'),
  );
  assert.equal(adapters.length, matched.length, 'one adapter per adapter file, none from a helper file');
});

// Names the shim calls that no adapter claims yet: the chat/session group (remote-protocol-chat*.ts hold only factories, not an adapter), push,
// project start, quota resume, visualize and browser-remote. A call to one rejects with UnclaimedNodeMethodError. Claiming one removes it here.
const UNCLAIMED_ON_THIS_LINE = [
  'browserRemoteTabOpen',
  'pushPublicKey',
  'registerPushSubscription',
  'removePushSubscription',
  'startProject',
  'startProjectTask',
  'startTask',
  'browserRemoteStream',
  'browserRemoteStreamAck',
  'browserRemoteControl',
  'markSessionRead',
  'searchSessionContent',
  'renameSession',
  'continueSessionInModel',
  'scheduleQuotaResume',
  'cancelQuotaResume',
  'stopShellJob',
  'releaseShellJob',
  'getQuotaAutoResume',
  'viewerDevice',
  'getTaskWorkspace',
  'readTranscriptItem',
  'setQuotaAutoResume',
  'setSessionArchived',
  'openAgentHome',
  'resetAgentHome',
  'agentRoomAction',
  'setSessionFavorite',
  'setSessionProject',
  'deleteSession',
  'prefetchSession',
  'readTranscriptHistory',
  'getSnapshot',
  'browserReleasePage',
  'submitNewTask',
  'submitToSession',
  'abortSession',
  'resolveToolApprovalForSession',
  'inheritSession',
  'listProviderModels',
  'setModelRoute',
  'setFast',
  'invokeCapability',
  'readCapabilities',
  'visualizeState',
  'visualizePaneInline',
  'visualizeCommand',
  'visualizePanePages',
  'visualizeExport',
  'browserRemoteTabs',
  'browserRemoteTabClose',
  'browserHistorySearch',
  'browserCredentialSuggestions',
  'browserCredentialFill',
  'browserProfileImportSources',
  'browserProfileImportStart',
];

test('the router builds over the bundled table, which holds every request name the shim can call', async () => {
  const { createProtocolRouter } = await import('./remote-shim-protocol.ts');
  const adapters = await bundledTable();
  const ready = Promise.resolve();
  createProtocolRouter(adapters, {
    host: { ctx: {}, client: () => ({}), declareLane() {} },
    started: () => ready,
    synced: () => ready,
    probe() {},
    silentSince: () => false,
  });
  const held = new Set(adapters.flatMap((adapter) => [...Object.keys(adapter.calls ?? {}), ...Object.keys(adapter.fires ?? {})]));
  const api = readFileSync(join(here, 'remote-shim-api.ts'), 'utf8');
  const named = [...api.matchAll(/\b(?:call|fire)(?:<[^()]*?>)?\(\s*'([A-Za-z]+)'/g)].map((match) => match[1]);
  assert.ok(named.length > 100, `the shim names ${named.length} requests`);
  assert.deepEqual([...new Set(named)].filter((name) => !held.has(name)), UNCLAIMED_ON_THIS_LINE);
});


