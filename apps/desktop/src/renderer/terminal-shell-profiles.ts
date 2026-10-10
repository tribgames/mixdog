// Detected shells are fetched ONCE per renderer session and shared by every
// terminal surface, so the picker opens on a ready list instead of flashing an
// empty state.

export type ShellProfile = { id: string; label: string; path: string; default?: boolean };

/** loading = not answered yet; ready = answered (possibly empty); failed =
 *  the request threw or returned a non-list, so the UI can offer a retry. */
export type ShellProfilesState =
  | { status: 'loading' }
  | { status: 'ready'; profiles: ShellProfile[] }
  | { status: 'failed' };

let shellProfilesCache: ShellProfile[] | null = null;
let shellProfilesRequest: Promise<ShellProfilesState> | null = null;

export const cachedShellProfiles = (): ShellProfile[] | null => shellProfilesCache;

export function loadShellProfiles(): Promise<ShellProfilesState> {
  if (shellProfilesCache) return Promise.resolve({ status: 'ready', profiles: shellProfilesCache });
  shellProfilesRequest ??= (async (): Promise<ShellProfilesState> => {
    try {
      const request = window.mixdogDesktop.termProfiles?.();
      const list = request ? await request : [];
      if (!Array.isArray(list)) return { status: 'failed' };
      const profiles = list as ShellProfile[];
      // Only a non-empty answer is cached; an empty one is shown as such but
      // re-asked on the next load.
      if (profiles.length) shellProfilesCache = profiles;
      return { status: 'ready', profiles };
    } catch {
      return { status: 'failed' };
    } finally {
      if (!shellProfilesCache) shellProfilesRequest = null;
    }
  })();
  return shellProfilesRequest;
}
