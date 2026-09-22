import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { app, safeStorage, session } from 'electron';

import { BrowserProfileImportService, prepareChromeForImport, type BrowserImportProgress } from './profile-import';
import { verifyCookieImport } from './profile-import-cookies.integration';
import { verifyPartitionedCookieImport } from './cookie-jar.integration';

const execFileAsync = promisify(execFile);
process.stdout.write('browser profile import integration loaded\n');
const configuredRoot = String(process.env.MIXDOG_BROWSER_PROFILE_IMPORT_TEST_ROOT || '');
const root = configuredRoot || (await mkdtemp(join(tmpdir(), 'mixdog-browser-profile-import-')));
await mkdir(root, { recursive: true });
app.setPath('userData', join(root, 'electron-user-data'));
app.disableHardwareAcceleration();

/** Every directory this integration reads or writes: a stand-in Chrome profile
 *  on one side, the Mixdog data directory the import fills on the other. */
interface ImportFixture {
  sourceUserData: string;
  sourceProfile: string;
  destinationUserData: string;
  temporaryDirectory: string;
  chromeExecutable: string;
}

/** Windows: an import closes the running browser before reading its profile.
 *  A WinForms process stands in for Chrome so no real browser is killed. */
async function verifyRunningBrowserIsClosed(root: string): Promise<void> {
  const closeFixture = join(root, 'mxclosefixture.exe');
  const closeFixtureSource = join(root, 'mxclosefixture.cs');
  const compiler = join(
    String(process.env.SystemRoot || 'C:\\Windows'),
    'Microsoft.NET',
    'Framework64',
    'v4.0.30319',
    'csc.exe'
  );
  await writeFile(
    closeFixtureSource,
    `
using System;
using System.Windows.Forms;
public static class MixdogBrowserCloseFixture {
  [STAThread]
  public static void Main() {
    Application.EnableVisualStyles();
    Application.Run(new Form { Text = "Mixdog browser close fixture", Width = 320, Height = 180 });
  }
}
`
  );
  await execFileAsync(
    compiler,
    ['/nologo', '/target:winexe', `/out:${closeFixture}`, '/reference:System.Windows.Forms.dll', closeFixtureSource],
    {
      windowsHide: true,
      timeout: 20_000,
    }
  );
  const fixtureProcess = spawn(closeFixture, [], {
    windowsHide: false,
    stdio: 'ignore',
  });
  try {
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      fixtureProcess.once('spawn', resolveSpawn);
      fixtureProcess.once('error', rejectSpawn);
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 800));
    await prepareChromeForImport({
      imageName: 'mxclosefixture.exe',
      timeoutMs: 8_000,
    });
    assert.notEqual(fixtureProcess.exitCode, null);
  } finally {
    if (fixtureProcess.exitCode === null) fixtureProcess.kill();
  }
}

/** The Chrome-side fixture an import reads: profile metadata (including an
 *  unsafe profile name) and a History database with one visible page. */
async function seedChromeProfile(fixture: ImportFixture): Promise<void> {
  await writeFile(
    join(fixture.sourceUserData, 'Local State'),
    JSON.stringify({
      profile: {
        info_cache: {
          Default: {
            name: '재영',
            user_name: 'owner@example.test',
          },
          '../escape': {
            name: 'Unsafe',
          },
        },
      },
    })
  );

  const history = new DatabaseSync(join(fixture.sourceProfile, 'History'));
  history.exec(`
    CREATE TABLE urls (
      id INTEGER PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      visit_count INTEGER NOT NULL,
      last_visit_time INTEGER NOT NULL,
      hidden INTEGER NOT NULL DEFAULT 0
    );
  `);
  history
    .prepare(`
    INSERT INTO urls (url, title, visit_count, last_visit_time, hidden)
    VALUES (?, ?, ?, ?, ?)
  `)
    .run('https://accounts.example.test/dashboard', 'Account dashboard', 7, 13_400_000_000_000_000n, 0);
  history
    .prepare(`
    INSERT INTO urls (url, title, visit_count, last_visit_time, hidden)
    VALUES (?, ?, ?, ?, ?)
  `)
    .run('chrome://settings/', 'Settings', 1, 13_400_000_000_000_001n, 0);
  history.close();
}

/** The service under test, plus the cookie sink and the preparation counter
 *  the assertions read back. */
