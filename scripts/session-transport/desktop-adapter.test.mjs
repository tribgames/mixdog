import test from 'node:test';
import assert from 'node:assert/strict';
import {
  writeFileSync,
  join,
  pathToFileURL,
  RUNTIME_ROOT,
  createSessionService,
  createStubSessionRuntime,
} from './_shared.mjs';


test('desktop clients keep install adapters isolated by module URL', async () => {
  const firstModule = join(RUNTIME_ROOT, 'desktop-service-first.mjs');
  const secondModule = join(RUNTIME_ROOT, 'desktop-service-second.mjs');
  const adapterSource = (label) => `
    export async function createDesktopService() {
      return {
        invoke(method) { return { label: ${JSON.stringify(label)}, method }; },
        async control() {},
        async dispose() {},
      };
    }
  `;
  writeFileSync(firstModule, adapterSource('first'));
  writeFileSync(secondModule, adapterSource('second'));
  const service = createSessionService({ createSessionRuntime: async () => createStubSessionRuntime() });
  try {
    const first = await service.handleCall('desktop.init', {
      desktopId: 'desktop_first',
      moduleUrl: pathToFileURL(firstModule).href,
    }, { clientToken: 'client_first' });
    const second = await service.handleCall('desktop.init', {
      desktopId: 'desktop_second',
      moduleUrl: pathToFileURL(secondModule).href,
    }, { clientToken: 'client_second' });
    const firstAgain = await service.handleCall('desktop.init', {
      desktopId: 'desktop_first_again',
      moduleUrl: pathToFileURL(firstModule).href,
    }, { clientToken: 'client_first_again' });
    assert.equal(first.desktopId, 'desktop_first');
    assert.equal(second.desktopId, 'desktop_second');
    assert.equal(firstAgain.desktopId, 'desktop_first',
      'clients from the same install reuse their adapter');
    const firstInvoked = await service.handleCall('desktop.invoke', {
      desktopId: first.desktopId,
      method: 'probe',
      args: [],
    }, { clientToken: 'client_first' });
    const secondInvoked = await service.handleCall('desktop.invoke', {
      desktopId: second.desktopId,
      method: 'probe',
      args: [],
    }, { clientToken: 'client_second' });
    assert.deepEqual(firstInvoked, { label: 'first', method: 'probe' });
    assert.deepEqual(secondInvoked, { label: 'second', method: 'probe' });
  } finally {
    await service.stop('test end');
  }
});

test('an in-place CJS desktop update loads the newly keyed artifact without replacing the old adapter', async () => {
  const modulePath = join(RUNTIME_ROOT, 'desktop-service-in-place.cjs');
  const writeAdapter = (label) => writeFileSync(modulePath, `
    module.exports.createDesktopService = async function createDesktopService() {
      return {
        invoke() { return ${JSON.stringify(label)}; },
        async control() {},
        async dispose() {},
      };
    };
  `);
  writeAdapter('old');
  const service = createSessionService({ createSessionRuntime: async () => createStubSessionRuntime() });
  try {
    const oldService = await service.handleCall('desktop.init', {
      desktopId: 'desktop_in_place_old',
      moduleUrl: `${pathToFileURL(modulePath).href}?build=old`,
    }, { clientToken: 'client_in_place_old' });
    writeAdapter('new');
    const newService = await service.handleCall('desktop.init', {
      desktopId: 'desktop_in_place_new',
      moduleUrl: `${pathToFileURL(modulePath).href}?build=new`,
    }, { clientToken: 'client_in_place_new' });
    assert.equal(await service.handleCall('desktop.invoke', {
      desktopId: oldService.desktopId,
      method: 'probe',
    }), 'old');
    assert.equal(await service.handleCall('desktop.invoke', {
      desktopId: newService.desktopId,
      method: 'probe',
    }), 'new');
  } finally {
    await service.stop('test end');
  }
});

test('the daemon injects its process-local runtime into the desktop adapter', async () => {
  const modulePath = join(RUNTIME_ROOT, 'desktop-service-runtime.mjs');
  writeFileSync(modulePath, `
    export async function createDesktopService({ runtime }) {
      return {
        invoke(method) { return method === 'runtime-marker' ? runtime.marker : null; },
        async control() {},
        async dispose() {},
      };
    }
  `);
  const desktopRuntime = { marker: 'daemon-process-runtime' };
  const service = createSessionService({
    createSessionRuntime: async () => createStubSessionRuntime(),
    desktopRuntime,
  });
  try {
    const initialized = await service.handleCall('desktop.init', {
      desktopId: 'desktop_runtime',
      moduleUrl: pathToFileURL(modulePath).href,
    }, { clientToken: 'desktop_runtime_client' });
    const marker = await service.handleCall('desktop.invoke', {
      desktopId: initialized.desktopId,
      method: 'runtime-marker',
      args: [],
    }, { clientToken: 'desktop_runtime_client' });
    assert.equal(marker, desktopRuntime.marker);
  } finally {
    await service.stop('test end');
  }
});

test('daemon lifetime sees phone clients owned by the desktop adapter', async () => {
  const modulePath = join(RUNTIME_ROOT, 'desktop-service-clients.mjs');
  writeFileSync(modulePath, `
    export async function createDesktopService({ onClientCountChanged }) {
      let clientCount = 0;
      return {
        get clientCount() { return clientCount; },
        invoke(method, args) {
          if (method === 'clients') {
            clientCount = Number(args[0]) || 0;
            onClientCountChanged();
          }
          return clientCount;
        },
        async control() {},
        async dispose() {},
      };
    }
  `);
  let changed = 0;
  const service = createSessionService({
    createSessionRuntime: async () => createStubSessionRuntime(),
    onExternalClientsChanged: () => { changed += 1; },
  });
  try {
    await service.handleCall('desktop.init', {
      desktopId: 'desktop_clients',
      moduleUrl: pathToFileURL(modulePath).href,
    }, { clientToken: 'desktop_client' });
    await service.handleCall('desktop.invoke', {
      desktopId: 'desktop_clients',
      method: 'clients',
      args: [2],
    }, { clientToken: 'desktop_client' });
    assert.equal(service.externalClientCount, 2);
    assert.equal(changed, 1);
  } finally {
    await service.stop('test end');
  }
});
