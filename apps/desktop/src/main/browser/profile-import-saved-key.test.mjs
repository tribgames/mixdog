// The cookie import's use of the saved Chrome key, end to end through the real
// child-process protocol: a stand-in importer (a node preload that answers
// `import-cookies` / `capabilities`) records how it was called and speaks the
// importer's sealed-envelope protocol. Fixture Local State and fake keys only.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url: 'data:text/javascript,export const app={isPackaged:false},safeStorage={isEncryptionAvailable:()=>true,encryptString:(s)=>Buffer.from(s),decryptString:(b)=>b.toString()};export const session={},BrowserWindow={};',
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});
const { BrowserProfileImportService } = await import('./profile-import.ts');
const { APP_BOUND_KEY_FILE } = await import('./profile-import-key.ts');

const BLOB = 'QVBQQgEAAADQjJ3fARXREYx6AMBPwpfr';
const ROTATED_BLOB = 'QVBQQgEAAAAAAAAAAAAAAAAAAAAAAAAA';
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const VALID_KEY = randomBytes(32).toString('base64');

/** The importer's side of the protocol, run by node itself (`--import`) before
 *  it would look for a script named `import-cookies`. */
const FAKE_IMPORTER = String.raw`
import { createCipheriv, randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const command = basename(process.argv[1] || '');
if (command === 'import-cookies' || command === 'capabilities') {
  const dir = process.env.MX_FAKE_IMPORTER_DIR;
  const scenario = JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8'));
  const args = process.argv.slice(2);
  const log = (extra) => appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ command, args, ...extra }) + '\n');
  if (command === 'capabilities') {
    if (scenario.legacy) {
      process.stderr.write('Invalid importer command.\n');
      process.exit(2);
    }
    process.stdout.write('{"savedAppBoundKey":1}');
    process.exit(0);
  }
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const lines = input.split('\n');
  const transportKey = Buffer.from(lines[0].trim(), 'base64');
  const savedKey = args.includes('--v20-key-stdin') ? (lines[1] || '').trim() : '';
  const base = {
    stdinLines: lines.filter(Boolean).length,
    savedKeyGiven: Boolean(savedKey),
    keyLeaked: Boolean(savedKey) && (process.argv.some((value) => value.includes(savedKey)) ||
      Object.values(process.env).some((value) => value.includes(savedKey))),
    elevated: false,
  };
  const fail = (message, extra = {}) => {
    log({ ...base, ...extra, failed: message });
    process.stderr.write(message + '\n');
    process.exit(1);
  };
  const report = {
    version: 2, sourceCount: 1, expired: 0,
    cookies: [{ name: 'SID', value: 'fixture-value', domain: 'example.test', path: '/', secure: true, httpOnly: true, session: true }],
    failures: { decryption: 0, domainMismatch: 0, invalidEncoding: 0, invalidPartition: 0 },
  };
  if (scenario.chromeRunning) fail('Chrome is still running. Close Chrome and try again.');
  let elevated = false;
  if (scenario.legacy) {
    elevated = true;
  } else if (savedKey) {
    if (savedKey !== scenario.validKey) fail('The saved Chrome key was rejected.');
  } else if (scenario.needsV20) {
    if (args.includes('--no-elevation')) fail('A saved Chrome key is required.');
    elevated = true;
    if (args.includes('--return-v20-key')) report.appBoundKey = { key: scenario.validKey, blobSha256: scenario.blobSha256 };
  }
  log({ ...base, elevated });
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', transportKey, nonce);
  const body = Buffer.concat([cipher.update(JSON.stringify(report)), cipher.final()]);
  process.stdout.write(JSON.stringify({
    version: 1,
    nonce: nonce.toString('base64'),
    ciphertext: Buffer.concat([body, cipher.getAuthTag()]).toString('base64'),
  }));
  process.exit(0);
}
`;

