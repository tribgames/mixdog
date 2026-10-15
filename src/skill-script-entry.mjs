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
const { canonicalSkillScriptPath, decodeSkillArgv, SKILL_ARGV_ENV } = await import(
  './runtime/shared/skill-script-runtime.mjs'
);

// The PowerShell `mixdog-skill-node` function passes its arguments in the
// environment (see renderPowerShellSkillFunction); the script never sees them.
const envArgv = process.argv.length === 2 ? decodeSkillArgv(process.env[SKILL_ARGV_ENV]) : null;
delete process.env[SKILL_ARGV_ENV];
const [execPath, , target, ...args] = envArgv ? [process.argv[0], process.argv[1], ...envArgv] : process.argv;
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
