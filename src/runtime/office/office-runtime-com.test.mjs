import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertOfficeOperationContracts, describeOfficeCapabilities } from './capabilities.mjs';
import { _stopMicrosoftOfficeSessionClients } from './com/com-adapter.mjs';
import { acceptSessionIdentity } from './com/office-session-client.mjs';
import { physicalAsarPath } from './shared/asar-path.mjs';

process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';

test('persistent Office validation inspects the open document with bounded Excel busy retries', async () => {
  const source = await readFile(new URL('./com/office-com-session-host.ps1', import.meta.url), 'utf8');
  const start = source.indexOf("'validate' {");
  const end = source.indexOf("'checkpoint' {", start);
  const validation = source.slice(start, end);
  assert.match(validation, /Snapshot-SessionDocument \$document/);
  assert.match(validation, /Issues-SessionDocument \$document/);
  assert.match(source, /Invoke-ExcelComRetry[\s\S]+Excel session snapshot/);
  assert.match(source, /Invoke-ExcelComRetry[\s\S]+Excel session issue inspection/);
  assert.match(source, /\$app\.Presentations\.Add\(\$visible\)/);
  assert.doesNotMatch(validation, /Validate-NativeDocument/);
});

test('Office COM host resolves to the physical ASAR sidecar for external PowerShell', () => {
  const packaged = 'C:\\Program Files\\Mixdog\\resources\\runtime.asar\\node_modules\\mixdog\\src\\runtime\\office\\com\\office-com-host.ps1';
  assert.equal(
    physicalAsarPath(packaged),
    'C:\\Program Files\\Mixdog\\resources\\runtime.asar.unpacked\\node_modules\\mixdog\\src\\runtime\\office\\com\\office-com-host.ps1',
  );
  const development = 'C:\\Project\\mixdog\\src\\runtime\\office\\com\\office-com-host.ps1';
  assert.equal(physicalAsarPath(development), development);
});

test('Office process exit requests EOF cleanup without force-closing owned or attached applications', () => {
  const killedApplications = [];
  const failures = [];
  const makeClient = (sessionId, ownership, appPid) => {
    const timer = setTimeout(() => {}, 60_000);
    const state = { hostKills: 0, stdinEnds: 0, readlineCloses: 0 };
    return {
      client: {
        sessionId,
        ownership,
        appPid,
        closed: false,
        pending: new Map([['request', {
          timer,
          resolve: (failure) => failures.push(failure),
        }]]),
        readline: { close: () => { state.readlineCloses += 1; } },
        child: {
          stdin: { end: () => { state.stdinEnds += 1; } },
          kill: () => { state.hostKills += 1; },
        },
      },
      state,
    };
  };
  const owned = makeClient('owned', 'owned', 101);
  const attached = makeClient('attached', 'attached', 202);
  const clients = new Map([
    [owned.client.sessionId, owned.client],
    [attached.client.sessionId, attached.client],
  ]);

  _stopMicrosoftOfficeSessionClients(clients, 'process exit', {
    killProcess: (pid) => killedApplications.push(pid),
  });

  assert.equal(clients.size, 0);
  assert.deepEqual(killedApplications, []);
  assert.deepEqual(owned.state, { hostKills: 0, stdinEnds: 1, readlineCloses: 0 });
  assert.deepEqual(attached.state, { hostKills: 0, stdinEnds: 1, readlineCloses: 0 });
  assert.equal(failures.length, 2);
  assert.ok(failures.every((failure) => failure.error === 'process exit'));
});

test('Office cleanup follows process replacements without acquiring attached applications', () => {
  for (const ownership of ['owned', 'attached']) {
    for (const ok of [true, false]) {
      const client = { sessionId: 'reopened', ownership, appPid: 101, pending: new Map() };
      const clients = new Map([[client.sessionId, client]]);
      const killed = [];
      // Even a response that fails after reopening must move cleanup to the new process.
      acceptSessionIdentity(client, { session: client.sessionId, ok, appPid: 202, ownership: 'owned' });
      _stopMicrosoftOfficeSessionClients(clients, 'cancelled', { killProcess: (pid) => killed.push(pid) });
      assert.equal(client.appPid, 202);
      assert.deepEqual(killed, []);
    }
  }
});

test('Office cleanup ignores unrelated or malformed identities and forgets retired PIDs', () => {
  const client = { sessionId: 'owner', ownership: 'owned', appPid: 101, pending: new Map() };
  for (const message of [
    { session: 'other', appPid: 202 },
    { session: 'owner' },
    { session: 'owner', appPid: null },
    { session: 'owner', appPid: -1 },
    { session: 'owner', appPid: '202' },
  ]) {
    acceptSessionIdentity(client, message);
    assert.equal(client.appPid, 101);
  }
  acceptSessionIdentity(client, { session: 'owner', appPid: 0 });
  const killed = [];
  _stopMicrosoftOfficeSessionClients(new Map([['owner', client]]), 'exit', { killProcess: (pid) => killed.push(pid) });
  assert.deepEqual(killed, []);
});

test('operation registry matches every COM implementation and rejects unknown fields before dispatch', async () => {
  const source = await readFile(new URL('./com/office-com-host.ps1', import.meta.url), 'utf8');
  const sections = [
    ['docx', 'function Apply-WordOperation', 'function Excel-Sheet'],
    ['xlsx', 'function Apply-ExcelOperation', 'function Ppt-Slide'],
    ['pptx', 'function Apply-PowerPointOperation', 'function Apply-Operations'],
  ];
  for (const [format, startMarker, endMarker] of sections) {
    const start = source.indexOf(startMarker);
    const block = source.slice(start, source.indexOf(endMarker, start + startMarker.length));
    const implemented = [...block.matchAll(/^\s{4}'([a-z][a-z0-9_]*)'\s*\{/gm)]
      .map((match) => match[1])
      .sort();
    const described = describeOfficeCapabilities({
      format,
      backend: 'microsoft-office-com',
    }).operations.sort();
    const native = described.filter((operation) => !describeOfficeCapabilities({
      format,
      backend: 'microsoft-office-com',
      operation,
    }).operation.virtual);
    assert.deepEqual(native, implemented, `${format} registry drifted from the COM backend`);
    for (const operation of described) {
      const targeted = describeOfficeCapabilities({
        format,
        backend: 'microsoft-office-com',
        operation,
      }).operation;
      assert.equal(targeted.input.required[0], 'op');
      assert.ok(targeted.supportedBackends.includes('microsoft-office-com'));
    }
  }
  assert.throws(
    () => assertOfficeOperationContracts({
      format: 'pdf',
      backend: 'mixdog-pdf',
      operations: [{ op: 'compress', alowNoChange: true }],
    }),
    /unknown field\(s\): alowNoChange.*alowNoChange→allowNoChange/,
  );
});
