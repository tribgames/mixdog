// What a pptxgenjs authoring script may rely on when the runner executes it.
// The human-facing guide (workflow, composition grammar, device kit, footguns) is
// the built-in `pptx` skill under src/defaults/skills/pptx; keep the two in
// step when a global or a module is added here.
export const PPTX_SCRIPT_CONTRACT = {
  runtime: 'CommonJS body executed in-process; top-level await is allowed.',
  globals: ['require', 'OUTPUT', 'console', 'Buffer', 'process.env'],
  require: ['pptxgenjs', 'sharp', 'node:fs', 'node:path', 'node:buffer'],
  output: 'Write exactly one file at OUTPUT; the runtime opens it as the session document.',
  timeoutMs: 90_000,
};
