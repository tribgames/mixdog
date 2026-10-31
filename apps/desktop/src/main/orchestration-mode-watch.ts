import { configuredOrchestrationMode } from '../../../../src/runtime/shared/orchestration.mjs';
import type { DesktopOrchestrationMode } from '../shared/contract-session';
import { ORCHESTRATION_MODE_EVENT } from '../shared/orchestration-mode';
import type { MixdogConfigModule } from './settings-store';

/** Publish ORCHESTRATION_MODE_EVENT whenever the persisted config's orchestration
 *  default changes value, whoever wrote it (settings UI, the setup tool, another
 *  window or process). Its own narrow event: the stores caching the mode need
 *  no settings re-read (the broader settings-changed `agent` scope comes from
 *  agent-settings-watch.ts). Returns the unsubscribe (undefined on a config
 *  layer without change events). */
export function watchConfiguredOrchestrationMode(
  config: Pick<MixdogConfigModule, 'readConfig' | 'subscribeConfigChange'>,
  publish: (name: string, value: unknown) => void
): (() => void) | undefined {
  // Orchestration settings live in the persisted config's `agent` section, which
  // is what the runtime hands configuredOrchestrationMode; the root has none.
  const configured = (): DesktopOrchestrationMode =>
    configuredOrchestrationMode((config.readConfig() as { agent?: unknown } | null | undefined)?.agent);
  let known = configured();
  return config.subscribeConfigChange?.(() => {
    const next = configured();
    if (next === known) return;
    known = next;
    publish(ORCHESTRATION_MODE_EVENT, { mode: next });
  });
}
