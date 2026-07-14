import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  GRAPH_PLATFORMS,
  PATCH_PLATFORMS,
  validateGraphManifest,
  validatePatchManifest,
  validateRuntimeManifest,
  verifyAssetDownloads,
  verifyReleaseAssets,
} from './verify-release-assets.mjs';

const VERSION = '1.2.3';
const APP_VERSION = '0.9.49';
const GRAPH_VERSION = '0.1.0';
const bytes = Buffer.from('local release fixture');
const sha256 = createHash('sha256').update(bytes).digest('hex');

function patchFixture() {
  return {
    version: VERSION,
    _comment: 'test fixture',
    assets: Object.fromEntries(Object.entries(PATCH_PLATFORMS).map(([platform, filename]) => [
      platform,
      {
        url: `https://github.com/tribgames/mixdog/releases/download/patch-v${VERSION}/${filename}`,
        sha256,
      },
    ])),
  };
}

function runtimeFixture() {
  return {
    release_tag: 'runtime-v1.2.3',
    assets: Object.fromEntries(Object.keys(PATCH_PLATFORMS).map((platform) => [
      platform,
      { url: `https://fixtures.invalid/${platform}`, sha256, size: bytes.length },
    ])),
  };
}

function graphFixture() {
  return {
    version: GRAPH_VERSION,
    _comment: 'test fixture',
    assets: Object.fromEntries(Object.entries(GRAPH_PLATFORMS).map(([platform, filename]) => [
      platform,
      {
        url: `https://github.com/tribgames/mixdog/releases/download/graph-v${GRAPH_VERSION}/${filename}`,
        sha256,
      },
    ])),
  };
}

function yamlScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return JSON.parse(trimmed);
  }
  return trimmed.replace(/\s+#.*$/, '').trim();
}

