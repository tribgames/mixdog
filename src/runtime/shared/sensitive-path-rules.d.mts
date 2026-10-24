export interface SensitiveScope {
  /** A Mixdog home or data folder, as path segments; only its secret subset is denied. */
  root: string[];
}
export function matchesSensitivePath(path: string, within?: readonly SensitiveScope[]): boolean;
export function mixdogSensitiveScopes(extraData?: readonly string[]): SensitiveScope[];
export function isSensitiveLocalPath(path: string, options?: { extraData?: readonly string[] }): boolean;
