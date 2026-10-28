/**
 * Sign-ins across a real restart of the managed profile: a local site sets a
 * persistent and a session cookie (both HttpOnly) on the Browser Use
 * partition, the process ends — cleanly (the host's dispose path) or by a
 * crash a few seconds after the login — and a second process on the same
 * data directory restores the profile the way the host does and asks the
 * site who it is. Driven by scripts/run-browser-login-persistence-integration.mjs.
 * A crash before the profile ever wrote its Local State (a first run killed
 * within seconds) loses the keychain key, so sealed session cookies cannot
 * be read back; the `warm` phase stands for the earlier runs of a real install.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { app, BrowserWindow, safeStorage, session } from 'electron';

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

import { createBrowserSessionStore, safeStorageEncrypt, watchBrowserSessionCookies } from './browser-session-store';
import { BROWSER_PARTITION } from './command';
import { createBrowserCookieJar } from './cookie-jar';
import { CredentialVault } from './credential-vault';
import { createPartitionSignIns } from './host-foundation';
import { BrowserProfileImportService } from './profile-import';

const directory = process.env.MIXDOG_LOGIN_PERSISTENCE_ROOT;
const phase = process.env.MIXDOG_LOGIN_PERSISTENCE_PHASE;
if (!directory || !['warm', 'login-clean', 'login-crash', 'check', 'signed-out'].includes(phase || '')) {
  throw new Error('The login persistence fixture requires an isolated directory and an explicit phase.');
}
const root = directory;
app.setPath('userData', root);

/** The site: /login signs in with both cookie kinds, /whoami echoes them. */
function startSite(): Promise<{ origin: string; close(): void }> {
  const server = createServer((request, response) => {
    if (request.url === '/login') {
      response.setHeader('Set-Cookie', [
        'remember=persistent-token; Max-Age=86400; Path=/; HttpOnly; SameSite=Lax',
        'sid=session-token; Path=/; HttpOnly; SameSite=Lax',
      ]);
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<title>${request.url}</title><pre id="who">${request.headers.cookie || ''}</pre>`);
  });
  return new Promise((resolve) => {
    server.listen(Number(process.env.MIXDOG_LOGIN_PERSISTENCE_PORT || 0), '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({ origin: `http://localhost:${address.port}`, close: () => server.close() });
    });
  });
}

// This check covers Mixdog's persistence and sign-out logic, not the OS keychain.
// A Linux runner without a usable keychain opts in (scripts/suite-health.mjs) to
// Electron's in-memory-password fallback, here in the harness only: the app
// never enables it. It is a no-op on Windows and macOS.
if (process.platform === 'linux' && process.env.MIXDOG_TEST_PLAINTEXT_SAFE_STORAGE === '1') {
  safeStorage.setUsePlainTextEncryption(true);
}

async function run() {
  await app.whenReady();
  // Session cookies are kept only sealed by safeStorage; without it nothing
  // survives a restart, which is the environment's fault, not a sign-in bug.
  if (!safeStorage.isEncryptionAvailable()) {
    const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : process.platform;
    throw new Error(
      `safeStorage encryption is unavailable (backend: ${backend}); the login persistence check needs an OS keychain ` +
        '(on Linux, an unlocked gnome-keyring in a D-Bus session) or MIXDOG_TEST_PLAINTEXT_SAFE_STORAGE=1.'
    );
  }
  const partition = session.fromPartition(BROWSER_PARTITION);
  const jar = createBrowserCookieJar(partition);
  // The host's wiring (host-foundation.ts createBrowserRestartState).
  const store = createBrowserSessionStore({ cookies: jar, directory: join(root, 'browser-state') });
  const restored = await store.restore();
  store.startAutosave();
  watchBrowserSessionCookies(partition.cookies, store, jar);
  if (phase === 'warm') {
    // An earlier run of the app: the OS keychain key the sealed store uses
    // is already in the profile's Local State, as on any real install.
    await safeStorageEncrypt('warm');
    await jar.dispose();
    app.quit();
    return;
  }
  const site = await startSite();
  const page = new BrowserWindow({ show: false, webPreferences: { partition: BROWSER_PARTITION } });
  if (phase === 'check') {
    await page.loadURL(`${site.origin}/whoami`);
    const seen = String(await page.webContents.executeJavaScript(`document.getElementById('who').textContent`));
    const cookies = await jar.get({ url: site.origin });
    const flags = Object.fromEntries(
      cookies.map((cookie) => [cookie.name, { httpOnly: cookie.httpOnly, session: cookie.session }])
    );
    process.stdout.write(`${JSON.stringify({ restored, seen, flags })}\n`);
    assert.match(seen, /remember=persistent-token/, 'the persistent cookie survives');
    assert.match(seen, /sid=session-token/, 'the session cookie survives');
    assert.deepEqual(flags.sid, { httpOnly: true, session: true }, 'restored without an expiry, still HttpOnly');
    assert.equal(flags.remember?.httpOnly, true);
    // "로그인 유지 중인 사이트" lists it; 로그아웃 and 전체 지우기 take it and the
    // copied Chrome data away, and the next start brings nothing back.
    const imported = ['browser-password-vault.bin', 'browser-imported-history.json', 'browser-import-backups'].map(
      (name) => join(root, name)
    );
    writeFileSync(imported[0], 'sealed');
    writeFileSync(imported[1], '[]');
    mkdirSync(imported[2], { recursive: true });
    writeFileSync(join(imported[2], 'cookies-1.bin'), 'sealed');
    const signIns = createPartitionSignIns(
      partition,
      jar,
      new BrowserProfileImportService({
        userDataDirectory: root,
        temporaryDirectory: app.getPath('temp'),
        partition,
        cookieJar: jar,
      }),
      store,
      new CredentialVault({ userDataDirectory: root })
    );
    const listed = await signIns.list();
    assert.deepEqual(listed, [{ site: 'localhost', cookies: 2 }]);
    assert.doesNotMatch(JSON.stringify(listed), /token/);
    assert.equal(await signIns.signOut('localhost'), 2);
    assert.deepEqual(await signIns.list(), []);
    await signIns.clearAll();
    assert.deepEqual(
      imported.map((path) => existsSync(path)),
      [false, false, false],
      'the imported vault, history and cookie backups are gone'
    );
    assert.equal(existsSync(store.file), false, 'no sealed sign-in is left for the next start');
    await jar.flushStore();
    site.close();
    await jar.dispose();
    process.stdout.write('Login persistence check passed.\n');
    app.exit(0);
    return;
  }
  if (phase === 'signed-out') {
    await page.loadURL(`${site.origin}/whoami`);
    const seen = String(await page.webContents.executeJavaScript(`document.getElementById('who').textContent`));
    assert.equal(seen, '', 'a signed-out site stays signed out after a restart');
    site.close();
    await jar.dispose();
    process.stdout.write('Login persistence sign-out check passed.\n');
    app.exit(0);
    return;
  }
  await page.loadURL(`${site.origin}/login`);
  if (phase === 'login-clean') {
    // What the host's dispose does on quit (host-methods.ts).
    await store.save();
    await jar.flushStore();
    site.close();
    await jar.dispose();
    process.stdout.write('Login persistence clean quit.\n');
    app.exit(0);
    return;
  }
  // A crash shortly after the sign-in: no dispose, no final save.
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  process.stdout.write('Login persistence crashing.\n');
  process.kill(process.pid, 'SIGKILL');
}

void run().catch((error) => {
  console.error(error);
  app.exit(1);
});
