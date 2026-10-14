#!/usr/bin/env node
// Entry the skill-script launcher runs (src/runtime/shared/skill-script-runtime.mjs):
//   <runtime executable> skill-script-entry.mjs <script.mjs> [args...]
// The script then sees itself as the main module, exactly as under
// `node <script.mjs> [args...]`, and its exit code is the process's.

// Before anything can import sharp: Electron on Linux must use its wasm build.
await import('./runtime/shared/sharp-electron-linux.mjs');
// Node mode belongs to this process only; whatever the script starts is a
// normal child again.
delete process.env.ELECTRON_RUN_AS_NODE;

const { pathToFileURL } = await import('node:url');
const { canonicalSkillScriptPath } = await import('./runtime/shared/skill-script-runtime.mjs');

const [execPath, , target, ...args] = process.argv;
if (!target) {
  console.error('Usage: <skill launcher> <script.mjs> [args...]');
  process.exitCode = 2;
} else {
  const script = canonicalSkillScriptPath(target);
  // The scripts' main check compares import.meta.url with argv[1].
  process.argv = [execPath, script, ...args];
  try {
    await import(pathToFileURL(script).href);
  } catch (error) {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  }
}
