// The one way the slow replays "over a real core" find a built mixdogd: MIXDOGD_BIN names it (CI: the core-build artifact; locally:
// `cargo build -p mixdog-cli --features dev-controls` in native/core, then MIXDOGD_BIN=native/core/target/debug/mixdogd[.exe]).
// Some replays also need `--features "terminal-lease-clock replay-controls"`. No fallback to a machine-specific build folder:
// without a built core the test fails at once with this message instead of failing somewhere inside a spawned replay.
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export function builtCoreBin(env = process.env) {
  const named = String(env.MIXDOGD_BIN ?? '').trim();
  if (!named)
    throw new Error(
      'core not built: set MIXDOGD_BIN to a built mixdogd (cargo build -p mixdog-cli --features dev-controls, in native/core)'
    );
  const absolute = resolve(named);
  if (!existsSync(absolute))
    throw new Error(`core not built: MIXDOGD_BIN names a file that does not exist: ${absolute}`);
  // Started by its real path: the core finds its own processes by image path, which a path through a folder link is not.
  return realpathSync(absolute);
}
