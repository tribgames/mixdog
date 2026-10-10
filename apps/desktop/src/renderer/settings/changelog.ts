export interface ChangelogRelease {
  version: string;
  date: string;
  body: string;
}

/** English release list with each version's translated section swapped in when the locale file has it. */
export function localizeReleases(english: ChangelogRelease[], localized: ChangelogRelease[]): ChangelogRelease[] {
  const byVersion = new Map(localized.map((release) => [release.version, release]));
  return english.map((release) => byVersion.get(release.version) ?? release);
}

/** The section announced on the first launch of `appVersion`, if the changelog has one. */
export function selectWhatsNew(releases: ChangelogRelease[], appVersion: string): ChangelogRelease | undefined {
  return releases.find((release) => release.version === `v${appVersion}`);
}

/** Released sections of CHANGELOG.md (`## v1.2.3 - YYYY-MM-DD`), newest first; Unreleased is skipped. */
export function parseChangelog(text: string): ChangelogRelease[] {
  return text
    .split(/^## /m)
    .slice(1)
    .flatMap((section) => {
      const newline = section.indexOf('\n');
      const heading = (newline === -1 ? section : section.slice(0, newline)).trim();
      const match = /^(v\d\S*)(?:\s+-\s+(\S+))?$/.exec(heading);
      const body = newline === -1 ? '' : section.slice(newline + 1).trim();
      return match && body ? [{ version: match[1], date: match[2] ?? '', body }] : [];
    });
}
