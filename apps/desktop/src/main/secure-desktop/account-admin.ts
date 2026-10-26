import { execFile } from 'node:child_process';

/**
 * Whether the Windows account running this app is an administrator, for the
 * phone's Windows-password sheet: only when it is not does the sheet ask for
 * an administrator account name too (the service's batch-logon path uses the
 * signed-in account when no name is sent, and refuses it unless it is an
 * administrator: native/mixdog-secure-desktop `logon.rs`, `not-admin`).
 *
 * Read from the process token's groups (`whoami /groups`, which lists group
 * SIDs, so it holds on any Windows language). The Administrators group is in
 * the token of an administrator whether the app runs elevated (enabled) or
 * not (a filtered token lists it "for deny only"), exactly the "full or
 * limited token" test of `logon.rs`; a standard account's token lacks it.
 */
const ADMINISTRATORS_SID = 'S-1-5-32-544';

/** A quoted SID field of a `whoami /groups /fo csv /nh` row. */
const SID_FIELD = /(?:^|,)"(S-1-\d+(?:-\d+)+)"(?=,|$)/gimu;

/**
 * Whether `whoami /groups /fo csv /nh` output lists the Administrators group
 * (by SID, whatever the group is called in this Windows language, and whether
 * it is enabled or for deny only); null when the output has no group SID at
 * all (a failed or unrecognizable run): not known, never "not an administrator".
 * Every token lists at least `Everyone` (S-1-1-0), so a real answer has SIDs.
 */
export function groupsListAdministrators(csv: string): boolean | null {
  const sids = [...csv.matchAll(SID_FIELD)].map((match) => match[1].toUpperCase());
  return sids.length ? sids.includes(ADMINISTRATORS_SID) : null;
}

const whoamiGroups = (): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      'whoami',
      ['/groups', '/fo', 'csv', '/nh'],
      { windowsHide: true, timeout: 10_000, maxBuffer: 1 << 20 },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    );
  });

/** The check, read once per app run (the account running the app does not
 *  change); a failed read is not kept, and answers null (not known). */
export function createAccountAdminCheck(groups: () => Promise<string> = whoamiGroups): () => Promise<boolean | null> {
  let known: Promise<boolean> | null = null;
  const read = async (): Promise<boolean> => {
    const admin = groupsListAdministrators(await groups());
    if (admin === null) throw new Error('the account groups could not be read');
    return admin;
  };
  return async () => {
    known ??= read();
    try {
      return await known;
    } catch {
      known = null;
      return null;
    }
  };
}
