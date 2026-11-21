// Electron's Linux binary links the system libglib/libgobject, so sharp's native addon binds g_object_* to them
// and the first pipeline dies with SIGSEGV in g_object_unref (sharp warns: SharpElectronLinux).
// The wasm build links nothing from the host.
import { registerHooks } from 'node:module';

const NATIVE_SHARP = /^@img\/sharp-linux(?:musl)?-[^/]+\/sharp\.node$/;

export function sharpElectronLinuxRedirect(specifier) {
  return NATIVE_SHARP.test(specifier) ? '@img/sharp-wasm32/sharp.node' : null;
}

if (process.versions.electron && process.platform === 'linux') {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      return nextResolve(sharpElectronLinuxRedirect(specifier) || specifier, context);
    },
  });
}
