// Decides the release tag a memory runtime build publishes under.
//
// Published runtime assets are immutable: every app that shipped a manifest
// naming a tag verifies that tag's assets by size and sha256, so replacing an
// asset under a shipped tag breaks the next runtime install of all of those
// apps. A build that would replace an asset of a shipped tag (any tag at or
// below the bundled manifest's release_tag) moves to the next patch tag; the
// manifest sync then points new app builds at it.
//
// CLI: node scripts/plan-runtime-release-tag.mjs <requested-tag> <shipped-tag> <needed-assets-file> <published-assets-file>
// prints the tag to build. The asset files hold one asset name per line.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const TAG_RE = /^runtime-v(\d+)\.(\d+)\.(\d+)$/;

function parseTag(tag) {
  const match = TAG_RE.exec(String(tag ?? '').trim());
  if (!match) throw new Error(`invalid runtime release tag: ${tag}`);
  return match.slice(1).map(Number);
}

export function compareTags(left, right) {
  const a = parseTag(left);
  const b = parseTag(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function nextRuntimeTag(tag) {
  const [major, minor, patch] = parseTag(tag);
  return `runtime-v${major}.${minor}.${patch + 1}`;
}

/** Reuse this commit's pending release, but never publish into someone else's tag. */
export function selectRuntimeRelease({ requested, shipped, inspect }) {
  let tag = compareTags(requested, shipped) > 0 ? requested : nextRuntimeTag(shipped);
  for (;;) {
    const { state, belongsToCommit } = inspect(tag);
    if (belongsToCommit) return { tag, mode: state === 'public' ? 'recover' : 'build' };
    tag = nextRuntimeTag(tag);
  }
}

export function planRuntimeReleaseTag({ requestedTag, shippedTag, neededAssets, publishedAssets }) {
  const published = new Set(publishedAssets);
  const replacesPublished = neededAssets.some((name) => published.has(name));
  if (!replacesPublished || compareTags(requestedTag, shippedTag) > 0) return requestedTag;
  return nextRuntimeTag(shippedTag);
}

function readNames(path) {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [requestedTag, shippedTag, neededPath, publishedPath] = process.argv.slice(2);
  process.stdout.write(
    `${planRuntimeReleaseTag({
      requestedTag,
      shippedTag,
      neededAssets: readNames(neededPath),
      publishedAssets: readNames(publishedPath),
    })}\n`
  );
}
