# Dynamic language servers

Mixdog starts language servers only when a matching file is opened. Resolution order is:

1. Project registry: `.mixdog/lsp.json`
2. Project-local executable: `node_modules/.bin`, `.venv`, or `venv`
3. System `PATH`
4. Monaco and `code_graph` fallback when no server is available

Built-in mappings cover TypeScript/JavaScript, Python, Go, Rust, C/C++/Objective-C, and Ruby. The server process is shared by files that use the same server inside one project and stops after the final document has remained closed for two minutes.

## Project registry

Project configuration is trusted executable configuration, like a project-local MCP stdio server. Review it before opening files from an untrusted repository.

```json
{
  "servers": [
    {
      "id": "typescript-language-server",
      "name": "TypeScript Language Server",
      "languages": ["typescript", "javascript"],
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "candidates": ["node_modules/.bin/typescript-language-server"]
    }
  ]
}
```

`candidates` must be project-relative. A configured server overrides the built-in mapping for its language IDs. Mixdog does not download servers automatically.
