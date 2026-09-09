import { app, session } from 'electron';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { importBrowserCookies } from '../src/main/browser/profile-import-cookies';

const root = process.env.MIXDOG_COOKIE_DIAGNOSIS_ROOT;
if (!root) throw new Error('Isolated profile required.');
app.setPath('userData', join(root, 'profile'));
app.disableHardwareAcceleration();

void app.whenReady().then(async () => {
  const source = process.argv[2];
  if (!source) throw new Error('Pass an exact Chrome Cookies database path.');
  const database = new DatabaseSync(source, { readOnly: true });
  const rows = database.prepare(`
    SELECT host_key, name, path, is_secure, is_httponly, has_expires,
      is_persistent, CAST(expires_utc AS REAL) AS expires_utc, samesite FROM cookies
  `).all();
  database.close();
  const partition = session.fromPartition('cookie-metadata-diagnosis');
  const failures: unknown[] = [];
  const cookies = rows.map((row) => ({
        domain: row.host_key, name: row.name, path: row.path, value: 'fixture-cookie-value',
        secure: row.is_secure === 1, httpOnly: row.is_httponly === 1,
        session: row.has_expires === 0 || row.is_persistent === 0,
        expires: Math.floor(Number(row.expires_utc) / 1_000_000) - 11_644_473_600,
        sameSite: row.samesite === 0 ? 'none' : row.samesite === 1 ? 'lax' : row.samesite === 2 ? 'strict' : '',
  }));
  try {
    await importBrowserCookies({
      cookies: {
        get: partition.cookies.get.bind(partition.cookies),
        flushStore: partition.cookies.flushStore.bind(partition.cookies),
        set: async (details: Electron.CookiesSetDetails) => {
          try {
            await partition.cookies.set(details);
          } catch (error) {
            failures.push({ url: details.url, domain: details.domain, name: details.name,
              path: details.path, secure: details.secure, sameSite: details.sameSite,
              error: String(error).replaceAll('fixture-cookie-value', '[fixture]') });
            throw error;
          }
        },
      },
    } as unknown as Electron.Session, cookies, async () => {});
  } catch {
    if (!failures.length) throw new Error('Unclassified metadata failure.');
  }
  console.log(JSON.stringify({ total: rows.length, metadataFailures: failures }));
  app.exit(0);
}).catch((error: unknown) => {
  console.error('Cookie metadata diagnosis failed; no source values were read.', String(error));
  app.exit(1);
});
