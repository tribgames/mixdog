/*
 * components/statusline-module-loader.mjs — lazy import of the footer renderer.
 */
let statuslineModulePromise = null;

export function loadStatuslineModule() {
  if (!statuslineModulePromise) statuslineModulePromise = import('./statusline-render.mjs');
  return statuslineModulePromise;
}

export function resetStatuslineModuleLoad() {
  statuslineModulePromise = null;
}
