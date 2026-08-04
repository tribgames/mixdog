#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('project registry override isolates Direct E2E paths and marker writes', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-project-registry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const realHome = join(root, 'real-home');
  const isolatedFile = join(root, 'probe', 'projects.json');
  const projectPath = join(root, 'fixture-project');
  mkdirSync(projectPath, { recursive: true });

  const previousHome = process.env.MIXDOG_HOME;
  const previousFile = process.env.MIXDOG_PROJECTS_FILE;
  const previousMarkers = process.env.MIXDOG_DISABLE_PROJECT_MARKERS;
  process.env.MIXDOG_HOME = realHome;
  process.env.MIXDOG_PROJECTS_FILE = isolatedFile;
  process.env.MIXDOG_DISABLE_PROJECT_MARKERS = '1';
  try {
    const moduleUrl = new URL('../src/standalone/projects.mjs', import.meta.url);
    moduleUrl.searchParams.set('isolation-test', String(Date.now()));
    const projects = await import(moduleUrl.href);
    projects.addProject(projectPath);
    assert.equal(projects.listProjects()[0]?.path, projectPath);
    assert.equal(existsSync(isolatedFile), true);
    assert.equal(existsSync(join(realHome, 'projects.json')), false);
    assert.equal(existsSync(join(projectPath, '.mixdog', 'project.id')), false);
  } finally {
    restoreEnv('MIXDOG_HOME', previousHome);
    restoreEnv('MIXDOG_PROJECTS_FILE', previousFile);
    restoreEnv('MIXDOG_DISABLE_PROJECT_MARKERS', previousMarkers);
  }

  const runner = readFileSync(
    new URL('../apps/desktop/scripts/direct-e2e-windows.ps1', import.meta.url),
    'utf8',
  );
  assert.match(runner, /MIXDOG_PROJECTS_FILE/);
  assert.match(runner, /MIXDOG_DISABLE_PROJECT_MARKERS/);
});
