import { createInlineSessionRuntimeHost } from './session-runtime-inline-host.mjs';
import { createSessionRuntimeHost } from './session-runtime-host.mjs';

export function resolveSessionRuntimeMode(value = process.env.MIXDOG_SESSION_RUNTIME_MODE) {
  const mode = String(value || 'inline').trim().toLowerCase();
  if (mode === 'inline') return 'inline';
  if (mode === 'process') return 'process';
  throw new Error(`unsupported MIXDOG_SESSION_RUNTIME_MODE=${JSON.stringify(value)}`);
}

export function createDaemonSessionRuntimeHost(options = {}, {
  createInline = createInlineSessionRuntimeHost,
  createProcess = createSessionRuntimeHost,
  mode = resolveSessionRuntimeMode(),
} = {}) {
  return mode === 'process' ? createProcess(options) : createInline(options);
}
