# Contributing to Mixdog

Thanks for helping make Mixdog better. Bug reports, reproductions, and root-cause
analysis are as valuable as code. Everyone taking part follows our
[Code of Conduct](CODE_OF_CONDUCT.md).

## Every change starts with an issue

**Bug fixes and features from an outside contributor must link an issue.**
Small changes — typo and wording fixes, documentation, and small type or
formatting fixes that don't change behavior — can go straight to a pull
request. Maintainers and automated dependency updates are always exempt.

1. Search [open and closed issues](https://github.com/tribgames/mixdog/issues?q=is%3Aissue)
   and [pull requests](https://github.com/tribgames/mixdog/pulls?q=is%3Apr) first.
   If one already covers your problem, add what you know there instead.
2. Open an issue with the bug or feature form and describe the problem.
3. For a feature, wait for a maintainer to confirm the issue before you write
   code; pull requests for unconfirmed features may be closed. A bug fix with
   a clear reproduction need not wait.
4. Open your pull request and write `Fixes #123` (or `Refs #123`) in its
   description. For bug fixes and features a check requires that link; docs,
   refactors, and the small changes above are exempt. A pull request that
   changes only documentation passes by its files; for any other small change,
   a maintainer adds the `small-change` label, which passes the check. The
   check only sees the link; a maintainer confirms the issue.

## What we merge

- **One problem per pull request.** Unrelated fixes, refactors, and formatting
  go in separate pull requests. Several small test fixes for the same cause go
  in one pull request, not one each.
- **A test that fails before your change and passes after it.** Changes
  without such a test are not merged unless a test is genuinely impossible;
  then explain how you verified it.
- **The smallest change that fixes the problem.** Extra abstraction, defensive
  branches for cases nobody hits, and broad rewrites are not merged.
- **Land one pull request before opening the next.** Don't open many at once;
  submit them in your order of preference and wait for each to land. If you
  must have several open, keep it to a handful so reviews don't pile up.

## AI-assisted work

Using AI tools is fine, but you are responsible for the final code:
understand the direction and logic of your change well enough to explain it,
and run it yourself before opening the pull request. Write the issue and the
pull request description briefly, in your own words; walls of generated text
may be ignored, and submissions that obviously skip your own review are closed.

## Before you open a pull request

While you work, `npm test -- --changed` (and the same after
`npm test --prefix apps/desktop`) runs only the tests your edits reach. Run the
full commands below once, at the end:

```sh
npm test
npm test --prefix apps/desktop
npm run typecheck --prefix apps/desktop
```

For visible changes, attach before/after screenshots or a short recording.

## Security

Do not report vulnerabilities in public issues. Follow the
[security policy](SECURITY.md).
