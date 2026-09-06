import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GPU_FIELDS = 'index,uuid,name,memory.total,memory.free';
const CACHE_MS = 5_000;

export function parseNvidiaGpus(output) {
  return String(output || '').split(/\r?\n/).flatMap((line) => {
    const parts = line.split(',').map((part) => part.trim());
    if (parts.length < 5) return [];
    const index = Number(parts[0]);
    const uuid = parts[1];
    const memoryBytes = Number(parts.at(-2)) * 1024 ** 2;
    const freeMemoryBytes = Number(parts.at(-1)) * 1024 ** 2;
    if (!Number.isSafeInteger(index) || index < 0 || !/^GPU-[a-f0-9-]+$/i.test(uuid)
        || !Number.isSafeInteger(memoryBytes) || memoryBytes <= 0
        || !Number.isSafeInteger(freeMemoryBytes) || freeMemoryBytes < 0
        || freeMemoryBytes > memoryBytes) return [];
    return [{ index, uuid, vendor: 'NVIDIA', name: parts.slice(2, -2).join(', '), memoryBytes, freeMemoryBytes }];
  });
}

export function createHardwareProbe({
  queryFn = async () => (await execFileAsync('nvidia-smi', [
    `--query-gpu=${GPU_FIELDS}`, '--format=csv,noheader,nounits',
  ], { encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024 })).stdout,
  platform = process.platform,
  arch = process.arch,
  now = Date.now,
  cacheMs = CACHE_MS,
} = {}) {
  const platformSupported = platform === 'win32' && arch === 'x64';
  let value = { platform, arch, gpu: null, gpus: [], supported: false, checking: platformSupported, checkedAt: null, error: null };
  let pending = null;
  function refresh({ force = false } = {}) {
    if (pending) return pending;
    if (!force && value.checkedAt !== null && now() - value.checkedAt < cacheMs) return Promise.resolve(value);
    if (!platformSupported) {
      value = { ...value, checking: false, checkedAt: now() };
      return Promise.resolve(value);
    }
    value = { ...value, checking: true };
    pending = Promise.resolve().then(queryFn).then((output) => {
      const gpus = parseNvidiaGpus(output).sort((a, b) =>
        b.memoryBytes - a.memoryBytes || b.freeMemoryBytes - a.freeMemoryBytes || a.index - b.index);
      value = { platform, arch, gpu: gpus[0] || null, gpus, supported: gpus.length > 0,
        checking: false, checkedAt: now(), error: gpus.length ? null : 'No compatible NVIDIA GPU detected.' };
      return value;
    }, (error) => {
      value = { platform, arch, gpu: null, gpus: [], supported: false, checking: false,
        checkedAt: now(), error: String(error?.message || error) };
      return value;
    }).finally(() => { pending = null; });
    return pending;
  }
  return {
    refresh,
    status() {
      void refresh();
      return { ...value, gpus: value.gpus.map((gpu) => ({ ...gpu })), gpu: value.gpu ? { ...value.gpu } : null };
    },
  };
}

const probe = createHardwareProbe();
export const localProviderHardwareStatus = () => probe.status();
export const detectLocalProviderHardware = ({ refresh = false } = {}) => probe.refresh({ force: refresh });

export function selectLocalProviderGpu(hardware, model) {
  if (!hardware?.supported) throw new Error(`[local-provider] GPU detection failed: ${hardware?.error || 'unsupported hardware'}`);
  const requiredBytes = Number(model.estimatedVramBytes);
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes <= 0) {
    throw new Error('[local-provider] model is missing a GPU memory estimate');
  }
  const candidates = (hardware.gpus || []).filter((gpu) => gpu.memoryBytes >= model.minimumVramBytes)
    .sort((a, b) => b.freeMemoryBytes - a.freeMemoryBytes || a.index - b.index);
  const gpu = candidates.find((entry) => entry.freeMemoryBytes >= requiredBytes);
  if (!gpu) {
    throw new Error(`[local-provider] insufficient available GPU memory: estimated requirement ${requiredBytes} bytes; best compatible GPU has ${candidates[0]?.freeMemoryBytes || 0} bytes free. Free GPU memory or choose a smaller compatible model.`);
  }
  return gpu;
}
