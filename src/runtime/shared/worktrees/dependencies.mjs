/**
 * Automatic dependency preparation for a new managed worktree, for every
 * supported stack the committed files reveal; nothing to configure.
 *
 * A project folder is the root, a workspace package the root declares
 * (package.json `workspaces`, as npm, yarn and bun read it, or
 * pnpm-workspace.yaml `packages`), or any other nested folder whose
 * counterpart in the main checkout holds the stack's installed artefact
 * (node_modules, .venv): the user installed there, so it is a real project,
 * while a test fixture never is. Nothing inside node_modules counts. Per
 * folder and stack, the committed lockfile or manifest decides:
 *
 *   JS       package-lock.json / pnpm-lock.yaml / yarn.lock / bun.lock(b)
 *            → npm ci, pnpm|bun install --frozen-lockfile, yarn install
 *              --immutable (Yarn 2+) or --frozen-lockfile (Yarn 1)
 *   Python   uv.lock → uv sync --frozen; poetry.lock → poetry install
 *            --no-root; Pipfile.lock → pipenv sync; requirements*.txt alone
 *            → a .venv and pip install -r
 *
 * Further stacks are one STACKS entry each (see there). Java (Gradle, Maven),
 * Rust and Go fetch on their own and need nothing.
 *
 * Nothing is shared with the main checkout: every artefact is installed in
 * the worktree folder at the start of the session's first turn
 * (setup-commands.mjs). A linked node_modules is never safe: `npm ci` lists
 * the folder it finds and deletes each entry, which through a link (junction
 * or symlink) are the main checkout's, and other installs prune or rebuild in
 * place the same way. A folder whose artefact already exists in the worktree
 * is left alone; while any is a link (made by hand, or by an earlier version
 * and not yet detached, manager detachDependencyLinks), nothing in the
 * worktree is installed, since an install can reach other folders than its
 * own. A tool that is not on PATH is skipped with a note.
 */
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { which } from '../../tidy/process.mjs';
import { runGit } from './git.mjs';
import { runWorktreeSetupCommands } from './setup-commands.mjs';

