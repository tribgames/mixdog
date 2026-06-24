# mixdog-cli Port Plan

**Status**: active
**Strategy**: strangler-fig migration — vendor pi whole, then **remove → replace → delete** one capability at a time until the body is mixdog's.
**Scope**: turn the existing mixdog system into a standalone coding-agent CLI/TUI, using pi as the living shell that gets hollowed out and refilled.

---

## 1. Product definition

`C:\Project\mixdog-cli` is the standalone build of **mixdog itself** as a terminal coding agent.

It **is**:

> mixdog as a standalone terminal coding agent, grown by gutting pi from the inside — pi supplies the running body, mixdog replaces the organs one at a time, dead pi code is excised on the spot.

It is **not**:

- a helper CLI for the current plugin,
- a thin client that only talks to a running mixdog,
- a generic project parser,
- a direct Claude Code clone,
- pi-with-mixdog-bolted-on-top (the rejected "stack on top" approach — it leaves duplication and bloat).

## 2. The three codebases

| Codebase | Role |
|---|---|
| `C:\Project\mixdog` | **Organs to transplant** — gateway/providers, tools, memory, search, code graph, bridge/workers, session/compact, (optional) channels |
| `C:\Project\refs\pi` | **Living host** — vendored whole, then progressively gutted. Supplies TUI body, interactive loop, session scaffolding, and the **minimal permission model we keep** |
| `C:\Project\refs\claude-code` | **UX reference only** — copy behavior/shape (statusline, tool cards, model selector, slash UX, compact/clear feel). Never copy its React/Ink source |

Priority order on conflict:

```text
mixdog behavior/system correctness
  > pi implementation convenience
  > Claude Code UX parity
```

## 3. Core method — strangler, not stacking

Every capability swap is **three beats**, and the build stays runnable after each:

> **REMOVE** the pi piece → **REPLACE** with the mixdog piece → **DELETE** the now-dead pi code.

```text
[rejected]  pi (untouched)  +  mixdog (added on top)   → duplication, bloat
[chosen]    pi piece removed → mixdog piece inserted → dead pi code excised → always slim
```

Two standing rules enforced at every step:

1. **Excise dead code immediately.** After a replacement, the orphaned pi code is deleted in the *same* step — never deferred. Prevents the body from bloating.
2. **Always green.** `mixdog-cli` must launch and complete one turn after every beat. No moving on while broken.

## 3.5 Comparison gate — analyze before you swap

Porting is **not** mechanical. Before REMOVE→REPLACE→DELETE, every component passes a 4-step **comparison gate**. The gate decides *whether* to replace at all.

```text
1. COMPARE   read the pi / claude-code structure for this component,
             put it side by side with mixdog's equivalent.
2. ANALYZE   pros/cons table: who does what better, and why.
3. DECIDE    one of three —
             ├ pi/CC is better   → keep theirs, graft only mixdog's strengths
             ├ mixdog is better  → replace with ours
             └ both fall short   → re-do it our way (third option)
4. RECORD    log the one-line verdict in §10 Decision log.
```

> **gate (why/what) → three beats (how).** Never gut-and-graft without the analysis first. Every step asks: "why did pi build it this way, and are we actually better?"

The outcome is **not always "replace with mixdog."** Three legal results:

| Analysis result | Action |
|---|---|
| pi/CC does it better | 🟦 **keep theirs** + absorb only mixdog's edge (permission is already this case) |
| mixdog does it better | 🟥 **replace with ours** |
| both fall short | 🟩 **re-do our way** (third option) |

Keeping pi's minimal permission model is the precedent: compared, found to fit our philosophy better, so **kept, not replaced.**

## 4. Keep / Replace / Remove map

