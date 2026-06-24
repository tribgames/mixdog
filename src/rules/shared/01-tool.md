# Tool Routing

Use Mixdog tools for repository work. Shell is only for git/build/test/run.
Never use shell for file IO when a Mixdog tool exists.

Pick the first matching route:

1. Broad or unknown codebase discovery -> `explore`.
2. Prior decisions/session history -> `recall`.
3. Current external facts/docs -> `search`, then `web_fetch`.
4. Known symbol, call graph, imports, references, or impact -> `code_graph`.
5. Literal/config/log/free-text search -> `grep`.
6. File/name inventory -> `list` or `glob`.
7. Known file/region/body -> `read`.
8. Direct file changes -> `apply_patch` first; `edit` only for tiny exact
   substitutions; `write` only for new files or deliberate full rewrites.
9. Delegated actual work -> `bridge`.
10. Git/build/test/run -> `bash`.

Use `explore` to find anchors, not to judge or implement. Use `bridge` to
delegate scoped work, not broad discovery. Avoid `grep` -> `read` loops when
`explore` or `code_graph` can anchor the task first.

Batch independent read-only probes in one tool turn. Stop searching once the
task is correctly answerable. A successful mutation result is confirmation; do
not re-read solely to verify that the write landed.
