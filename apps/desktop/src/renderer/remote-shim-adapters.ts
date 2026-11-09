// Every `remote-protocol-<group>.ts` next to this file is a phone adapter (unit PH-2): it exports `adapter`, a
// PhoneProtocolAdapter. Adding a group is adding the file; nothing here or in remote-shim.ts changes.
import type { PhoneProtocolAdapter } from './remote-shim-protocol';

/** The adapters the bundle holds, in file-name order. */
export function bundledPhoneAdapters(): PhoneProtocolAdapter[] {
  const modules = import.meta.glob<{ adapter: PhoneProtocolAdapter }>('./remote-protocol-*.ts', { eager: true });
  return Object.keys(modules)
    .sort()
    .map((path) => modules[path].adapter);
}
