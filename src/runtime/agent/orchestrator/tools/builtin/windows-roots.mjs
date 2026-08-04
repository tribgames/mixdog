// Windows program-root derivation from present environment only. No guessed
// defaults: every candidate path must originate from a DEFINED env root, so a
// machine that lacks a given root simply contributes no candidates rather than
// inviting a hardcoded 'C:\\...' fallback.

// De-duped list of defined program-root dirs, in priority order. Undefined or
// empty env vars are dropped — never substituted with a literal default.
export function windowsProgramRoots() {
  const roots = [
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA,
  ].filter(Boolean)
  return [...new Set(roots)]
}

// Windows system root (e.g. the dir holding System32). Returns undefined when
// SystemRoot is absent — callers must treat that as "not detected", never as
// 'C:\\Windows'.
export function windowsSystemRoot() {
  return process.env.SystemRoot
}
