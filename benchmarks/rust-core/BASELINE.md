# Node baseline report (P0-BENCH)

Product: Mixdog `1.4.5`-line dev tree, repo commit `b82ff13a7` (`src` tree `d1cc6bcf`, `apps` tree `a6553550`), Node v22.20.0, win32 x64, Intel Core Ultra 7 265KF (20 logical), 32 GiB. This PC is the reference machine until the user names one (decisions.md). Raw data: `results/baseline-node.json` (20 iterations per series).

Harness: the product's own observed daemon (`src/standalone/test-fixtures/daemon-steady-harness.mjs`) in an isolated home; calls go through the real client protocol (`session.list`, `session.read`, `session.read` + `action`). "Loop delay" is `monitorEventLoopDelay` (10 ms resolution, so ~10 ms is the floor) inside the daemon over the measured window — the Node analog of RT-W/RT-C poll lag.

## Results (ms, p95 unless stated)

| Measure | 100 sessions | 10,000 sessions | Rust gate it feeds |
|---|---|---|---|
| Daemon launch → ready (incl. seeding the corpus) | 2,438 | 9,362 | G1 (≤300 ms to B4) |
| First `session.list` after ready (catalog build) | 1,720 (loop max 535) | 11,516 (loop max 339) | G1 (≤500 ms) |
| `session.list` steady (p50 / p95 / max) | 2.0 / 3.0 / 3.6 | 110 / 160 / 163 (loop max 55) | G1, G3, G7 |
| Cold open small session (`session.read`) | 9.1 (max 58) | 7.2 (max 65) | G2 (≤600 ms) |
| `listProviderModels` | 12.9 | 13.5 | G3/G4 (≤500 ms) |
| `getUsageDashboard` | 4.0 | 7.0 | G3/G7 |
| `getUsageStats` | 57 (max 255) | 62 (max 240) | G3/G7 |
| `getUsageRequests` | 4.0 | 9.5 | G3/G7 |

Cold open of large sessions (single sample each, 100-session daemon; 20 iterations are impossible without restarting the daemon because a second read is warm): 19 MB log 1,245 ms (loop max 21); 200 × 1 MiB entries 4,106 ms (loop max 397); one 50 MiB tool output 2,032 ms (loop max 138). Against G2's ≤600 ms these are the gaps the Rust store must close; the 200 × 1 MiB case also blocks the Node loop ~400 ms.

## Caveats (read before comparing)

