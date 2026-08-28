/**
 * Public Computer Use host boundary.
 *
 * The current Windows implementation is isolated behind this facade so a
 * compiled native backend can replace it without changing desktop startup or
 * the renderer/session contract.
 */
import {
  createPowerShellComputerHost,
  type PowerShellComputerHost,
} from './computer-host-powershell';

export type {
  ChromeRemoteDebuggingSetup,
  ChromeRemoteDebuggingTarget,
} from './computer-host-powershell';
export type ComputerHost = PowerShellComputerHost;

export function createComputerHost(
  options: { bridgeEnabled?: boolean } = {},
): ComputerHost {
  return createPowerShellComputerHost(options);
}
