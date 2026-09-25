// Argv reading shared by the scripts/ CLIs (bench, diag and smoke runners).
// `--name value` and `--name=value` are equivalent; a missing option yields
// the caller's fallback. `argv` is a seam for tests only — callers keep
// reading the live process arguments.
export function argValue(name, fallback = null, argv = process.argv) {
  const index = argv.indexOf(name);
  if (index >= 0 && index + 1 < argv.length) return argv[index + 1];
  const prefix = `${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

export function hasFlag(name, argv = process.argv) {
  return argv.includes(name);
}

// The non-flag entries of `argv` (user arguments only, e.g.
// process.argv.slice(2)). A bare `--name` consumes the next entry as its
// value unless it is in `booleanFlags`; `--name=value` consumes nothing.
export function positionalArgs(argv, booleanFlags) {
  return argv.filter((arg, index) => {
    if (arg.startsWith('--')) return false;
    const prev = index > 0 ? argv[index - 1] : '';
    return !(prev.startsWith('--') && !prev.includes('=') && !booleanFlags.has(prev));
  });
}

// A numeric option that keeps a deliberate 0 (or negative): only a missing,
// blank or non-numeric value takes the fallback.
export function numArg(name, fallback, argv = process.argv) {
  const raw = argValue(name, null, argv);
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// A positive-integer option: a missing, non-numeric or non-positive value
// keeps the fallback, so a typo degrades to the documented default instead of
// silently running with NaN.
export function intArg(name, fallback, argv = process.argv) {
  const parsed = Number.parseInt(argValue(name, String(fallback), argv), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
