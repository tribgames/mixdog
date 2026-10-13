// The service client of a connection, reporting the window's trusted actions
// (model-proxy-grants) before they reach the daemon.
import type { DesktopCapability } from '../../shared/contract';
import { DesktopServiceClient } from '../desktop-service-client';
import { MODEL_USE_TRUSTED_CAPABILITIES } from '../model-proxy-grants';

type Base = DesktopServiceClient;

/** Each request in MODEL_USE_TRUSTED_REQUESTS, and each capability in
 *  MODEL_USE_TRUSTED_CAPABILITIES, calls `onTrusted` first, so this PC's grant
 *  exists before the server starts the work. Only the window's IPC handlers
 *  call these methods, after checking the sender is the window's main frame
 *  (ipc.ts); nothing the server sends reaches them. */
export class TrustedActionClient extends DesktopServiceClient {
  constructor(
    options: ConstructorParameters<typeof DesktopServiceClient>[0],
    private readonly onTrusted: () => void
  ) {
    super(options);
  }

  override submitNewTask(...args: Parameters<Base['submitNewTask']>): ReturnType<Base['submitNewTask']> {
    this.onTrusted();
    return super.submitNewTask(...args);
  }

  override submitToSession(...args: Parameters<Base['submitToSession']>): ReturnType<Base['submitToSession']> {
    this.onTrusted();
    return super.submitToSession(...args);
  }

  /** Only allowing a tool lets the user's work go on; a denial (or anything
   *  but an explicit allow) neither opens nor extends a grant. */
  override resolveToolApprovalForSession(
    ...args: Parameters<Base['resolveToolApprovalForSession']>
  ): ReturnType<Base['resolveToolApprovalForSession']> {
    if (args[2]?.approved === true) this.onTrusted();
    return super.resolveToolApprovalForSession(...args);
  }

  override inheritSession(...args: Parameters<Base['inheritSession']>): ReturnType<Base['inheritSession']> {
    this.onTrusted();
    return super.inheritSession(...args);
  }

  override continueSessionInModel(
    ...args: Parameters<Base['continueSessionInModel']>
  ): ReturnType<Base['continueSessionInModel']> {
    this.onTrusted();
    return super.continueSessionInModel(...args);
  }

  override scheduleQuotaResume(
    ...args: Parameters<Base['scheduleQuotaResume']>
  ): ReturnType<Base['scheduleQuotaResume']> {
    this.onTrusted();
    return super.scheduleQuotaResume(...args);
  }

  override invokeCapability<T = unknown>(capability: DesktopCapability, args?: unknown[], sessionId?: string) {
    if (MODEL_USE_TRUSTED_CAPABILITIES.has(capability)) this.onTrusted();
    return super.invokeCapability<T>(capability, args, sessionId);
  }
}
