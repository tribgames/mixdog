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
} from './host/powershell-host';

export type {
  ChromeRemoteDebuggingSetup,
  ChromeRemoteDebuggingTarget,
} from './host/powershell-host';
export type ComputerHost = PowerShellComputerHost;

export function createComputerHost(
  options: {
    bridgeEnabled?: boolean;
    observeOnly?: boolean;
    onDiagnostic?: (event: string, data: Record<string, unknown>) => void;
  } = {},
): ComputerHost {
  return createPowerShellComputerHost(options);
}
