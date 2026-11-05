# Rust-core benchmarks and fixtures (P0-BENCH)

Baselines and recorders on today's **Node** product. The Rust gates (RL §14,
P §14, DS §18, LR §11) compare against what is recorded here. Fixtures are
data under `native/core/fixtures/<set>/` with a per-set `MANIFEST.json`
(sha256 per file, recorder command, product identity = git tree ids of `src`
and `apps`) and an index `native/core/fixtures/MANIFEST.json`.

No real credential, token, user data or provider call is used anywhere.
Daemons run with a temporary `MIXDOG_DATA_DIR`/`HOME` and are stopped by the
recorder. `scanForSecrets` rejects secret-shaped text before a manifest is written.

## Prerequisite: a tree with `node_modules`

Every recorder takes `--tree <dir>` (or `MIXDOG_BENCH_TREE`): a Node product
tree that has `node_modules` (and `apps/desktop/node_modules` for the desktop
recorders). CI: `npm ci` in the checkout. Dev PC without installs:

```powershell
git archive --format=tar -o head.tar HEAD; mkdir tree; tar -xf head.tar -C tree
cmd /c mklink /J tree\node_modules <main checkout>\node_modules
cmd /c mklink /J tree\apps\desktop\node_modules <main checkout>\apps\desktop\node_modules
```

## Recorder commands (all idempotent; re-running yields identical manifests, except `baseline-node`, which is timing data)

| Set | Command (from repo root) | Output |
|---|---|---|
| Baselines (RL §14) | `node benchmarks/rust-core/recorders/baseline-node.mjs --tree T [--corpora 100,10000[,100000]] [--iterations 20]` | `benchmarks/rust-core/results/baseline-node.json` |
| Provider recordings | `node benchmarks/rust-core/recorders/record-providers.mjs --tree T` | `native/core/fixtures/providers/` |
| Tool goldens | `node benchmarks/rust-core/recorders/record-tools.mjs --tree T --native-root <dir with mixdog-{spawn,patch,graph}/target/release>` | `native/core/fixtures/tools/` |
| Desktop golden twins | `node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs benchmarks/rust-core/recorders/record-desktop.mjs --tree T` | `native/core/fixtures/desktop/` |
| `session-state` streams | `cd T/apps/desktop; node --import ./scripts/test-env.mjs --import ./scripts/test-tsx.mjs <repo>/benchmarks/rust-core/recorders/record-session-state.mjs --tree T` | `native/core/fixtures/session-state/` |
| 1.4.5 lifecycle | `node benchmarks/rust-core/recorders/record-lifecycle.mjs --tree T [--tag-tree <git archive 69fe41b05 + node_modules>]` | `native/core/fixtures/lifecycle/` |
| Provider recordings, intercepted adapters | `node benchmarks/rust-core/recorders/record-providers-intercepted.mjs --tree T [--only <id>]` (about 8 min: adapters retry) | `native/core/fixtures/providers-intercepted/` |
| Desktop service twins | `node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs benchmarks/rust-core/recorders/record-desktop-services.mjs --tree T` | `native/core/fixtures/desktop/{settings,github,terminal,lsp,notifications,transfer,remote-relay}/` |
| Extra tool goldens | `node benchmarks/rust-core/recorders/record-tools-extra.mjs --tree T` (after record-tools.mjs) | `native/core/fixtures/tools/{code_graph,office,read,memory}/` |
| 1.4.5 usage ledger | `node benchmarks/rust-core/recorders/record-ledger-v145.mjs --tree T [--corpus <migration-corpus>]` | `native/core/fixtures/migration/ledger-v145/` |
| Verify + index | `node benchmarks/rust-core/recorders/verify-manifests.mjs` | exit 1 on any drift |

Layout of each set and what a consumer compares:

- `providers/<provider>/<scenario>/{request.json,response.sse,result.json}` — the exact request the Node adapter sent to a local fake server (method, path, headers with secrets redacted, body text), the exact SSE bytes served, and the adapter's normalized result (content, toolCalls, usage, stopReason, or the error) plus the tool calls dispatched while streaming. `request-builders/` holds pure request-body vectors (anthropic-oauth, OpenAI Responses, WS `response.create`/delta). `oracles/` are copies of the repo's existing parity fixtures.
- `tools/<tool>/<case>.json` — `{tool,input,text,isError}` over a fixed workspace (`<ROOT>` = workspace, mtimes pinned); `tools/existing/` copies the product's own text goldens.
- `desktop/{git,search,files,ports}/corpus.json` — `{op,args,result|error}` per call; commit hashes/timestamps are scrubbed to `<H40>`/`<H>`/`<T>`, paths to `<ROOT>`. Rust must reproduce them after normalizing only error text to `data.reason` (DS §18.1).
- `session-state/steps.json` (daemon-side snapshots published) and `stream.json` (each `session-state` wire message that crossed the desktop service boundary + the folded renderer snapshot after it). Covers all 42 contract fields.
- `lifecycle/` — barrier bytes (`barrier/`), `barrier-unit.json` (verdicts of the real tag modules), `daemon-start-against-barrier.json` (real 1.4.5 `daemon.mjs`), `tag.json` (tag commit + blob ids of the tag files the tests use + the `git archive` recipe), `migration-corpus-ref.json` (reference to the existing migration corpus; not duplicated).

Gate harnesses G1–G10, DS-LANE-1, reconnect storm and slow consumer are WP-BENCH, not this package. See `BASELINE.md` for numbers and the list of what could not be recorded.
