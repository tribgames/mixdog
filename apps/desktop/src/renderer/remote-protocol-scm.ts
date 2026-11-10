// PH-2 "Source control" group of the phone over `mixdogd`: the git panel, commits, branches, pull requests, GitHub login and the
// three installers. The phone still calls by Node's relay method names (remote-shim-api.ts); each answers as Node's host did
// (remote-methods.ts at b6f10295a): the host's argument grammar first, then the desktop operation, then the frame the relay
// sent back (`undefined` as null, a failure as the page's rebuilt Error with its `code`).
//
// The conversions are the desktop's own, shared with its operation lane: the request mapping and reply shapes
// (shared/scm-operation-route.ts), the argument grammar (shared/scm-input.ts, shared/git-contract.mjs) and the core failure
// (shared/core-error.ts).
import { validateGithubRequest } from '../../../../src/runtime/github/contract.mjs';
import { codedErrorParams } from '../shared/coded-error';
import { coreFailure } from '../shared/core-error';
import {
  requiredCommitHash,
  requiredGitIgnoreScope,
  requiredGitResetMode,
  requiredGitRevision,
  requiredRepositoryCwd,
  requiredReviewSource,
} from '../shared/git-contract.mjs';
import { SCM_OPERATION_ROUTES, SCM_REPLIES } from '../shared/scm-operation-route';
import {
  optionalGithubLoginOptions,
  requiredGitBranchName,
  requiredGitDiscardMode,
  requiredGitGlobalConfigKey,
  requiredGitLogLimit,
  requiredGitLogOffset,
  requiredGitLogQuery,
  requiredGitOptionalMessage,
  requiredGitPatch,
  requiredGitPath,
  requiredGitPaths,
  requiredGitRequestContextInput,
  requiredReviewDiffFiles,
  requiredString,
} from '../shared/scm-input';
import type { NodeCall, PhoneProtocolAdapter, PhoneProtocolHost } from './remote-shim-protocol';

/** The part of the protocol client this group uses. */
interface ScmClient {
  call(method: string, params: unknown): Promise<unknown>;
  /** The latest initialize answer of the PC's core. */
  readonly server?: { readonly platformFamily?: string };
}

/** The PC's platform, which decides what an absolute path is (Node checked on the PC). */
const platformFamily = (host: PhoneProtocolHost): string | undefined => (host.client() as unknown as ScmClient).server?.platformFamily;

/** The string `code`s Node's source-control errors carried onto the relay frame (remote-methods.ts `errorCode`): the contract
 *  code of a reset that needs the user's confirmation (git-mutations.ts GIT_RESET_DIRTY_CODE), the git runner's own deadline and
 *  overflow codes (git-runner.ts EGITTIMEOUT, EMAXBUFFER), and a child's system error (`spawn git ENOENT`, code ENOENT). */
const NODE_CODE = /^(git-reset-dirty-worktree|EGITTIMEOUT|EMAXBUFFER|UNKNOWN|E[A-Z0-9]{3,})$/;

/** The core names the same failures with codes of its own (mixdog-scm/src/error.rs); every other core code (`COMMAND_FAILED`,
 *  `NOT_A_REPOSITORY`, `IO_ERROR`, `NO_OPERATION`, ...) is bookkeeping where Node's error had no code, so it does not reach the page. */
const CORE_CODE_AS_NODE: Readonly<Record<string, string>> = { GIT_TIMEOUT: 'EGITTIMEOUT', OUTPUT_TOO_LARGE: 'EMAXBUFFER' };

/** A program the core could not start (`capabilityUnavailable{capability}`), as Node's child spawn failed: `spawn git ENOENT`. */
function spawnFailure(error: unknown): Error | undefined {
  const data = (error as { detail?: { kind?: unknown; data?: { reason?: unknown; capability?: unknown } } } | null)?.detail;
  if (data?.kind !== 'rpc' || data.data?.reason !== 'capabilityUnavailable' || typeof data.data.capability !== 'string') return undefined;
  return Object.assign(new Error(`spawn ${data.data.capability} ENOENT`), { code: 'ENOENT' });
}

