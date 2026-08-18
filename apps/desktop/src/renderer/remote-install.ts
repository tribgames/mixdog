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

export function isIosInstallPlatform(
  userAgent: string,
  platform: string,
  maxTouchPoints: number,
): boolean {
  return /iPad|iPhone|iPod/iu.test(userAgent)
    || (platform === "MacIntel" && maxTouchPoints > 1);
}
