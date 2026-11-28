// The state of the GitHub release for a tag, from the list of releases, never from a command's exit status: a listing that fails throws
// (the run stops), a tag with no release is `none` only when the whole listing is read and shows none, and a draft is told from a public
// release. Shared by deploy.yml's plan (which version to release) and release.yml's staging (which draft to fill).
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** @returns {{state: 'none'|'draft'|'public', release?: object}} */
export function releaseState(releases, tag) {
  const found = releases.filter((release) => release.tag_name === tag);
  if (found.length > 1) throw new Error(`${found.length} releases carry the tag ${tag}: refusing to pick one`);
  if (found.length === 0) return { state: 'none' };
  return { state: found[0].draft ? 'draft' : 'public', release: found[0] };
}

const gh = (args) =>
  execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
export const listReleases = (repo) =>
  JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`])).flat();

/**
 * The hidden draft to fill for a tag at a commit: one existing release is resumed only if it names this commit, and none is
 * created. A public one is a re-run after publication, which release-assets.mjs lets through only where it holds exactly the
 * run's assets, and never changes. The release is then bound by its id (every later job reads it by id).
 * @returns {{action: 'create'|'resume', id?: number}}
 */
export function stageDraft(releases, tag, ref) {
  const { state, release } = releaseState(releases, tag);
  if (state === 'none') return { action: 'create' };
  if (release.target_commitish !== ref)
    throw new Error(
      `the ${state} release ${release.id} of ${tag} targets ${release.target_commitish}, not ${ref}: it is not resumed`
    );
  return { action: 'resume', id: release.id };
}

export function ensureDraft(repo, tag, ref, releases = listReleases(repo)) {
  const decision = stageDraft(releases, tag, ref);
  return decision.action === 'resume'
    ? decision.id
    : JSON.parse(
        gh([
          'api',
          '--method',
          'POST',
          `repos/${repo}/releases`,
          '-f',
          `tag_name=${tag}`,
          '-f',
          `target_commitish=${ref}`,
          '-F',
          'draft=true',
          '-F',
          'prerelease=false',
        ])
      ).id;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { GITHUB_REPOSITORY: repo, RELEASE_TAG: tag, RELEASE_REF: ref } = process.env;
  const id = ensureDraft(repo, tag, ref);
  appendFileSync(process.env.GITHUB_OUTPUT, `id=${id}\n`);
}