/** What the page's rebuilt Error carried of a failed relay frame: the message, the error's own string `code`, and the public
 *  display params that code declares (remote-shim-dispatch.ts at b6f10295a). */
export function phoneCallError(error: unknown): unknown {
  // A lost or closed connection is not a failure of the call: the router turns it into the interruption error
  // (remote-shim-protocol.ts:122-124; Node's remote-shim-calls.ts:276-282), which needs the client's own error and its detail.
  const ended = (error as { detail?: { kind?: string } } | null)?.detail?.kind;
  if (ended === 'connectionLost' || ended === 'clientClosed') return error;
  const failure = spawnFailure(error) ?? coreFailure(error);
  if (!(failure instanceof Error)) return failure;
  const given = (failure as { code?: unknown }).code;
  const named = typeof given === 'string' ? (CORE_CODE_AS_NODE[given] ?? given) : undefined;
  const code = named !== undefined && NODE_CODE.test(named) ? named : undefined;
  const params = codedErrorParams(code, (failure as { details?: unknown }).details);
  const rebuilt: Error & { code?: string; details?: unknown } = new Error(failure.message || 'remote call failed.');
  if (typeof code === 'string' && code) rebuilt.code = code;
  if (params) rebuilt.details = params;
  return rebuilt;
}

/** One desktop operation over the connection, answered as the relay's result frame carried it. */
async function operate(host: PhoneProtocolHost, name: string, args: unknown[]): Promise<unknown> {
  const client = host.client() as unknown as ScmClient;
  const call = (method: string, params: unknown): Promise<unknown> => client.call(method, params);
  try {
    const route = SCM_OPERATION_ROUTES[name](args);
    const reply = await call(route.method, route.params);
    const value = await SCM_REPLIES[name](reply, { args, params: route.params, call });
    return value === undefined ? null : value;
  } catch (error) {
    throw phoneCallError(error);
  }
}

const operation =
  (name: string, args: (params: unknown[], os: string | undefined) => unknown[] = () => []): NodeCall =>
  (params, host) =>
    operate(host, name, args(params, platformFamily(host)));

