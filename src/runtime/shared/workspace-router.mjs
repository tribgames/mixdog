import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const PROJECT_MARKER_FILES = [
  '.git',
  'package.json',
  'pyproject.toml',
  'setup.py',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'build.sbt',
  'Package.swift',
  'composer.json',
];

const IGNORE_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.idea',
  '.vscode',
  '.cache',
  '.next',
  '.nuxt',
  '.turbo',
  'node_modules',
  '_backup',
  '_backups',
  'backup',
  'backups',
  '.backup',
  '.backups',
  'dist',
  'build',
  'out',
  'target',
  'bin',
  'obj',
  'coverage',
  'Library',
  'Temp',
  'Logs',
  'UserSettings',
]);

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_DIRS = 700;
const DEFAULT_MAX_CANDIDATES = 80;

function safeResolve(path) {
  try { return resolve(path); } catch { return null; }
}

function safeIsDirectory(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function samePath(left, right) {
  const a = safeResolve(left);
  const b = safeResolve(right);
  if (!a || !b) return false;
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function markerForDir(dir) {
  for (const marker of PROJECT_MARKER_FILES) {
    if (existsSync(join(dir, marker))) return marker === '.git' ? 'git' : marker;
  }
  if (existsSync(join(dir, 'ProjectSettings')) && existsSync(join(dir, 'Packages', 'manifest.json'))) {
    return 'unity';
  }
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.sln'))) {
      return 'solution';
    }
  } catch { /* unreadable */ }
  return null;
}

function projectFromRoot(root, marker) {
  const resolved = safeResolve(root);
  if (!resolved) return null;
  return {
    root: resolved,
    name: basename(resolved),
    marker: marker || markerForDir(resolved) || 'project',
  };
}

function findNearestProjectRoot(start) {
  const initial = safeResolve(start);
  if (!initial || !safeIsDirectory(initial)) return null;
  let cur = initial;
  while (true) {
    const marker = markerForDir(cur);
    if (marker) return projectFromRoot(cur, marker);
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function shouldIgnoreDir(name) {
  return IGNORE_DIRS.has(name) || name.startsWith('$') || name.endsWith('.tmp');
}

function discoverProjectCandidates(base, {
  maxDepth = DEFAULT_MAX_DEPTH,
  maxDirs = DEFAULT_MAX_DIRS,
  maxCandidates = DEFAULT_MAX_CANDIDATES,
} = {}) {
  const root = safeResolve(base);
  if (!root || !safeIsDirectory(root)) return [];

  const found = new Map();
  const queue = [{ dir: root, depth: 0 }];
  let visited = 0;

  while (queue.length && visited < maxDirs && found.size < maxCandidates) {
    const { dir, depth } = queue.shift();
    visited += 1;

    const marker = markerForDir(dir);
    if (marker) {
      const project = projectFromRoot(dir, marker);
      if (project) {
        const key = process.platform === 'win32' ? project.root.toLowerCase() : project.root;
        found.set(key, project);
      }
      continue;
    }

    if (depth >= maxDepth) continue;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink?.() || shouldIgnoreDir(entry.name)) continue;
      queue.push({ dir: join(dir, entry.name), depth: depth + 1 });
    }
  }

  return [...found.values()].sort((a, b) => a.root.localeCompare(b.root));
}

function uniqueProjects(projects) {
  const out = new Map();
  for (const project of projects || []) {
    if (!project?.root) continue;
    const key = process.platform === 'win32' ? resolve(project.root).toLowerCase() : resolve(project.root);
    if (!out.has(key)) out.set(key, project);
  }
  return [...out.values()].sort((a, b) => a.root.localeCompare(b.root));
}

function orderProjects(projects, activeProject) {
  const values = [...(projects || [])];
  values.sort((a, b) => {
    const aActive = activeProject?.root && samePath(a.root, activeProject.root);
    const bActive = activeProject?.root && samePath(b.root, activeProject.root);
    if (aActive !== bActive) return aActive ? -1 : 1;
    return a.root.localeCompare(b.root);
  });
  return values;
}

function preferGitProjects(projects, activeProject) {
  const values = [...(projects || [])];
  if (!values.some((project) => project.marker === 'git')) return values;
  return values.filter((project) => project.marker === 'git'
    || (activeProject?.root && samePath(project.root, activeProject.root)));
}

function scanBaseFor(currentCwd, activeProject) {
  if (activeProject?.root) return dirname(activeProject.root);
  return currentCwd;
}

function createWorkspaceRouter({
  entryCwd = process.cwd(),
  maxDepth = DEFAULT_MAX_DEPTH,
  maxDirs = DEFAULT_MAX_DIRS,
  maxCandidates = DEFAULT_MAX_CANDIDATES,
} = {}) {
  let cached = null;

  function snapshot(currentCwd) {
    const resolvedCwd = resolve(currentCwd || entryCwd || process.cwd());
    const activeProject = findNearestProjectRoot(resolvedCwd);
    const entryProject = findNearestProjectRoot(entryCwd);
    const scanBase = scanBaseFor(resolvedCwd, activeProject);
    const key = [
      process.platform === 'win32' ? scanBase.toLowerCase() : scanBase,
      maxDepth,
      maxDirs,
      maxCandidates,
    ].join('|');

    if (!cached || cached.key !== key) {
      cached = {
        key,
        projects: uniqueProjects([
          ...(entryProject ? [entryProject] : []),
          ...(activeProject ? [activeProject] : []),
          ...discoverProjectCandidates(scanBase, { maxDepth, maxDirs, maxCandidates }),
        ]),
      };
    }

    const candidates = orderProjects(
      preferGitProjects(cached.projects, activeProject),
      activeProject,
    );

    return {
      currentCwd: resolvedCwd,
      activeProject,
      scanBase,
      candidates,
      isProjectRoot: activeProject ? samePath(resolvedCwd, activeProject.root) : false,
    };
  }

  return { snapshot };
}

function formatWorkspaceSessionContext(snapshot) {
  if (!snapshot) return '';
  const candidates = (snapshot.candidates || []).slice(0, 20);
  const lines = ['# Workspace'];
  lines.push(`current cwd: ${snapshot.currentCwd}`);
  if (snapshot.activeProject) {
    lines.push(`detected project: ${snapshot.activeProject.name} (${snapshot.activeProject.root})`);
    if (!snapshot.isProjectRoot) {
      lines.push('current cwd is inside a project but is not the project root; set cwd to the project root before repo-wide work.');
    }
  } else {
    lines.push('detected project: none');
  }
  if (candidates.length) {
    lines.push('project candidates:');
    candidates.forEach((project, index) => {
      lines.push(`${index + 1}. ${project.name} [${project.marker}] ${project.root}`);
    });
  } else {
    lines.push('project candidates: none');
    lines.push('If the user asks for repo-scoped work, summarize that no project was detected and ask for the working directory.');
  }
  return lines.join('\n');
}

function resolveWorkspaceCwd(baseCwd, value) {
  const raw = String(value || '').trim();
  if (!raw) return resolve(baseCwd || process.cwd());
  return isAbsolute(raw) ? resolve(raw) : resolve(baseCwd || process.cwd(), raw);
}
