// Memory pressure, injected at load (a daemon-steady `MIXDOG_STEADY_STATE_MUTATION`
// module): a large retained heap, so that the working-set trimming the stress
// probe applies from its own child (the operating system taking the process's
// pages, as in the 2026-11-12 incident) leaves much to fault back in. Also
// loads the slow-disk injection, which a daemon takes only one module of.
import { writeFileSync } from 'node:fs';
import './daemon-slow-disk.mjs';

const megabytes = Number(process.env.MIXDOG_PRESSURE_MB ?? 256);
// Small objects, not one buffer: the collector walks them, touching every page.
globalThis.__memoryPressureBallast = Array.from({ length: megabytes * 1024 }, (_, i) => ({ i, text: `ballast-${i}`.padEnd(900, 'x') }));
// What was really allocated, for the probe's report (it states what was applied).
if (process.env.MIXDOG_PRESSURE_REPORT) {
  writeFileSync(process.env.MIXDOG_PRESSURE_REPORT, JSON.stringify({ heldMb: megabytes, objects: globalThis.__memoryPressureBallast.length }));
}
