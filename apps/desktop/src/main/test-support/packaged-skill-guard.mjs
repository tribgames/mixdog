import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const { MIXDOG_ARTIFACT_SKILL_ENTRY: entry, MIXDOG_ARTIFACT_MODULES: modules } = process.env;
const driver = realpathSync.native(process.argv[2]);
assert.equal(realpathSync.native(process.argv[1]), entry);

function rejectResolution(message) {
  // Optional imports may catch a resolution error. Even then the smoke fails.
  process.exitCode = 1;
  assert.fail(message);
}

// Check the real target, not just the requested URL: Node can find packages
// above the artifact, and even an in-tree path can be a link to the checkout.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (resolved.url.startsWith('node:')) return resolved;
    if (!resolved.url.startsWith('file:')) rejectResolution(`non-file dependency: ${resolved.url}`);
    const target = realpathSync.native(fileURLToPath(resolved.url));
    if (target !== driver) {
      const location = relative(modules, target);
      if (!location || isAbsolute(location) || location.split(sep)[0] === '..') {
        rejectResolution(`${specifier} resolved outside the packaged modules: ${target}`);
      }
    }
    if (target === entry) globalThis[Symbol.for('mixdog.packaged-skill-entry')] = target;
    return resolved;
  },
});