| pi component | Disposition | Why |
|---|---|---|
| TUI render core (`tui/src/tui.ts`, `components/*`) | 🟦 **KEEP** | the body's skeleton; reshaped, not replaced |
| Interactive loop (`modes/interactive/*`) | 🟦 **KEEP** | mutated in place, organ by organ |
| **Permission model** (`trust-manager.ts`, `project-trust.ts`, `--approve`) | 🟦 **KEEP** | **pi's minimal style is honored by design — do NOT port mixdog's heavy permission-evaluator** |
| Provider/`ai` direct wiring | 🟥 REPLACE → mixdog gateway routing | one brain, ours |
| Footer / statusline | 🟥 REPLACE → mixdog statusline, CC-styled | the UX point Jae-young named |
| Settings surface (`settings-manager`, `config-selector`) | 🟥 REPLACE → mixdog settings UX | |
| Builtin tools (`core/tools/*`) | 🟥 REPLACE → mixdog tools, one at a time | read/list/glob/grep/bash/write/edit/apply_patch |
| Session / compaction | 🟥 REPLACE → mixdog session+compact (CLI-owned) | drop Claude Code host assumption |
| Bedrock register, unused providers/packages | ⬛ **REMOVE** | not in our stack |

## 5. Decision: the `ai` package

**Verified dependency fact:** 24 files in `coding-agent/src` import `@earendil-works/pi-ai` (starting at `main.ts:9`). Dropping `ai` up front = 24 broken imports = build cannot compile = Stage 0 never boots. `ai` is pi's own gateway (40+ providers, OAuth, SSE/WebSocket streaming, thinking/effort, prompt cache) — the one component that **directly overlaps** mixdog gateway.

**Decision (D2, corrected):** the *destination* is unchanged — `ai` is fully removed, everything becomes ours. Only the *timing* changes: **vendor `ai` as load-bearing scaffold, replace its 24 dependents one-by-one in Stage 1, remove `ai` last** once nothing imports it. Removing the prop first would collapse the build mid-migration — that violates the "always green" rule, not the one-by-one principle.

> 🔁 **Reversible:** if we later prefer pi's provider matrix over gateway, keep `ai` and have gateway wrap it instead of replacing. Single switch point.

## 5.5 Decision: MCP vs native tools

**Structural fact (verified):** pi tools are **in-process functions** (`ToolDefinition` → `registerTool` → direct `execute()`), no network. Current mixdog tools are **MCP/JSON-RPC**, hosted by Claude Code. These are two different worlds — making mixdog tools "the default" forces a transport choice:

| | 🅰 Embed MCP client | 🅱 Native absorb |
|---|---|---|
| What | mixdog-cli becomes an MCP client; `registerTool` wraps each MCP tool as a proxy | lift mixdog tool *logic* into pi `ToolDefinition`s; excise MCP layer |
| Pro | reuse mixdog tools almost unchanged; memory/search/bridge come free | truly standalone, no daemon, slimmest, fits pi minimal |
| Con | daemon dependency, JSON-RPC round-trips, not fully standalone | hand-port each tool (this is why Stage 4 is long) |

**Decision — hybrid:** target 🅱 native; bridge heavy infra with 🅰 temporarily.
- File tools (read/list/glob/grep/bash/write/edit/apply_patch) → 🅱 **native** (pi already has equivalents — natural swap).
- Heavy infra (bridge/memory/search/code_graph) → 🅰 **MCP proxy** as a stopgap, absorbed to native when convenient.

> Rationale: "remove the unnecessary middle layer (MCP) for file tools" *is* the strangler move, and matches pi-minimal. Heavy infra rides MCP first to land fast, then gets absorbed — standalone + speed at once.

## 6. Stages

Legend — 🟢 do now · 🟡 core value (MVP lands here) · 🔵 extension.

Each stage opens with **🔍 Compare** (the pi/CC files to read first) before any swap. The verdict from §3.5 lands in §10.

### 🟢 Stage 0 — vendor pi whole, make it live
- 🔍 Compare: `refs/pi/packages/coding-agent/src/{cli.ts,main.ts}`, `tui/src/tui.ts` vs current `mixdog-cli/src/{cli,app}.mjs`.
- Keep pi `coding-agent` + `tui` under `mixdog-cli/refs/pi` as reference-only source (per §5: **not** `ai`).
- **Change nothing** behaviorally — confirm pi TUI boots under the `mixdog-cli` name and completes one turn.
- First excision: drop bedrock register + packages we'll never use.
- ✅ Done when: pure pi runs as `mixdog-cli`, one turn of chat works.

