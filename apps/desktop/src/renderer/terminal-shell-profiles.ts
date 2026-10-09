// Detected shells are fetched ONCE per renderer session and shared by every
// terminal surface, so the picker opens on a ready list instead of flashing an
// empty state.

export type ShellProfile = { id: string; label: string; path: string; default?: boolean };

let shellProfilesCache: ShellProfile[] | null = null;
let shellProfilesRequest: Promise<ShellProfile[]> | null = null;

export const cachedShellProfiles = (): ShellProfile[] | null => shellProfilesCache;

export function loadShellProfiles(): Promise<ShellProfile[]> {
  if (shellProfilesCache) return Promise.resolve(shellProfilesCache);
  shellProfilesRequest ??= (async () => {
    try {
      const request = window.mixdogDesktop.termProfiles?.();
      const list = request ? await request : [];
      const profiles = Array.isArray(list) ? (list as ShellProfile[]) : [];
      // Only a real answer is cached; an empty/failed one retries next time,
      // so a transient IPC failure never pins "No shells detected".
      if (profiles.length) shellProfilesCache = profiles;
      return profiles;
    } catch {
      return [];
    } finally {
      if (!shellProfilesCache) shellProfilesRequest = null;
    }
  })();
  return shellProfilesRequest;
}
