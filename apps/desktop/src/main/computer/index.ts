import type { ForegroundLeaseRuntime } from './backend/foreground-lock-host';
import { createPowerShellComputerHost, type PowerShellComputerHost } from './host/powershell-host';

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
    /** The desktop's Auto login setting (browserAutoSignIn), read per command. */
    savedLoginEnabled?: () => boolean;
    /** Replaces the lease thread and fallback unlock of the host's foreground lock, for a host
     *  bundled outside the app. */
    foregroundLease?: ForegroundLeaseRuntime;
  } = {}
): ComputerHost {
  return createPowerShellComputerHost(options);
}
