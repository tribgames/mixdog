// Files that external processes (PowerShell, Office) must open by path cannot live
// inside an Electron ASAR archive; map them to the unpacked sidecar directory.
export function physicalAsarPath(path) {
  return String(path).replace(/([\\/][^\\/]+\.asar)([\\/])/i, '$1.unpacked$2');
}
