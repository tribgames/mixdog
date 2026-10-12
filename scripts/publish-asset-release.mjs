#!/usr/bin/env node
// Create or publish a NON-app release (effort-judge, voice, graph, spawn,
// mobile, ...) without ever moving GitHub's "Latest" pointer, which belongs to
// the newest app release (vX.Y.Z) alone.
//
//   publish-asset-release.mjs create  <tag> [gh release create options/files...]
//   publish-asset-release.mjs publish <tag>      # draft -> published
//
// Always passes --latest=false, and fails if Latest changed across the call.

import { pathToFileURL } from 'node:url';
import { APP_TAG_RE, currentLatestTag, gh } from './release-guard.mjs';

export function buildArgs(action, tag, extra = [], repo) {
  if (APP_TAG_RE.test(tag)) throw new Error(`${tag} is an app release tag; asset releases must not use it`);
  if (extra.some((arg) => /^--latest(=|$)/.test(arg))) {
    throw new Error('--latest is set by this script; do not pass it');
  }
  const scope = repo ? ['--repo', repo] : [];
  if (action === 'create') return ['release', 'create', tag, ...extra, ...scope, '--latest=false'];
  if (action === 'publish') return ['release', 'edit', tag, ...scope, '--draft=false', '--latest=false'];
  throw new Error(`unknown action ${action} (expected create|publish)`);
}

export function publishAssetRelease({ action, tag, extra = [], repo, run = gh }) {
  const args = buildArgs(action, tag, extra, repo);
  const before = currentLatestTag(repo, run);
  run(args);
  const after = currentLatestTag(repo, run);
  if (after !== before) {
    throw new Error(`Latest moved from ${before ?? 'none'} to ${after ?? 'none'} while ${action} ${tag}`);
  }
  return before;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [action, tag, ...extra] = process.argv.slice(2);
  if (!action || !tag) {
    throw new Error('usage: publish-asset-release.mjs <create|publish> <tag> [gh release create args...]');
  }
  const latest = publishAssetRelease({ action, tag, extra, repo: process.env.GITHUB_REPOSITORY });
  console.log(`${action} ${tag}: Latest unchanged (${latest ?? 'none'}).`);
}
