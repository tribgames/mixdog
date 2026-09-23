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
| Project's documented TypeScript check | unused locals, imports, parameters, private members when the project enables those diagnostics | use its existing command and flags; do not silently add `--noUnusedLocals` or `--noUnusedParameters` |
| `knip` (`node_modules/.bin/knip`) | unused files, exports, types, dependencies; imports missing from the manifest (`unlisted`) or resolving to nothing (`unresolved`) | JS/TS; only when the project already depends on it |
| `vulture` (in the project's venv) | unused functions, classes, imports with confidence | Python; only when present |
| `deadcode` (Go, `golang.org/x/tools`) / `cargo machete` | unreachable functions / unused crates | only when on PATH |
| `code_graph mode:symbols` per selected file | private helpers with no callers (`callers`) | universal, no install |

Keep optional unused-code diagnostics separate from the build baseline.
Do not add stricter compiler flags for a routine cleanup check; an explicitly
requested additional diagnostic does not redefine the project's build criteria.

An import the project cannot resolve, or one whose package is absent from the
manifest, is not dead code but a phantom dependency: report it under "Bugs
found" and never settle it by installing the package.

## Verify every candidate

1. `code_graph mode:references symbols:[name]` — zero references outside the
   declaration is the first gate, not the last.
2. Search the symbol name and module path across the repository, including
   tests, configs, templates, docs, JSON/YAML, and string literals. Classify
   hits against the actual declaration:
   - A resolved call, import, registry entry, or executable string/template
     lookup is a consumer; keep the symbol.
   - A test or documentation may establish a supported contract. An example,
     historical comment, or unrelated same-spelled name is not itself a live
     dynamic reference; inspect its meaning instead of counting text matches.
   - An unresolved dynamic lookup blocks deletion; neither zero static
     references nor an ambiguous textual hit settles it.
   Reading consumers outside the selected area does not authorize editing them.
3. Apply the never-dead list below.
4. Verify removal has no required side effects. Unread variables can have
   effectful initializers, and the last unused import binding can still load a
   module for registration or initialization. Preserve required initialization
   rather than deleting it with the binding.
5. Record the symbol, kind, classified usage and contract evidence, side-effect
   result, and proposed action in the shared candidate inventory.

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

## Legacy and compatibility retirement

Age, a `legacy`/`deprecated` label, or lack of recent edits is not retirement
evidence. Apply this procedure before classifying an old path as dead:

1. Identify its obligations: supported versions and platforms, public callers,
   persisted old data/config formats, feature-flag rollback, and migrations.
   Name the current contract or owner evidence for each relevant obligation.
2. Establish that the obligation has ended or a completed transition makes the
   old path unreachable for supported inputs. An inactive flag, no recent
   traffic, or a newer implementation existing is not sufficient.
3. If removal changes supported behavior, formats, or error handling, report a
   separate RISKY migration requiring approval. A required data migration is
   not a cleanup task, and migration entry points remain protected above.
4. For a verified obsolete path, inventory its callers, flags/config, tests,
   docs, files, and dependencies. Remove only approved members in the order
   below; request scope expansion before editing related files outside it.
5. Verify the current path and remaining supported compatibility cases with
   documented checks. Record the retirement evidence and any remaining items.
   A still-required path is kept with its contract; an unknown obligation
   leaves the candidate blocked, not assumed obsolete.

## Remove in order

1. Unused imports and locals (SAFE only after usage and side-effect verification).
2. Unused private functions, methods, constants (SAFE once verified).
3. Unused exports (CAREFUL) — after the never-dead check.
4. Orphan files (CAREFUL) — a file nobody imports; delete whole, then grep
   for its path in configs and docs.
5. Dependencies in `package.json` / `pyproject.toml` (CAREFUL) — last, after
   the code that used them is gone; keep the lockfile consistent through the
   project's own package manager.

Group edits by file so one batch never touches a file another batch edits.
Verification and failure rollback follow the skill body (section 4 step 3 and
the test-failure pitfall); never patch forward past a failure.

## Report

Use the shared candidate inventory and closing report, not a second dead-code
ledger. Include the symbol/kind, usage and side-effect evidence, any legacy
obligations, and verification result for each completed, kept, or unfinished ID.
