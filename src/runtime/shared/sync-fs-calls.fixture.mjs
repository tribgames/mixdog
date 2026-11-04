// Test fixture: the synchronous node:fs calls `run` makes, as `method path`
// rows, through every import style (default, namespace, named bindings).
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

export async function syncFsCalls(run) {
  const calls = [];
  const real = new Map();
  for (const name of Object.keys(fs)) {
    if (!name.endsWith('Sync') || typeof fs[name] !== 'function') continue;
    const original = fs[name];
    real.set(name, original);
    fs[name] = function countedSync(...args) {
      calls.push(`${name} ${String(args[0])}`);
      return original.apply(this, args);
    };
  }
  syncBuiltinESMExports();
  try {
    await run();
  } finally {
    for (const [name, original] of real) fs[name] = original;
    syncBuiltinESMExports();
  }
  return calls;
}
