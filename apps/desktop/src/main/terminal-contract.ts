/** Spawn specification shared by Electron's validated terminal surface and the
 * singleton backend daemon. The renderer names only a detected profile ID; the
 * backend resolves that ID before starting a PTY. */
export interface TerminalSpawnProfile {
  path: string;
  args?: string[];
  env?: Record<string, string>;
}
