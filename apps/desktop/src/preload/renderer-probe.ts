import { ipcRenderer } from 'electron';

import { DESKTOP_IPC } from '../shared/contract';
import { DESKTOP_PET_IPC } from '../shared/desktop-pet';
import type { DesktopRendererProbeApi } from '../shared/renderer-probe';

// Every channel main can send this window. While counting, each gets one
// listener of its own beside the subscriptions, which stay untouched: an off
// probe adds nothing to any message, and a channel nobody subscribes to still
// shows what it costs.
const CHANNELS = [...new Set<string>([...Object.values(DESKTOP_IPC), ...Object.values(DESKTOP_PET_IPC)])];

export function createRendererProbeBridge(): DesktopRendererProbeApi {
  const counts = new Map<string, number>();
  const counters = new Map<string, () => void>();
  return {
    enabled: () =>
      ipcRenderer.invoke(DESKTOP_IPC.rendererProbeEnabled).then(
        (on: unknown) => on === true,
        () => false
      ),
    countIpc(on) {
      if (on === counters.size > 0) return;
      if (on) {
        for (const channel of CHANNELS) {
          const counter = (): void => {
            counts.set(channel, (counts.get(channel) ?? 0) + 1);
          };
          counters.set(channel, counter);
          ipcRenderer.on(channel, counter);
        }
        return;
      }
      for (const [channel, counter] of counters) ipcRenderer.removeListener(channel, counter);
      counters.clear();
      counts.clear();
    },
    takeIpcCounts() {
      const taken = Object.fromEntries(counts);
      counts.clear();
      return taken;
    },
    write(record) {
      try {
        // As text, so main can refuse an oversized message before reading it.
        ipcRenderer.send(DESKTOP_IPC.rendererProbeLog, JSON.stringify(record));
      } catch {
        /* diagnostics only */
      }
    },
  };
}
