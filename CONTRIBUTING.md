# Contributing to Mixdog

Thanks for helping make Mixdog better. Bug reports, reproductions, and root-cause
analysis are as valuable as code. Everyone taking part follows our
[Code of Conduct](CODE_OF_CONDUCT.md).

## Every change starts with an issue

**Every pull request from an outside contributor must link an issue.**
Maintainers and automated dependency updates are exempt.

1. Search [open and closed issues](https://github.com/tribgames/mixdog/issues?q=is%3Aissue)
   and [pull requests](https://github.com/tribgames/mixdog/pulls?q=is%3Apr) first.
   If one already covers your problem, add what you know there instead.
2. Open an issue with the bug or feature form and describe the problem.
3. Wait for a maintainer to confirm the issue before you write code. Pull
   requests for issues nobody has confirmed may be closed.
4. Open your pull request and write `Fixes #123` (or `Refs #123`) in its
   description. A check fails until the description links an issue in this
   repository. The check only sees the link; a maintainer confirms the issue.

## What we merge

- **One problem per pull request.** Unrelated fixes, refactors, and formatting
  go in separate pull requests. Several small test fixes for the same cause go
  in one pull request, not one each.
- **A test that fails before your change and passes after it.** Changes
  without such a test are not merged unless a test is genuinely impossible;
  then explain how you verified it.
- **The smallest change that fixes the problem.** Extra abstraction, defensive
  branches for cases nobody hits, and broad rewrites are not merged.
- **At most three open pull requests per person.** Land one before opening
  more. A check fails on any pull request beyond the first three. When one
  of your earlier pull requests closes, edit the description of a later one
  to run the check again.

## AI-assisted work

Using AI tools is fine. You must understand and be able to explain every line
you submit, and you must have run it yourself. Pull requests that appear to be
generated and submitted without that understanding are closed.

## Before you open a pull request

```sh
npm test
npm test --prefix apps/desktop
npm run typecheck --prefix apps/desktop
```

For visible changes, attach before/after screenshots or a short recording.

## Security

Do not report vulnerabilities in public issues. Follow the
[security policy](SECURITY.md).
