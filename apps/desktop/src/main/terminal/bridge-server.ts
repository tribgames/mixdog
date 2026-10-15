/**
 * Loopback command server behind the runtime's `terminal` tool: the
 * shared loopback bridge published as `terminal-bridge.json`.
 */
import { LoopbackBridgeServer, type LoopbackBridgeServerOptions } from '../bridge/loopback-bridge-server';

export class TerminalBridgeServer<TCommand extends object> extends LoopbackBridgeServer<TCommand> {
  constructor(options: LoopbackBridgeServerOptions<TCommand>) {
    super(options, { discoveryFile: 'terminal-bridge.json', label: 'terminal' });
  }
}
