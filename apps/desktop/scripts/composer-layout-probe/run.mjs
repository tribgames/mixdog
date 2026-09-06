import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import electron from "electron";

const here = dirname(fileURLToPath(import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "mixdog-composer-layout-"));
try {
  await build({
    entryPoints: [join(here, "entry.tsx")],
    outfile: join(temp, "entry.js"),
    bundle: true, format: "esm", jsx: "automatic",
    define: {
      "process.env.NODE_ENV": '"production"', "process.env": "{}",
      "process.platform": JSON.stringify(process.platform),
    },
    loader: { ".css": "empty", ".svg": "empty", ".png": "empty", ".woff2": "empty" },
    plugins: [{
      name: "unused-editor-workers",
      setup(builder) {
        builder.onResolve({ filter: /\?worker$/ }, (args) => ({ path: args.path, namespace: "worker" }));
        builder.onLoad({ filter: /.*/, namespace: "worker" }, () => ({
          contents: "export default class Worker {}", loader: "js",
        }));
      },
    }],
  });
  const renderer = resolve(here, "../../src/renderer");
  await writeFile(join(temp, "index.html"), `<!doctype html><html><head>
    <link rel="stylesheet" href="${pathToFileURL(join(renderer, "styles.css"))}">
    <link rel="stylesheet" href="${pathToFileURL(join(renderer, "desktop.css"))}">
    </head><body><div id="root"></div><script>
    window.probeErrors = [];
    window.addEventListener("error", event => window.probeErrors.push(String(event.error?.stack || event.message)));
    </script><script type="module" src="./entry.js"></script></body></html>`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const exitCode = await new Promise((done, reject) => {
    const child = spawn(electron, [join(here, "main.cjs"), temp, process.argv[2] || "all"], { env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", done);
  });
  const report = await readFile(join(temp, "report.json"), "utf8");
  console.log(report);
  const line = /entry\.js:(\d+):/.exec(report);
  if (line) {
    const source = (await readFile(join(temp, "entry.js"), "utf8")).split("\n");
    console.error(source.slice(Math.max(0, Number(line[1]) - 4), Number(line[1]) + 3).join("\n"));
  }
  if (exitCode !== 0) process.exitCode = 1;
} finally {
  // Only this invocation's generated temporary bundle is removed.
  await rm(temp, { recursive: true, force: true });
}
