# Dead code removal

Read this before removing any unused symbol, file, or dependency. A tool
report is a candidate list, never proof: exports reached through dynamic
import, reflection, string lookup, templates, or configuration look unused
to every scanner.

## Candidates

Collect from what already runs in the project; never install a scanner and
never route one through `tidy` (they are not tidy engines):

| Source | Gives | Notes |
|---|---|---|
| `tidy check` diagnostics | unused imports/variables from Biome, ruff (`F401`, `F841`), ESLint `no-unused-vars` | exact file:line, safest tier |
| `tsc --noEmit --noUnusedLocals --noUnusedParameters` | unused locals, imports, parameters, private members | TypeScript projects; run through the project's own `tsc` |
| `knip` (`node_modules/.bin/knip`) | unused files, exports, types, dependencies; imports missing from the manifest (`unlisted`) or resolving to nothing (`unresolved`) | JS/TS; only when the project already depends on it |
| `vulture` (in the project's venv) | unused functions, classes, imports with confidence | Python; only when present |
| `deadcode` (Go, `golang.org/x/tools`) / `cargo machete` | unreachable functions / unused crates | only when on PATH |
| `code_graph mode:symbols` per changed file | private helpers with no callers (`callers`) | universal, no install |

An import the project cannot resolve, or one whose package is absent from the
manifest, is not dead code but a phantom dependency: report it under "Bugs
found" and never settle it by installing the package.

## Verify every candidate

1. `code_graph mode:references symbols:[name]` — zero references outside the
   declaration is the first gate, not the last.
2. `grep` the bare name across the whole repository, including tests,
   configs, templates, docs, JSON/YAML, and string literals: `'name'`,
   `"name"`, `.name(`, `name:`. A hit in a string or template means the
   symbol is reached dynamically; keep it.
3. Apply the never-dead list below.
4. Record the candidate as `file:line → symbol → kind → action → evidence`.

## Never dead

- Entry points: `main`, `index`/barrel files, CLI commands, `bin` scripts,
  `package.json` `exports`/`main`/`bin` targets, framework-discovered files
  (routes, migrations, plugins, fixtures).
- Public API of a library package: any export from the package entry.
- Symbols referenced by tests — tests are consumers; delete the test first
  only when the behavior itself is being removed on separate evidence.
- `@public`/`@api` annotated symbols, registry or factory tables
  (`create…Tool`, `register…`), event names, wire strings, config keys.
- Feature-flag rollback paths that a comment or docs name as intentional;
  confirm with the user before removing.
- A required-by-signature unused parameter: rename to `_name`, never remove.

## Remove in order

1. Unused imports and locals (SAFE).
2. Unused private functions, methods, constants (SAFE once verified).
3. Unused exports (CAREFUL) — after the never-dead check.
4. Orphan files (CAREFUL) — a file nobody imports; delete whole, then grep
   for its path in configs and docs.
5. Dependencies in `package.json` / `pyproject.toml` (CAREFUL) — last, after
   the code that used them is gone; keep the lockfile consistent through the
   project's own package manager.

Group edits by file so one batch never touches a file another batch edits.
Run the narrowest documented checks for each meaningful behavior group and
the documented final tests/typecheck once after the round. Reuse unaffected
results. On failure, stop and undo only this run's edits with targeted patches;
preserve pre-existing and concurrent changes. Never restore entire files with
`git checkout`, `reset`, or `restore`, and never stash automatically. If safe
separation is unclear, leave the files intact and report the blocker instead
of discarding work or patching forward.

## Report

```text
| # | File:line | Symbol | Kind | Action | Evidence |
|---|---|---|---|---|---|
| 1 | src/foo.ts:42 | unusedFunc | function | removed | 0 refs, no grep hits |
| 2 | src/baz.ts:7 | ctx | parameter | prefixed _ | required by signature |
| 3 | src/api.ts:10 | legacyRoute | export | kept | string lookup in routes.json |
```
