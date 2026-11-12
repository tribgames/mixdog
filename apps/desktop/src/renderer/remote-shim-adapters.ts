// Every `remote-protocol-<group>.ts` next to this file is a phone adapter (unit PH-2): it exports `adapter`, a
// PhoneProtocolAdapter. Adding a group is adding the file; nothing here or in remote-shim.ts changes.
// A shared helper that is not an adapter (queue, chat, chat-host) is excluded below; remote-shim-adapters.test.mjs fails on one that is not.
import type { PhoneProtocolAdapter } from './remote-shim-protocol';

/** The adapters the bundle holds, in file-name order. */
export function bundledPhoneAdapters(): PhoneProtocolAdapter[] {
  const modules = import.meta.glob<{ adapter: PhoneProtocolAdapter }>(['./remote-protocol-*.ts', '!./remote-protocol-queue.ts', '!./remote-protocol-chat.ts', '!./remote-protocol-chat-host.ts'], { eager: true });
  return Object.keys(modules)
    .sort()
    .map((path) => modules[path].adapter);
}
