import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { platformAssetKey } from './install.mjs';
import {
  DEFAULT_DOWNLOAD_POLICY,
  projectConfigFileFor,
  readTidyConfig,
  resolveDownloadPolicy,
  resolveEngines,
  runnableEngines,
} from './resolve.mjs';
import { ENGINE_CATALOG } from './engines.mjs';

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'tidy-resolve-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function touch(path) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '');
  return path;
}

function fakeBin(dir, name) {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, name);
  writeFileSync(target, '');
  return target;
}

const noPathEnv = { PATH: '', Path: '' };

test('project config beats every other source', async (t) => {
  const root = workspace(t);
  mkdirSync(join(root, '.mixdog'), { recursive: true });
  writeFileSync(join(root, '.mixdog', 'tidy.json'), JSON.stringify({
    engines: { ruff: { command: '/opt/ruff', args: ['--config', 'x.toml'] } },
    policy: { downloads: 'never' },
  }));
  fakeBin(join(root, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin'), 'ruff');

  const { engines, policy } = await resolveEngines({
    cwd: root,
    engineIds: ['ruff'],
    probeVersions: false,
    env: noPathEnv,
  });
  assert.equal(engines[0].source, 'project-config');
  assert.equal(engines[0].command, '/opt/ruff');
  assert.deepEqual(engines[0].args, ['--config', 'x.toml']);
  assert.equal(policy.downloads, 'never');
  assert.equal(policy.source, 'project-config');
});

test('project-local beats PATH, and PATH beats a managed install', async (t) => {
  const root = workspace(t);
  const pathDir = join(root, 'fake-path');
  fakeBin(pathDir, 'ruff');
  fakeBin(join(root, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin'), 'ruff');
  const local = await resolveEngines({
    cwd: root,
    engineIds: ['ruff'],
    probeVersions: false,
    env: { PATH: pathDir },
  });
  assert.equal(local.engines[0].source, 'project-local');

  rmSync(join(root, '.venv'), { recursive: true, force: true });
  const onPath = await resolveEngines({
    cwd: root,
    engineIds: ['ruff'],
    probeVersions: false,
    env: { PATH: pathDir },
  });
  assert.equal(onPath.engines[0].source, 'path');
});

test('a managed install resolves under <pluginData>/tools/<engine>/<version>', async (t) => {
  const root = workspace(t);
  const pluginData = join(root, 'data');
  const binName = process.platform === 'win32' ? 'stylua.exe' : 'stylua';
  fakeBin(join(pluginData, 'tools', 'stylua', '0.20.0'), binName);
  const manifest = {
    version: 1,
    engines: {
      stylua: {
        version: '0.20.0',
        license: 'MPL-2.0',
        kind: ['format'],
        languages: ['lua'],
        source: 'upstream',
        assets: { [platformAssetKey()]: { url: 'https://example.invalid/stylua.zip', sha256: 'a'.repeat(64), archive: 'zip', binPath: binName } },
      },
    },
  };
  const { engines } = await resolveEngines({
    cwd: root,
    engineIds: ['stylua'],
    pluginData,
    manifest,
    probeVersions: false,
    env: noPathEnv,
  });
  assert.equal(engines[0].source, 'managed');
  assert.equal(engines[0].version, '0.20.0');
});

test('an unresolved engine reports its install hint and whether tidy can fetch it', async (t) => {
  const root = workspace(t);
  const manifest = {
    version: 1,
    engines: {
      shfmt: {
        version: '3.8.0',
        license: 'BSD-3-Clause',
        kind: ['format'],
        languages: ['bash'],
        source: 'mirror',
        assets: { [platformAssetKey()]: { url: 'https://example.invalid/shfmt', sha256: 'b'.repeat(64), archive: 'none', binPath: 'shfmt' } },
      },
    },
  };
  const { engines } = await resolveEngines({
    cwd: root,
    engineIds: ['shfmt', 'rustfmt'],
    pluginData: join(root, 'data'),
    manifest,
    probeVersions: false,
    env: noPathEnv,
  });
  const shfmt = engines.find((engine) => engine.id === 'shfmt');
  const rustfmt = engines.find((engine) => engine.id === 'rustfmt');
  assert.equal(shfmt.source, 'missing');
  assert.equal(shfmt.installable, true);
  assert.equal(shfmt.installHint, ENGINE_CATALOG.shfmt.installHint);
  // Toolchain engines are never downloadable, only hinted.
  assert.equal(rustfmt.source, 'missing');
  assert.equal(rustfmt.installable, undefined);
  assert.equal(rustfmt.toolchain, true);
  assert.deepEqual(runnableEngines(engines), []);
});

test('an engine the manifest cannot serve on this platform is not advertised as installable', async (t) => {
  const root = workspace(t);
  // clang-format ships no linux-arm64 build: the engine is in the manifest, but
  // there is no asset for this platform, so only the hint is honest.
  const manifest = {
    version: 1,
    engines: {
      'clang-format': {
        version: '20.0.0',
        license: 'Apache-2.0 WITH LLVM-exception',
        kind: ['format'],
        languages: ['c', 'cpp'],
        source: 'upstream',
        assets: {
          'someother-arch': { url: 'https://example.invalid/clang-format', sha256: 'e'.repeat(64), archive: 'none', binPath: 'clang-format' },
        },
      },
    },
  };
  const { engines } = await resolveEngines({
    cwd: root,
    engineIds: ['clang-format'],
    pluginData: join(root, 'data'),
    manifest,
    probeVersions: false,
    env: noPathEnv,
  });
  assert.equal(engines[0].source, 'missing');
  assert.equal(engines[0].installable, undefined);
  assert.equal(engines[0].installHint, ENGINE_CATALOG['clang-format'].installHint);
});

test('a project on Prettier/ESLint keeps them and stands Biome down', async (t) => {
  const root = workspace(t);
  const binDir = join(root, 'node_modules', '.bin');
  fakeBin(binDir, 'prettier');
  fakeBin(binDir, 'biome');
  writeFileSync(join(root, '.prettierrc'), '{}');
  const { engines } = await resolveEngines({
    cwd: root,
    engineIds: ['biome', 'prettier'],
    probeVersions: false,
    env: noPathEnv,
  });
  const biome = engines.find((engine) => engine.id === 'biome');
  const prettier = engines.find((engine) => engine.id === 'prettier');
  assert.equal(prettier.source, 'project-local');
  assert.equal(prettier.configFile, '.prettierrc');
  assert.equal(biome.source, 'project-local');
  assert.deepEqual(biome.suppressedBy, ['prettier']);
  assert.match(biome.skipped, /project uses prettier/);
  assert.deepEqual(runnableEngines(engines).map((engine) => engine.id), ['prettier']);
});

test('ESLint stays project-local only: a PATH copy is not adopted', async (t) => {
  const root = workspace(t);
  const pathDir = join(root, 'fake-path');
  fakeBin(pathDir, 'eslint');
  const { engines } = await resolveEngines({
    cwd: root,
    engineIds: ['eslint'],
    probeVersions: false,
    env: { PATH: pathDir },
  });
  assert.equal(engines[0].source, 'missing');
});

test('dprint without a project config is resolved but not run', async (t) => {
  const root = workspace(t);
  const pathDir = join(root, 'fake-path');
  fakeBin(pathDir, 'dprint');
  const withoutConfig = await resolveEngines({ cwd: root, engineIds: ['dprint'], probeVersions: false, env: { PATH: pathDir } });
  assert.equal(withoutConfig.engines[0].source, 'path');
  assert.match(withoutConfig.engines[0].skipped, /no project config/);

  writeFileSync(join(root, 'dprint.json'), '{}');
  const withConfig = await resolveEngines({ cwd: root, engineIds: ['dprint'], probeVersions: false, env: { PATH: pathDir } });
  assert.equal(withConfig.engines[0].skipped, undefined);
  assert.equal(withConfig.engines[0].configFile, 'dprint.json');
});

test('nothing detected means nothing resolved, not the whole catalog', async (t) => {
  const root = workspace(t);
  const { engines, policy } = await resolveEngines({ cwd: root, probeVersions: false, env: noPathEnv });
  assert.deepEqual(engines, []);
  assert.equal(policy.downloads, 'ask');
});

test('download policy defaults to ask and rejects unknown values', () => {
  assert.equal(resolveDownloadPolicy({ policy: {} }, {}).downloads, DEFAULT_DOWNLOAD_POLICY);
  assert.equal(resolveDownloadPolicy({ policy: { downloads: 'auto' } }, {}).downloads, 'auto');
  assert.equal(resolveDownloadPolicy({ policy: {} }, { MIXDOG_TIDY_DOWNLOADS: 'never' }).downloads, 'never');
  // Project config wins over the environment.
  assert.equal(resolveDownloadPolicy({ policy: { downloads: 'never' } }, { MIXDOG_TIDY_DOWNLOADS: 'auto' }).downloads, 'never');
  const bad = resolveDownloadPolicy({ policy: { downloads: 'sometimes' } }, {});
  assert.equal(bad.downloads, DEFAULT_DOWNLOAD_POLICY);
  assert.match(bad.warning, /not one of/);
});

test('a malformed tidy.json is reported instead of thrown', async (t) => {
  const root = workspace(t);
  mkdirSync(join(root, '.mixdog'), { recursive: true });
  writeFileSync(join(root, '.mixdog', 'tidy.json'), '{ broken');
  const config = readTidyConfig(root);
  assert.match(config.error, /cannot read \.mixdog\/tidy\.json/);
  const { config: reported } = await resolveEngines({ cwd: root, engineIds: ['ruff'], probeVersions: false, env: noPathEnv });
  assert.match(reported.error, /cannot read/);
});

test('pyproject [tool.ruff] counts as a project config marker', (t) => {
  const root = workspace(t);
  touch(join(root, 'pyproject.toml'));
  writeFileSync(join(root, 'pyproject.toml'), '[tool.ruff]\nline-length = 100\n');
  assert.equal(projectConfigFileFor(root, ENGINE_CATALOG.ruff), 'pyproject.toml');
});