function createImportService(
  fixture: ImportFixture,
  partition: Electron.Session
): { service: BrowserProfileImportService; importedCookies: unknown[]; preparationCalls: () => number } {
  const importedCookies: unknown[] = [];
  let chromePreparationCalls = 0;
  const service = new BrowserProfileImportService({
    userDataDirectory: fixture.destinationUserData,
    temporaryDirectory: fixture.temporaryDirectory,
    partition: {
      ...partition,
      cookies: {
        ...partition.cookies,
        get: partition.cookies.get.bind(partition.cookies),
        flushStore: partition.cookies.flushStore.bind(partition.cookies),
        set: async (cookie: unknown) => {
          importedCookies.push(cookie);
        },
      },
      flushStorageData: async () => undefined,
    } as unknown as Electron.Session,
    chromeExecutablePath: fixture.chromeExecutable,
    chromeUserDataDirectory: fixture.sourceUserData,
    prepareChromeForImport: async () => {
      chromePreparationCalls += 1;
    },
    readNativeCredentials: async (profileId) => {
      assert.equal(profileId, 'Default');
      return [
        {
          url: 'https://accounts.example.test/',
          username: 'fixture-user',
          password: 'fixture-password',
          note: '',
        },
      ];
    },
    readNativeCookies: async (profileId) => {
      assert.equal(profileId, 'Default');
      return {
        version: 2,
        sourceCount: 1,
        expired: 0,
        failures: { decryption: 0, domainMismatch: 0, invalidEncoding: 0, invalidPartition: 0 },
        cookies: [
          {
            name: 'session',
            value: 'secret-cookie-value',
            domain: '.example.test',
            path: '/',
            secure: true,
            httpOnly: true,
            session: true,
            sameSite: 'Lax',
          },
        ],
      };
    },
  });
  return { service, importedCookies, preparationCalls: () => chromePreparationCalls };
}

/** Discovery: one Chrome source, only safe profile ids, and per-item support
 *  that follows what the native importer can actually read. */
async function verifyDiscoveredSources(
  service: BrowserProfileImportService,
  fixture: ImportFixture,
  partition: Electron.Session
): Promise<void> {
  const sources = await service.sources();
  assert.equal(sources.length, 1);
  assert.deepEqual(
    sources[0].profiles.map((profile) => profile.id),
    ['Default']
  );
  assert.equal(sources[0].profiles[0].accountEmail, 'owner@example.test');
  assert.equal(sources[0].supports.cookies, true);
  assert.equal(sources[0].supports.history, true);
  assert.equal(sources[0].supports.passwords, true);
  assert.equal(sources[0].passwordSupportReason, undefined);

  const passwordOnlyService = new BrowserProfileImportService({
    userDataDirectory: fixture.destinationUserData,
    temporaryDirectory: fixture.temporaryDirectory,
    partition,
    chromeExecutablePath: fixture.chromeExecutable,
    chromeUserDataDirectory: fixture.sourceUserData,
    readNativeCredentials: async () => [],
  });
  const passwordOnlySources = await passwordOnlyService.sources();
  assert.equal(passwordOnlySources[0].supports.passwords, true);
  assert.equal(passwordOnlySources[0].supports.cookies, false);
  assert.match(passwordOnlySources[0].supportReasons?.cookies || '', /native cookie importer is not installed/);
}

/** Passwords never leave the source profile without explicit administrator
 *  approval, and a denied import must not even close the browser. */
async function verifyApprovalIsRequired(
  service: BrowserProfileImportService,
  preparationCalls: () => number
): Promise<void> {
  await assert.rejects(
    service.importProfile(
      {
        jobId: 'fixturedenied1234',
        sourceId: 'chrome',
        profileId: 'Default',
        items: ['passwords'],
        administratorApproved: false,
      },
      () => undefined
    ),
    /explicit administrator approval/i
  );
  assert.equal(preparationCalls(), 0);
}

/** The approved import: per-item counts, ordered progress, a vault the user can
 *  decrypt, and no secret anywhere in the progress or result payloads. */
