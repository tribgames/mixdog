import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const DEV_DEBUG_PORT = 9342;
const desktopDir = fileURLToPath(new URL('..', import.meta.url));
const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/i;

// Kept dev profiles live outside the repository and the installed app's data,
// so settings, sign-ins and sessions survive restarts of the dev app only.
export function persistentDevProfileDir(name = 'default', parent = process.env) {
  if (!PROFILE_NAME.test(name)) {
    throw new Error('Profile name must use letters, digits and hyphens (at most 64).');
  }
  const root = parent.LOCALAPPDATA ? join(parent.LOCALAPPDATA, 'mixdog-dev') : join(homedir(), '.mixdog-dev');
  return join(root, name);
}

export async function assertDebugPortAvailable(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Debug port must be an integer from 1 to 65535.');
  }
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', (error) => {
      reject(
        new Error(
          `Cannot use test debug port ${port}: ${error.code}. ` +
            'Use the existing test app, or choose another port (--port for dev, -Port for E2E).',
          { cause: error }
        )
      );
    });
    server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
  });
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

export async function createIsolatedDevEnv(parent = process.env, profileParent = tmpdir()) {
  return isolatedEnvFor(await mkdtemp(join(profileParent, 'mixdog-desktop-test-')), parent);
}

export async function createPersistentDevEnv(
  parent = process.env,
  profile = persistentDevProfileDir('default', parent)
) {
  return isolatedEnvFor(profile, parent);
}

async function isolatedEnvFor(profile, parent) {
  const env = { ...parent };
  // A shell launched by the installed daemon inherits its live data, bridge
  // and runtime paths. Overriding userData alone does not isolate that shell.
  for (const key of Object.keys(env)) {
    if (/^(MIXDOG_|ELECTRON_)/i.test(key)) delete env[key];
  }
  Object.assign(env, {
    MIXDOG_DESKTOP_USER_DATA: profile,
    MIXDOG_HOME: join(profile, 'home'),
    MIXDOG_DATA_DIR: join(profile, 'data'),
    MIXDOG_RUNTIME_ROOT: join(profile, 'runtime'),
    MIXDOG_BRIDGE_DISCOVERY_DIR: join(profile, 'bridges'),
    MIXDOG_PROJECTS_FILE: join(profile, 'projects.json'),
    MIXDOG_DISABLE_PROJECT_MARKERS: '1',
  });
  await Promise.all(
    ['home', 'data', 'runtime', 'bridges'].map((directory) => mkdir(join(profile, directory), { recursive: true }))
  );
  return env;
}

async function main() {
  const { values } = parseArgs({
    options: {
      'env-json': { type: 'boolean', default: false },
      fresh: { type: 'boolean', default: false },
      preview: { type: 'boolean', default: false },
      profile: { type: 'string' },
      port: { type: 'string', default: String(DEV_DEBUG_PORT) },
      // An inherited MIXDOG_RELAY_URL is stripped with every other live
      // override; a local test relay is named explicitly instead.
      'relay-url': { type: 'string' },
    },
  });
  if (values.fresh && values.profile !== undefined) {
    throw new Error('Use either --fresh or --profile, not both.');
  }
  const profile = values.fresh ? null : persistentDevProfileDir(values.profile ?? 'default');
  const port = Number(values.port);
  await assertDebugPortAvailable(port);
  const env = profile ? await createPersistentDevEnv(process.env, profile) : await createIsolatedDevEnv();
  if (values['relay-url']) env.MIXDOG_RELAY_URL = values['relay-url'];
  // electron-vite's preview CLI has no --remoteDebuggingPort option. Supply
  // only our own Electron args after stripping any inherited app overrides.
  if (values.preview) {
    env.ELECTRON_CLI_ARGS = JSON.stringify([`--remote-debugging-port=${port}`]);
  }
  if (values['env-json']) {
    console.log(JSON.stringify(env));
    return;
  }
  console.log(`${profile ? 'Dev profile (kept)' : 'Test profile (fresh)'}: ${env.MIXDOG_DESKTOP_USER_DATA}`);
  console.log(`Test debug port: ${port}`);
  // Never remove a profile here: a kept profile is the user's dev workspace,
  // and a fresh one is retained for diagnosis while Electron or an isolated
  // daemon may still be shutting down.
  const child = spawn(
    process.execPath,
    [
      join(desktopDir, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'),
      ...(values.preview ? ['preview', '--skipBuild'] : ['dev', '--remoteDebuggingPort', String(port)]),
    ],
    { cwd: desktopDir, env, stdio: 'inherit' }
  );
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
