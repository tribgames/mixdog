# Git & GitHub

Git installation and GitHub CLI installation/sign-in live in
**Extensions → Plugin → Git & GitHub**. The existing `git` feature id, install
marker, enabled flag, and CLI credentials are preserved. Disabling the feature
does not uninstall Git or sign out.

Source Control commits require a manually entered summary and accept an optional
description. There are no commit-message presets, format checks, autocomplete,
or AI generation. Legacy `desktop.git` preferences are no longer read or written.

The **GitHub** side view retains the pull-request list and adds repositories,
issues, Actions runs, workflows, releases, and notifications. Lists are paged.
The repository selector accepts `owner/name`; Enterprise requests can specify a
DNS hostname. Clone requires an absolute new destination under an existing
parent. Review submissions carry the PR head commit id.

The `github` agent tool and desktop IPC use the same allowlisted command builder
and CLI process runner in `src/runtime/github`. No arbitrary `gh` command, raw
API endpoint, token, shell script, or local request-body filename is accepted.
The CLI owns credentials. API bodies are JSON on stdin. CLI and API errors are
visible, responses are bounded, and uncertain writes are not automatically
replayed. Mutations are serialized per host/repository within the executor.
Local checkout/clone also use the Git repository write lock.

## Supported operations

- Repositories: list, inspect, create, clone, fork.
- Issues: list, inspect, create, edit, close/reopen, comment, read comments.
- Pull requests: list, inspect, create, checkout, merge, review/approve/request
  changes, comment, read inline review comments.
- Actions: list workflows/runs, inspect runs, read logs, dispatch workflows,
  rerun all/failed jobs, cancel runs.
- Releases: list, inspect, create, edit/publish drafts.
- Notifications: list and mark individual threads read.

Actions dispatches and published releases can trigger deployment. The UI warns
and confirms before submitting them; the agent tool requires explicit user
approval for writes. Repository creation requires an explicit visibility choice.
Release creation in the UI defaults to a draft.

GitHub permissions still apply: issues/PR writes need repository access,
workflow dispatch needs Actions permission, and notifications require the
account's notifications scope. A permission failure is not treated as an empty
list. Authentication is managed in the plugin details.

## Workspace activity recovery

"Workspace activity cannot be verified. Nothing was changed." means the
repository's shared activity ledger (`mixdog-workspace-admission.json` in the
shared Git directory, `git rev-parse --path-format=absolute --git-common-dir`)
could not be used.

- **Damaged contents** (truncated, malformed, or zero-filled): nothing for you
  to do. Mixdog keeps the damaged file as
  `mixdog-workspace-admission.json.corrupt-<time>` and starts a new ledger.
  Prompts and shell commands keep running. Only branch and worktree changes
  (merge, cleanup, branch switches) are refused for about 15 seconds while every
  running Mixdog process republishes the work it holds; a change that touches a
  folder with running work keeps being refused by name, and changes resume on
  their own afterwards. Keep the `.corrupt-` file if you want to report the
  damage.
- **Unreadable file** (permissions, file in use, or other storage errors):
  Mixdog leaves the file as it is and refuses new work and workspace changes
  until it can be read again. Restore access; do not delete it, the Git
  directory, or substitute an older copy that may omit still-running work.
- **Written by a newer Mixdog** (after a downgrade): the file is left untouched.
  Prompts and shell commands continue, but workspace changes are refused until
  you run the newer version again.

## Reference review

Reference repositories: `github-desktop` and
`vscode-pull-request-github`. Their repository-scoped state,
PR/issue separation, and review flows informed the integration. The official
`github-cli` source (https://github.com/cli/cli) was consulted for command/API
behavior. No reference source code
was copied into Mixdog.

## Verification

Runtime contracts and agent integration:

```powershell
node --test src/runtime/github/github.test.mjs src/session-runtime/builtin-features.test.mjs src/session-runtime/tool-profile.test.mjs
```

Desktop integration (from `apps/desktop`):

```powershell
node --import ./scripts/test-env.mjs --import tsx --test src/main/github-service.test.mjs src/renderer/github/github-ui.test.mjs src/renderer/settings/git-plugin.test.mjs src/renderer/source-control-commit.test.mjs
npm run typecheck
```

No tests publish a release, trigger a workflow, or write to a real repository.
