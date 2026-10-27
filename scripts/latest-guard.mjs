#!/usr/bin/env node
// Keep GitHub's "Latest" release on the newest published app release.
// Run by .github/workflows/latest-guard.yml. When Latest points elsewhere (or
// nowhere) it is set back with `gh release edit <tag> --latest`, the job
// summary and an issue describe what was wrong, and the job fails so the
// drift is visible even though it has been repaired.

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { currentLatestTag, gh, listReleases, selectLatestAppRelease } from './release-guard.mjs';

const ISSUE_TITLE = 'Latest release pointer drifted from the newest app release';

function report(text) {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

function openIssue(repo, body) {
  const existing = JSON.parse(
    gh([
      'issue',
      'list',
      '--repo',
      repo,
      '--state',
      'open',
      '--search',
      `"${ISSUE_TITLE}" in:title`,
      '--json',
      'number,title',
    ])
  ).find((issue) => issue.title === ISSUE_TITLE);
  if (existing) {
    gh(['issue', 'comment', String(existing.number), '--repo', repo, '--body', body]);
    return `commented on issue #${existing.number}`;
  }
  gh(['issue', 'create', '--repo', repo, '--title', ISSUE_TITLE, '--body', body]);
  return 'opened an issue';
}

export function main(repo = process.env.GITHUB_REPOSITORY) {
  const expected = selectLatestAppRelease(listReleases(repo));
  if (!expected) {
    report('No published app release (vX.Y.Z) exists; nothing to guard.');
    return 0;
  }
  const actual = currentLatestTag(repo);
  if (actual === expected.tag_name) {
    report(`Latest is ${actual}, the newest app release. OK.`);
    return 0;
  }

  const problem = `GitHub Latest was \`${actual ?? 'none'}\` but the newest published app release is \`${expected.tag_name}\`.`;
  gh(['release', 'edit', expected.tag_name, '--repo', repo, '--latest']);
  const repaired = currentLatestTag(repo);
  const outcome =
    repaired === expected.tag_name
      ? `Set Latest back to \`${expected.tag_name}\`.`
      : `Could not set Latest to \`${expected.tag_name}\`; it is now \`${repaired ?? 'none'}\`.`;
  const detail =
    `${problem}\n${outcome}\n\nWorkflow run: ${process.env.GITHUB_SERVER_URL ?? ''}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID ?? ''}\n` +
    'Check which release or workflow published a non-app release without `--latest=false` / `make_latest: false`.';
  report(`## Latest release guard\n${detail}`);
  try {
    report(`Issue: ${openIssue(repo, detail)}.`);
  } catch (error) {
    report(`Issue not filed: ${error.message}`);
  }
  return 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(main());
}
