// Route sharp to its WebAssembly build when this process runs on Electron's
// Linux binary (the desktop daemon runs as ELECTRON_RUN_AS_NODE).
//
// The Electron executable links the system libglib/libgobject for GTK, so they
// sit in the global symbol scope before sharp loads. sharp's native addon then
// binds g_object_* to the system GObject instead of the copy bundled in its
// libvips, and the first pipeline dies with SIGSEGV inside g_object_unref —
// one pasted image restarted the whole daemon. sharp itself warns about this
// (SharpElectronLinux). The wasm build links nothing from the host, so it is
// immune; plain Node keeps the faster native addon.
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
