/** Bundles the geometry probe entry for the Electron shell. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

/** Vite's `?worker` imports (Monaco) have no esbuild equivalent; the probe
 *  never opens an editor, so they resolve to an inert stub. */
const workerStub = {
  name: "worker-stub",
  setup(builder) {
    builder.onResolve({ filter: /\?worker$/ }, (args) => ({
      path: args.path,
      namespace: "worker-stub",
    }));
    builder.onLoad({ filter: /.*/, namespace: "worker-stub" }, () => ({
      contents: "export default class StubWorker {}",
      loader: "js",
    }));
  },
};

await build({
  entryPoints: [join(here, "entry.tsx")],
  outfile: join(here, "probe.bundle.js"),
  bundle: true,
  format: "iife",
  jsx: "automatic",
  logLevel: "info",
  plugins: [workerStub],
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".css": "empty", ".svg": "empty", ".png": "empty", ".woff2": "empty" },
});
