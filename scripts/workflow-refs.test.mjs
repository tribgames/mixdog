import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// What a workflow runs must exist on the branch: every script, manifest and action it names by a repository path, and
// every npm script it runs. Build outputs (apps/desktop/dist, .runtime, native/*/target) and the mobile workflows, whose
// paths are relative to apps/mobile, are not repository files and are left out.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(join(ROOT, file), 'utf8');
const scriptsOf = (dir) => Object.keys(JSON.parse(read(`${dir}package.json`)).scripts ?? {});
const NPM_SCRIPTS = { '': scriptsOf(''), 'apps/desktop': scriptsOf('apps/desktop/'), 'apps/relay': scriptsOf('apps/relay/') };

function workflowFiles() {
  const files = readdirSync(join(ROOT, '.github/workflows'))
    .filter((name) => name.endsWith('.yml') && !name.startsWith('mobile-'))
    .map((name) => `.github/workflows/${name}`);
  for (const action of readdirSync(join(ROOT, '.github/actions'))) files.push(`.github/actions/${action}/action.yml`);
  return files;
}

const PATH = /(?<![\w./-])((?:scripts|\.github\/(?:workflows|actions|scripts)|apps\/[\w-]+\/scripts|native\/[\w-]+(?:\/crates\/[\w-]+)?)\/[\w./@-]+\.(?:mjs|cjs|sh|ps1|py|json|yml|toml|rs))(?![\w/-])/g;
const NPM = /\bnpm\s+(?:--prefix\s+(\S+)\s+)?(?:run\s+(?:-s\s+)?([\w:.-]+)|(test|start))(?:[^\n]*?--prefix[ =](\S+))?/g;
const PREFIXED_TEST = /\bnpm\s+(?:test|run\s+(?:-s\s+)?test:[\w-]+)\s+--prefix\s+(apps\/[\w-]+)\s+--\s+([^;&|#]+)/g;
const FILE_SELECTOR = /^(?:[\w@.-]+\/)+[\w@.-]+\.[\w-]+$/;

function missingPathReferences(line, {
  exists = (path) => existsSync(join(ROOT, path)),
  isFile = (path) => statSync(join(ROOT, path), { throwIfNoEntry: false })?.isFile(),
} = {}) {
  const missing = [];
  // npm runs tests from the package. Consume these arguments here so the
  // repository-root scan doesn't check them again using the wrong directory.
  const rest = line.replace(PREFIXED_TEST, (_, prefix, filters) => {
    for (const arg of filters.trim().split(/\s+/)) {
      const selector = arg.replace(/^(['"])(.*)\1$/, '$2');
      if (!FILE_SELECTOR.test(selector)) continue;
      const path = `${prefix}/${selector}`;
      if (!isFile(path)) missing.push(path);
    }
    return '';
  });
  for (const [, path] of rest.matchAll(PATH)) {
    if (/[$*{]/.test(path) || /\/(target|dist)\//.test(path)) continue;
    if (!exists(path)) missing.push(path);
  }
  return missing;
}

test('every repository path a workflow names exists', () => {
  const missing = [];
  for (const file of workflowFiles()) {
    read(file)
      .split('\n')
      .forEach((line, index) => {
        for (const path of missingPathReferences(line)) {
          missing.push(`${file}:${index + 1} ${path}`);
        }
      });
  }
  assert.deepEqual(missing, []);
});

test('one missing desktop test file fails validation even if the other selector resolves', () => {
  const line = 'npm test --prefix apps/desktop -- scripts/first.test.mjs src/main/second.test.mjs src/renderer/';
  const paths = ['apps/desktop/scripts/first.test.mjs', 'apps/desktop/src/main/second.test.mjs'];
  for (const path of paths) {
    assert.deepEqual(missingPathReferences(line, { isFile: (candidate) => candidate === path }), paths.filter((other) => other !== path));
  }
});

test('every npm script a workflow runs exists in the package it runs it in', () => {
  const missing = [];
  for (const file of workflowFiles()) {
    read(file)
      .split('\n')
      .forEach((line, index) => {
        for (const match of line.matchAll(NPM)) {
          const name = match[2] ?? match[3];
          const prefix = (match[1] ?? match[4] ?? '').replace(/^["']|["']$/g, '').replace(/\/$/, '');
          if (prefix && !(prefix in NPM_SCRIPTS)) continue;
          // `working-directory:` is not part of the line: a name that exists in the root or the desktop package passes.
          const known = prefix ? NPM_SCRIPTS[prefix] : [...NPM_SCRIPTS[''], ...NPM_SCRIPTS['apps/desktop']];
          if (!known.includes(name)) missing.push(`${file}:${index + 1} npm run ${name}${prefix ? ` --prefix ${prefix}` : ''}`);
        }
      });
  }
  assert.deepEqual(missing, []);
});

test('no workflow names the deleted Node core pieces', () => {
  const REMOVED = /supervisor|build:tui|build:daemon|release-paths|shipped-history|google-oauth-client\.mjs/;
  const found = workflowFiles().flatMap((file) =>
    read(file)
      .split('\n')
      .map((line, index) => (REMOVED.test(line) ? `${file}:${index + 1} ${line.trim()}` : null))
      .filter(Boolean),
  );
  assert.deepEqual(found, []);
});