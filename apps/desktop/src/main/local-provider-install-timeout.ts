const LOCAL_PROVIDER_DOWNLOAD_TIMEOUT_MS = 6 * 60 * 60_000;
const TRANSPORT_COMPLETION_GRACE_MS = 5 * 60_000;

export const LOCAL_PROVIDER_INSTALL_REQUEST_TIMEOUT_MS =
  LOCAL_PROVIDER_DOWNLOAD_TIMEOUT_MS + TRANSPORT_COMPLETION_GRACE_MS;

export function localProviderInstallRequestTimeout(
  capability: string,
  args: unknown[] = [],
): number | undefined {
  if (capability === 'installLocalProviderModel') {
    return LOCAL_PROVIDER_INSTALL_REQUEST_TIMEOUT_MS;
  }
  if (capability === 'installBuiltinFeature' && args[0] === 'localProvider') {
    return LOCAL_PROVIDER_INSTALL_REQUEST_TIMEOUT_MS;
  }
  return undefined;
}
