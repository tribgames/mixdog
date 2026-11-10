/*
 * components/statusline-module-loader.mjs — lazy import of src/ui/statusline.mjs.
 *
 * Must stay directly under components/: the specifier is resolved at runtime
 * relative to this file in source and to src/tui/dist/ in the bundle, and
 * '../../ui/statusline.mjs' is only correct from both of those depths.
 */
// Loaded at RUNTIME (not bundled) so its vendored statusline-lib relative
// imports resolve from the real src/ui location, not the dist/ bundle dir.
// esbuild leaves dynamic-import string specifiers alone.
const STATUSLINE_MODULE = '../../ui/statusline.mjs';
let statuslineModulePromise = null;

export function loadStatuslineModule() {
  if (!statuslineModulePromise) statuslineModulePromise = import(STATUSLINE_MODULE);
  return statuslineModulePromise;
}

export function resetStatuslineModuleLoad() {
  statuslineModulePromise = null;
}