const isWindows = process.platform === 'win32';
const root = mkdtempSync(join(tmpdir(), 'mixdog-saved-key-'));
test.after(() => rmSync(root, { recursive: true, force: true }));
const preload = join(root, 'fake-importer.mjs');
writeFileSync(preload, FAKE_IMPORTER);
const executable = process.execPath;
const executableSha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --import=${pathToFileURL(preload).href}`.trim();
process.env.MX_FAKE_IMPORTER_DIR = join(root, 'importer');
mkdirSync(process.env.MX_FAKE_IMPORTER_DIR);
test.after(() => {
  delete process.env.MX_FAKE_IMPORTER_DIR;
});

function fakeEncryption(available = true) {
  const scramble = (bytes) => Buffer.from(bytes.map((byte) => byte ^ 0x5a).reverse());
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text) => scramble(Buffer.from(text, 'utf8')),
    decryptString: (sealed) => scramble(sealed).toString('utf8'),
  };
}

let sequence = 0;
/** A fresh Chrome profile fixture, Mixdog data directory and service. */
function world(t, { scenario = {}, encryption = fakeEncryption() } = {}) {
  sequence += 1;
  const dir = join(root, `world-${sequence}`);
  const chrome = join(dir, 'chrome');
  const data = join(dir, 'data');
  mkdirSync(join(chrome, 'Default'), { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(join(dir, 'chrome.exe'), '');
  const writeLocalState = (blob) =>
    writeFileSync(
      join(chrome, 'Local State'),
      JSON.stringify({ profile: { info_cache: { Default: { name: 'Fixture' } } }, os_crypt: { app_bound_encrypted_key: blob } })
    );
  writeLocalState(BLOB);
  const callsFile = join(process.env.MX_FAKE_IMPORTER_DIR, 'calls.jsonl');
  rmSync(callsFile, { force: true });
  const setScenario = (next) =>
    writeFileSync(
      join(process.env.MX_FAKE_IMPORTER_DIR, 'scenario.json'),
      JSON.stringify({ needsV20: true, validKey: VALID_KEY, blobSha256: sha256(BLOB), ...next })
    );
  setScenario(scenario);
  const set = [];
  const jar = {
    supportsPartitions: false,
    get: async () => [],
    set: async (details) => {
      set.push(details.name);
    },
    remove: async () => {},
    flushStore: async () => {},
  };
  const service = new BrowserProfileImportService({
    userDataDirectory: data,
    temporaryDirectory: dir,
    partition: {},
    cookieJar: jar,
    chromeUserDataDirectory: chrome,
    chromeExecutablePath: join(dir, 'chrome.exe'),
    nativeImporterOverride: { executable, sha256: executableSha256 },
    keyEncryption: encryption,
    prepareChromeForImport: async () => {},
  });
  return {
    service,
    data,
    set,
    writeLocalState,
    setScenario: (next) => setScenario({ ...scenario, ...next }),
    keyFile: join(data, APP_BOUND_KEY_FILE),
    calls: () =>
      existsSync(callsFile)
        ? readFileSync(callsFile, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
            .filter((call) => call.command === 'import-cookies')
        : [],
    manual: () =>
      service.importProfile(
        { jobId: `job${sequence}${Date.now()}`, sourceId: 'chrome', profileId: 'Default', items: ['cookies'], administratorApproved: true },
        () => {}
      ),
  };
}

const flagsOf = (call) => call.args.filter((arg) => arg.startsWith('--') && !['--browser', '--profile', '--json'].includes(arg));
const elevations = (calls) => calls.filter((call) => call.elevated).length;

test('a manual import elevates once, keeps the key encrypted, and the next one needs no elevation', { skip: !isWindows }, async (t) => {
  const w = world(t);
  const first = await w.manual();
  assert.deepEqual(first.errors, {});
  assert.equal(first.counts.cookies, 1);
  assert.deepEqual(flagsOf(w.calls()[0]), ['--return-v20-key'], 'the first import may elevate and asks for the key back');
  assert.equal(elevations(w.calls()), 1);
  assert.equal(readFileSync(w.keyFile).includes(VALID_KEY), false, 'the key is encrypted at rest');
  assert.deepEqual(await w.service.savedKeyStatus(), { available: true, saved: true });

  const second = await w.manual();
  assert.deepEqual(second.errors, {});
  const [, reused] = w.calls();
  assert.deepEqual(flagsOf(reused), ['--v20-key-stdin', '--no-elevation']);
  assert.equal(reused.savedKeyGiven, true, 'the key reached the importer over stdin');
  assert.equal(reused.keyLeaked, false, 'and never through arguments or the environment');
  assert.equal(elevations(w.calls()), 1, 'still one elevation in total');
});

test('an automatic import with the saved key imports without ever allowing elevation', { skip: !isWindows }, async (t) => {
  const w = world(t);
  await w.manual();
  const outcome = await w.service.runAutomaticCookieImport('Default');
  assert.deepEqual(outcome, { state: 'imported', count: 1 });
  const automatic = w.calls().at(-1);
  assert.deepEqual(flagsOf(automatic), ['--v20-key-stdin', '--no-elevation']);
  assert.equal(elevations(w.calls()), 1);
  const state = await w.service.cookieAutoImportState.read();
  assert.equal(state.lastCount, 1);
  assert.equal(typeof state.lastImportAt, 'number');
  assert.equal(state.needsManualImport, undefined);
});

test('an automatic import with no saved key never elevates and records that one manual import is needed', { skip: !isWindows }, async (t) => {
  const w = world(t);
  const outcome = await w.service.runAutomaticCookieImport('Default');
  assert.deepEqual(outcome, { state: 'needs-manual-import' });
  const [call] = w.calls();
  assert.deepEqual(flagsOf(call), ['--no-elevation']);
  assert.equal(call.elevated, false);
  assert.equal((await w.service.cookieAutoImportState.read()).needsManualImport, true);
  assert.equal(w.set.length, 0, 'nothing was imported');
  // The manual import the user then does saves the key and clears the flag.
  await w.manual();
  assert.equal((await w.service.cookieAutoImportState.read()).needsManualImport, undefined);
  assert.deepEqual(await w.service.runAutomaticCookieImport('Default'), { state: 'imported', count: 1 });
});

test('a profile with nothing App-Bound imports automatically with no key at all', { skip: !isWindows }, async (t) => {
  const w = world(t, { scenario: { needsV20: false } });
  assert.deepEqual(await w.service.runAutomaticCookieImport('Default'), { state: 'imported', count: 1 });
  assert.equal(existsSync(w.keyFile), false);
});

test('when Chrome rotates its key the saved one is discarded: automatic stops, manual elevates once and re-saves', { skip: !isWindows }, async (t) => {
  const w = world(t);
  await w.manual();
  assert.equal(existsSync(w.keyFile), true);
  w.writeLocalState(ROTATED_BLOB);
  assert.deepEqual(await w.service.savedKeyStatus(), { available: true, saved: false });
  assert.equal(existsSync(w.keyFile), false, 'the stale key is gone');

  const before = w.calls().length;
  assert.deepEqual(await w.service.runAutomaticCookieImport('Default'), { state: 'needs-manual-import' });
  const automatic = w.calls().slice(before);
  assert.equal(automatic.length, 1);
  assert.deepEqual(flagsOf(automatic[0]), ['--no-elevation'], 'the old key is not sent');
  assert.equal(elevations(w.calls()), 1, 'no prompt for the automatic run');

  w.setScenario({ blobSha256: sha256(ROTATED_BLOB) });
  await w.manual();
  assert.equal(elevations(w.calls()), 2, 'the manual import is the one prompt');
  assert.deepEqual(await w.service.savedKeyStatus(), { available: true, saved: true });
  assert.deepEqual(await w.service.runAutomaticCookieImport('Default'), { state: 'imported', count: 1 });
  assert.equal(elevations(w.calls()), 2);
});

test('a saved key the importer rejects is discarded: automatic stops, manual falls back to one elevation', { skip: !isWindows }, async (t) => {
  const w = world(t);
  await w.manual();
  // Same blob, but the importer no longer accepts the saved key.
  const rotatedKey = randomBytes(32).toString('base64');
  w.setScenario({ validKey: rotatedKey });

  const before = w.calls().length;
  assert.deepEqual(await w.service.runAutomaticCookieImport('Default'), { state: 'needs-manual-import' });
  const automatic = w.calls().slice(before);
  assert.equal(automatic.length, 1);
  assert.deepEqual(flagsOf(automatic[0]), ['--v20-key-stdin', '--no-elevation']);
  assert.equal(elevations(w.calls()), 1, 'rejection never prompts');
  assert.equal(existsSync(w.keyFile), false);
  assert.equal((await w.service.cookieAutoImportState.read()).needsManualImport, true);

  // Reinstate a key that will be rejected, then import by hand.
  w.setScenario({ validKey: VALID_KEY });
  await w.manual();
  w.setScenario({ validKey: rotatedKey });
  const beforeManual = w.calls().length;
  const manual = await w.manual();
  assert.deepEqual(manual.errors, {});
  const manualCalls = w.calls().slice(beforeManual);
  assert.deepEqual(manualCalls.map(flagsOf), [['--v20-key-stdin', '--no-elevation'], ['--return-v20-key']]);
  assert.equal(elevations(manualCalls), 1, 'a single prompt after the saved key failed');
  assert.deepEqual(await w.service.savedKeyStatus(), { available: true, saved: true });
});

test('without OS encryption nothing is stored, the importer is not asked for the key, and automatic import cannot run', { skip: !isWindows }, async (t) => {
  const w = world(t, { encryption: fakeEncryption(false) });
  // The backup of the cookie jar needs OS encryption too, so only the importer side is observed.
  await w.manual();
  assert.deepEqual(flagsOf(w.calls()[0]), []);
  assert.equal(readdirSync(w.data).includes(APP_BOUND_KEY_FILE), false);
  assert.deepEqual(await w.service.savedKeyStatus(), { available: false, saved: false });
  assert.deepEqual(await w.service.runAutomaticCookieImport('Default'), { state: 'needs-manual-import' });
  assert.equal(elevations(w.calls()), 1);
});

test('an automatic run while Chrome holds the database is skipped quietly', { skip: !isWindows }, async (t) => {
  const w = world(t, { scenario: { chromeRunning: true } });
  assert.deepEqual(await w.service.runAutomaticCookieImport('Default'), { state: 'skipped', reason: 'chrome-running' });
  assert.deepEqual(await w.service.cookieAutoImportState.read(), {});
});

test('a failed automatic import is recorded without secrets and does not claim "needs a manual import"', { skip: !isWindows }, async (t) => {
  const w = world(t, { scenario: { needsV20: false } });
  const outcome = await w.service.runAutomaticCookieImport('Gone');
  assert.equal(outcome.state, 'failed');
  assert.match(outcome.error, /no longer available/);
  const state = await w.service.cookieAutoImportState.read();
  assert.equal(state.lastError, outcome.error);
  assert.equal(state.needsManualImport, undefined);
  assert.equal(w.calls().length, 0, 'the importer is not run for an unknown profile');
});

test('an automatic run is skipped while a manual import is in progress', { skip: !isWindows }, async (t) => {
  const w = world(t);
  const running = w.manual();
  assert.deepEqual(await w.service.runAutomaticCookieImport('Default'), { state: 'skipped', reason: 'busy' });
  await running;
});

test('an importer built before key reuse keeps the old behaviour for manual imports and cannot run unattended', { skip: !isWindows }, async (t) => {
  const w = world(t, { scenario: { legacy: true } });
  const manual = await w.manual();
  assert.deepEqual(manual.errors, {});
  assert.deepEqual(flagsOf(w.calls()[0]), [], 'the exact old command line');
  assert.equal(existsSync(w.keyFile), false);
  const outcome = await w.service.runAutomaticCookieImport('Default');
  assert.equal(outcome.state, 'failed');
  assert.match(outcome.error, /cannot reuse a saved key/);
  assert.equal(w.calls().length, 1, 'no unattended run of an importer that always elevates');
});

test('a capabilities probe that cannot run is not remembered as "unsupported"', { skip: !isWindows }, async (t) => {
  const w = world(t);
  const importer = { executable: join(root, 'does-not-exist.exe'), sha256: executableSha256 };
  w.service.options.nativeImporterOverride = importer;
  const failed = await w.manual();
  assert.ok(failed.errors.cookies, 'the import fails instead of silently elevating without the key logic');
  assert.equal(w.calls().length, 0);
  // The same binary identity now starts: it is probed again and key reuse works.
  importer.executable = executable;
  const ok = await w.manual();
  assert.deepEqual(ok.errors, {});
  assert.deepEqual(flagsOf(w.calls()[0]), ['--return-v20-key'], 'not the legacy command line');
  assert.deepEqual(await w.service.savedKeyStatus(), { available: true, saved: true });
});

test('automatic runs keep only the latest recovery snapshots of the cookie jar', { skip: !isWindows }, async (t) => {
  const w = world(t, { scenario: { needsV20: false } });
  for (let run = 0; run < 6; run += 1) await w.service.runAutomaticCookieImport('Default');
  await w.manual();
  const backups = readdirSync(join(w.data, 'browser-import-backups'));
  assert.equal(backups.filter((name) => name.startsWith('cookies-auto-')).length, 3);
  assert.equal(backups.filter((name) => /^cookies-\d/.test(name)).length, 1, 'a manual import snapshot is never pruned');
});

test('clearing imported data also forgets the saved key and the import record', { skip: !isWindows }, async (t) => {
  const w = world(t);
  await w.manual();
  assert.equal(existsSync(w.keyFile), true);
  await w.service.clearImportedData();
  assert.equal(existsSync(w.keyFile), false);
  assert.deepEqual(await w.service.cookieAutoImportState.read(), {});
});

test('forgetting the saved key removes it and the next import elevates again', { skip: !isWindows }, async (t) => {
  const w = world(t);
  await w.manual();
  await w.service.forgetSavedKey();
  assert.deepEqual(await w.service.savedKeyStatus(), { available: true, saved: false });
  await w.manual();
  assert.equal(elevations(w.calls()), 2);
});
