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

Mixdog records which folders of a repository are in use: running prompts,
shell and background commands, and branch or worktree changes. The record is
kept twice, in `mixdog-workspace-admission.json` and
`mixdog-workspace-admission.json.management`, in the repository's shared Git
directory (`git rev-parse --path-format=absolute --git-common-dir`). Both files
always hold the same record. A merge, worktree cleanup, or branch switch runs
only when no recorded work uses a folder it changes.

"Workspace activity cannot be verified. Nothing was changed." means Mixdog
could not confirm which work is running, so it changed nothing.

- **One file damaged or missing** (truncated, malformed, zero-filled, or
  deleted): nothing for you to do. Mixdog keeps the damaged bytes as
  `<file>.corrupt-<time>` and rebuilds the file from the other one, which still
  lists all running work. Prompts, commands, and workspace changes continue as
  before.
- **Both files damaged** (or one damaged and the other missing): the record of
  running work is lost. Prompts and shell commands keep running, but branch and
  worktree changes are refused with the message above until you reset the
  record (below). Waiting does not clear it, and neither does work finishing.
- **Unreadable file** (permissions, file in use, or other storage errors):
  Mixdog leaves both files as they are and refuses new prompts, commands, and
  workspace changes until the file can be read again. Restore access; do not
  delete the files or the Git directory, or substitute an older copy that may
  omit still-running work.
- **Written by a newer Mixdog** (after a downgrade): both files are left
  untouched, and new prompts, commands, and workspace changes are refused until
  you run the newer version again.

To reset the record after both files were damaged:

1. Stop every Mixdog instance that uses this repository or any of its linked
   worktrees.
2. Stop the background commands those instances started, or confirm they have
   finished.
3. If you want to report the damage, copy the two files somewhere else. Leave
   the `.corrupt-` copies where they are; they do not affect the reset.
4. Remove `mixdog-workspace-admission.json` and
   `mixdog-workspace-admission.json.management` from the shared Git directory.
5. Start Mixdog again, using only updated builds.

Limits:

- Every Mixdog process that uses the same shared Git directory, and the
  background commands it started, must run an updated build. Update all
  instances together. An older build cannot read the current record: its
  prompts and commands run without being recorded, so a change can run over
  them, and when it meets a damaged file it can discard the record of other
  instances' work.
- Removing both files while work is running is not supported. Mixdog cannot
  tell that apart from a new repository and starts an empty record.

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
