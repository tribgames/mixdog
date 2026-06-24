# Tool Routing

Use Mixdog tools for repository work. Shell is for git/build/test/run, not for
file IO. Do not use native host read/grep/glob/edit/write/web tools when a
Mixdog tool exists.

## Default Ladder

Pick the first matching route:

1. Current external info/docs: `search`, then `web_fetch` for selected pages.
2. Prior decisions/session history: `recall`.
3. Code structure, symbols, callers, references, imports, impact: `code_graph`.
4. File/content search: `grep`.
5. Directory/file inventory: `list`; use `glob` only when explicitly selected or
   a pattern search is the shortest path.
6. Known file region/body: `read`.
7. File changes: `apply_patch` first. Use `edit` only for tiny exact
   substitutions; use `write` only for new files or deliberate full rewrites.
8. Worker delegation/state-changing subtask: `bridge`.
9. Git/build/test/run: `bash`.

If a needed tool is not active, call `tool_search` once with `select`.

## Editing

- Prefer one multi-file `apply_patch` over many small edits.
- Read the target region before patching stale or ambiguous context.
- Delete files with `apply_patch`, not shell remove commands.
- A successful mutation tool result is confirmation; do not immediately re-read
  the same file just to verify the write landed.

## Efficiency

- Batch independent read-only probes in one tool turn.
- Batch related reads from the same file in one `read` call when possible.
- Use `code_graph` for identifiers before text grep.
- Stop searching once the task is correctly answerable.
- Do not blind-retry the same failed call more than twice; inspect the error and
  change strategy.

## Shell

Use `bash` only for commands whose purpose is execution: git, build, test,
lint, start, or other CLI programs. Do not use it for `cat`, `touch`, `mkdir`,
`rm`, ad-hoc file editing, or web fetching.
