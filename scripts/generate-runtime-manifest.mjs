#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { publishDraft, readAssets, readRelease, recordFile, uploadAssets, verifyAssets } from './ci/release-assets.mjs';
import { ensureDraft, listReleases, releaseState } from './ci/release-state.mjs';
import { selectRuntimeRelease } from './plan-runtime-release-tag.mjs';

const { GITHUB_REPOSITORY: repo, RELEASE_TAG: tag, RELEASE_REF: ref } = process.env;
const pg = { major: 16, minor: 4 };
const pgVersion = `${pg.major}.${pg.minor}`;
const pgvector = { version: '0.8.2' };
const platforms = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64'].map((key) => {
  const [os, arch] = key.split('-');
  const script = { linux: 'linux.sh', darwin: 'macos.sh', win32: 'windows.ps1' }[os];
  const buildHash = createHash('sha256').update(readFileSync(`scripts/build-runtime-${script}`)).digest('hex');
  const suffix = `${key}-pg${pgVersion}-pgvector${pgvector.version}`;
  return { key, os, arch, buildHash, tar: `mixdog-runtime-${suffix}.tar.gz`, marker: `build-success-${suffix}-${buildHash}.marker` };
});

const runtimeTag = /^runtime-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
if (!runtimeTag.test(tag ?? '') || !/^[a-f0-9]{40}$/.test(ref ?? '')) throw new Error('Expected a runtime tag and gated commit SHA');
const releases = listReleases(repo);
const remoteCommit = (name) => execFileSync('git', ['ls-remote', '--refs', 'origin', `refs/tags/${name}`], { encoding: 'utf8' }).trim().split(/\s+/)[0];
function belongsToCommit(name, state) {
  const remote = remoteCommit(name);
  return (!remote || remote === ref) && (state.state !== 'public' || remote === ref)
    && (!state.release || state.release.target_commitish === ref);
}

function requireCommit(name, state) {
  if (!belongsToCommit(name, state)) {
    throw new Error(`${name} does not belong to the gated commit ${ref}`);
  }
}

function plan() {
  const { release_tag: shipped } = JSON.parse(readFileSync('src/runtime/memory/data/runtime-manifest.json', 'utf8'));
  if (!runtimeTag.test(shipped)) throw new Error('Bundled runtime tag is invalid');
  const current = releaseState(releases, tag);
  const force = process.env.FORCE_REBUILD === 'true';
  const refresh = process.env.REFRESH_MANIFEST === 'true';
  const unchanged = tag === shipped && current.state === 'public'
    && platforms.every(({ marker }) => current.release.assets.some((asset) => asset.name === marker && asset.state === 'uploaded'));
  let selected = tag;
  let mode = 'skip';
  let refreshCommit = '';
  if (refresh && !force) {
    refreshCommit = remoteCommit(tag);
    if (current.state !== 'public' || current.release.prerelease !== false || !refreshCommit) {
      throw new Error('Manifest refresh requires an existing, published runtime tag and does not rebuild it');
    }
    mode = 'refresh';
  } else if (force || !unchanged) {
    ({ tag: selected, mode } = selectRuntimeRelease({ requested: tag, shipped, inspect: (candidate) => {
      const state = releaseState(releases, candidate);
      return { state: state.state, belongsToCommit: belongsToCommit(candidate, state) };
    } }));
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `tag=${selected}\nmode=${mode}\nhas_builds=${mode === 'build'}\nrefresh_commit=${refreshCommit}\n`);
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function publish() {
  const state = releaseState(releases, tag);
  const mode = process.env.RUNTIME_MODE;
  if (!['build', 'recover', 'refresh'].includes(mode) || (mode !== 'build' && state.state !== 'public')) {
    throw new Error(`Runtime release ${tag} changed state since it was planned`);
  }
  if (mode !== 'refresh') requireCommit(tag, state);
  const timestamp = execFileSync('git', ['show', '-s', '--format=%cI', ref], { encoding: 'utf8' }).trim();
  const generated = new Date(timestamp).toISOString(); // Identical when recovering the same release.
  const manifest = { schema_version: 1, generated_at: generated, release_tag: tag, pg, pgvector, assets: {} };
  const files = [];
  const expected = [];
  mkdirSync('dist', { recursive: true });
  for (const { key, os, arch, buildHash, tar, marker } of platforms) {
    const archive = join('smoke-results', `runtime-smoked-${tag}-${ref}-${key}`, tar);
    const sidecar = `${archive}.sha256`;
    const record = await recordFile(archive);
    const hash = record.digest.slice('sha256:'.length);
    if (readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0].toLowerCase() !== hash) {
      throw new Error(`${tar} does not match its smoked checksum`);
    }
    manifest.assets[key] = { url: `https://github.com/${repo}/releases/download/${tag}/${tar}`, sha256: hash, size: record.size };
    if (mode === 'refresh') {
      expected.push(record, await recordFile(sidecar));
      continue;
    }
    const markerPath = join('dist', marker);
    writeJson(markerPath, { build_hash: buildHash, pg_version: pgVersion, pgvector_version: pgvector.version,
      built_at: generated, commit_sha: ref, os, arch });
    files.push(archive, sidecar, markerPath);
    expected.push(record, await recordFile(sidecar), await recordFile(markerPath));
  }
  const manifestPath = 'dist/runtime-manifest.json';
  if (mode === 'refresh') {
    // Only the derived workflow artifact is refreshed; public assets are never edited.
    const commit = process.env.REFRESH_COMMIT;
    if (!commit || remoteCommit(tag) !== commit) throw new Error(`${tag} is not at the commit selected for refresh`);
    process.env.RELEASE_ID = String(state.release.id);
    readRelease(false, state.release.target_commitish);
    const names = expected.map(({ name }) => name);
    verifyAssets(readAssets().filter(({ name }) => names.includes(name) || /^mixdog-runtime-/.test(name)), expected, names);
    if (remoteCommit(tag) !== commit) throw new Error(`${tag} moved during verification`);
    writeJson(manifestPath, manifest);
    return;
  }
  writeJson(manifestPath, manifest);
  files.push(manifestPath);
  expected.push(await recordFile(manifestPath));
  const names = expected.map(({ name }) => name);
  // A failed aggregate can be re-run without re-running the planner. If it
  // already made the release public, only an exact match can complete the handoff.
  if (state.state === 'public') {
    process.env.RELEASE_ID = String(state.release.id);
    readRelease(false);
    verifyAssets(readAssets(), expected, names);
    return;
  }
  process.env.RELEASE_ID = String(ensureDraft(repo, tag, ref, releases));
  await uploadAssets(files);
  requireCommit(tag, state);
  publishDraft({ expected, names, latest: false });
  requireCommit(tag, { state: 'public' });
}

const [command] = process.argv.slice(2);
if (command === 'plan') plan();
else if (command === 'publish') await publish();
else throw new Error('Expected plan or publish');
