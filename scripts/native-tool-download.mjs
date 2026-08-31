#!/usr/bin/env node

/**
 * Target-aware download of the product-native tools for a desktop build.
 *
 * The runtime fetchers (graph/patch/spawn) resolve the HOST's asset.
 * That is exactly right for an installed app fetching its own binary, and
 * exactly wrong for preparing a runtime for another platform — so rather than
 * teach three production code paths a build-only concern, this reads the same
 * manifests and names the target explicitly.
 *
 * The URL is rebuilt from the manifest version and the target instead of being
 * trusted verbatim, which keeps a rewritten manifest from redirecting the
 * download; the recorded sha256 still has to match the bytes that arrive.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MAX_NATIVE_BINARY_DOWNLOAD_BYTES,
  streamResponseToFile,
} from '../src/runtime/shared/bounded-download.mjs'

const RELEASE_ROOT = 'https://github.com/tribgames/mixdog/releases/download'
const TOOLS_DIR = new URL('../src/runtime/agent/orchestrator/tools/', import.meta.url)

export const NATIVE_TOOL_KINDS = Object.freeze(['graph', 'patch', 'spawn'])

/** Released asset name. */
export function nativeToolAssetName(kind, target) {
  const suffix = target.platform === 'win32' ? '.exe' : ''
  return `mixdog-${kind}-${target.platform}-${target.arch}${suffix}`
}

export function nativeToolAssetUrl(kind, version, target) {
  return `${RELEASE_ROOT}/${kind}-v${version}/${nativeToolAssetName(kind, target)}`
}

/** Installed name inside the app, named for the TARGET rather than the host. */
export function nativeToolInstalledName(kind, target) {
  return target.platform === 'win32' ? `mixdog-${kind}.exe` : `mixdog-${kind}`
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function download(url, destination, label) {
  // 4 attempts, 1s/3s/9s backoff. A 4xx is the manifest being wrong, not the
  // network being unlucky, so it ends the attempt sequence immediately.
  const delays = [1000, 3000, 9000]
  let lastError
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(180_000) })
      if (response.status >= 400 && response.status < 500) {
        throw new Error(`${label}: HTTP ${response.status} is terminal — ${url}`)
      }
      if (!response.ok) throw new Error(`${label}: HTTP ${response.status} — ${url}`)
      await streamResponseToFile(response, destination, {
        maxBytes: MAX_NATIVE_BINARY_DOWNLOAD_BYTES,
        label,
      })
      return
    } catch (error) {
      lastError = error
      if (String(error?.message || '').includes('is terminal')) throw error
      if (attempt < delays.length) {
        process.stderr.write(
          `${label}: attempt ${attempt + 1} failed (${error?.message}); retrying…\n`,
        )
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
      }
    }
  }
  throw lastError
}

export async function downloadNativeTool(kind, target, cacheDir) {
  const manifestPath = fileURLToPath(new URL(`${kind}-manifest.json`, TOOLS_DIR))
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const version = String(manifest?.version || '')
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${kind}-manifest.json carries no usable version: ${version || '(empty)'}`)
  }
  const key = `${target.platform}-${target.arch}`
  const asset = manifest?.assets?.[key]
  const expectedSha256 = String(asset?.sha256 || '').toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    const supported = Object.keys(manifest?.assets || {}).join(', ') || '(none)'
    throw new Error(`${kind}-manifest.json has no ${key} asset. Available: ${supported}.`)
  }
  const url = nativeToolAssetUrl(kind, version, target)
  if (asset.url !== url) {
    throw new Error(
      `${kind}-manifest.json ${key} url does not match its own release identity.\n`
      + `  manifest: ${asset.url}\n  expected: ${url}`,
    )
  }
  await mkdir(cacheDir, { recursive: true })
  const destination = join(cacheDir, `${nativeToolAssetName(kind, target)}-${version}`)
  const label = `${kind} ${key} download`
  try {
    if (await sha256File(destination) === expectedSha256) return destination
  } catch { /* absent or unreadable: download it */ }
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`
  await download(url, temporary, label)
  const actual = await sha256File(temporary)
  if (actual !== expectedSha256) {
    await rm(temporary, { force: true })
    throw new Error(`${label}: sha256 mismatch — expected ${expectedSha256}, got ${actual}`)
  }
  await rename(temporary, destination)
  return destination
}
