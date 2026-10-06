// The parent's flags a worker thread may inherit. A worker rejects any flag that
// governs the process itself (heap sizes, inspector, TLS, test-runner settings)
// with ERR_WORKER_INVALID_EXEC_ARGV, and Node 24's test runner hands a child its
// whole option table in execArgv (--use-system-ca, --tls-cipher-list, ...), so a
// list of known-bad flags kept failing. Only what loads and resolves modules,
// and what governs warnings, carries over.
const INHERITED_FLAG =
  /^--(?:import|require|loader|experimental-loader|conditions|enable-source-maps|preserve-symlinks(?:-main)?|no-warnings|disable-warning|trace-warnings|no-deprecation|(?:no-)?experimental-[a-z0-9-]+)(?:=|$)/;
const SHORT_WITH_VALUE = new Set(['-r', '-C']);

export function workerExecArgv(execArgv = process.execArgv) {
  const source = Array.isArray(execArgv) ? execArgv.map(String) : [];
  const kept = [];
  for (let index = 0; index < source.length; index += 1) {
    const argument = source[index];
    const short = SHORT_WITH_VALUE.has(argument);
    if (!short && !INHERITED_FLAG.test(argument)) continue;
    kept.push(argument);
    // A flag written apart from its value (`--import tsx`) keeps the value too.
    const takesValue =
      short || /^--(?:import|require|loader|experimental-loader|conditions|disable-warning)$/.test(argument);
    if (takesValue && index + 1 < source.length) kept.push(source[++index]);
  }
  return kept;
}