### 🟢 Stage 1 — gut provider → graft gateway
- 🔍 Compare: pi `core/{model-registry,model-resolver,sdk}.ts` + `ai` provider abstraction vs `mixdog/src/gateway/*`.
- REMOVE pi `ai`/provider direct wiring.
- REPLACE with mixdog gateway routing; `/model` lists our provider registry (anthropic-oauth, oc-*, gpt-*, …).
- DELETE orphaned pi provider adapters / auth branches.
- ✅ Done when: replies come via our route; pi's original provider code is gone.

**Status: brain wired ✅ (verified).** The earlier pi gateway override path was removed from the executable CLI. The product path now uses the native mixdog runtime/provider implementation; pi remains only under `refs/pi` for comparison.

### 🟡 Stage 2 — gut footer → graft statusline
- 🔍 Compare: pi `core/footer-data-provider.ts` + interactive footer render vs mixdog statusline + Claude Code statusline UX.
- REMOVE pi default footer (`footer-data-provider`).
- REPLACE with mixdog statusline, Claude Code-styled.
- DELETE unused pi footer fields/render path.
- ✅ Done when: bottom shows our statusline; pi default footer code gone.

### 🟡 Stage 3 — gut settings → graft our settings UX
- 🔍 Compare: pi `core/{settings-manager,resolve-config-value}.ts` + `cli/config-selector.ts` vs mixdog config UI.
- REMOVE pi settings surface (`settings-manager` / `config-selector`).
- REPLACE with mixdog settings UI shape.
- DELETE pi-only config keys / dead screens.

### 🟡 Stage 4 — swap tools one at a time (longest stage)
- 🔍 Compare: pi `core/tools/*` (in-process `ToolDefinition`/`registerTool`) vs mixdog MCP tools. **Key structural fact:** pi tools are in-process functions, mixdog tools are MCP/JSON-RPC. Swapping changes the tool transport.
- **MCP decision (§5.5):** target 🅱 **native** — lift mixdog tool *logic* into pi `ToolDefinition`s and **excise the MCP layer** for file tools. Heavy infra tools (bridge/memory/search/code_graph) may ride 🅰 **MCP proxy** as a temporary bridge, absorbed to native later.
- Replace each builtin in order: `read → list → glob → grep → bash → write → edit → apply_patch`.
- Per tool: remove pi tool → insert mixdog tool → delete pi tool code.
- **Permission stays pi-minimal** — `trust-manager`/`project-trust` are KEPT untouched (§4). No heavy evaluator port.
- ✅ Done when: all tools are ours; pi `core/tools/*` emptied of replaced builtins.

> **MVP line — Stage 4 complete = usable daily-ish standalone.**

### 🔵 Stage 5 — insert search / recall
- 🔍 Compare: pi has no equivalent → pure insertion. Decide native vs MCP-proxy per §5.5.
- Pure insertion (pi has no equivalent): `search → web_fetch`, then `memory/recall`.

### 🔵 Stage 6 — insert code_graph / bridge
- 🔍 Compare: pi `core/extensions/*` (tool/command registration) as the surface to hang bridge/code_graph on.
- Insert `code_graph`; surface `bridge/workers` progress in the TUI.

### 🔵 Stage 7 — own session/compact
- 🔍 Compare: pi `core/{session-manager,compaction/*}.ts` vs mixdog session/compact + Claude Code host assumptions.
- REMOVE pi `session-manager` / `compaction`.
- REPLACE with mixdog session + compact, CLI-owned.
- DELETE Claude Code host-assumption remnants.

### ⬛ Stage 8 — channels/scheduler/webhook (only if meaningful standalone)
- Out of scope unless they earn their place outside the plugin host.

## 7. Host-assumption replacements (folded into the stages above)

The current mixdog code assumes Claude Code provides host behavior. Standalone must own each boundary:

