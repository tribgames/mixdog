// Every `remote-protocol-<group>.ts` next to this file is a phone adapter (unit PH-2): it exports `adapter`, a
// PhoneProtocolAdapter. Adding a group is adding the file; nothing here or in remote-shim.ts changes. A module that is not
// an adapter is named otherwise (`remote-chat-host.ts`), so the glob never finds it.
import type { PhoneProtocolAdapter } from './remote-shim-protocol';

/** The adapters of the modules the glob found, in file-name order; a module that exports none fails the boot by its path. */
export function adaptersOf(modules: Record<string, { adapter?: PhoneProtocolAdapter }>): PhoneProtocolAdapter[] {
  return Object.keys(modules)
    .sort()
    .map((path) => {
      const adapter = modules[path].adapter;
      const answers = adapter && [adapter.calls, adapter.fires, adapter.capabilities].some((table) => typeof table === 'object' && table !== null);
      if (!adapter || typeof adapter.group !== 'string' || !answers) throw new Error(`${path} exports no phone adapter`);
      return adapter;
    });
}

/** The adapters the bundle holds, in file-name order. */
export function bundledPhoneAdapters(): PhoneProtocolAdapter[] {
  return adaptersOf(import.meta.glob<{ adapter?: PhoneProtocolAdapter }>(['./remote-protocol-*.ts', '!./remote-protocol-queue.ts'], { eager: true }));
}