async function verifyFullImport(
  service: BrowserProfileImportService,
  fixture: ImportFixture,
  preparationCalls: () => number
): Promise<void> {
  const progress: BrowserImportProgress[] = [];
  const result = await service.importProfile(
    {
      jobId: 'fixturejob1234',
      sourceId: 'chrome',
      profileId: 'Default',
      items: ['passwords', 'cookies', 'history'],
      administratorApproved: true,
    },
    (update) => progress.push(update)
  );

  assert.equal(result.counts.passwords, 1, JSON.stringify(result));
  assert.equal(result.counts.history, 1, JSON.stringify(result));
  assert.equal(result.counts.cookies, 1, JSON.stringify(result));
  assert.deepEqual(result.errors, {});
  assert.deepEqual(
    progress.slice(0, 3).map((entry) => [entry.item, entry.state, entry.count]),
    [
      ['passwords', 'running', undefined],
      ['cookies', 'running', undefined],
      ['history', 'running', undefined],
    ]
  );
  assert.deepEqual(
    progress
      .slice(3)
      .map((entry) => [entry.item, entry.state, entry.count])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
    [
      ['cookies', 'completed', 1],
      ['history', 'completed', 1],
      ['passwords', 'completed', 1],
    ]
  );
  assert.equal(JSON.stringify(progress).includes('accounts.example.test'), false);
  assert.equal(JSON.stringify(progress).includes('secret-cookie-value'), false);
  assert.equal(JSON.stringify(progress).includes('fixture-password'), false);
  assert.equal(JSON.stringify(result).includes('fixture-password'), false);
  assert.equal(preparationCalls(), 1);
  const encryptedVault = await readFile(join(fixture.destinationUserData, 'browser-password-vault.bin'));
  const vault = JSON.parse(safeStorage.decryptString(encryptedVault)) as {
    credentials?: Array<Record<string, unknown>>;
  };
  assert.equal(vault.credentials?.length, 1);
  assert.equal(vault.credentials?.[0]?.url, 'https://accounts.example.test/');
  assert.equal(vault.credentials?.[0]?.username, 'fixture-user');
  assert.equal(vault.credentials?.[0]?.password, 'fixture-password');
}

/** A stored credential is offered only to the matching origin, and the plain
 *  values reach the fill callback without appearing in the suggestion. */
async function verifyStoredCredentialAccess(service: BrowserProfileImportService): Promise<void> {
  const credentialSuggestions = await service.credentialSuggestions('https://accounts.example.test/login');
  assert.equal(credentialSuggestions.length, 1);
  assert.match(credentialSuggestions[0].label, /^f.*r$/);
  assert.doesNotMatch(JSON.stringify(credentialSuggestions), /fixture-user|fixture-password/);
  assert.deepEqual(await service.credentialSuggestions('http://accounts.example.test/login'), []);
  const fillResult = await service.useCredential(
    'https://accounts.example.test/login',
    credentialSuggestions[0].id,
    async (credential) => {
      assert.equal(credential.username, 'fixture-user');
      assert.equal(credential.password, 'fixture-password');
      return { usernameFilled: true, passwordFilled: true };
    }
  );
  assert.deepEqual(fillResult, { usernameFilled: true, passwordFilled: true });
  await assert.rejects(
    service.useCredential('https://other.example.test/login', credentialSuggestions[0].id, async () => undefined),
    /does not match the current page origin/
  );
}

/** What the import landed: searchable history, and one normalized cookie on the
 *  destination partition. */
async function verifyHistoryAndCookieResults(
  service: BrowserProfileImportService,
  importedCookies: unknown[]
): Promise<void> {
  const suggestions = await service.searchHistory('dashboard');
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].url, 'https://accounts.example.test/dashboard');
  assert.equal(suggestions[0].title, 'Account dashboard');
  assert.equal(importedCookies.length, 1);
  assert.deepEqual(importedCookies[0], {
    url: 'https://example.test/',
    name: 'session',
    value: 'secret-cookie-value',
    domain: '.example.test',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
  });
}

/** One import at a time: a second request while the first is still closing the
 *  browser is rejected instead of racing it. */
