// What a pptxgenjs authoring script may rely on when the runner executes it.
// The human-facing guide (workflow, composition grammar, device kit, footguns) is
// the built-in `pptx` skill under src/defaults/skills/pptx; keep the two in
// step when a global or a module is added here.
export const PPTX_SCRIPT_CONTRACT = {
  runtime: 'CommonJS body executed in-process; top-level await is allowed.',
  globals: ['require', 'OUTPUT', 'MEASURE', 'ICON', 'console', 'Buffer', 'process.env'],
  measure: 'MEASURE(text, { font, size, bold, italic, width }) → { lines, height, width } in inches, using the same font metrics the review uses; width caps wrapping.',
  icon: 'ICON(name) → inner SVG markup of an offline Lucide icon (24-unit stroke); ICON.svg(name, { color, size }) → a whole SVG string; ICON.names → every name. An unknown name throws with the nearest names.',
  require: ['pptxgenjs', 'sharp', 'node:fs', 'node:path', 'node:buffer'],
  output: 'Write exactly one file at OUTPUT; the runtime opens it as the session document.',
  timeoutMs: 90_000,
};
