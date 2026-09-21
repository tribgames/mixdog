// Preload with --import before session tests, including their static imports.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

const root = mkdtempSync(join(tmpdir(), 'mixdog-session-isolation-'));
for (const key of [
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'MIXDOG_HOME',
  'MIXDOG_DATA_DIR',
  'MIXDOG_CONFIG_DIR',
  'MIXDOG_RUNTIME_ROOT',
  'MIXDOG_USER_DATA_BACKUP_ROOT',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
]) {
  const directory = join(root, key);
  mkdirSync(directory);
  process.env[key] = directory;
}

function externalAccess() {
  throw new Error('Session test attempted external provider or database access');
}
globalThis.fetch = externalAccess;
http.request = http.get = https.request = https.get = externalAccess;
net.connect = net.createConnection = net.Socket.prototype.connect = tls.connect = externalAccess;
syncBuiltinESMExports();

const keychainUrl = new URL('../../../../../lib/keychain-cjs.cjs', import.meta.url).href;
const databaseUrl = `data:text/javascript,${encodeURIComponent(`
  const unavailable = () => { throw new Error('Session test attempted external database access'); };
  export class Client { connect = unavailable; query = unavailable; }
  export class Pool { connect = unavailable; query = unavailable; }
  export default { Client, Pool };
`)}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'pg') return { url: databaseUrl, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === keychainUrl) {
      return {
        format: 'commonjs',
        shortCircuit: true,
        source: `
          const secrets = new Map();
          module.exports = {
            SERVICE: 'mixdog',
            getSecret: (key) => secrets.get(key) ?? null,
            setSecret: (key, value) => { secrets.set(key, value); },
            deleteSecret: (key) => { secrets.delete(key); },
            hasSecret: (key) => secrets.has(key),
            invalidateSecretCache() {},
            async prewarmSecrets() {},
          };
        `,
      };
    }
    return next(url, context);
  },
});

process.on('exit', () => rmSync(root, { recursive: true, force: true }));