/** JS lockfile → package manager, in the order a folder with several picks one. */
const JS_LOCKFILES = [
  ['package-lock.json', 'npm'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
];
/**
 * Every Python install builds the worktree's own `.venv`, never an inherited
 * or activated environment: the activation variables are removed (`uv sync`,
 * the `py` launcher, poetry and pipenv all honour VIRTUAL_ENV; poetry also a
 * conda prefix; uv also UV_PROJECT_ENVIRONMENT), and poetry and pipenv are
 * told to create the environment in the project folder.
 */
const PYTHON_ENV = Object.freeze({
  VIRTUAL_ENV: null,
  CONDA_PREFIX: null,
  UV_PROJECT_ENVIRONMENT: null,
  POETRY_VIRTUALENVS_CREATE: 'true',
  POETRY_VIRTUALENVS_IN_PROJECT: 'true',
  PIPENV_VENV_IN_PROJECT: '1',
});
const VERSION_TIMEOUT_MS = 30_000;
const quote = (value) => (/[\s"&|<>^()]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value);
const escapeRegExp = (text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

async function yarnInstallFlag(tool, cwd, signal) {
  const report = await runWorktreeSetupCommands({
    commands: [{ command: `"${tool}" --version`, file: tool, args: ['--version'], cwd }],
    signal,
    timeoutMs: VERSION_TIMEOUT_MS,
  });
  const major = Number.parseInt(report.steps[0]?.output.trim() ?? '', 10);
  if (report.status !== 'completed' || !Number.isInteger(major)) return null;
  return major >= 2 ? '--immutable' : '--frozen-lockfile';
}

/**
 * The supported stacks. Adding one (Ruby, PHP, .NET, Elixir, Dart, …) is one
 * entry here and nothing else:
 *   stack     its name;
 *   names     the committed basenames it reads;
 *   globs     committed basename globs it reads (`*` within a name), optional;
 *   artefact  the folder an install leaves: the main checkout having it
 *             admits a nested folder, the worktree having it skips the folder;
 *   pick(files)  the folder's committed basenames → { manager, lockfile?, … }
 *                or null;
 *   install(match, { cwd, tool, signal })
 *                → { tools, args, followUp?, env? } (tools: names tried on
 *                PATH in order; args: an argument array, run without a shell;
 *                followUp: a second step `{ file, args }`; env: variables
 *                to set, or null to remove, for the run), or null when it
 *                cannot be run. Called without `tool` to name the install, then
 *                with the resolved tool path, for arguments that depend on its
 *                version.
 */
const STACKS = [
  {
    stack: 'js',
    names: ['package.json', ...JS_LOCKFILES.map(([name]) => name)],
    artefact: 'node_modules',
    pick(files) {
      if (!files.has('package.json')) return null;
      const match = JS_LOCKFILES.find(([name]) => files.has(name));
      return match ? { manager: match[1], lockfile: match[0] } : null;
    },
    async install({ manager }, { cwd, tool, signal }) {
      if (manager === 'npm') return { tools: ['npm'], args: ['ci'] };
      if (manager !== 'yarn') return { tools: [manager], args: ['install', '--frozen-lockfile'] };
      if (!tool) return { tools: ['yarn'], args: ['install', '--frozen-lockfile'] };
      const flag = await yarnInstallFlag(tool, cwd, signal);
      return flag ? { tools: ['yarn'], args: ['install', flag] } : null;
    },
  },
  {
    stack: 'python',
    names: ['uv.lock', 'poetry.lock', 'Pipfile.lock'],
    globs: ['requirements*.txt'],
    artefact: '.venv',
    pick(files) {
      if (files.has('uv.lock')) return { manager: 'uv', lockfile: 'uv.lock' };
      if (files.has('poetry.lock')) return { manager: 'poetry', lockfile: 'poetry.lock' };
      if (files.has('Pipfile.lock')) return { manager: 'pipenv', lockfile: 'Pipfile.lock' };
      const requirements = [...files]
        .filter((name) => /^requirements.*\.txt$/i.test(name))
        .sort((a, b) => (a === 'requirements.txt' ? -1 : b === 'requirements.txt' ? 1 : a.localeCompare(b)));
      return requirements.length ? { manager: 'pip', requirements } : null;
    },
    install({ manager, requirements }, { cwd }) {
      const env = PYTHON_ENV;
      if (manager === 'uv') return { tools: ['uv'], args: ['sync', '--frozen'], env };
      if (manager === 'poetry') return { tools: ['poetry'], args: ['install', '--no-root'], env };
      if (manager === 'pipenv') return { tools: ['pipenv'], args: ['sync'], env };
      // requirements*.txt without a lockfile: a project-local virtualenv.
      const venvPython = join(
        cwd,
        ...(process.platform === 'win32' ? ['.venv', 'Scripts', 'python.exe'] : ['.venv', 'bin', 'python'])
      );
      return {
        tools: process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'],
        args: ['-m', 'venv', '.venv'],
        followUp: { file: venvPython, args: ['-m', 'pip', 'install', ...requirements.flatMap((name) => ['-r', name])] },
        env,
      };
    },
  },
  {
    stack: 'ruby',
    names: ['Gemfile.lock'],
    artefact: '.bundle',
    pick: (files) => (files.has('Gemfile.lock') ? { manager: 'bundler', lockfile: 'Gemfile.lock' } : null),
    install: () => ({ tools: ['bundle'], args: ['install', '--frozen'] }),
  },
  {
    stack: 'php',
    names: ['composer.lock'],
    artefact: 'vendor',
    pick: (files) => (files.has('composer.lock') ? { manager: 'composer', lockfile: 'composer.lock' } : null),
    install: () => ({ tools: ['composer'], args: ['install', '--no-interaction'] }),
  },
  {
    stack: 'dotnet',
    names: ['packages.lock.json'],
    globs: ['*.csproj'],
    artefact: 'obj',
    pick(files) {
      if (files.has('packages.lock.json')) return { manager: 'dotnet', lockfile: 'packages.lock.json' };
      return [...files].some((name) => /\.csproj$/i.test(name)) ? { manager: 'dotnet' } : null;
    },
    install: ({ lockfile }) => ({ tools: ['dotnet'], args: lockfile ? ['restore', '--locked-mode'] : ['restore'] }),
  },
  {
    stack: 'elixir',
    names: ['mix.lock'],
    artefact: 'deps',
    pick: (files) => (files.has('mix.lock') ? { manager: 'mix', lockfile: 'mix.lock' } : null),
    install: () => ({ tools: ['mix'], args: ['deps.get', '--check-locked'] }),
  },
  {
    stack: 'dart',
    names: ['pubspec.lock'],
    artefact: '.dart_tool',
    pick: (files) => (files.has('pubspec.lock') ? { manager: 'pub', lockfile: 'pubspec.lock' } : null),
    async install(_match, { cwd }) {
      const pubspec = await readOrNull(join(cwd, 'pubspec.yaml'));
      const flutter = pubspec && /^\s+flutter\s*:/m.test(pubspec.toString('utf8'));
      return { tools: [flutter ? 'flutter' : 'dart'], args: ['pub', 'get', '--enforce-lockfile'] };
    },
  },
];

const STACK_NAMES = new Set(STACKS.flatMap((stack) => stack.names));
const STACK_GLOBS = STACKS.flatMap((stack) => stack.globs ?? []);
const STACK_GLOB_MATCHERS = STACK_GLOBS.map((glob) => new RegExp(`^${segmentPattern(glob)}$`, 'i'));

/** A glob path segment (`*` within the segment) as a regular expression source. */
function segmentPattern(glob) {
  return escapeRegExp(glob).replace(/\*/g, '[^/]*');
}

function relevantName(name) {
  return STACK_NAMES.has(name) || STACK_GLOB_MATCHERS.some((matcher) => matcher.test(name));
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

async function readOrNull(path) {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

function folderPath(root, dir) {
  return dir ? join(root, ...dir.split('/')) : root;
}

function folderLabel(dir) {
  return dir || 'project root';
}

/** The `packages:` list of a pnpm-workspace.yaml (block or flow style). */
function pnpmWorkspacePatterns(text) {
  const patterns = [];
  let inPackages = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    const top = /^packages\s*:\s*(.*)$/.exec(line);
    if (top) {
      const flow = /^\[(.*)\]$/.exec(top[1].trim());
      if (flow) patterns.push(...flow[1].split(','));
      inPackages = !flow;
      continue;
    }
    if (!inPackages) continue;
    const item = /^\s+-\s*(.+)$/.exec(line);
    if (item) patterns.push(item[1]);
    else if (!/^\s/.test(line)) inPackages = false;
  }
  return patterns.map((pattern) => pattern.trim().replace(/^(['"])(.*)\1$/, '$2')).filter(Boolean);
}

/** The workspace package patterns the root package.json and pnpm-workspace.yaml declare. */
async function workspacePatterns(projectDir) {
  const patterns = [];
  try {
    const { workspaces } = JSON.parse(String(await readOrNull(join(projectDir, 'package.json'))));
    const list = Array.isArray(workspaces) ? workspaces : workspaces?.packages;
    if (Array.isArray(list)) patterns.push(...list.filter((entry) => typeof entry === 'string'));
  } catch {
    /* no readable package.json: no declared workspaces */
  }
  const pnpm = await readOrNull(join(projectDir, 'pnpm-workspace.yaml'));
  if (pnpm) patterns.push(...pnpmWorkspacePatterns(pnpm.toString('utf8')));
  return patterns;
}

/** A workspace glob (`*` one segment, `**` any depth, `!` excludes) as a matcher of folders. */
function workspaceMatcher(patterns) {
  const compile = (pattern) => {
    const body = pattern
      .replace(/^\.\//, '')
      .replace(/\/+$/, '')
      .split('/')
      .map((part) => (part === '**' ? '.*' : segmentPattern(part)))
      .join('/')
      .replace(/\/\.\*$/, '(?:/.*)?')
      .replace(/^\.\*\//, '(?:.*/)?');
    return new RegExp(`^${body}$`);
  };
  const include = patterns.filter((pattern) => !pattern.startsWith('!')).map(compile);
  const exclude = patterns.filter((pattern) => pattern.startsWith('!')).map((pattern) => compile(pattern.slice(1)));
  return (dir) => include.some((re) => re.test(dir)) && !exclude.some((re) => re.test(dir));
}

/**
 * The folders (forward-slash, relative to `projectDir`, '' itself) holding
 * committed files some stack reads, with those basenames; nothing inside
 * node_modules. Empty when git cannot list them.
 * @returns {Promise<Map<string, Set<string>>>}
 */
async function committedFolders(projectDir, signal) {
  const pathspecs = [...STACK_NAMES, ...STACK_GLOBS].map((name) => `:(glob)**/${name}`);
  const result = await runGit(projectDir, ['-c', 'core.quotePath=false', 'ls-files', '-z', '--', ...pathspecs], {
    signal,
    readOnly: true,
    allowFailure: true,
  });
  const folders = new Map();
  if (result.code !== 0) return folders;
  for (const path of result.stdout.split('\0')) {
    const parts = path.split('/');
    const name = parts.pop();
    if (!name || !relevantName(name) || parts.includes('node_modules')) continue;
    const dir = parts.join('/');
    if (!folders.has(dir)) folders.set(dir, new Set());
    folders.get(dir).add(name);
  }
  return folders;
}

/** Whether `stack` reads the committed basename `name`. */
function stackReads(stack, name) {
  return stack.names.includes(name) || (stack.globs ?? []).some((glob) => matchesSegment(glob, name));
}

function matchesSegment(glob, name) {
  return new RegExp(`^${segmentPattern(glob)}$`, 'i').test(name);
}

/**
 * Every installed artefact in `projectDir` that is a link (forward-slash
 * paths): the artefact of each folder with committed files of its stack, so
 * a node_modules beside every committed package.json, the workspace packages
 * that share the root lockfile too. Only the artefact itself is examined
 * (lstat), never what a link points at. An install reaches beyond its own
 * folder (`npm ci` at the root resets every workspace package's
 * node_modules), so any one blocks every install in the worktree.
 * @returns {Promise<string[]>}
 */
export async function linkedArtefacts(projectDir, { signal } = {}) {
  const links = [];
  for (const [dir, files] of await committedFolders(projectDir, signal)) {
    for (const stack of STACKS) {
      if (![...files].some((name) => stackReads(stack, name))) continue;
      const info = await lstatOrNull(join(folderPath(projectDir, dir), stack.artefact));
      if (info?.isSymbolicLink()) links.push([dir, stack.artefact].filter(Boolean).join('/'));
    }
  }
  return links;
}

/** Whether `dir` holds the installed `artefact`: a real directory, never a link. */
async function installedArtefact(dir, artefact) {
  const info = await lstatOrNull(join(dir, artefact));
  return !!info?.isDirectory() && !info.isSymbolicLink();
}

/**
 * What to prepare (forward-slash `dir` relative to `projectDir`; '' is the
 * project itself), root first: one entry per project folder and stack, with
 * the manager its committed files select. `mainDir`: the same folder in the
 * main checkout, whose installed artefacts admit nested folders.
 * @returns {Promise<Array<{ dir: string, stack: string, manager: string, artefact: string,
 *   lockfile?: string, requirements?: string[] }>>}
 */
export async function findLockfileFolders(projectDir, { mainDir = null, signal } = {}) {
  const folders = await committedFolders(projectDir, signal);
  const isWorkspace = workspaceMatcher(await workspacePatterns(projectDir));
  const found = [];
  for (const [dir, files] of folders) {
    for (const stack of STACKS) {
      const match = stack.pick(files);
      if (!match) continue;
      const admitted =
        !dir || isWorkspace(dir) || (mainDir && (await installedArtefact(folderPath(mainDir, dir), stack.artefact)));
      if (admitted) {
        found.push({ dir, stack: stack.stack, artefact: stack.artefact, ...match });
      }
    }
  }
  return found.sort((a, b) => a.dir.split('/').length - b.dir.split('/').length || a.dir.localeCompare(b.dir));
}

const sharedClause = (count) =>
  `${count > 1 ? 'are' : 'is'} shared from the main checkout by .worktreeinclude and not installed here`;

const sharedNote = (artefact, where) => `${artefact} in ${where} ${sharedClause(1)}.`;

/** Display text of a command (never run through a shell). */
const displayLine = (tool, args) => `${tool} ${args.map(quote).join(' ')}`;

function commandLine(tool, { args, followUp }) {
  return `${displayLine(tool, args)}${followUp ? ` && ${displayLine(quote(followUp.file), followUp.args)}` : ''}`;
}

/**
 * What the first turn still has to do in the worktree folder `worktreeDir`:
 * the installs (`commands`, setup-commands entries) and one line per folder
 * it leaves alone (`notes`: nothing found, tool not on PATH, an artefact that
 * is a link it must not install through).
 * `mainDir`: the same folder in the main checkout (findLockfileFolders).
 * `env`: where the tools are looked up (PATH).
 * `shared`: artefacts (forward-slash, relative to `worktreeDir`) that are links
 * the user asked for in .worktreeinclude; they are never installed through or
 * replaced, and are reported as shared rather than as a link to remove.
 * @param {{ worktreeDir: string, mainDir?: string|null, shared?: string[], signal?: AbortSignal, env?: NodeJS.ProcessEnv }} input
 */
export async function planDependencySetup({ worktreeDir, mainDir = null, shared = [], signal, env = process.env }) {
  const folders = await findLockfileFolders(worktreeDir, { mainDir, signal });
  if (!folders.length) {
    return { commands: [], notes: ['No lockfile or dependency manifest found; nothing was installed.'] };
  }
  const commands = [];
  const notes = [];
  // While any artefact is a link nothing is installed (linkedArtefacts).
  const links = await linkedArtefacts(worktreeDir, { signal });
  for (const entry of folders) {
    const cwd = folderPath(worktreeDir, entry.dir);
    const where = folderLabel(entry.dir);
    const info = await lstatOrNull(join(cwd, entry.artefact));
    if (info && !info.isSymbolicLink()) continue;
    const stack = STACKS.find((candidate) => candidate.stack === entry.stack);
    const named = await stack.install(entry, { cwd, signal });
    if (!named) continue;
    if (info && shared.includes([entry.dir, entry.artefact].filter(Boolean).join('/'))) {
      notes.push(sharedNote(entry.artefact, where));
      continue;
    }
    if (info) {
      notes.push(
        `${entry.artefact} in ${where} is a link, not an install of its own; ${where} was not prepared (replace it with \`${commandLine(named.tools[0], named)}\` there if tests need it).`
      );
      continue;
    }
    const others = links.filter((rel) => !shared.includes(rel));
    if (others.length) {
      notes.push(
        `${where} was not prepared while ${others.join(', ')} ${others.length > 1 ? 'are links' : 'is a link'} an install could reach through (run \`${commandLine(named.tools[0], named)}\` there once replaced if tests need it).`
      );
      continue;
    }
    if (links.length) {
      notes.push(`${where} was not prepared; ${links.join(', ')} ${sharedClause(links.length)}.`);
      continue;
    }
    const found = named.tools.find((candidate) => which(candidate, { env }));
    if (!found) {
      notes.push(
        `${named.tools[0]} is not on PATH; ${where} was not prepared (run \`${commandLine(named.tools[0], named)}\` there if tests need it).`
      );
      continue;
    }
    const tool = which(found, { env });
    const spec = await stack.install(entry, { cwd, tool, signal });
    if (!spec) {
      notes.push(`${found} could not be queried; ${where} was not prepared.`);
      continue;
    }
    const label = `${entry.manager} (${where})`;
    const specEnv = spec.env ? { env: spec.env } : {};
    commands.push({
      command: displayLine(`"${tool}"`, spec.args),
      file: tool,
      args: spec.args,
      cwd,
      label,
      ...specEnv,
    });
    if (spec.followUp) {
      const { file, args } = spec.followUp;
      commands.push({ command: displayLine(`"${file}"`, args), file, args, cwd, label, ...specEnv });
    }
  }
  return { commands, notes };
}
