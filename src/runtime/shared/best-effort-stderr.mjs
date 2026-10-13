// stderr diagnostics that must never throw (closed or broken stderr).
export function writeStderrBestEffort(line) {
  try {
    process.stderr.write(line);
  } catch {
    /* diagnostics only */
  }
}
