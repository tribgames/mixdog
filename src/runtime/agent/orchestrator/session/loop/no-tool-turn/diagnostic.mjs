// stderr diagnostics for the no-tool recovery ladders; never throws.
export function writeLoopDiagnostic(line) {
  try {
    process.stderr.write(line);
  } catch {
    /* diagnostics only */
  }
}
