// Electron Builder omits the architecture suffix for x64.
export function packagedOutputName(platform, arch) {
  const prefix = { darwin: 'mac', linux: 'linux', win32: 'win' }[platform];
  if (!prefix || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`Unsupported desktop package lane: ${platform}-${arch}`);
  }
  const suffix = arch === 'x64' ? '' : `-${arch}`;
  return `${prefix}${suffix}${platform === 'darwin' ? '' : '-unpacked'}`;
}
