// Staged dynamic import of a large module graph. Loading a graph (file reads,
// compilation, evaluation) runs synchronously inside one import() call, so the
// daemon's session-runtime warm-up held the event loop for ~0.5 s in one
// piece right after `daemon-ready`. Importing the graph's top-level stages one
// loop turn apart splits that block without changing what is loaded.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A static `import … from './x'`, `export … from './x'` or bare `import './x'`
// at the start of a line, in source order.
const STATIC_RELATIVE_IMPORT =
  /^(?:import|export)\b[^;]*?\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]|^import\s*['"](\.{1,2}\/[^'"]+)['"]/gm;

/** The relative static imports of the module at `url`, resolved, in source order. */
export function staticRelativeImports(url) {
  const source = readFileSync(fileURLToPath(url), 'utf8');
  return [...source.matchAll(STATIC_RELATIVE_IMPORT)].map((match) => new URL(match[1] || match[2], url).href);
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

/**
 * import(url), after importing each static relative dependency of `stagesOf`
 * (in its source order, one loop turn apart). Module evaluation order is the
 * one a single import gives — dependencies depth-first in source order — as
 * long as no module of a stage's graph imports `stagesOf` or an importer of it
 * back. Staging stops at the first stage that fails, so no later stage
 * evaluates; the final import then reports the failure as a single import
 * would.
 */
export async function importInStages(url, stagesOf) {
  let stages = [];
  try {
    stages = staticRelativeImports(stagesOf);
  } catch {
    // Unreadable source: one import, as before.
  }
  for (const stage of stages) {
    try {
      await import(stage);
    } catch {
      break;
    }
    await nextTurn();
  }
  return import(url);
}
