import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export function embeddingModelCachePath(cacheDir, modelId) {
  const root = resolve(cacheDir)
  const parts = String(modelId ?? '').split('/').filter(Boolean)
  if (
    parts.length === 0
    || parts.some((part) => part === '.' || part === '..' || part.includes('\\'))
  ) {
    throw new Error(`Invalid embedding model id: ${modelId}`)
  }
  const modelDir = resolve(root, ...parts)
  if (!modelDir.startsWith(`${root}${sep}`)) {
    throw new Error(`Embedding model cache escapes its root: ${modelId}`)
  }
  return modelDir
}

export async function compressEmbeddingModelCache(
  cacheDir,
  modelId,
  {
    platform = process.platform,
    accessPath = access,
    runCompact = execFileAsync,
  } = {},
) {
  if (platform !== 'win32') return { supported: false, compressed: false }

  const modelDir = embeddingModelCachePath(cacheDir, modelId)
  await accessPath(modelDir)
  await runCompact('compact.exe', [
    '/c',
    `/s:${modelDir}`,
    '/i',
    '/q',
    '/exe:lzx',
    `${modelDir}${sep}*`,
  ], {
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  })
  return { supported: true, compressed: true, modelDir }
}
