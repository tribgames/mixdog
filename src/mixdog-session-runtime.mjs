// Thin facade. The former ~3.3k-line implementation was split into cohesive
// modules under src/session-runtime/ (runtime-core.mjs holds the orchestrator
// createMixdogSessionRuntime plus the module-level wiring; env.mjs and
// boot-profile.mjs hold the extracted env/boot helpers). This file re-exports
// the exact same public API so existing importers (TUI engine,
// scripts/tool-smoke.mjs, tests) keep their import paths unchanged.
export * from './session-runtime/runtime-core.mjs';
