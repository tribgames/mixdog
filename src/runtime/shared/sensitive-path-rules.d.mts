export interface SensitiveScope {
  root: string[];
  /** Subfolders of the root that stay reachable. */
  except: readonly string[];
  /** Whole tree (a registered private root) or Mixdog's secret subset. */
  whole: boolean;
}
export function sensitivePathSegments(path: string): string[];
export function matchesSensitivePath(
  path: string,
  within?: readonly SensitiveScope[],
  options?: { envTemplates?: boolean }
): boolean;
export function mixdogSensitiveScopes(extraData?: readonly string[]): SensitiveScope[];
export function isSensitiveLocalPath(path: string, options?: { extraData?: readonly string[] }): boolean;
