// Root test loader: tsx, so a test can import TypeScript sources that live under node_modules (the workspace
// package @mixdog/protocol, reached through packages/protocol-client). Node's own type stripping refuses those files
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). scripts/test.mjs passes it to every run of the root package, the way
// apps/desktop passes its own scripts/test-tsx.mjs.
await import('tsx');