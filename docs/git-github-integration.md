# Git & GitHub

Git installation, GitHub CLI installation/sign-in, and commit-message preferences
live in **Extensions → Plugin → Git & GitHub**. The existing `git` feature id,
install marker, enabled flag, CLI credentials, and `desktop.git` preferences are
preserved. Disabling the feature does not uninstall Git or sign out.

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

## Reference review

Existing local references: `C:\Project\refs\github-desktop` and
`C:\Project\refs\vscode-pull-request-github`. Their repository-scoped state,
PR/issue separation, and review flows informed the integration. The missing
official CLI source was cloned to `C:\Project\refs\github-cli` from
https://github.com/cli/cli for command/API behavior. No reference source code
was copied into Mixdog.

## Verification

Runtime contracts and agent integration:

```powershell
node --test src/runtime/github/github.test.mjs src/session-runtime/builtin-features.test.mjs src/session-runtime/tool-profile.test.mjs
```

Desktop integration (from `apps/desktop`):

```powershell
node --import ./scripts/test-env.mjs --import tsx --test src/main/github-service.test.mjs src/renderer/github/github-ui.test.mjs src/renderer/settings/git-plugin.test.mjs src/renderer/settings/git-preference-save.test.mjs
npm run typecheck
```

No tests publish a release, trigger a workflow, or write to a real repository.
