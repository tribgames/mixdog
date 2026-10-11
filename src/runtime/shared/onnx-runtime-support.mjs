// onnxruntime-node ships no macOS Intel (darwin-x64) native binding since
// 1.23, so the features built on it (memory embeddings, the Auto effort
// judge) are unavailable there; everything else runs normally.
export function onnxRuntimeSupported(platform = process.platform, arch = process.arch) {
  return !(platform === 'darwin' && arch === 'x64');
}
