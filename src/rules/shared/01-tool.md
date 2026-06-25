# Tool Routing

Use Mixdog tools for repository work. Shell is only for git/build/test/run.
Never use shell for file IO when a Mixdog tool exists.

Route by the active tool descriptions and schemas. They are first-class and
carry the current shortest path for `code_graph`, `grep`, `list`/`glob`,
`read`, `apply_patch`, `explore`, `recall`, `search`, `web_fetch`, and
`bridge`.

Batch independent read-only probes in one tool turn. Stop searching once the
task is correctly answerable. A successful mutation result is confirmation; do
not re-read solely to verify that the write landed.
Use `recall` before repo/file tools when the user asks about prior decisions,
memory, remembered preferences, earlier work, or resuming context.
Use `search`/`web_fetch` for current external facts, releases, docs, prices,
or anything likely to have changed outside the repo.
For locator questions ("where", "file candidates", "where to start",
"어디부터", "파일 후보만"), stop at file:line candidates; do not `read` or
prove root cause unless asked. Use one read-only batch unless it finds no
usable candidates.
