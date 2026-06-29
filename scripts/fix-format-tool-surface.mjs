import fs from "node:fs";
const p = "src/runtime/shared/tool-surface.mjs";
let s = fs.readFileSync(p, "utf8");
const block = `export function formatToolSurface(name, args, opts = {}) {
  const parsed = parseToolArgs(args);
  return {
    label: displayToolName(name, parsed),
    summary: summarizeToolArgs(name, parsed, opts),
    normalizedName: normalizeToolName(name),
    args: parsed,
  };
}

`;
while (s.includes(block)) {
  s = s.replace(block, "");
}
const anchor = `/** Collapsed agent/worker surface card: one-line brief under the header (30-40 chars). */`;
if (!s.includes(anchor)) throw new Error("anchor missing");
if (!s.includes("export function formatToolSurface")) {
  s = s.replace(anchor, block + anchor);
}
fs.writeFileSync(p, s);
console.log("fixed formatToolSurface");
