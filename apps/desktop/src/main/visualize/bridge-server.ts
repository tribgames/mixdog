/**
 * Loopback command server behind the runtime's `visualize` tool, published as
 * `visualize-bridge.json`. Same discovery, ownership and bearer-token auth as
 * the terminal bridge; a success answers `{ ok: true, text, tabs?, path? }`.
 */
import { LoopbackBridgeServer, type LoopbackBridgeServerOptions } from '../bridge/loopback-bridge-server';

export const VISUALIZE_BRIDGE_DISCOVERY_FILE = 'visualize-bridge.json';

export class VisualizeBridgeServer<TCommand extends object> extends LoopbackBridgeServer<TCommand> {
  constructor(options: LoopbackBridgeServerOptions<TCommand>) {
    super(
      // Room for a 512 KiB inline `content.source` after JSON escaping.
      { maxRequestBytes: 1536 * 1024, ...options },
      {
        discoveryFile: VISUALIZE_BRIDGE_DISCOVERY_FILE,
        label: 'visualize',
        successBody: (value) => ({ ...(value && typeof value === 'object' ? value : {}), ok: true }),
      }
    );
  }
}
