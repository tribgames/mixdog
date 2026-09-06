// The fixture uses production components with an in-memory host. It never
// connects to the daemon or the installed app's profile.
import { build } from "esbuild";
import electron from "electron";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const artifacts = resolve(here, "../../artifacts/extensions-layout");
await mkdir(artifacts, { recursive: true });
const output = await mkdtemp(join(artifacts, "run-"));
await build({
  entryPoints: [join(here, "entry.tsx")],
  outfile: join(output, "fixture.js"),
  bundle: true,
  format: "iife",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file", ".svg": "file", ".png": "file" },
  logLevel: "warning",
});
await writeFile(join(output, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="./fixture.css"></head><body><div id="root"></div><script src="./fixture.js"></script></body></html>');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [join(here, "main.cjs"), output, ...process.argv.slice(2)], {
  env, stdio: "inherit", windowsHide: true,
});
child.on("error", error => { console.error(error); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
