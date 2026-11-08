import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { setServerPayloadResolver } from '../ssh/remote-install-payload.ts';
import { currentSshContext, runWithSshContext } from '../ssh/ssh-context.ts';
import { createDesktopConnection } from './index.ts';
import { fakeProtocol } from './fake-core-protocol.mjs';

// The bootstrap resolves the runtime payload before its first ssh. The real
// one needs the desktop build's generated server lockfile (out/server/deps),
// which a checkout that was not built (CI's test job) does not have.
setServerPayloadResolver(async () => ({
  identity: { version: '1.1.2', build: 'test', installId: '1.1.2-test' },
  binary: async () => ({ sha256: '0'.repeat(64), archive: async () => Buffer.alloc(0) }),
}));
after(() => setServerPayloadResolver(null));

const deps = {
  moduleUrl: () => 'file:///daemon.cjs',
  environmentReady: () => Promise.resolve(),
  sessionOptions: () => ({
    userDataPath: 'C:\\profile',
    packaged: false,
    resourcesPath: '',
    appPath: '',
    appVersion: '0.0.0',
    rendererDir: '',
  }),
  loadModelProxyRuntime: async () => {
    throw new Error('unused');
  },
  appVersion: '0.0.0',
};

/** The settings ssh runs under when the transport dials a connection made under `made`, from a caller running under `again` (none: a reconnect the user or the link ladder starts). */
async function dialSpawns(made, again) {
  const spawned = [];
  let connector = null;
  const connection = runWithSshContext(made, () =>
    createDesktopConnection(
      { id: 'srv-key', kind: 'ssh', name: 'Box', target: 'root@127.0.0.1:2223' },
      {
        ...deps,
        createProtocol: (_identity, dialer) => {
          connector = dialer;
          return fakeProtocol();
        },
        localProtocol: () => fakeProtocol(),
      }
    )
  );
  try {
    connection.remote.config.spawnImpl = () => {
      spawned.push(currentSshContext()?.settings);
      throw new Error('stop here');
    };
    // What every (re)attach dials through: the connection's connector, which its protocol connection resolves by.
    const dial = () => connector.connect(() => {});
    await (again ? runWithSshContext(again, dial) : dial()).catch(() => undefined);
    return spawned;
  } finally {
    await connection.dispose();
  }
}
test('a reconnect outside any connect attempt still runs ssh with the identity file the connection was made with', async () => {
  const settings = { identityFile: '~/.ssh/id_work' };
  assert.equal(currentSshContext(), undefined);
  const spawned = await dialSpawns({ settings }, null);
  assert.ok(spawned.length > 0, 'the reconnect spawned ssh');
  for (const seen of spawned) assert.deepEqual(seen, settings);
});

test('an attempt that carries its own settings keeps them over the retained ones', async () => {
  const spawned = await dialSpawns(
    { settings: { identityFile: '~/.ssh/old' } },
    { settings: { identityFile: '~/.ssh/new' } }
  );
  assert.ok(spawned.length > 0);
  for (const seen of spawned) assert.deepEqual(seen, { identityFile: '~/.ssh/new' });
});
