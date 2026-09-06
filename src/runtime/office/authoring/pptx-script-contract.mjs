// What a pptxgenjs authoring script may rely on when the runner executes it.
// The human-facing guide (workflow, composition grammar, device kit, footguns) is
// the built-in `pptx` skill under src/defaults/skills/pptx; keep the two in
// step when a global or a module is added here.
export const PPTX_SCRIPT_CONTRACT = {
  runtime: 'CommonJS body executed in-process; top-level await is allowed.',
  kit: 'The code blocks of the pptx skill\'s kit.md, charts.md, and pictures.md run before the script (pres, T, TYPE, the helpers): the script holds the brief, one deck({ hue, accentHue?, mode, script, pairing, fonts }) call, and the slides. A script that declares its own `pres` runs without the prelude. Any helper may be redefined in the script.',
  globals: ['require', 'OUTPUT', 'MEASURE', 'ICON', 'RELATE', 'console', 'Buffer', 'process.env'],
  relate: 'Spread RELATE({ id, role, label?, group?, row?, column? }) into shape options. Roles: value, label, table-cell, paragraph, object. IDs are unique within a slide; a value names its label ID. Table cells name group, row, column. Declarations survive in shape names and inform diagnostics, not layout.',
  measure: 'MEASURE(text, { font, size, bold, italic, width }) → { lines, height, width } in inches, using the same font metrics the review uses; width caps wrapping.',
  icon: 'ICON(name) → inner SVG markup of an offline Lucide icon (24-unit stroke); ICON.svg(name, { color, size }) → a whole SVG string; ICON.names → every name. An unknown name throws with the nearest names.',
  require: ['pptxgenjs', 'sharp', 'node:fs', 'node:path', 'node:buffer'],
  output: 'Write exactly one file at OUTPUT; the runtime opens it as the session document.',
  timeoutMs: 90_000,
};
