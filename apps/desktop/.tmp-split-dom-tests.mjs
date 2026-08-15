// One-off splitter for src/renderer/renderer.dom.test.mjs.
// Produces renderer-dom-test-prelude.mjs plus themed renderer-dom.*.test.mjs files.
import { readFile, writeFile } from "node:fs/promises";

const SRC = "src/renderer/renderer.dom.test.mjs";
const PRELUDE = "src/renderer/renderer-dom-test-prelude.mjs";

const GROUPS = [
  [102, "surfaces"],
  [1659, "studio-context"],
  [3207, "transcript-review"],
  [4676, "rail-agents"],
  [5930, "pane-focus"],
  [7506, "new-task"],
  [9076, "session-switch"],
  [10693, "sidebar"],
  [11971, "notifications"],
  [13134, "model-workbench"],
  [14548, "docks-tabs"],
  [16333, "composer"],
];

const raw = await readFile(SRC, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
const lines = raw.split(/\r?\n/);

const isStart = (line) =>
  /^(test\(|(?:async )?function |const |let |var |class |import |afterEach\(|globalThis\.)/.test(line);

// Collect top-level blocks; attach preceding column-0 comment runs.
const starts = [];
for (let i = 0; i < lines.length; i += 1) {
  if (isStart(lines[i])) {
    let s = i;
    while (s > 0 && /^\/\//.test(lines[s - 1])) s -= 1;
    starts.push({ line: i, from: s });
  }
}
const blocks = starts.map((st, idx) => {
  const endExclusive = idx + 1 < starts.length ? starts[idx + 1].from : lines.length;
  let to = endExclusive - 1;
  while (to > st.line && lines[to].trim() === "") to -= 1;
  return { start: st.line, from: st.from, to, text: lines.slice(st.from, to + 1).join(eol), head: lines[st.line] };
});

const testBlocks = blocks.filter((b) => b.head.startsWith("test("));
const helperBlocks = blocks.filter((b) => /^(?:async )?function /.test(b.head));
const headerBlocks = blocks.filter((b) =>
  b.start < testBlocks[0].start && !b.head.startsWith("test(") && !b.head.startsWith("afterEach("));

// ---- names exported from the prelude ----
const staticNames = ["assert", "readFile", "React", "act", "flushSync", "SPINNER_VERBS",
  "cleanupDom", "dom", "installDom", "root"];
const destructured = [];
const headerText = headerBlocks.map((b) => b.text).join(eol);
for (const m of headerText.matchAll(/const \{([^}]*)\} = await import\("[^"]+"\)/g)) {
  for (const piece of m[1].split(",")) {
    const p = piece.trim();
    if (!p) continue;
    const alias = p.includes(":") ? p.split(":")[1].trim() : p;
    destructured.push(alias);
  }
}
const helperNames = helperBlocks.map((b) => b.head.match(/^(?:async )?function ([A-Za-z0-9_$]+)/)[1]);
const allNames = [...new Set([...staticNames, ...destructured, ...helperNames])];

// ---- prelude ----
const preludeParts = [];
preludeParts.push([
  "// Shared prelude for the renderer-dom.*.test.mjs suite (split from the former",
  "// renderer.dom.test.mjs monolith). Exports the component bindings, the DOM",
  "// harness handles, and the cross-suite helpers. Test files must register",
  "// afterEach(cleanupDom) themselves.",
].join(eol));
for (const b of headerBlocks) {
  if (b.head.startsWith("import ") && b.text.includes('"node:test"')) continue; // node:test stays in test files
  let text = b.text;
  if (/^const \{/.test(b.head) || /^const [A-Za-z]/.test(b.head)) text = `export ${text}`;
  preludeParts.push(text);
}
for (const b of helperBlocks) preludeParts.push(`export ${b.text}`);
preludeParts.push(`export { ${staticNames.join(", ")} };`);
await writeFile(PRELUDE, preludeParts.join(eol + eol) + eol);

// ---- group test files ----
const skipDropped = [];
const titles = new Map();
const groupBlocks = new Map(GROUPS.map(([, name]) => [name, []]));
for (const b of testBlocks) {
  const title = b.head.match(/^test\("((?:[^"\\]|\\.)*)"/)?.[1] ?? b.head;
  titles.set(title, (titles.get(title) ?? 0) + 1);
  if (/\{ skip:/.test(b.head)) { skipDropped.push(title); continue; }
  let name = GROUPS[0][1];
  for (const [threshold, groupName] of GROUPS) {
    if (b.start + 1 >= threshold) name = groupName;
  }
  groupBlocks.get(name).push(b);
}

for (const [, name] of GROUPS) {
  const list = groupBlocks.get(name);
  const body = list.map((b) => b.text).join(eol + eol);
  const used = allNames.filter((n) => new RegExp(`\\b${n}\\b`).test(body));
  if (!used.includes("cleanupDom")) used.push("cleanupDom");
  const header = [
    `// Split from renderer.dom.test.mjs; shared bindings and helpers live in`,
    `// renderer-dom-test-prelude.mjs. Runs under the tsx loader with`,
    `// --test-concurrency=1 (see package.json "test:renderer").`,
    `import { afterEach, test } from "node:test";`,
    ``,
    `import {`,
    ...used.sort((a, z) => a.localeCompare(z)).map((n) => `  ${n},`),
    `} from "./renderer-dom-test-prelude.mjs";`,
    ``,
    `afterEach(cleanupDom);`,
  ].join(eol);
  await writeFile(`src/renderer/renderer-dom.${name}.test.mjs`, header + eol + eol + body + eol);
  console.log(`${name}: ${list.length} tests, ${body.split(/\r?\n/).length} body lines`);
}

console.log(`total tests: ${testBlocks.length}, dropped skipped: ${skipDropped.length}`);
for (const t of skipDropped) console.log(`  dropped: ${t}`);
for (const [t, n] of titles) if (n > 1) console.log(`  DUPLICATE title x${n}: ${t}`);
console.log(`helpers: ${helperNames.join(", ")}`);
console.log(`prelude exports: ${allNames.length} names`);
