/** Spawn specification shared by Electron's validated terminal surface and the
 * singleton daemon. The renderer names only a detected profile ID; the
 * service resolves that ID before starting a PTY. */
export interface TerminalSpawnProfile {
  path: string;
  args?: string[];
  env?: Record<string, string>;
}