- Launch time includes the corpus seeding done in `prepare`; use the first-list time and the loop-delay maxima as the signal, not the absolute launch figure.
- Usage reads ran on an empty ledger (no turns were run, no provider exists), so they show call overhead, not the 120,000-row ledger cost; the ledger fixture belongs to the G7 harness.
- Synthetic sessions are small (8 messages) except the three large ones; the real 1.05 GB corpus is user data and is not copied. The 1,000,000-entry session is not recorded (Node's one-JSON-file format cannot hold it practically).
- The 100,000-session corpus is supported (`--corpora 100,10000,100000`) but was not run here.
- Single run on a shared dev PC; timings vary run to run. Re-run the command for current numbers; the loop-delay histogram resolution is 10 ms.

## Recorded vs not recorded

Recorded (see README for commands):

- Providers (real Node adapters against local fake servers): `anthropic` (text, tool call, tool-result follow-up, 400 error, truncated stream with no `message_stop` → 3 retries then error), `openai-compat` chat (text, tool call, follow-up, 401, truncated), `mixdog-local`, OpenAI Responses over HTTP/SSE (text, tool call, follow-up, truncated without `response.completed`); pure request-body vectors for `anthropic-oauth`, OpenAI Responses and WS `response.create`/delta; the repo's existing parity fixtures copied as oracles.
- Tools: 19 cases (read, list, glob, find, grep, edit, apply_patch, shell, code_graph) + the two existing text goldens.
- Desktop golden twins: git (17 ops), workspace search/replace (10), project files (19), listening-port parsers (3).
- `session-state`: 15 frames over all 42 `DesktopSessionState` fields incl. `streamingTail`/`streamingPartial`, `toolApproval`/`toolApprovalsWaiting`, `promptRestore`.
- Lifecycle 1.4.5: barrier unit (real tag modules) matches LR §2.2 (claim → `owned:false`, refresh → `busy`, handoff → `owned:false`, release → false, record byte-identical, no record written when deleted); real tag `daemon.mjs` against the barrier exits 0 with "live peer holds owner lock (pid=…) — exiting for attach" and leaves record and barrier untouched.

Could not be recorded here, and why:

- Provider adapters, intercepted set (`native/core/fixtures/providers-intercepted/`, 89 scenarios, recorder `record-providers-intercepted.mjs`): recorded in-process through a global-fetch / `ws` / `node:http2` loopback hub with fake credential stores in a temp `MIXDOG_DATA_DIR`; each scenario stores the original origin, request/handshake headers (secrets redacted), request bytes or WS frames both ways, the served bytes and the adapter result. Covers OpenAI and OpenAI-OAuth Responses over **WebSocket** (text, tool call, `response.failed` frame, `error` frame, handshake 401, socket killed before `response.completed`) and over HTTP/SSE, `anthropic-oauth`, `gemini`, `vertex-ai` (ADC + API key), `grok-oauth`, `antigravity-oauth`, `muse-code-oauth`, `command-code-oauth`, `mimo-oauth`, `opencode-go-oauth`, `devin-oauth`, `cursor-api`; per HTTP transport an error (400/401) and two truncated cases (clean EOF, connection reset). Partial: `devin-oauth` has errors and a reset only (its success path is protobuf Connect framing the recorder does not synthesize); `cursor-api` records the token exchange and the HTTP/2 request, but its runs end by recorder abort (`abortedByRecorder: true`) because the adapter keeps waiting on a bidirectional stream; `grok-oauth` and `mimo-oauth` truncated runs are likewise recorder-aborted after the adapter retries for 45 s. Recorded as what Node does, not as a spec.
- Desktop service twins (`native/core/fixtures/desktop/{settings,github,terminal,lsp,notifications,transfer,remote-relay}/corpus.json`, recorder `record-desktop-services.mjs`): no Electron was needed. The real `createDesktopOperations` dispatcher loads under the TS resolve hooks (a `.json` load hook was added). Recorded: settings, terminal (real node-pty; output reduced to marker/shape facts), LSP (unsupported language, server absent, language tables), GitHub (feature gate through the dispatcher; command building through the product `executeGithubRequest` with an injected `run`, so the real `gh` is never invoked), notifications (center over the product preference store), transfer (grant, lease, ranges, finish, cross-device, expiry, revoke) and the remote/relay device leg against a local `ws` relay stand-in (handshake, frames sent on open, pair code, close). Not recorded: browser (Electron webContents/CDP), a full relay E2EE session with a paired phone (needs a peer implementing the E2EE handshake; only the device leg is recorded), real language servers (none installed), dispatcher ops that spawn `gh`/`git` installers or LibreOffice (environment-dependent), and Electron-only surfaces (windows, tray, native notifications; `sendPcTest` is stubbed).
- Tool goldens added by `record-tools-extra.mjs`: all 13 `code_graph` modes (+ error cases), `office` (describe/detect/create/snapshot/validate/save/close/batch/query on docx, xlsx, pptx, csv; local portable backend), `read` of PDF (hand-built), DOCX/XLSX/PPTX (created by `office`) and corrupt inputs, and `memory` (embedded Postgres, temp data dir). Not capturable: `web_fetch`/`web_search` (network by definition), `recall` (needs a populated index and embeddings), `session`/`agent`/`task` (need a live daemon turn), `browser`/`computer` (desktop-bridged), `office` render/OCR (needs LibreOffice/tesseract) and the `microsoft-office-com` backend (needs Microsoft Office; `detect` records only what this PC reports). Blank created DOCX/PPTX/XLSX read as empty or not-a-presentation, so content-bearing OOXML read goldens exist only for the xlsx written by the `batch` case.
- `lifecycle`: only LR §11 tests 1 and 2 have recorded fixtures; the 10+10 simultaneous-start, suspend/stale-heartbeat, crash-point, storage and wind-down tests need the Rust core and are harness work (WP-BENCH/WP-LIFECYCLE). The tag's own `node_modules` (from its lockfile) was not installed; the HEAD tree's `node_modules` stood in (`lifecycle/tag.json` says so) — CI must run `npm ci` from the tag lockfile.
- RL §14 gates that need the Rust core or fault injection (G3 storage faults, G4 saturation, G5–G10) have no Node baseline: they have no Node equivalent. The Node loop-delay figures above are the only comparable "poll" data.

## 1.4.5 usage ledger and the scratch corpus ledger

`native/core/fixtures/migration/ledger-v145/` is a genuine 1.4.5 ledger: the tag's own `usage-ledger.mjs` (`UsageLedger.record`) recorded the 5,781 usage rows of the corpus's `gateway-usage.local.jsonl` into a fresh SQLite file. It has 13 tables, 7 indexes, 1 view and 16 triggers (the counts P0-STORE derived from the tag); `schema.json` lists every object and `tables.json` gives per-table row counts and an ordered-row sha256 (the `.sqlite` bytes are not byte-reproducible; the logical hashes are). **The ledger inside the scratch migration corpus (`migration-corpus/v145/usage/ledger.sqlite`, 18 tables) was written by the dev build, not by 1.4.5: it is dev-build-shaped and must not be used as the 1.4.5 schema reference.**

## Retry determinism and provenance (provider sets)

Provider recordings (providers/, providers-intercepted/) keep every request header (credential values redacted; random per-request ids typed as <random:hex32>; host normalized to the original origin) and carry a `determinism` block per scenario: seeded `Math.random` samples (mulberry32, seed = fnv1a32(scenarioId)) with call sites, and `retrySleeps` (exact scheduled delay in ms and the attempt it preceded). Watchdog/deadline timer delays are not recorded (re-arm counts and Date.now-derived delays are not reproducible); only their sites are listed. Product identity in each MANIFEST is derived from the tree actually loaded (content hashes of src/apps, blob comparison to the closest recent commit; `commit` is null unless exact). The loaded archive tree differs from every candidate commit in 290 files, so the recordings are labelled by content hash, not by commit.
