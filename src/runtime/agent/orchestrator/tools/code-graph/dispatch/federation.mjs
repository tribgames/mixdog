/**
 * federation.mjs — answer a call from a cwd that is not itself a project
 * (filesystem root, multi-repo parent, `files:['.']` at a sentinel-free
 * folder) by fanning out over the trusted or discovered project roots
 * beneath it.
 */
import { resolve as pathResolve, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import {
  _isFilesystemRootPath,
  collectTrustedCodeGraphRoots,
  formatFederatedProjectLabel,
  owningTrustedCodeGraphRoot,
} from '../trusted-roots.mjs';
import { _childProjectRoots } from '../project-root.mjs';
import {
  _AGGREGATE_FILE_WILDCARD_RE,
  CODE_GRAPH_DISCOVERED_FEDERATION_CAP,
  ROOT_FEDERATED_MODES,
  _collectGraphFileList,
  _runCodeGraphFederation,
} from '../aggregate-roots.mjs';
import { raceAbort } from './abort-race.mjs';

/** `input` resolved against `base`; an absolute input stands on its own. */
export function _absFrom(base, input) {
  return isAbsolute(input) ? pathResolve(input) : pathResolve(base, input);
}

const notSelf = (baseCwd) => (root) => pathResolve(root) !== pathResolve(baseCwd);

/**
 * Decide whether — and over which roots — this call federates. `active`
 * false means the ordinary single-project path answers.
 */
export function planFederation(args, baseCwd, { baseProjectRoot, fileArg, hasAggregateFileArgs }) {
  const filesystemRootCwd = !baseProjectRoot && _isFilesystemRootPath(baseCwd);
  const files = _collectGraphFileList(args);
  const rawMode = String(args?.mode || '').trim();
  const exactDotFederation = files.length === 1 && files[0] === '.' && ROOT_FEDERATED_MODES.has(rawMode);
  const parentDotFederation = !baseProjectRoot && !filesystemRootCwd && exactDotFederation;
  // Trusted graph targets living UNDER a sentinel-free cwd. Self is filtered
  // out: federating a directory into itself would recurse forever.
  const trustedRoots = baseProjectRoot ? [] : collectTrustedCodeGraphRoots(baseCwd).filter(notSelf(baseCwd));
  // Trust registration is a ROUTING PREFERENCE, not an admission gate. A
  // sentinel-free cwd whose children are obvious project roots (a refs/ folder
  // of checkouts, a multi-repo parent) is answerable: federate over those
  // children instead of refusing the call. Cost stays bounded by the existing
  // per-project graph timeout and the federation fan-out cap — the same way the
  // reference CLIs bound a wide search (time/output caps, never a scope
  // refusal). Registered roots keep priority; discovered children only fill in
  // when registration yields nothing.
  let federationRoots = trustedRoots;
  if (!trustedRoots.length && !baseProjectRoot) {
    federationRoots = _childProjectRoots(baseCwd, { cap: CODE_GRAPH_DISCOVERED_FEDERATION_CAP }).filter(
      notSelf(baseCwd)
    );
  }
  // A sentinel-free cwd (multi-repo parent, vendored reference tree) is still
  // routable when trusted project roots live under it — federate over those
  // instead of refusing the call outright.
  const sentinelFreeFederation =
    !baseProjectRoot &&
    !filesystemRootCwd &&
    !parentDotFederation &&
    !fileArg &&
    !hasAggregateFileArgs &&
    ROOT_FEDERATED_MODES.has(rawMode) &&
    federationRoots.length > 0;
  return {
    active: filesystemRootCwd || parentDotFederation || sentinelFreeFederation,
    filesystemRootCwd,
    exactDotFederation,
    rawMode,
    // A filesystem root stays on the REGISTERED set only: fanning out over
    // every project directory on a whole drive is a different cost class than
    // fanning out over one folder's children.
    roots: filesystemRootCwd ? trustedRoots : federationRoots,
    files: exactDotFederation ? [] : files,
  };
}

/** The roots a federated child call must not re-index: siblings nested under it. */
function excludedRootsFor(root, roots) {
  return roots.filter((candidate) => candidate !== root && owningTrustedCodeGraphRoot(candidate, [root]) === root);
}

async function federateFileAnchors(name, args, plan, baseCwd, signal, options, execute) {
  const { roots, files, rawMode } = plan;
  if (files.some((file) => _AGGREGATE_FILE_WILDCARD_RE.test(file))) {
    return `Error: ${name}: wildcard-shaped file anchors are not allowed at a filesystem root`;
  }
  const routed = files.map((file) => {
    const abs = _absFrom(baseCwd, file);
    return { file, abs, exists: existsSync(abs), root: owningTrustedCodeGraphRoot(abs, roots) };
  });
  const missing = routed.find((row) => !row.exists);
  if (missing) return `Error: ${name}: file not found: ${missing.file}`;
  const untrusted = routed.find((row) => !row.root);
  if (untrusted) return `Error: ${name}: file anchor is not owned by a trusted project: ${untrusted.file}`;
  const projectArgs = { ...args };
  delete projectArgs.cwd;
  const sections = await Promise.all(
    routed.map(async ({ file, abs, root }) => {
      let body;
      try {
        body = await execute(name, { ...projectArgs, file: abs, files: undefined }, root, signal, {
          ...options,
          excludedProjectRoots: excludedRootsFor(root, roots),
        });
      } catch (err) {
        body = `Error: ${err?.message || String(err)}`;
      }
      return `# ${rawMode} ${file}\n# project ${formatFederatedProjectLabel(root)}\n${body}`;
    })
  );
  return sections.join('\n\n');
}

function federateRoots(name, args, plan, signal, options, execute) {
  const { roots, exactDotFederation } = plan;
  const projectArgs = { ...args };
  delete projectArgs.cwd;
  if (exactDotFederation) {
    delete projectArgs.file;
    delete projectArgs.files;
  }
  const runOne = async (root, nextArgs) =>
    execute(name, nextArgs, root, signal, { ...options, excludedProjectRoots: excludedRootsFor(root, roots) });
  const work = _runCodeGraphFederation(roots, runOne, projectArgs).then((sections) => sections.join('\n\n'));
  return raceAbort(work, signal);
}

/**
 * The federated answer, or null when the plan cannot route the call and the
 * single-project path must decide. `execute` is the full tool entry so each
 * child call re-roots exactly like a direct one.
 */
export function runFederation(name, args, plan, baseCwd, signal, options, execute) {
  if (plan.files.length) return federateFileAnchors(name, args, plan, baseCwd, signal, options, execute);
  if (plan.roots.length && ROOT_FEDERATED_MODES.has(plan.rawMode)) {
    return federateRoots(name, args, plan, signal, options, execute);
  }
  return null;
}