function yamlBlockEnd(lines, start, indent) {
  for (let index = start + 1; index < lines.length; index += 1) {
    const text = lines[index];
    if (/^\s*(?:#.*)?$/.test(text)) continue;
    if (text.match(/^\s*/)[0].length <= indent) return index;
  }
  return lines.length;
}

function yamlMappingEntry(text, indent) {
  if (text.match(/^\s*/)[0].length !== indent) return undefined;
  const match = text.slice(indent).match(/^("(?:\\.|[^"])*"|'(?:''|[^'])*'|[A-Za-z0-9_-]+):\s*(.*)$/);
  if (!match) return undefined;
  return { key: yamlScalar(match[1]), rawValue: match[2] };
}

function yamlChildren(lines, start, end, parentIndent) {
  let childIndent;
  const children = [];
  for (let index = start + 1; index < end; index += 1) {
    const text = lines[index];
    if (/^\s*(?:#.*)?$/.test(text)) continue;
    const indent = text.match(/^\s*/)[0].length;
    if (indent <= parentIndent) break;
    childIndent ??= indent;
    if (indent !== childIndent) continue;
    const entry = yamlMappingEntry(text, indent);
    if (entry) children.push({
      ...entry,
      index,
      indent,
      end: yamlBlockEnd(lines, index, indent),
    });
  }
  return children;
}

function yamlEnvironment(lines, parent) {
  const env = {};
  for (const entry of yamlChildren(lines, parent.index, parent.end, parent.indent)) {
    env[entry.key] = yamlScalar(entry.rawValue);
  }
  return env;
}

function yamlSteps(lines, parent) {
  const itemIndexes = [];
  let itemIndent;
  for (let index = parent.index + 1; index < parent.end; index += 1) {
    const match = lines[index].match(/^(\s*)-\s+(.*)$/);
    if (!match || /^\s*(?:#.*)?$/.test(lines[index])) continue;
    const indent = match[1].length;
    if (itemIndent === undefined) itemIndent = indent;
    if (indent === itemIndent) itemIndexes.push(index);
  }

  return itemIndexes.map((start, position) => {
    const end = itemIndexes[position + 1] ?? parent.end;
    const fieldIndent = itemIndent + 2;
    const fields = { env: {} };
    for (let index = start; index < end; index += 1) {
      const source = index === start
        ? lines[index].replace(/^\s*-\s+/, '')
        : lines[index].slice(fieldIndent);
      if (index !== start && lines[index].match(/^\s*/)[0].length !== fieldIndent) continue;
      const field = source.match(/^(name|run|uses|env):\s*(.*)$/);
      if (!field) continue;
      const [, key, rawValue] = field;
      if (key === 'env' && /^(?:#.*)?$/.test(rawValue)) {
        fields.env = yamlEnvironment(lines, {
          index,
          indent: fieldIndent,
          end: yamlBlockEnd(lines, index, fieldIndent),
        });
      } else if (key === 'run' && /^[|>][-+0-9]*\s*(?:#.*)?$/.test(rawValue)) {
        const commands = [];
        for (let blockIndex = index + 1; blockIndex < end; blockIndex += 1) {
          const blockLine = lines[blockIndex];
          if (blockLine.trim() === '' || /^\s*#/.test(blockLine)) continue;
          if (blockLine.match(/^\s*/)[0].length <= fieldIndent) break;
          commands.push(blockLine.trim());
        }
        fields.run = commands.join('\n');
      } else {
        fields[key] = yamlScalar(rawValue);
      }
    }
    return fields;
  });
}

function parseWorkflowSubset(workflow) {
  const lines = workflow.replaceAll('\r\n', '\n').split('\n');
  const roots = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => yamlMappingEntry(line, 0)?.key === 'jobs');
  assert.equal(roots.length, 1, 'workflow must define exactly one jobs mapping');
  const jobsBlock = {
    index: roots[0].index,
    indent: 0,
    end: yamlBlockEnd(lines, roots[0].index, 0),
  };
  const jobs = yamlChildren(lines, jobsBlock.index, jobsBlock.end, jobsBlock.indent).map((entry) => {
    const children = yamlChildren(lines, entry.index, entry.end, entry.indent);
    const envEntry = children.find((child) => child.key === 'env');
    const stepsEntry = children.find((child) => child.key === 'steps');
    const strategyEntry = children.find((child) => child.key === 'strategy');
    const matrixEntry = strategyEntry
      ? yamlChildren(lines, strategyEntry.index, strategyEntry.end, strategyEntry.indent)
        .find((child) => child.key === 'matrix')
      : undefined;
    const matrixLines = matrixEntry
      ? lines.slice(matrixEntry.index + 1, matrixEntry.end)
        .filter((line) => !/^\s*(?:#.*)?$/.test(line))
        .map((line) => line.trim())
      : [];
    const includeEntry = matrixEntry
      ? yamlChildren(lines, matrixEntry.index, matrixEntry.end, matrixEntry.indent)
        .find((child) => child.key === 'include')
      : undefined;
    const matrixInclude = includeEntry
      ? lines.slice(includeEntry.index + 1, includeEntry.end)
        .filter((line) => /^\s*-\s+/.test(line) && !/^\s*-\s*#/.test(line))
        .map((line) => line.replace(/^\s*-\s+/, '').trim())
      : [];
    return {
      name: entry.key,
      env: envEntry ? yamlEnvironment(lines, envEntry) : {},
      matrix: matrixEntry ? { lines: matrixLines, include: matrixInclude } : undefined,
      steps: stepsEntry ? yamlSteps(lines, stepsEntry) : [],
    };
  });
  return { jobs };
}

function workflowJob(workflow, name) {
  const matches = parseWorkflowSubset(workflow).jobs.filter((job) => job.name === name);
  assert.equal(matches.length, 1, `workflow must define exactly one jobs.${name}`);
  return matches[0];
}

function namedStep(job, name) {
  const matches = job.steps.filter((step) => step.name === name);
  assert.equal(matches.length, 1, `jobs.${job.name} must contain exactly one "${name}" step`);
  return matches[0];
}

function extractReleaseSteps(workflow) {
  return workflowJob(workflow, 'release').steps;
}

function runLines(step) {
  return step.run?.split('\n') ?? [];
}

function assertRunLine(step, line, message) {
  assert.ok(runLines(step).includes(line), message);
}

function matrixRowsWithKey(matrix, key) {
  return matrix.include.filter((row) => {
    const fields = row.match(/^\{(.*)\}$/)?.[1] ?? row;
    return new RegExp(`(?:^|,)\\s*${key}\\s*:`).test(fields);
  });
}

function effectiveStepEnv(job, step, key) {
  if (Object.hasOwn(step.env, key)) return step.env[key];
  return job.env[key];
}

function cargoBuildCommands(step) {
  return runLines(step).filter((line) => /\bcargo\s+build(?:\s|$)/.test(line));
}

function assertRepeatedCommand(commands, expected, count, message) {
  assert.equal(commands.length, count, message);
  for (const command of commands) {
    assert.equal(command, expected, message);
  }
}

function assertProvenanceDigestLinkage(step) {
  for (const line of [
    'FIRST=$(sha256 "_asset/$ASSET")',
    'SECOND=$(sha256 "$BIN")',
    'cmp "_asset/$ASSET" "$BIN"',
    'test "$FIRST" = "$SECOND"',
    'ASSET_DIGEST=$FIRST \\',
    'assetDigest: process.env.ASSET_DIGEST,',
  ]) {
    assertRunLine(step, line, `reproducibility step must preserve digest/provenance linkage: ${line}`);
  }
}

function assertMatrixRustflags(job) {
  assert.ok(job.matrix, 'jobs.build must define a strategy matrix');
  assert.ok(job.matrix.include.length > 0, 'jobs.build matrix must define include rows');
  assert.equal(
    matrixRowsWithKey(job.matrix, 'rustflags').length,
    job.matrix.include.length,
    'every jobs.build matrix include row must define rustflags',
  );
  assert.equal(
    job.env.RUSTFLAGS,
    '${{ matrix.rustflags }}',
    'jobs.build must set RUSTFLAGS from matrix.rustflags',
  );
}

function assertProtocolStep(job) {
  const protocol = namedStep(job, 'Test protocol');
  assert.equal(
    protocol.env.RUSTFLAGS,
    '',
    'protocol tests must explicitly clear RUSTFLAGS for loadable host proc-macro dylibs',
  );
  assertRunLine(
    protocol,
    'cargo test --locked --manifest-path native/mixdog-graph/Cargo.toml',
    'Test protocol step must own the locked graph protocol test command',
  );
}

function assertReproducibilityStep(job) {
  const reproducibility = namedStep(job, 'Build twice and compare');
  assert.equal(
    effectiveStepEnv(job, reproducibility, 'RUSTFLAGS'),
    '${{ matrix.rustflags }}',
    'reproducibility builds must preserve matrix RUSTFLAGS',
  );
  assertRepeatedCommand(
    cargoBuildCommands(reproducibility),
    'cargo build --locked --release --target "${{ matrix.target }}" --manifest-path native/mixdog-graph/Cargo.toml',
    2,
    'Build twice and compare must own exactly two targeted locked release cargo build commands',
  );
  assertProvenanceDigestLinkage(reproducibility);
}

function assertGraphReleaseRustflagsContract(workflow) {
  const build = workflowJob(workflow, 'build');
  assertMatrixRustflags(build);
  assertProtocolStep(build);
  assertReproducibilityStep(build);
}

function assertReleaseWorkflowOrdering(workflow) {
  const steps = extractReleaseSteps(workflow);
  const required = [
    ['Verify bundled release assets', 'node scripts/verify-release-assets.mjs'],
    ['Install', 'npm ci'],
    ['Execute code graph from a clean cache', 'npm run test:code-graph-clean-cache'],
    ['Focused release regressions', 'npm run test:release-focused'],
    ['Smoke', 'npm run smoke'],
    ['Publish', 'npm publish --provenance --access public'],
  ];
  const indexes = {};
  for (const [name, command] of required) {
    const matches = steps
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => step.name === name);
    assert.equal(matches.length, 1, `release workflow must contain exactly one "${name}" step`);
    assert.ok(
      matches[0].step.run?.split('\n').includes(command),
      `"${name}" step must run ${command}`,
    );
    indexes[name] = matches[0].index;
  }

  const asset = indexes['Verify bundled release assets'];
  const install = indexes.Install;
  const cleanCache = indexes['Execute code graph from a clean cache'];
  const focused = indexes['Focused release regressions'];
  const smoke = indexes.Smoke;
  const publish = indexes.Publish;
  assert.ok(asset < install, 'release asset blocker must run before Install');
  assert.ok(asset < cleanCache, 'release asset blocker must run before clean-cache graph execution');
  assert.ok(install < cleanCache, 'Install must run before clean-cache graph execution');
  assert.ok(cleanCache < focused, 'clean-cache graph execution must run before Focused release regressions');
  assert.ok(focused < smoke, 'Focused release regressions must run before Smoke');
  assert.ok(smoke < publish, 'Smoke must run before Publish');
  assert.ok(asset < publish, 'release asset blocker must run before Publish');
  assert.ok(cleanCache < publish, 'clean-cache graph execution must run before Publish');
}

test('accepts independent strict patch, runtime, app, and graph versions', () => {
  assert.equal(validatePatchManifest(patchFixture(), `[package]\nversion = "${VERSION}"\n`).version, VERSION);
  assert.equal(validateRuntimeManifest(runtimeFixture()).release_tag, 'runtime-v1.2.3');
  assert.equal(validateGraphManifest(graphFixture(), { version: APP_VERSION }).version, GRAPH_VERSION);
});

test('rejects stale Cargo version, partial schema, and wrong patch tag URL', () => {
  assert.throws(
    () => validatePatchManifest(patchFixture(), '[package]\nversion = "1.2.2"\n'),
    /does not match manifest version/,
  );

  const partial = patchFixture();
  delete partial.assets['linux-arm64'];
  assert.throws(
    () => validatePatchManifest(partial, `[package]\nversion = "${VERSION}"\n`),
    /keys must be exactly/,
  );

  const wrongTag = patchFixture();
  wrongTag.assets['linux-x64'].url = wrongTag.assets['linux-x64'].url.replace('patch-v1.2.3', 'patch-v1.2.2');
  assert.throws(
    () => validatePatchManifest(wrongTag, `[package]\nversion = "${VERSION}"\n`),
    /patch-v1\.2\.3/,
  );

  const extraPatch = patchFixture();
  extraPatch.assets['freebsd-x64'] = extraPatch.assets['linux-x64'];
  assert.throws(
    () => validatePatchManifest(extraPatch, `[package]\nversion = "${VERSION}"\n`),
    /keys must be exactly/,
  );

  const extraRuntime = runtimeFixture();
  extraRuntime.assets['freebsd-x64'] = extraRuntime.assets['linux-x64'];
  assert.throws(() => validateRuntimeManifest(extraRuntime), /keys must be exactly/);
});

test('rejects stale, noncanonical, partial, and malformed graph manifests', () => {
  const partial = graphFixture();
  delete partial.assets['darwin-arm64'];
  assert.throws(() => validateGraphManifest(partial, { version: APP_VERSION }), /keys must be exactly/);

  for (const replacement of [
    'https://github.com/tribgames/mixdog/releases/download/v0.7.18/mixdog-graph-linux-x64',
    'https://github.com/tribgames/mixdog/releases/download/graph-v0.1.1/mixdog-graph-linux-x64',
    'https://example.com/tribgames/mixdog/releases/download/graph-v0.1.0/mixdog-graph-linux-x64',
    'https://github.com/tribgames/mixdog/releases/download/graph-v0.1.0/mixdog-graph-wrong',
  ]) {
    const noncanonical = graphFixture();
    noncanonical.assets['linux-x64'].url = replacement;
    assert.throws(
      () => validateGraphManifest(noncanonical, { version: APP_VERSION }),
      /graph asset URL must be/,
    );
  }

  const malformedDigest = graphFixture();
  malformedDigest.assets['win32-x64'].sha256 = 'not-a-digest';
  assert.throws(
    () => validateGraphManifest(malformedDigest, { version: APP_VERSION }),
    /invalid graph asset sha256/,
  );

  const malformedVersion = graphFixture();
  malformedVersion.version = '0.1';
  assert.throws(
    () => validateGraphManifest(malformedVersion, { version: APP_VERSION }),
    /not strict MAJOR\.MINOR\.PATCH/,
  );
});

test('downloads local fixture responses, retries, and checks sha256 without network', async () => {
  let calls = 0;
  await verifyAssetDownloads(
    { fixture: { url: 'https://fixtures.invalid/asset', sha256, size: bytes.length } },
    {
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) throw new Error('fixture transient failure');
        return new Response(bytes);
      },
      retryDelay: async () => {},
    },
  );
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(
    verifyAssetDownloads(
      { fixture: { url: 'https://fixtures.invalid/asset', sha256: '0'.repeat(64) } },
      {
        fetchImpl: async () => {
          calls += 1;
          return new Response(bytes);
        },
        retryDelay: async () => {},
      },
    ),
    /verification failed after 3 attempts: sha256 mismatch/,
  );
  assert.equal(calls, 3);
});

test('cancels an undeclared-size patch stream immediately at the absolute ceiling', async () => {
  let chunksProduced = 0;
  let cancellations = 0;
  let aborts = 0;
  const stream = new ReadableStream(
    {
      pull(controller) {
        chunksProduced += 1;
        controller.enqueue(Buffer.from('abc'));
      },
      cancel() {
        cancellations += 1;
      },
    },
    { highWaterMark: 0 },
  );

  await assert.rejects(
    verifyAssetDownloads(
      { fixture: { url: 'https://fixtures.invalid/asset', sha256 } },
      {
        attempts: 1,
        maxAssetBytes: 5,
        fetchImpl: async (_url, { signal }) => {
          signal.addEventListener('abort', () => { aborts += 1; });
          return { ok: true, status: 200, body: stream };
        },
      },
    ),
    /byte ceiling exceeded \(5 bytes\)/,
  );
  assert.equal(chunksProduced, 2);
  assert.equal(cancellations, 1);
  assert.equal(aborts, 1);
});

test('cancels immediately when a stream exceeds its declared size below the absolute ceiling', async () => {
  let chunksProduced = 0;
  let cancellations = 0;
  let aborts = 0;
  const stream = new ReadableStream(
    {
      pull(controller) {
        chunksProduced += 1;
        controller.enqueue(Buffer.from('abc'));
      },
      cancel() {
        cancellations += 1;
      },
    },
    { highWaterMark: 0 },
  );

  await assert.rejects(
    verifyAssetDownloads(
      { fixture: { url: 'https://fixtures.invalid/asset', sha256, size: 5 } },
      {
        attempts: 1,
        maxAssetBytes: 10,
        fetchImpl: async (_url, { signal }) => {
          signal.addEventListener('abort', () => { aborts += 1; });
          return { ok: true, status: 200, body: stream };
        },
      },
    ),
    /byte ceiling exceeded \(5 bytes\)/,
  );
  assert.equal(chunksProduced, 2);
  assert.equal(cancellations, 1);
  assert.equal(aborts, 1);
});

test('full guard reads deterministic fixtures and downloads every declared asset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-release-assets-'));
  const paths = {
    patchManifestPath: join(dir, 'patch.json'),
    cargoPath: join(dir, 'Cargo.toml'),
    runtimeManifestPath: join(dir, 'runtime.json'),
    graphManifestPath: join(dir, 'graph.json'),
    packagePath: join(dir, 'package.json'),
  };
  await Promise.all([
    writeFile(paths.patchManifestPath, JSON.stringify(patchFixture())),
    writeFile(paths.cargoPath, `[package]\nversion = "${VERSION}"\n`),
    writeFile(paths.runtimeManifestPath, JSON.stringify(runtimeFixture())),
    writeFile(paths.graphManifestPath, JSON.stringify(graphFixture())),
    writeFile(paths.packagePath, JSON.stringify({ version: APP_VERSION })),
  ]);
  let downloads = 0;
  try {
    await verifyReleaseAssets({
      ...paths,
      downloadOptions: {
        attempts: 1,
        timeoutMs: 1000,
        fetchImpl: async () => {
          downloads += 1;
          return new Response(bytes);
        },
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(downloads, 15);
});

test('release workflow orders the asset and clean-cache blockers before consumers', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assertReleaseWorkflowOrdering(workflow);

  const quotedNames = workflow
    .replace('- name: Install', '- name: "Install"')
    .replace('- name: Smoke', "- name: 'Smoke'");
  assertReleaseWorkflowOrdering(quotedNames);

  const wrongStep = workflow
    .replace('run: npm run smoke', 'run: echo smoke')
    .replace('run: npm run test:release-focused', 'run: npm run test:release-focused\n      # npm run smoke');
  assert.throws(() => assertReleaseWorkflowOrdering(wrongStep), /"Smoke" step must run npm run smoke/);

  const otherJob = workflow
    .replace('run: npm run smoke', 'run: echo smoke')
    .replace(
      '\n  release:',
      '\n  decoy:\n    steps:\n      - name: Smoke\n        run: npm run smoke\n  release:',
    );
  assert.throws(() => assertReleaseWorkflowOrdering(otherJob), /"Smoke" step must run npm run smoke/);
});

test('graph release clears test RUSTFLAGS but keeps targeted reproducibility builds', async () => {
  const workflow = await readFile(new URL('../.github/workflows/graph-release.yml', import.meta.url), 'utf8');
  assertGraphReleaseRustflagsContract(workflow);

  const quotedNames = workflow
    .replace('- name: Test protocol', '- name: "Test protocol"')
    .replace('- name: Build twice and compare', "- name: 'Build twice and compare'");
  assertGraphReleaseRustflagsContract(quotedNames);

  assert.throws(
    () => assertGraphReleaseRustflagsContract(workflow.replace('          RUSTFLAGS: ""', '          RUSTFLAGS: "-C unsafe-for-host"')),
    /protocol tests must explicitly clear RUSTFLAGS/,
  );
  assert.throws(
    () => assertGraphReleaseRustflagsContract(workflow.replace('--release --target', '--release')),
    /exactly two targeted locked release cargo build commands/,
  );

  const renamedBuild = workflow
    .replace('\n  build:\n', '\n  renamed-build:\n')
    .replace(
      '\n  gate:',
      '\n  decoy-build:\n    env:\n      RUSTFLAGS: ${{ matrix.rustflags }}\n'
        + '    steps:\n      - name: Test protocol\n'
        + '        run: cargo test --locked --manifest-path native/mixdog-graph/Cargo.toml\n  gate:',
    );
  assert.throws(
    () => assertGraphReleaseRustflagsContract(renamedBuild),
    /exactly one jobs\.build/,
  );

  const commentedBuild = workflow.replace(
    '          cargo build --locked --release --target "${{ matrix.target }}" --manifest-path native/mixdog-graph/Cargo.toml',
    '          # cargo build --locked --release --target "${{ matrix.target }}" --manifest-path native/mixdog-graph/Cargo.toml',
  );
  assert.throws(
    () => assertGraphReleaseRustflagsContract(commentedBuild),
    /exactly two targeted locked release cargo build commands/,
  );

  const commandInWrongStep = workflow
    .replace(
      '        run: cargo test --locked --manifest-path native/mixdog-graph/Cargo.toml',
      '        run: echo protocol command moved',
    )
    .replace(
      '          test "$(git rev-parse HEAD)" = "${{ needs.gate.outputs.source_sha }}"',
      '          cargo test --locked --manifest-path native/mixdog-graph/Cargo.toml\n'
        + '          test "$(git rev-parse HEAD)" = "${{ needs.gate.outputs.source_sha }}"',
    );
  assert.throws(
    () => assertGraphReleaseRustflagsContract(commandInWrongStep),
    /Test protocol step must own/,
  );
});
