/**
 * Where a terminal reveal goes: the desktop window gets it whole (with the ack
 * id and each tab's directory); paired clients get the projection that carries
 * no ack id and no path.
 */
import { type DesktopTerminalRunRequest, remoteTerminalRun } from '../../shared/terminal-command';

export function createTerminalRunDispatch({
  sendToWindow,
  relay,
}: {
  /** False when no desktop window can take it. */
  sendToWindow(request: DesktopTerminalRunRequest): boolean;
  relay(request: DesktopTerminalRunRequest): void;
}): (request: DesktopTerminalRunRequest) => boolean {
  return (request) => {
    relay(remoteTerminalRun(request));
    return sendToWindow(request);
  };
}
