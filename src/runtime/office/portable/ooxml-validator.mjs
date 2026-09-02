import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

const VERSION = '0.3.0';
const MAX_ARCHIVE_BYTES = 160 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const PLATFORM_PACKAGES = Object.freeze({
  'win32-x64': {
    name: '@xarsh/ooxml-validator-win32-x64',
    integrity: 'sha512-VflQjYjMfq6Up3sclSiVL5p2dVz17RrubZF+QqXhoWCiOPlMlaMN07hx99J6Ngh6TPboAK6TjcuG8DlGIhcp0w==',
    binary: 'ooxml-validator.exe',
  },
  'win32-arm64': {
    name: '@xarsh/ooxml-validator-win32-arm64',
    integrity: 'sha512-mx7RqjopCZ3mNVlNyPar935FbMA61hOCyIA854L/3trLt4vmj62/spSfjkpgyKx6TKq5/HXTjMf+rNM/WKayaw==',
    binary: 'ooxml-validator.exe',
  },
  'linux-x64': {
    name: '@xarsh/ooxml-validator-linux-x64',
    integrity: 'sha512-GltV9YzcOwLdxhTvw9MIw1kgMbsjnpUvYYaKovDUwMcvwIOlb72Lealp4mZRugLDS1XRDqHbjoChL6Ko+awLpw==',
    binary: 'ooxml-validator',
  },
  'linux-arm64': {
    name: '@xarsh/ooxml-validator-linux-arm64',
    integrity: 'sha512-5D8M0PF8J3eIrnUYNiHfOKyjiwnTkWRfcmUMrwMsqzSTBX0LmTRa1QjbIpAwTjKalkGq8nzutSO6eu/UmNothg==',
    binary: 'ooxml-validator',
  },
  'darwin-x64': {
    name: '@xarsh/ooxml-validator-darwin-x64',
    integrity: 'sha512-Mj0IEDx4lnDbz+cWqhbyQ3zrJTrtcOUhgU13qXgM4m1yS+SNhsojwfIw6NfPjeI6QTvh5rq9oocgewBe7W9LYw==',
    binary: 'ooxml-validator',
  },
  'darwin-arm64': {
    name: '@xarsh/ooxml-validator-darwin-arm64',
    integrity: 'sha512-hgxBf6YzMJCvgEKJN3wVmd4KhIkAx0eCl3ODMoi8a9m8o6N7xE0UKHJFjAku0WhAdbVrZN4w3K5oUVLCC6GnTA==',
    binary: 'ooxml-validator',
  },
});

function packageUrl(name) {
  const slug = name.slice(name.indexOf('/') + 1);
  return `https://registry.npmjs.org/${name}/-/${slug}-${VERSION}.tgz`;
}

function archiveEntry(buffer, wanted) {
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start, length) => header.subarray(start, start + length)
      .toString('utf8').replace(/\0.*$/s, '').trim();
    const prefix = text(345, 155);
    const name = [prefix, text(0, 100)].filter(Boolean).join('/');
    const size = Number.parseInt(text(124, 12) || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new Error('OOXML validator archive has an invalid TAR entry size');
    const body = offset + 512;
    if (name === wanted) return buffer.subarray(body, body + size);
    offset = body + Math.ceil(size / 512) * 512;
  }
  throw new Error(`OOXML validator archive is missing ${wanted}`);
}

