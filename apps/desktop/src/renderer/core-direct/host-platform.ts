/** The host's OS as the operation lane wants it (it folds folder keys on Windows only). */
export function hostPlatform(): 'win32' | 'darwin' | 'linux' {
  const name = typeof navigator === 'object' ? String(navigator.platform ?? '') : '';
  if (/^win/i.test(name)) return 'win32';
  return /^mac/i.test(name) ? 'darwin' : 'linux';
}
