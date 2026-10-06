import assert from 'node:assert/strict';
import test from 'node:test';
import { createHardwareProbe, localProviderPlatformKey, parseNvidiaGpus, selectLocalProviderGpu } from './hardware.mjs';

const small = '0, GPU-aaaaaaaa, NVIDIA RTX 3070, 8192, 7000';
const large = '1, GPU-bbbbbbbb, NVIDIA RTX 3090, 24576, 23500';
const model = { minimumVramBytes: 23 * 1024 ** 3, estimatedVramBytes: 22 * 1024 ** 3 };

test('GPU inspection is nonblocking, coalesced, and independent of device enumeration order', async () => {
  let finish;
  let calls = 0;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  const probe = createHardwareProbe({
    platform: 'win32',
    arch: 'x64',
    queryFn: async () => {
      calls++;
      return gate;
    },
  });
  assert.equal(probe.status().checking, true);
  const first = probe.refresh();
  const second = probe.refresh();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish(`${small}\n${large}`);
  const hardware = await first;
  assert.equal(hardware.gpus.length, 2);
  assert.equal(hardware.gpu.uuid, 'GPU-bbbbbbbb');
  assert.equal(selectLocalProviderGpu(hardware, model).uuid, 'GPU-bbbbbbbb');
  assert.equal(selectLocalProviderGpu({ ...hardware, gpus: [...hardware.gpus].reverse() }, model).uuid, 'GPU-bbbbbbbb');
});

test('preflight uses available VRAM and fails closed on insufficient or unavailable measurements', async () => {
  const probe = createHardwareProbe({
    platform: 'win32',
    arch: 'x64',
    queryFn: async () => large.replace('23500', '1000'),
  });
  const hardware = await probe.refresh();
  assert.throws(() => selectLocalProviderGpu(hardware, model), /insufficient available GPU memory/);
  const failed = createHardwareProbe({
    platform: 'win32',
    arch: 'x64',
    queryFn: async () => {
      throw new Error('driver unavailable');
    },
  });
  const unavailable = await failed.refresh();
  assert.equal(unavailable.checking, false);
  assert.throws(() => selectLocalProviderGpu(unavailable, model), /driver unavailable/);
  assert.deepEqual(parseNvidiaGpus('0, invalid uuid, GPU, 24576, 24000'), []);
});

test('Apple Silicon reports one Metal GPU sized by the wired limit, or two thirds of RAM without one', async () => {
  const total = 16 * 1024 ** 3;
  const probe = createHardwareProbe({
    platform: 'darwin',
    arch: 'arm64',
    queryFn: async () => {
      throw new Error('nvidia-smi must not run on a Mac');
    },
    appleQueryFn: async () => ({ name: 'Apple M4', totalBytes: total, wiredLimitMb: 0 }),
  });
  const hardware = await probe.refresh();
  assert.equal(hardware.supported, true);
  assert.equal(hardware.gpu.vendor, 'Apple');
  assert.equal(hardware.gpu.name, 'Apple M4');
  assert.equal(hardware.gpu.memoryBytes, Math.floor((total * 2) / 3));
  assert.equal(hardware.gpu.freeMemoryBytes, hardware.gpu.memoryBytes);
  const fits = { minimumVramBytes: 8 * 1024 ** 3, estimatedVramBytes: 7 * 1024 ** 3 };
  assert.equal(selectLocalProviderGpu(hardware, fits).uuid, 'MTL0');
  assert.throws(() => selectLocalProviderGpu(hardware, model), /insufficient available GPU memory/);
  const raised = createHardwareProbe({
    platform: 'darwin',
    arch: 'arm64',
    appleQueryFn: async () => ({ name: 'Apple M4', totalBytes: total, wiredLimitMb: 14_336 }),
  });
  assert.equal((await raised.refresh()).gpu.memoryBytes, 14_336 * 1024 ** 2);
  assert.equal(localProviderPlatformKey('darwin', 'arm64'), 'darwin-arm64-metal');
  assert.equal(localProviderPlatformKey('win32', 'x64'), 'win32-x64-nvidia');
  assert.equal(localProviderPlatformKey('darwin', 'x64'), '');
  assert.equal(localProviderPlatformKey('linux', 'x64'), '');
  const intel = createHardwareProbe({ platform: 'darwin', arch: 'x64' });
  assert.equal((await intel.refresh()).supported, false);
});

test('stale hardware measurements refresh asynchronously without retaining stale success after a driver failure', async () => {
  let time = 0;
  let fail = false;
  const probe = createHardwareProbe({
    platform: 'win32',
    arch: 'x64',
    now: () => time,
    queryFn: async () => {
      if (fail) throw new Error('disconnected');
      return large;
    },
  });
  assert.equal((await probe.refresh()).supported, true);
  time = 5001;
  fail = true;
  assert.equal(probe.status().checking, true);
  assert.equal((await probe.refresh()).supported, false);
  assert.equal(probe.status().gpu, null);
});