const cwdOnly = (name: string): NodeCall => operation(name, ([cwd], os) => [requiredRepositoryCwd(cwd, os)]);

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const calls: Record<string, NodeCall> = {
    // ── working tree and index ──
    gitStatus: operation('gitStatus', ([cwd, options], os) => {
      const hint = record(options);
      return [requiredRepositoryCwd(cwd, os), { reuseLineStats: hint.reuseLineStats === true, skipLineStats: hint.skipLineStats === true }];
    }),
    gitDiff: operation('gitDiff', ([cwd, path, staged, worktreeOnly, untracked], os) => [
      requiredRepositoryCwd(cwd, os),
      requiredGitPath(path, os),
      staged === true,
      worktreeOnly === true,
      untracked === true,
    ]),
    gitApplyPatch: operation('gitApplyPatch', ([cwd, path, patch, reverse], os) => {
      if (reverse !== undefined && typeof reverse !== 'boolean') throw new TypeError('git patch direction is invalid.');
      return [requiredRepositoryCwd(cwd, os), requiredGitPath(path, os), requiredGitPatch(patch), reverse === true];
    }),
    gitStage: operation('gitStage', ([cwd, paths], os) => [requiredRepositoryCwd(cwd, os), requiredGitPaths(paths, os)]),
    gitUnstage: operation('gitUnstage', ([cwd, paths], os) => [requiredRepositoryCwd(cwd, os), requiredGitPaths(paths, os)]),
    gitIgnore: operation('gitIgnore', ([cwd, path, scope], os) => [
      requiredRepositoryCwd(cwd, os),
      requiredGitPath(path, os),
      requiredGitIgnoreScope(scope),
    ]),
    gitCommit: operation('gitCommit', ([cwd, message], os) => [
      requiredRepositoryCwd(cwd, os),
      requiredString(message, 'commit message', 20_000),
    ]),
    gitCommitPaths: operation('gitCommitPaths', ([cwd, message, paths], os) => [
      requiredRepositoryCwd(cwd, os),
      requiredString(message, 'commit message', 20_000),
      requiredGitPaths(paths, os),
    ]),
    gitAmend: operation('gitAmend', ([cwd, message], os) => [requiredRepositoryCwd(cwd, os), requiredGitOptionalMessage(message)]),
    gitUndoLastCommit: cwdOnly('gitUndoLastCommit'),
    gitRevert: operation('gitRevertFile', ([cwd, path, untracked, mode], os) => [
      requiredRepositoryCwd(cwd, os),
      requiredGitPath(path, os),
      untracked === true,
      requiredGitDiscardMode(mode),
    ]),
    gitReview: operation('gitReview', ([cwd, source], os) => [requiredRepositoryCwd(cwd, os), requiredReviewSource(source)]),
    gitReviewDiff: operation('gitReviewDiff', ([cwd, path, untracked, source], os) => [
      requiredRepositoryCwd(cwd, os),
      requiredGitPath(path, os),
      untracked === true,
      requiredReviewSource(source),
    ]),
    gitReviewDiffs: operation('gitReviewDiffs', ([cwd, files, source], os) => [
      requiredRepositoryCwd(cwd, os),
      requiredReviewDiffFiles(files, os),
      requiredReviewSource(source),
    ]),
    gitStash: operation('gitStash', ([cwd, message], os) => [requiredRepositoryCwd(cwd, os), requiredGitOptionalMessage(message)]),
    gitStashPop: cwdOnly('gitStashPop'),
    gitStashList: cwdOnly('gitStashList'),
    gitStashApply: operation('gitStashApply', ([cwd, ref], os) => [requiredRepositoryCwd(cwd, os), requiredString(ref, 'stash ref', 64)]),
    gitStashDrop: operation('gitStashDrop', ([cwd, ref], os) => [requiredRepositoryCwd(cwd, os), requiredString(ref, 'stash ref', 64)]),

    // ── branches, tags, the remote ──
    gitBranches: cwdOnly('gitBranches'),
    gitRenameBranch: operation('gitRenameBranch', ([cwd, branch, nextBranch], os) => [
      requiredRepositoryCwd(cwd, os),
      requiredGitBranchName(branch),
      requiredGitBranchName(nextBranch),
    ]),
    gitDeleteBranch: operation('gitDeleteBranch', ([cwd, branch], os) => [requiredRepositoryCwd(cwd, os), requiredGitBranchName(branch)]),
    gitCreateTag: operation('gitCreateTag', ([cwd, tag, hash], os) => [
      requiredRepositoryCwd(cwd, os),
      requiredString(tag, 'git tag', 512),
      requiredCommitHash(hash),
    ]),
    gitDeleteTag: operation('gitDeleteTag', ([cwd, tag], os) => [requiredRepositoryCwd(cwd, os), requiredString(tag, 'git tag', 512)]),
    gitPush: cwdOnly('gitPush'),
    gitFetch: cwdOnly('gitFetch'),
    gitPull: cwdOnly('gitPull'),
    gitSync: cwdOnly('gitSync'),
    gitContinue: cwdOnly('gitContinue'),
    gitAbortOperation: cwdOnly('gitAbortOperation'),

    // ── commit-addressed reads and moves, the global identity ──
    gitLog: operation('gitLog', ([cwd, query, skip, limit], os) => [
      requiredRepositoryCwd(cwd, os),
      requiredGitLogQuery(query),
      requiredGitLogOffset(skip),
      requiredGitLogLimit(limit),
    ]),
    gitShow: operation('gitShow', ([cwd, hash], os) => [requiredRepositoryCwd(cwd, os), requiredCommitHash(hash)]),
    gitShowDiff: operation('gitShowDiff', ([cwd, hash, path], os) => [
      requiredRepositoryCwd(cwd, os),
      requiredCommitHash(hash),
      requiredGitPath(path, os),
    ]),
    gitRequestContext: operation('gitRequestContext', ([cwd, input], os) => [
      requiredRepositoryCwd(cwd, os),
      requiredGitRequestContextInput(input, os),
    ]),
    gitShowFile: operation('gitShowFile', ([cwd, rev, path], os) => [
      requiredRepositoryCwd(cwd, os),
      requiredGitRevision(rev),
      requiredGitPath(path, os),
    ]),
    gitResetToCommit: operation('gitResetToCommit', ([cwd, hash, mode, confirmedDirty], os) => [
      requiredRepositoryCwd(cwd, os),
      requiredCommitHash(hash),
      requiredGitResetMode(mode),
      confirmedDirty === true,
    ]),
    gitRevertCommit: operation('gitRevertCommit', ([cwd, hash], os) => [requiredRepositoryCwd(cwd, os), requiredCommitHash(hash)]),
    gitCherryPickCommit: operation('gitCherryPickCommit', ([cwd, hash], os) => [requiredRepositoryCwd(cwd, os), requiredCommitHash(hash)]),
    gitGlobalConfig: operation('gitGlobalConfig'),
    // Empty is a real value here: it UNSETS the key. Node then announced `notifySettingsChanged('git')` to the desktop's
    // windows; the core does not (Rust gap, native/core/crates/mixdog-scm/src/desktop.rs git_global_config_write).
    setGitGlobalConfig: operation('setGitGlobalConfig', ([key, value]) => {
      if (typeof value !== 'string' || value.length > 500) {
        throw new TypeError('value must be a string of at most 500 characters.');
      }
      return [requiredGitGlobalConfigKey(key), value];
    }),

    // ── tooling: installers and GitHub ──
    githubStarStatus: operation('githubStarStatus'),
    starGithub: operation('starGithub'),
    gitCliStatus: operation('gitCliStatus'),
    installGitCli: operation('installGitCli'),
    libreOfficeStatus: operation('libreOfficeStatus', ([refresh]) => [refresh === true]),
    installLibreOffice: operation('installLibreOffice'),
    githubCliStatus: operation('githubCliStatus'),
    githubRequest: operation('githubRequest', ([cwd, input], os) => [requiredRepositoryCwd(cwd, os), validateGithubRequest(input)]),
    installGithubCli: operation('installGithubCli'),
    // A remote client opens the device page on its own browser, never the host's: the core's gh never opens one.
    githubCliLoginStart: operation('githubCliLoginStart', () => [{ openBrowser: false }]),
    githubCliLoginStatus: operation('githubCliLoginStatus', ([flowId]) => [requiredString(flowId, 'flowId', 200)]),
    githubCliLoginOpenBrowser: operation('githubCliLoginOpenBrowser', ([flowId, options]) => [
      requiredString(flowId, 'flowId', 200),
      optionalGithubLoginOptions(options),
    ]),
    githubCliLoginCancel: operation('cancelGithubCliLogin', ([flowId]) => [requiredString(flowId, 'flowId', 200)]),
    githubCliLogout: operation('githubCliLogout'),
    githubCliAccount: operation('githubCliAccount'),
    ghPrList: cwdOnly('ghPrList'),
    ghPrDefaultBranch: cwdOnly('ghPrDefaultBranch'),
    ghPrCreate: operation('ghPrCreate', ([cwd, input], os) => [requiredRepositoryCwd(cwd, os), input]),
    ghPrView: operation('ghPrView', ([cwd, number], os) => [requiredRepositoryCwd(cwd, os), number]),
    ghPrCheckout: operation('ghPrCheckout', ([cwd, number], os) => [requiredRepositoryCwd(cwd, os), number]),
    ghPrMerge: operation('ghPrMerge', ([cwd, number, method], os) => [requiredRepositoryCwd(cwd, os), number, method]),
    ghPrDiff: operation('ghPrDiff', ([cwd, number], os) => [requiredRepositoryCwd(cwd, os), number]),
};

// Ordering is the router's: every call of this group runs through the shared per-connection queue (remote-protocol-queue.ts runQueued).
export const adapter: PhoneProtocolAdapter = { group: 'scm', calls };
