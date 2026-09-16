# Import-resolution fixtures

One directory per language, each a COMPLETE little project: the protocol test
copies it to a temporary root and runs a full walk there, so `resolvedImports`
is produced by the same code path a real repository uses.

Two conventions:

* `_node_modules/` is renamed to `node_modules/` by the test. The directory
  cannot be checked in under its real name — the repository's `.gitignore`
  ignores `node_modules/` everywhere, and the walk honours git ignore rules,
  so a committed `node_modules/` fixture would be invisible to the very code
  it exists to test.
* every file is reachable from the fixture root with no extra configuration
  (no `package.json`, no `tsconfig.json`), because these resolvers are
  layout-driven, not manifest-driven.
