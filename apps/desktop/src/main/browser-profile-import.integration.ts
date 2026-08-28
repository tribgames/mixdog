import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { app, safeStorage, session } from 'electron';

import {
  BrowserProfileImportService,
  prepareChromeForImport,
  type BrowserImportProgress,
} from './browser-profile-import';

const execFileAsync = promisify(execFile);
process.stdout.write('browser profile import integration loaded\n');
const configuredRoot = String(process.env.MIXDOG_BROWSER_PROFILE_IMPORT_TEST_ROOT || '');
const root = configuredRoot || await mkdtemp(join(tmpdir(), 'mixdog-browser-profile-import-'));
await mkdir(root, { recursive: true });
app.setPath('userData', join(root, 'electron-user-data'));
app.disableHardwareAcceleration();

async function run(): Promise<void> {
  const sourceUserData = join(root, 'Chrome', 'User Data');
  const sourceProfile = join(sourceUserData, 'Default');
  const destinationUserData = join(root, 'Mixdog');
  const temporaryDirectory = join(root, 'Temp');
  const chromeExecutable = join(root, 'chrome.exe');
  await mkdir(sourceProfile, { recursive: true });
  await mkdir(destinationUserData, { recursive: true });
  await mkdir(temporaryDirectory, { recursive: true });
  await writeFile(chromeExecutable, '');
  if (process.platform === 'win32') {
    const closeFixture = join(root, 'mxclosefixture.exe');
    const closeFixtureSource = join(root, 'mxclosefixture.cs');
    const compiler = join(
      String(process.env.SystemRoot || 'C:\\Windows'),
      'Microsoft.NET',
      'Framework64',
      'v4.0.30319',
      'csc.exe',
    );
    await writeFile(closeFixtureSource, String.raw`
using System;
using System.Windows.Forms;
public static class MixdogBrowserCloseFixture {
  [STAThread]
  public static void Main() {
    Application.EnableVisualStyles();
    Application.Run(new Form { Text = "Mixdog browser close fixture", Width = 320, Height = 180 });
  }
}
`);
    await execFileAsync(compiler, [
      '/nologo',
      '/target:winexe',
      `/out:${closeFixture}`,
      '/reference:System.Windows.Forms.dll',
      closeFixtureSource,
    ], {
      windowsHide: true,
      timeout: 20_000,
    });
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
  await writeFile(join(sourceUserData, 'Local State'), JSON.stringify({
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
  }));

  const history = new DatabaseSync(join(sourceProfile, 'History'));
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
  history.prepare(`
    INSERT INTO urls (url, title, visit_count, last_visit_time, hidden)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    'https://accounts.example.test/dashboard',
    'Account dashboard',
    7,
    13_400_000_000_000_000n,
    0,
  );
  history.prepare(`
    INSERT INTO urls (url, title, visit_count, last_visit_time, hidden)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    'chrome://settings/',
    'Settings',
    1,
    13_400_000_000_000_001n,
    0,
  );
  history.close();
  const cookieDirectory = join(sourceProfile, 'Network');
  await mkdir(cookieDirectory, { recursive: true });
  const cookies = new DatabaseSync(join(cookieDirectory, 'Cookies'));
  cookies.exec('CREATE TABLE fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL);');
  cookies.prepare('INSERT INTO fixture (value) VALUES (?)').run('encrypted-cookie-placeholder');
  cookies.close();

  const importedCookies: unknown[] = [];
  let chromePreparationCalls = 0;
  const partition = session.fromPartition(`mixdog-import-test-${Date.now()}`);
  const service = new BrowserProfileImportService({
    userDataDirectory: destinationUserData,
    temporaryDirectory,
    partition: {
      ...partition,
      cookies: {
        ...partition.cookies,
        set: async (cookie: unknown) => {
          importedCookies.push(cookie);
        },
      },
      flushStorageData: async () => undefined,
    } as unknown as Electron.Session,
    chromeExecutablePath: chromeExecutable,
    chromeUserDataDirectory: sourceUserData,
    prepareChromeForImport: async () => {
      chromePreparationCalls += 1;
    },
    readNativeCredentials: async (profileId) => {
      assert.equal(profileId, 'Default');
      return [{
        url: 'https://accounts.example.test/',
        username: 'fixture-user',
        password: 'fixture-password',
        note: '',
      }];
    },
    readCookiesFromSnapshot: async ({ cookieDatabase }) => {
      const snapshot = new DatabaseSync(cookieDatabase, { readOnly: true });
      try {
        assert.equal(
          snapshot.prepare('SELECT value FROM fixture LIMIT 1').get()?.value,
          'encrypted-cookie-placeholder',
        );
      } finally {
        snapshot.close();
      }
      return [{
        name: 'session',
        value: 'secret-cookie-value',
        domain: '.example.test',
        path: '/',
        secure: true,
        httpOnly: true,
        session: true,
        sameSite: 'Lax',
      }];
    },
  });

  const sources = await service.sources();
  assert.equal(sources.length, 1);
  assert.deepEqual(
    sources[0].profiles.map((profile) => profile.id),
    ['Default'],
  );
  assert.equal(sources[0].profiles[0].accountEmail, 'owner@example.test');
  assert.equal(sources[0].supports.cookies, true);
  assert.equal(sources[0].supports.history, true);
  assert.equal(sources[0].supports.passwords, true);
  assert.equal(sources[0].passwordSupportReason, undefined);

  await assert.rejects(
    service.importProfile({
      jobId: 'fixturedenied1234',
      sourceId: 'chrome',
      profileId: 'Default',
      items: ['passwords'],
      administratorApproved: false,
    }, () => undefined),
    /explicit administrator approval/i,
  );
  assert.equal(chromePreparationCalls, 0);

  const progress: BrowserImportProgress[] = [];
  const result = await service.importProfile({
    jobId: 'fixturejob1234',
    sourceId: 'chrome',
    profileId: 'Default',
    items: ['passwords', 'cookies', 'history'],
    administratorApproved: true,
  }, (update) => progress.push(update));

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
    ],
  );
  assert.deepEqual(
    progress.slice(3)
      .map((entry) => [entry.item, entry.state, entry.count])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
    [
      ['cookies', 'completed', 1],
      ['history', 'completed', 1],
      ['passwords', 'completed', 1],
    ],
  );
  assert.equal(JSON.stringify(progress).includes('accounts.example.test'), false);
  assert.equal(JSON.stringify(progress).includes('secret-cookie-value'), false);
  assert.equal(JSON.stringify(progress).includes('fixture-password'), false);
  assert.equal(JSON.stringify(result).includes('fixture-password'), false);
  assert.equal(chromePreparationCalls, 1);
  const encryptedVault = await readFile(join(destinationUserData, 'browser-password-vault.bin'));
  const vault = JSON.parse(safeStorage.decryptString(encryptedVault)) as {
    credentials?: Array<Record<string, unknown>>;
  };
  assert.equal(vault.credentials?.length, 1);
  assert.equal(vault.credentials?.[0]?.url, 'https://accounts.example.test/');
  assert.equal(vault.credentials?.[0]?.username, 'fixture-user');
  assert.equal(vault.credentials?.[0]?.password, 'fixture-password');

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

  process.stdout.write('browser profile import integration passed\n');
}

process.stdout.write('browser profile import integration waiting for app\n');
void app.whenReady().then(async () => {
  process.stdout.write('browser profile import integration app ready\n');
  await run();
  app.exit(0);
}).catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  app.exit(1);
});
