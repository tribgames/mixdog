import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { resolveStaticTarget } from './static-http.mjs';

const MAX_DOCUMENT_BYTES = 128 * 1024;
const MAX_ASSETS = 128;

function assetPath(value) {
  const path = String(value || '').replace(/^\.\//, '').replace(/^\//, '');
  if (!path || /[\\?#:]/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('invalid renderer asset path');
  }
  return `/${path}`;
}

/** Readiness checks run as the service account, not the root installer.
 *  The static resolver owns escape protection on both paths. */
export function inspectRenderer(rendererDir) {
  if (!rendererDir) throw new Error('renderer not configured');
  const files = new Map();
  const requireAsset = (value) => {
    const path = assetPath(value);
    if (files.has(path)) return files.get(path);
    if (files.size >= MAX_ASSETS) throw new Error('renderer asset list exceeds limit');
    const resolved = resolveStaticTarget(rendererDir, path);
    // Readiness never accepts the SPA fallback as an asset.
    if (resolved.status !== 200 || !/\.[a-z0-9]+$/i.test(path)) {
      throw new Error('required renderer asset missing');
    }
    accessSync(resolved.target, constants.R_OK);
    files.set(path, resolved.target);
    return resolved.target;
  };
  const readSmall = (value) => {
    const path = requireAsset(value);
    if (statSync(path).size > MAX_DOCUMENT_BYTES) throw new Error('renderer metadata exceeds limit');
    return readFileSync(path, 'utf8');
  };
  const document = readSmall('index.html');
  const version = /<meta name="mixdog-shell-version" content="([a-f0-9]{64})">/.exec(document)?.[1];
  const declared = /<meta name="mixdog-shell-assets" content="([^"]+)">/.exec(document)?.[1];
  if (!version || !declared) throw new Error('renderer release metadata missing');
  for (const asset of declared.split(',')) requireAsset(asset);
  // Cover the actual entry, styles and install metadata too; a stale metadata
  // list must not conceal a missing script referenced by the document.
  for (const match of document.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)=["']([^"']+)["'][^>]*>/gi)) {
    requireAsset(match[1]);
  }
  requireAsset('boot.js'); // CSP hashes the inlined script against this file.
  const manifest = JSON.parse(readSmall('manifest.webmanifest'));
  if (!manifest || typeof manifest !== 'object' || !manifest.start_url) {
    throw new Error('renderer manifest invalid');
  }
  for (const icon of manifest.icons ?? []) requireAsset(icon.src);
  const worker = readSmall('sw.js');
  for (const match of worker.matchAll(/\bimportScripts\(\s*["']([^"']+)["']\s*\)/g)) {
    requireAsset(match[1]);
  }
  return {
    status: 'ready',
    indexSha256: createHash('sha256').update(document).digest('hex'),
    version,
    assets: files.size,
  };
}

/** A bounded cache keeps a public probe from repeatedly walking the tree.
 *  Deployments restart the process, so the first check always sees the new
 *  release; later checks notice missing files without a process restart. */
export function createRendererReadiness(rendererDir, { cacheMs = 2000, now = Date.now } = {}) {
  let cached, expiresAt = 0;
  return () => {
    const time = now();
    if (cached && time < expiresAt) return cached;
    try {
      cached = { statusCode: 200, body: inspectRenderer(rendererDir) };
    } catch {
      // Do not expose filesystem paths or low-level permission errors publicly.
      cached = { statusCode: 503, body: { status: 'not-ready' } };
    }
    expiresAt = time + cacheMs;
    return cached;
  };
}