async function fetchArchive(url, { signal = null } = {}) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`OOXML validator download failed with HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_ARCHIVE_BYTES) throw new Error('OOXML validator archive exceeds the download size limit');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_ARCHIVE_BYTES) throw new Error('OOXML validator archive exceeds the download size limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function verifyIntegrity(buffer, integrity) {
  const [algorithm, expected] = String(integrity).split('-', 2);
  const actual = createHash(algorithm).update(buffer).digest('base64');
  if (actual !== expected) throw new Error('OOXML validator archive integrity check failed');
}

function isOfficeExtensionCompatibilityError(error) {
  const path = String(error?.path || '');
  const xPath = String(error?.xPath || '');
  const description = String(error?.description || '');
  if (!/^\/(?:ppt|xl)\/charts\//i.test(path)) return false;
  return /\/c:extLst\[\d+](?:\/c:ext\[\d+])?/i.test(xPath)
    || /schemas\.microsoft\.com\/office\/drawing\/20\d{2}\//i.test(description);
}

// Script generators write <p:notesMasterIdLst> after <p:sldIdLst>, which the
// schema rejects but every PowerPoint build opens; reordering the children is
// what actually breaks the deck, so the order is tolerated as-is.
function isPresentationChildOrderError(error) {
  if (!/^\/ppt\/presentation\.xml$/i.test(String(error?.path || ''))) return false;
  if (!/^\/p:presentation\[1]$/i.test(String(error?.xPath || ''))) return false;
  return /unexpected child element .*:(?:notesMasterIdLst|handoutMasterIdLst)'/i.test(String(error?.description || ''));
}

function isCompatibilityError(error) {
  return isOfficeExtensionCompatibilityError(error) || isPresentationChildOrderError(error);
}

export function classifyOoxmlValidationErrors(errors = []) {
  const reported = Array.isArray(errors) ? errors : [];
  return {
    errors: reported.filter((error) => !isCompatibilityError(error)),
    compatibilityWarnings: reported.filter(isCompatibilityError),
  };
}

function cachePaths(dataDir, entry) {
  const root = join(dataDir, 'office', 'tools', 'ooxml-validator', VERSION, `${process.platform}-${process.arch}`);
  return {
    root,
    binary: join(root, entry.binary),
  };
}

async function usableBinary(path) {
  try {
    const details = await stat(path);
    return details.isFile() && details.size > 1024 * 1024;
  } catch {
    return false;
  }
}

export async function ensureOoxmlValidator({
  dataDir,
  download = true,
  signal = null,
} = {}) {
  const override = String(process.env.MIXDOG_OOXML_VALIDATOR_CLI || '').trim();
  if (override) {
    await access(override);
    return { available: true, cached: true, downloaded: false, path: override, version: 'override' };
  }
  if (process.env.MIXDOG_OOXML_VALIDATOR_DISABLED === '1') {
    return { available: false, disabled: true, downloaded: false, reason: 'OOXML schema validation is disabled.' };
  }
  const entry = PLATFORM_PACKAGES[`${process.platform}-${process.arch}`];
  if (!entry) {
    return {
      available: false,
      downloaded: false,
      reason: `OOXML schema validation is unavailable on ${process.platform}-${process.arch}.`,
    };
  }
  const paths = cachePaths(dataDir, entry);
  if (await usableBinary(paths.binary)) {
    return { available: true, cached: true, downloaded: false, path: paths.binary, version: VERSION };
  }
  if (!download) {
    return {
      available: false,
      cached: false,
      downloaded: false,
      downloadRequired: true,
      reason: 'OOXML schema validator is not cached.',
    };
  }
  await mkdir(paths.root, { recursive: true });
  const temporary = join(paths.root, `.${entry.binary}.${randomUUID()}.tmp`);
  try {
    const archive = await fetchArchive(packageUrl(entry.name), { signal });
    verifyIntegrity(archive, entry.integrity);
    const tar = gunzipSync(archive);
    const binary = archiveEntry(tar, `package/${entry.binary}`);
    await writeFile(temporary, binary, { mode: 0o755 });
    await chmod(temporary, 0o755);
    await rm(paths.binary, { force: true });
    await rename(temporary, paths.binary);
    return {
      available: true,
      cached: false,
      downloaded: true,
      path: paths.binary,
      version: VERSION,
      bytes: binary.length,
    };
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function validateOoxmlSchema(path, {
  dataDir,
  download = true,
  officeVersion = 'Microsoft365',
  signal = null,
} = {}) {
  const runtime = await ensureOoxmlValidator({ dataDir, download, signal });
  if (!runtime.available) return { ...runtime, ok: false, errors: [] };
  return await new Promise((resolve) => {
    const child = spawn(runtime.path, [path, officeVersion], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener?.('abort', abort);
      resolve(value);
    };
    const append = (current, chunk) => {
      const next = `${current}${chunk}`;
      return next.length > MAX_OUTPUT_BYTES ? next.slice(0, MAX_OUTPUT_BYTES) : next;
    };
    const abort = () => {
      try { child.kill(); } catch {}
      finish({ ...runtime, ok: false, errors: [], reason: 'OOXML schema validation was cancelled.' });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.once('error', (error) => finish({
      ...runtime,
      ok: false,
      errors: [],
      reason: `Failed to start OOXML schema validator: ${error.message}`,
    }));
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        finish({ ...runtime, ok: false, errors: [], reason: stderr.trim() || `OOXML schema validator exited with code ${code}.` });
        return;
      }
      try {
        const result = JSON.parse(stdout.trim() || '{}');
        const valid = result.isValid ?? result.valid ?? result.ok;
        const reportedErrors = Array.isArray(result.errors) ? result.errors : [];
        const classified = classifyOoxmlValidationErrors(reportedErrors);
        finish({
          ...runtime,
          ok: valid === true || (reportedErrors.length > 0 && classified.errors.length === 0),
          errors: classified.errors.slice(0, 500),
          compatibilityWarnings: classified.compatibilityWarnings.slice(0, 500),
          omittedErrors: Math.max(0, classified.errors.length - 500),
          rawValid: valid === true,
          officeVersion,
          validation: 'open-xml-sdk',
        });
      } catch (error) {
        finish({ ...runtime, ok: false, errors: [], reason: `Invalid OOXML schema validator output: ${error.message}` });
      }
    });
    const timeout = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ...runtime, ok: false, errors: [], reason: 'OOXML schema validation timed out after 120 seconds.' });
    }, 120_000);
    if (signal?.aborted) abort();
    else signal?.addEventListener?.('abort', abort, { once: true });
  });
}

export function ooxmlValidatorManifest() {
  return {
    version: VERSION,
    platforms: Object.keys(PLATFORM_PACKAGES),
    packages: Object.fromEntries(Object.entries(PLATFORM_PACKAGES).map(([key, value]) => [key, {
      name: value.name,
      integrity: value.integrity,
    }])),
  };
}