async function verifyConcurrentImportRejected(fixture: ImportFixture, partition: Electron.Session): Promise<void> {
  let releasePreparation = () => {};
  let announcePreparation = () => {};
  const preparationEntered = new Promise<void>((resolve) => {
    announcePreparation = resolve;
  });
  const preparationRelease = new Promise<void>((resolve) => {
    releasePreparation = resolve;
  });
  const raceService = new BrowserProfileImportService({
    userDataDirectory: join(fixture.destinationUserData, 'race'),
    temporaryDirectory: fixture.temporaryDirectory,
    partition,
    chromeExecutablePath: fixture.chromeExecutable,
    chromeUserDataDirectory: fixture.sourceUserData,
    prepareChromeForImport: async () => {
      announcePreparation();
      await preparationRelease;
    },
    readNativeCookies: async () => ({
      version: 2,
      sourceCount: 0,
      expired: 0,
      cookies: [],
      failures: { decryption: 0, domainMismatch: 0, invalidEncoding: 0, invalidPartition: 0 },
    }),
  });
  const firstImport = raceService.importProfile(
    {
      jobId: 'racejob1234',
      sourceId: 'chrome',
      profileId: 'Default',
      items: ['cookies'],
      administratorApproved: true,
    },
    () => undefined
  );
  await preparationEntered;
  await assert.rejects(
    raceService.importProfile(
      {
        jobId: 'racejob5678',
        sourceId: 'chrome',
        profileId: 'Default',
        items: ['cookies'],
        administratorApproved: true,
      },
      () => undefined
    ),
    /Another browser import is already running/
  );
  releasePreparation();
  await firstImport;
}

/** Partial native failures stay visible: the item completes with its usable
 *  cookies, reports the failure counts, and names no private cookie or domain. */
async function verifyPartialCookieFailureReport(fixture: ImportFixture, partition: Electron.Session): Promise<void> {
  const partialService = new BrowserProfileImportService({
    userDataDirectory: join(fixture.destinationUserData, 'partial'),
    temporaryDirectory: fixture.temporaryDirectory,
    partition,
    chromeExecutablePath: fixture.chromeExecutable,
    chromeUserDataDirectory: fixture.sourceUserData,
    prepareChromeForImport: async () => {},
    readNativeCookies: async () => ({
      version: 2,
      sourceCount: 3,
      expired: 0,
      cookies: [
        {
          domain: 'partial.example.test',
          name: 'SID',
          value: 'private-partial-token',
          session: true,
        },
      ],
      failures: { decryption: 1, domainMismatch: 0, invalidEncoding: 0, invalidPartition: 1 },
    }),
  });
  const partialProgress: BrowserImportProgress[] = [];
  const partial = await partialService.importProfile(
    {
      jobId: 'partialfixture123',
      sourceId: 'chrome',
      profileId: 'Default',
      items: ['cookies'],
      administratorApproved: true,
    },
    (update) => partialProgress.push(update)
  );
  assert.equal(partial.counts.cookies, 1);
  assert.match(partial.errors.cookies || '', /2 failed/);
  assert.match(partial.errors.cookies || '', /1 decryption/);
  assert.equal(partialProgress.at(-1)?.state, 'failed');
  assert.equal(partialProgress.at(-1)?.count, 1);
  assert.doesNotMatch(JSON.stringify([partial, partialProgress]), /private-partial-token|partial\.example\.test/);
}

async function run(): Promise<void> {
  const sourceUserData = join(root, 'Chrome', 'User Data');
  const fixture: ImportFixture = {
    sourceUserData,
    sourceProfile: join(sourceUserData, 'Default'),
    destinationUserData: join(root, 'Mixdog'),
    temporaryDirectory: join(root, 'Temp'),
    chromeExecutable: join(root, 'chrome.exe'),
  };
  await mkdir(fixture.sourceProfile, { recursive: true });
  await mkdir(fixture.destinationUserData, { recursive: true });
  await mkdir(fixture.temporaryDirectory, { recursive: true });
  await writeFile(fixture.chromeExecutable, '');
  if (process.platform === 'win32') await verifyRunningBrowserIsClosed(root);
  await seedChromeProfile(fixture);

  const partition = session.fromPartition(`mixdog-import-test-${Date.now()}`);
  const { service, importedCookies, preparationCalls } = createImportService(fixture, partition);
  await verifyDiscoveredSources(service, fixture, partition);
  await verifyApprovalIsRequired(service, preparationCalls);
  await verifyFullImport(service, fixture, preparationCalls);
  await verifyStoredCredentialAccess(service);
  await verifyHistoryAndCookieResults(service, importedCookies);
  await verifyConcurrentImportRejected(fixture, partition);
  await verifyPartialCookieFailureReport(fixture, partition);

  await verifyCookieImport();
  await verifyPartitionedCookieImport();
  process.stdout.write('browser profile import integration passed\n');
}

process.stdout.write('browser profile import integration waiting for app\n');
void app
  .whenReady()
  .then(async () => {
    process.stdout.write('browser profile import integration app ready\n');
    await run();
    app.exit(0);
  })
  .catch(async (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    app.exit(1);
  });
