import { cp, mkdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export function runtimePackageSource(rootDir, entryPath) {
  const relativePath = String(entryPath).replaceAll('/', sep);
  const source = resolve(rootDir, relativePath);
  if (source !== rootDir && !source.startsWith(`${rootDir}${sep}`)) {
    throw new Error(`Refusing to package a path outside the Mixdog root: ${entryPath}`);
  }
  return { relativePath, source };
}

export async function copyRuntimePackagePayload({ rootDir, manifest, destination }) {
  await mkdir(destination, { recursive: true });
  for (const entry of manifest.files) {
    const { relativePath, source } = runtimePackageSource(rootDir, entry.path);
    const target = join(destination, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true });
  }
}
