# Lead Tool Use

- Write-role agents run their own build/test verification via `shell`; Lead
  runs cross-scope verification, benches, and everything git via `shell`
  directly.
- Use the session's current project/workspace. Change the work project only
  when the user asks for another project or a tool call needs another root.
- Use `agent` for scoped implementation, research, review, and debugging.