| Current assumption | Standalone replacement | Stage |
|---|---|---|
| Claude Code transcript/session host | local session store | 7 |
| Claude Code tool permission UI | **pi minimal trust (kept)** + CC-styled prompt veneer | 4 |
| Claude Code MCP tool surface | internal runtime tool registry | 4 |
| Claude Code statusline hook | native footer/statusline | 2 |
| Claude Code slash command loader | standalone command registry | 2–3 |
| Claude Code subagent tools | mixdog bridge/workers in TUI | 6 |
| Hook/channel events | explicit runtime events / optional services | 8 |

## 8. Non-goals (now)

- No changes to `C:\Project\mixdog` unless explicitly requested.
- No deploy, push, publish, or git init.
- No generic project parser detour.
- No direct Claude Code UI source copy.
- No "stack on top" — every swap removes its pi predecessor.
- No heavy mixdog permission layer — pi minimal is honored.

## 9. Next concrete step

Execute **Stage 0** on approval:

1. keep pi `coding-agent` + `tui` as reference source under `mixdog-cli/refs/pi`,
2. boot it unchanged as `mixdog-cli`, confirm one turn,
3. first excision (bedrock + unused packages),
4. smoke test that launch succeeds without touching `C:\Project\mixdog`.

## 10. Decision log

One line per comparison-gate verdict (§3.5). Append as stages execute.

