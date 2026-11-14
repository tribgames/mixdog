/**
 * Public Computer Use host boundary.
 *
 * The current Windows implementation is isolated behind this facade so a
 * compiled native backend can replace it without changing desktop startup or
 * the renderer/session contract.
 */
import type { ForegroundLeaseRuntime } from './backend/foreground-lock-host';
import { windowsWorkerFromEnvironment, type WindowsWorker } from './backend/host-worker-process';
import { createPowerShellComputerHost, type PowerShellComputerHost } from './host/powershell-host';

export type {
  ChromeRemoteDebuggingSetup,
  ChromeRemoteDebuggingTarget,
} from './host/powershell-host';
export type { WindowsWorker };
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
    /** Which program a Windows worker runs: the `mixdog-computer` helper (default) or the
     *  PowerShell host, kept as the rollback path. Unset, MIXDOG_COMPUTER_WINDOWS_WORKER decides. */
    windowsWorker?: WindowsWorker;
  } = {}
): ComputerHost {
  return createPowerShellComputerHost({ ...options, windowsWorker: options.windowsWorker ?? windowsWorkerFromEnvironment() });
}
