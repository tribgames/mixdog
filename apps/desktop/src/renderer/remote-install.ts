export type RemoteInstallMode = "hidden" | "prompt" | "ios";

export function remoteInstallMode(input: {
  remote: boolean;
  standalone: boolean;
  dismissed: boolean;
  canPrompt: boolean;
  ios: boolean;
}): RemoteInstallMode {
  if (!input.remote || input.standalone || input.dismissed) return "hidden";
  if (input.canPrompt) return "prompt";
  return input.ios ? "ios" : "hidden";
}

/** iOS install guidance. A Home Screen app runs in its OWN storage container,
 *  so the pairing has to ride the URL the install captures: "prepare" restores
 *  the scanned link before the Share sheet. Only a browser whose pairing has
 *  actually connected can offer one; without it the plain hint stands. */
export type IosInstallStep = "prepare" | "share" | "plain";

export function iosInstallStep(input: { handoff: boolean; prepared: boolean }): IosInstallStep {
  if (input.prepared) return "share";
  return input.handoff ? "prepare" : "plain";
}

export function isIosInstallPlatform(
  userAgent: string,
  platform: string,
  maxTouchPoints: number,
): boolean {
  return /iPad|iPhone|iPod/iu.test(userAgent)
    || (platform === "MacIntel" && maxTouchPoints > 1);
}
