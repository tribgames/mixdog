export const REMOTE_PAIRING_STORAGE_KEYS = {
  token: 'mixdog.remote-token',
  server: 'mixdog.remote-server',
  paired: 'mixdog.remote-paired',
  e2eePublicKey: 'mixdog.remote-e2ee-public-key',
  e2eeSecret: 'mixdog.remote-e2ee-secret',
} as const;

export function isInvalidRemotePairingClose(
  event: Pick<CloseEvent, 'code' | 'reason'>,
): boolean {
  if (event.code === 4003) return true;
  if (event.code !== 4004) return false;
  return /relay encryption (?:handshake (?:required|timed out)|authentication failed)|invalid encrypted relay frame/iu
    .test(event.reason);
}

export function clearStoredRemotePairing(
  storage: Pick<Storage, 'removeItem'>,
): void {
  for (const key of Object.values(REMOTE_PAIRING_STORAGE_KEYS)) storage.removeItem(key);
}
