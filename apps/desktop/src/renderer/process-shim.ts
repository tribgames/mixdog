// Renderer-safe process stub. TUI-shared modules (theme.mjs OSC writes, env
// guards) reference `process` behind runtime checks; the browser renderer has
// no global. Must be the FIRST import of the renderer entry so it initializes
// before any shared-module top-level code runs.
type ProcessLike = { env: Record<string, string | undefined>; stdout?: undefined; platform?: string };
const globalRef = globalThis as { process?: ProcessLike };
if (!globalRef.process) {
  globalRef.process = { env: {}, stdout: undefined, platform: "win32" };
}
export {};