| # | Component | Compared | Verdict | Action |
|---|---|---|---|---|
| D1 | Permission model | pi trust vs mixdog evaluator | pi minimal fits our philosophy | 🟦 keep pi, no port |
| D2 | `ai` package | pi 20+ providers vs mixdog gateway | gateway already owns routing | ⬛ don't vendor `ai` |
| D3 | Tool transport | pi in-process vs mixdog MCP | hybrid: native for files, MCP-proxy for heavy infra | 🟩 re-do our way (§5.5) |
| D4 | Provider / brain | full pi-ai (40+ providers, 12-event stream, transformMessages) vs mixdog gateway (routing, OAuth-bypass, Claude-Code spoofing, usage) | gateway is an Anthropic-compatible HTTP server → split at the HTTP boundary, not fused | 🟩 **hybrid (§5.6):** KEEP pi's stream-event model + message normalization + Anthropic SSE parser; ROUTE through gateway for provider/OAuth/spoof/usage; pi's other 39 providers hide behind gateway → trimmed as dead weight |
| D5 | max_tokens default | pi sends model's full output ceiling (opus 128000) vs subscription-OAuth limit | OAuth path rejects huge caps with "out of extra usage"; real Claude Code caps far lower | 🟥 **clamp in pi** when gateway-routed: `min(requested, MIXDOG_ANTHROPIC_MAX_TOKENS ?? 32000)` |
| D6 | Stage 1 approach reversal | wire pi's Anthropic SDK layer → gateway (env override) vs port mixdog's own raw provider | pi sends via `@anthropic-ai/sdk` (`Anthropic/JS 0.91.1` + stainless headers); even with correct body the SDK request shape kept hitting "out of extra usage" while mixdog's own raw provider (this very session) works flawlessly. mixdog `anthropic-oauth.mjs` is raw HTTP+SSE, no SDK, with Claude Code spoofing built in, and depends only on internal `shared/*`+`session/context-utils` (no host/MCP/hooks coupling). | 🟩 **REVERSE: port mixdog's own provider layer in, use pi only as a reference to diff/patch gaps.** Faster + keeps the proven brain. Supersedes the env-override wiring (baseUrl/max_tokens hacks become temporary scaffolding). |
| D7 | undici dispatcher in standalone | ported provider passes its own `undici` Agent as per-request `dispatcher` to global `fetch` | standalone mixdog-cli installs `undici` as a separate package instance from Node's built-in fetch undici → `UND_ERR_INVALID_ARG`. Verified: no dispatcher → 401 (connects), imported-undici dispatcher → INVALID_ARG. | 🟩 **patch ported `http-agent.mjs`:** self-install the Agent via `setGlobalDispatcher` once, return `undefined` per-request so call sites ride the global. First "port + adapt to standalone env" case. |
| D8 | agent loop ownership | adapt pi's agent loop + 12-event adapter vs port mixdog's own `agentLoop` whole | mixdog's `agentLoop` (session/loop.mjs) is the engine that already runs bridge workers host-independently. Full closure = 144 files (110 new on top of the 34-file provider port), and of those only **3 touch-points** needed adapting (http-agent undici, keychain, permission-evaluator dynamic path). MCP client is a standard `@modelcontextprotocol/sdk` client, not host coupling — ported whole. | 🟩 **PORT THE WHOLE LOOP.** Verified: `agentLoop(provider, ...)` returns `content:"pong"` via ported anthropic-oauth. mixdog brain (loop→provider→tools→session/compact/store→MCP→permissions) now loads & runs inside mixdog-cli. pi is reduced to TUI rendering. |
| D9 | TUI junction | wrap pi AgentSession vs drive our agentLoop from a native REPL | our engine is the owner; pi's AgentSession engine is bypassed entirely. Built `src/repl.mjs`: stdin line → `agentLoop(provider, messages, ...)` → `onTextDelta` streams tokens to stdout live. | 🟩 **native REPL owns the loop.** Verified: `mixdog-cli --repl` streams `pong` from our agentLoop+anthropic-oauth, no pi engine in path. Next: layer pi `tui` widgets (input/render) as presentation; wire builtin tools into the loop's tool list. |
| D10 | tool wiring | connect ported builtin tools to the REPL loop | `BUILTIN_TOOLS` (read/edit/write/bash/grep/glob/list, minus host-only diagnostics/open_config) passed as the loop's `tools` arg; loop runs them via ported `executeBuiltinTool`. | 🟩 **tools live.** Verified: `mixdog-cli --repl` given "read ./tooltest.txt" emits `[tool: read]` and correctly answers `42` — real file read, full multi-turn tool loop. mixdog-cli is now a working standalone coding agent. |
| D11 | default entrypoint | keep pi TUI as default vs make our engine default | our engine is the product; pi is reference-only. | 🟩 **canonical TUI is DEFAULT.** `mixdog-cli` (no args) now runs the Ink/React TUI in `src/tui` over the mixdog session runtime. The old `--react` and pi TUI routes are removed. |
| D12 | host-env assumptions | ported runtime assumes Claude Code env (the "delayed host-coupling" predicted earlier) | clean env (no `CLAUDE_PLUGIN_DATA/ROOT`) surfaced two: `plugin-paths` threw without the host env; `internal-roles` couldn't find `defaults/hidden-roles.json` (data file, not caught by import-closure tracing). | 🟩 **standalone fallbacks added.** `resolvePluginData()` (both `.mjs` + `.cjs`) falls back to `MIXDOG_DATA_DIR ?? ~/.mixdog/data`; copied mixdog `defaults/` (hidden-roles, user-workflow, templates) into `src/defaults/`. Verified: `mixdog-cli` runs with Claude Code vars unset — picked `grep`, answered `999`. Truly host-independent now. |
| D13 | upstream sync strategy | how to track mixdog changes (the runtime is copied, not a package) | of 141 ported `.mjs`, **137 are pure copies** of mixdog/src — this is vendored-dependency shaped, not a fork. Only 3 standalone patches survive (http-agent undici D7, plugin-paths ×2 D12); the baseUrl "patches" were pi-side scaffolding our raw provider never needed. Upstream also kept evolving (anthropic cache-marker fix landed after our copy). | 🟩 **vendored + sync script (option B).** `scripts/sync-runtime.mjs`: recomputes the agentLoop import closure live from upstream → re-copies all 144 files + lib/hooks cjs + defaults → re-applies the 3 anchor-based, idempotent, fail-loud patches. `--check` reports drift. One command (`node scripts/sync-runtime.mjs`) absorbs any upstream change. Long-term: declare a fork point once the port stabilizes and graduate from sync. |
