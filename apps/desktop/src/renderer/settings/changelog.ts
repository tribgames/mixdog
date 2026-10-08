export interface ChangelogRelease {
  version: string;
  date: string;
  body: string;
}

/** Released sections of CHANGELOG.md (`## v1.2.3 - YYYY-MM-DD`), newest first; Unreleased is skipped. */
export function parseChangelog(text: string): ChangelogRelease[] {
  return text.split(/^## /m).slice(1).flatMap((section) => {
    const newline = section.indexOf('\n');
    const heading = (newline === -1 ? section : section.slice(0, newline)).trim();
    const match = /^(v\d\S*)(?:\s+-\s+(\S+))?$/.exec(heading);
    const body = newline === -1 ? '' : section.slice(newline + 1).trim();
    return match && body ? [{ version: match[1], date: match[2] ?? '', body }] : [];
  });
}
