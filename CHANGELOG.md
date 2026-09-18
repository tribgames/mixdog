# Changelog

Notable changes, newest first. The Deploy pipeline refuses to release while
the Unreleased section is empty, and stamps it with the released version.

## Unreleased

- A page no longer opens by announcing downloads it never made. Saved files
  belong to the session, but each page tracked what it had reported starting
  from zero, so every page opened afterwards greeted the caller with the whole
  backlog — a search page reporting a file another tab had saved minutes
  earlier. A new page starts already aware of what happened before it existed;
  a file saved while it is open still reaches it.

- The browser's own faults no longer read as the page's. A timed-out CDP call,
  a child frame that could not be attached, an interception that could not be
  answered — all of them were logged as page console errors, so a reply about a
  healthy site could open with `CDP Runtime.evaluate timed out` as if the site
  had logged it. They stay readable through `console`, marked `[browser]`, and
  no longer count among the errors a page is answerable for.

- A deadline reached behind an open dialog says so. An alert, confirm or prompt
  freezes the page's main thread, so the next call died on its timeout with
  nothing but the deadline — and the obvious retry timed out the same way. The
  error now names the dialog and its text, and says to answer it with
  `handle_dialog` before acting on the page again.

- A client-side route change is answered with the screen it produced, not the
  one the caller left. Single-page apps move the address with `history.pushState`
  and render the new view a moment later; no document loads, so the settle saw a
  quiet page and returned at once — and an `expect.url` was satisfied by the new
  address before anything was drawn. Clicking "Learn" on react.dev answered with
  the home page under the `/learn` address. When an action changes the address
  without a load, the reply now waits for the page to go quiet and a URL
  condition may not cut that short. Measured on the real-device harness:
  navigate, click and snapshot latencies are unchanged, because only same-
  document route changes take the extra wait.

- A WebSocket detail shows the upgrade request it actually sent. Only the
  address and the handshake response were recorded, so `network` answered with
  an empty request-header section — and a refused upgrade is usually explained
  by `Origin`, `Sec-WebSocket-Protocol` or a cookie. Credentials stay redacted.

- A click that opens a tab is no longer reported as a click that did nothing.
  A `target="_blank"` link leaves the current document untouched, so the reply
  answered "No observable change" and told the caller to look for a covering
  element — while the page it had just opened sat in `list_tabs` unmentioned.
  The reply now names the page that opened and how to act on it.

- `drag` takes snapshot-free targets like every other pointer action. Its two
  ends only accepted refs or raw coordinates, and the elements a page makes
  draggable — cards, list rows, drop zones — often carry no accessible name and
  therefore no ref, so moving one meant grounding a visual snapshot first even
  when the CSS selector was known. `target` and `dropTarget` now name the two
  ends, resolved together in one observation; refs and coordinates work as
  before, and both ends still have to be addressed the same way.

- A saved file is no longer announced as a failed request. An address that
  turns into a download cancels its own navigation, and Chromium reports that
  cancellation as `net::ERR_ABORTED`, so a reply that listed the download also
  listed it as a recent network failure. Cancelled requests — downloads, fetches
  the page abandoned, navigations replaced by another — stay readable through
  `network` but are no longer volunteered as faults of the page; a request that
  genuinely failed still is.

- A `brief` reply no longer turns one filled field into a page-wide change. It
  compares against the caller's previous observation, and when that observation
  was capped or filtered it had never reported the rest of the page — so every
  element outside it was listed as "changed or new". Filling three boxes on a
  form answered with fifteen elements, and typing one search word answered with
  a hundred and forty-six. The reply now keeps what the action demonstrably
  changed apart from what the earlier observation simply never covered, and says
  how much of the page that observation held. Nothing is omitted either way.

- Request headers in `network` are the ones that were actually sent. Chromium
  reports a provisional set first and adds language, encoding, client hints and
  cookies afterwards, so a request detail could show two headers and read as if
  the page never asked for Korean content. The later set is merged in;
  credentials are still named and never shown. Header names are case-insensitive
  and the two reports spell them differently, so the merge keeps one entry per
  header — the spelling and value that went on the wire — instead of listing
  `User-Agent` and `user-agent` as if the request carried both.

- Sites see Browser Use as the Chrome build that renders them. The agent string
  still carried the desktop app version and the Electron runtime, while the
  client hints the same pages received named Chromium alone; GitHub answered
  that contradiction with a sign-in wall on a public repository. The browser
  partition now presents the plain Chrome string — one less fingerprint, and
  fewer "unsupported browser" detours — and an emulated user agent still wins
  when a task asks for one.

- Pages that keep attaching frames can be observed again. Portals and news
  front pages open ad slots and widgets in bursts, and a snapshot that started
  mid-burst used to give up with "frame topology changed during observation" —
  reproducibly, on the first and second try. Observations have no side effects,
  so the collector now waits briefly for the burst to settle and reads again,
  up to a small ceiling, instead of handing the caller an error for a page that
  was merely busy. When a reading still fails, the reply now says the page is
  loaded and only the reading of it failed, so the next step is to observe
  again rather than abandon a page that is fine.

- A page reports only its own failures. Requests and console errors from the
  previous document stayed in the ledgers, so a snapshot of a healthy page could
  list aborted requests from the site visited before it, and `console` on a
  clean page could answer with the errors of the page before — both sending the
  reader after a fault that was not there. Loading a new document clears them;
  navigating inside the same document keeps them, because nothing reloaded.

- Browser Use display races are no longer failures. A capture that loses to a
  navigation or a window resize now answers with a resample marker instead of
  an error, because the pane was always going to ask again for whatever the
  page shows next. Ordinary browsing used to fill the app log with capture
  failures — seventeen in one harness run, none now — and a paired phone
  reported the same race as "could not connect to browser screen"; it now
  re-samples at the active cadence and reports only a display that genuinely
  stops making progress.

- Clear Browser Use browsing data. The browser pane has an eraser button that
  removes the cache, the data sites stored on this device, and cookies, each
  as its own decision: cache is preselected because losing it costs one slower
  reload, while cookies sign you out of every site and are never the default.
  Each scope is cleared on its own, so one failure is reported as a failure
  instead of disappearing behind the scopes that worked. Clearing cookies also
  rewrites the sealed file that carries session sign-ins across restarts, so a
  login you cleared does not come back the next time the app opens — and if
  that file cannot be rewritten, cookies are reported as not cleared rather
  than as done. Until now the shared partition grew on disk with no way to
  reclaim it.

- Browser Use `performance` metrics report the memory of the process painting
  the page, not just the JavaScript heap: a page whose images and layers hold
  the memory used to look small. The reading names the process, since one
  renderer can paint several pages of the same site.

- Browser Use domain policy covers peer connections. When an operator
  restricts the domains a page may reach, WebRTC no longer walks past the
  filter through STUN and TURN: peer connections are refused in the page and
  in every child frame. Without a domain policy nothing changes, and this
  remains containment for page code rather than a network boundary.

- Browser Use element screenshots. `snapshot mode=visual` accepts `ref` or
  `target` and returns that element as its own image. The box is measured in
  top-document CSS pixels — same-process frames fold their offset in on the
  page side, a cross-origin frame adds its session offset without the hit
  test that guards input, because a picture dispatches nothing and a frame
  under a CSS transform still deserves one — and the crop is scaled by the
  image-to-viewport ratio, so it holds
  on a zoomed or high-DPI display. An element taller or wider than the window
  is cut out of the document capture instead of the viewport, so a long table
  or article arrives whole rather than ending at the fold; only a page too
  large to capture falls back to the visible part, and says so. The image is
  inspection-only: it is never bound as coordinate grounding, because the ref
  remains the way to act on the element. `mode=semantic`, `fullPage` and
  `format=pdf` refuse a target rather than ignoring it.

- Browser Use input fidelity. `drag` now completes a page's own HTML5 drag:
  Chromium's drag interception hands over the payload the page started and
  the gesture finishes as `dragEnter`/`dragOver`/`drop`, which is what a
  kanban card, a sortable list or a file drop zone actually listens for;
  pages that only track mouse events keep the previous path. `type` sends a
  real key event per character instead of inserting the whole string, so
  keystroke-driven autocomplete and combo boxes react, while characters
  outside the US layout (Korean, emoji) are still inserted as text. `press`
  sends the US key codes for punctuation (`.` was Delete, `-` was Insert),
  keeps a shortcut from typing a character, and no longer infers Shift from a
  capital letter, which had turned `Control+A` into `Control+Shift+A`.
  `upload` drops files on an element that never opens a file chooser, with a
  guard that neutralizes an unhandled drop — otherwise the browser navigates
  the page to the dropped file — and reports plainly when nothing accepted it.

- Browser Use observation fidelity. `scroll text=` searches frames and shadow
  roots like `read` and `expect` do, picks one match across them, and no
  longer scrolls to a collapsed element. `expect.text` normalizes spaces
  within a line but keeps line breaks, so indented markup matches while two
  separate blocks never merge into one sentence. Console diagnostics keep
  what a page logged: object arguments arrive as a readable preview instead
  of an empty message, entries name the script and the line a reader would
  open, and an uncaught bare `throw` carries its location. Snapshots mark
  `aria-hidden`, a failed native `select` lists the options it did find, and
  `aria-labelledby` resolves inside a shadow root.

- Browser Use counts the diagnostics it could not fit. A page report shows the
  three newest console errors and network failures, which read as the whole
  story: twelve failures arrived as three. The report now names the total and
  points at `console` or `network` whenever the list is capped.

- Browser Use admits when a page excerpt stops early. The visible text in a
  snapshot is capped, and the report said only "condensed", so a long article
  read as if the excerpt were the whole page. Both snapshot paths — the
  accessibility capture and the DOM fallback — now mark a clipped excerpt, and
  the report names how much it carries and says the page holds more.

- Attachments report the size of the image they actually produced. Fitting an
  image to a vision patch budget trims the edges one at a time, which can ask
  for a box the picture does not fill; the rendition then came out smaller
  than the size reported beside it, and coordinates mapped through that size
  were off. The resize now reports the dimensions of the produced image.

- Browser Use says where a page script failed. `evaluate` kept only the first
  line of the browser's error, so a script of several lines reported
  `TypeError: ...` with nothing to locate it. The failure now carries the
  innermost stack frame with it, and the integration harness pins the position
  a throw on a later line reports.

- Browser Use names a PDF instead of reporting an empty page. Opening a link
  to a PDF committed the address, but the guest has no viewer for it, so the
  snapshot showed an untitled page with no text and console noise about a
  blocked viewer stylesheet — nothing that says what happened. The page report
  now states that the document is a PDF this browser cannot display and that
  the file has to be read from its URL, and the failures Chromium's own
  bundled components raise for their `chrome-extension://` resources no longer
  appear as the page's console or network errors. The integration harness
  covers the navigation, the quiet report, and a later snapshot of the page.

- Browser Use stops bouncing `close_tab` off the visible tab. `list_tabs`
  prints the visible page with an ordinary page id, so aiming `close_tab` at
  it was answered with `unknown background tab "p12"; call list_tabs` — the
  listing that handed the id out. The refusal now says the page belongs to
  the browser panel and points at navigating it elsewhere or `hide`, and
  unrelated names still report an unknown background tab.

- Browser Use says what a leave confirmation actually did. A page that guards
  unsaved work stopped a navigation with a `beforeunload` dialog, and the
  reply asked for `handle_dialog` — but Chromium answers that confirmation
  itself, so the call always came back "no JavaScript dialog is currently
  open" while repeating the navigation repeated the same instruction. The
  reply now states that the navigation was abandoned and the page stayed,
  that there is nothing left to answer, and that the work the page holds has
  to be finished or discarded first; the integration harness holds the whole
  sequence, including the navigation going through once the guard is gone.

- Browser Use locale emulation reaches the server. `emulate locale` set
  `navigator.language` alone, so the page kept asking for the old language
  and sites negotiated content the emulation contradicted; it now carries the
  locale as `Accept-Language` too, and clearing it restores the browser's own
  negotiation.

## v0.9.171 - 2026-09-18

- Release recovery: the staged production relay artifact is keyed to the run
  alone (`production-relay-<run_id>`) and uploads with `overwrite: true`. The
  name carried the run attempt, but a partial re-run preserves the successful
  `stage-production-web-relay` job while re-running
  `deploy-production-web-relay` as a dependent of the failed job, so the
  attempt-scoped artifact never existed and the deploy died on "Artifact not
  found" before it could reach production. That is exactly how v0.9.170
  published its GitHub release and npm package without deploying the web
  relay. `overwrite: true` keeps a full re-run, where the stage job does
  execute again, from colliding with the earlier attempt's artifact, and the
  release gate asserts both the name and the overwrite.

## v0.9.170 - 2026-09-17

- System prompt consolidation. Every rule now has one owner: the shared
  layer (`rules/shared/*.md`) is tool policy only and opens with
  `# Tool Calls` (batching first; `05-parallel-calls.md`), the Lead role is
  one file (`rules/lead/LEAD.md`: user communication, agent briefing and
  completion notifications behind `<!-- tools: agent -->`, tone), and the
  common agent contract is one file (`rules/agent/AGENT.md`: chain of
  command, no self-verification, English, handoff shape). `00-general.md`,
  `02-persona.md`, `lead-brief.md`, `00-core.md`, `00-common.md` and
  `75-goal.md` are gone — their surviving sentences moved to the file that
  owns them, and sentences a tool description already states (`load_tool`,
  `Skill`, `goal`, `memory` approval, `task wait`, `code_graph` outline,
  read call shape, Git routing, browser/computer routing) are stated there
  only. Precedence is per role: the user's latest explicit request for Lead,
  Lead's latest brief for agents. Lead's preamble rule now carries its
  reason (the user sees only your text) and asks for one line, not a word
  count; the briefing rule says an agent never sees the conversation, that
  findings are synthesized into paths, lines and the exact change ("based
  on your findings" never), and that an agent's result is never predicted.
  Destructive-action rules that were spread over four sections sit in one
  `# Destructive Actions` section. Role files (`agents/*/AGENT.md`) drop the
  blocker/handoff sentences the contract owns; `maintainer` gains name and
  description frontmatter. Output styles: the `## Depth` heading replaces
  `## Depth Variation`, and progress-report wording lives in the Lead rules
  only. The Default workflow no longer carries the reviewer-fallback
  paragraph; it rides with the orchestration-mode block that delegating
  modes inject. Tool descriptions: `edit` no longer points at `apply_patch`
  on surfaces that filtered it out, `shell` says Git goes to `git` only when
  that tool is present, `read`/`grep` drop byte caps the runtime reports
  anyway, `code_graph` states that `symbols` is the outline. Providers that
  deliver the round reminder themselves (`anthropic-oauth` as a turn-scoped
  system message, `cursor` through its relay) declare `deliversRoundReminder`
  so the runtime channel stays silent — Cursor sessions no longer receive the
  batching reminder twice per round. The batching nudge's provenance check
  normalizes path separators and accepts a directory shown as a prefix of a
  deeper path in the previous result, so a follow-up call on a path the last
  result revealed no longer reads as an unrelated single call (two
  false positives per session before). The `setup` route schema states
  `contextPercent` as bounded integer (the executor still requires a
  multiple of 10) so Gemini stops receiving an unrepresentable-enum
  placeholder. Stale test expectations left behind by the batching commit
  are brought current, and two timing/environment-dependent tests are made
  deterministic. Project skill `gamerscroll-article` is scoped to its
  project.
- GitHub releases now carry the version's CHANGELOG.md section as their
  notes, followed by the compare link; the draft previously relied on
  GitHub's generated notes, which list merged PRs only and left the page
  with a bare `Full Changelog` link because Deploy commits straight to main.
- Tool batching: after three single-call rounds of one tool in a row whose
  calls did not need each other (no argument taken from the previous result,
  no step ordered behind a mutation; a different tool restarts the streak, so
  read → shell → apply_patch is never reported; task waits, Computer Use,
  browser steps and schema/skill loads never count), or one
  round of same-tool calls that differ only in an array field, the runtime appends one
  short `<system-reminder>` naming the array arguments on the session's tool
  surface; it repeats whenever the pattern recurs and only a batched round
  clears it (traced as `batching_nudge`). A single-file `read` right after
  a grep/code_graph/glob/find round that located several files gets the
  located set back in the shape one `read` call takes
  (`[{file_path, offset, limit}, …]`; one read per file in the same response
  on providers whose read schema takes path strings only), traced as
  `located_sites`: a recorded Gemini 3.8 Flash session located files with
  grep 13 times and still read them one window at a time (63 reads, 20 of
  28 files read twice or more). The `read` and `grep` descriptions now say
  what the batch is — every file and range you will touch, before editing,
  in one call — and the windowed-read footer asks for one wider read instead
  of the next window. The shared rules now state the order of work on files
  once (`# Tool Calls`: enumerate only when the scope is unknown → locate
  every site → one read stage of `{file_path, offset, limit}` windows, ≤10 per
  call → every edit in one response → one verification) and drop the
  sentences that used to say parts of it in three places; the `read`,
  `grep`, `edit`, `apply_patch` and `code_graph` descriptions shrink to that
  contract (code_graph from ~150 to ~90 words), and a windowed read's
  smart-cap marker names the located-window form; a further pass trims
  parameter prose that repeated the rules or internal detail (`Skill`,
  `find`, `cwd`, `git`, `code_graph.mode`, `grep.path`/`text`,
  `include_noise`, shell's PowerShell cheat and `timeout_ms`) — the lead
  tool surface drops from 13.4 KB to 12.7 KB. Eight-task GPT-5.6 runs before
  and after stay at 8/8 with the same round, time and cost envelope; the
  one regression found on the way (a backup round for read-only inputs and
  `git log` surveys after two guarding clauses were cut) is restored. The
  backup rule now says where the copy goes — the same response as the first
  inspection, never a round of its own — because "inside the first inspection
  call" made GPT-5.6 open 2.8 backup-only rounds per eight-task run when the
  first inspection was a `read` or `git` call; with the wording fixed it
  opened none and batched every backup with that inspection. The serial
  reminder no longer treats an array inside a single call as a batch: a
  recorded Gemini 3.8 Flash review ran fifteen one-call rounds, alternating
  one- and two-command `git` calls, and never earned it because every array
  round reset the streak. The provenance check also remembers six rounds
  instead of two, so a file list from `git diff --name-only` walked one item
  per round no longer passes each item off as something the previous diff
  revealed. Two more runtime
  reminders: `late_locating` (a search after a read that took nothing from
  it) and `located_sites` handing over one window per located site —
  code_graph `(Lstart-end)` rows included — split into several read calls
  past ten. Route policy files
  (`rules/routes/*.md`) now also declare a one-line `turn-reminder:` (read
  once in the user turn's trailing `<system-reminder>` block, before the
  turn's first response) and a one-line `round-reminder:` next to their
  static rules; the agent loop resolves the latter per provider/model and it
  reaches the model after every tool round — as Anthropic's turn-scoped
  system message (`clear_at: next_user_message`) on `anthropic-oauth`, the
  pattern Anthropic documents for Claude Fable 5.1, or as a runtime
  `<system-reminder>` after single-call rounds elsewhere (`per_round`). The
  Fable 5.1 reminder moves from a hard-coded provider constant to the
  route files; histories recorded under the earlier sentence replay it
  byte-for-byte. One file, `routes/common.md`, carries the batching
  reminders for every route (an unrestricted file is the base; a file naming
  `models:` or `providers:` adds to that line for its routes rather than
  replacing it) —
  Gemini goes one call per round once tool results arrive, Grok
  batches calls but never used array arguments: its flattened tool schemas
  kept only the scalar branch of every one-or-many field
  (`read.file_path`, `grep.pattern`, `git.command`, …). The Grok flattening
  now keeps the array branch of such fields (one value travels as a
  one-element array) and says so in the field description, so the batching
  contract holds on that provider too. The shared rules gain a
  `# Parallel Tool Calls` section that states the contract plainly (recorded
  Gemini 3.8 Flash sessions issued one call per round in 105/105 rounds;
  with the section in place a headless run batched four files and git in
  one response). Provider/model-bound rules load from `rules/routes/*.md`
  through `providers:` / `models:` frontmatter and render after the shared
  rules in BP1.
  `MIXDOG_ANTIGRAVITY_DUMP_DIR=<dir>` writes every Antigravity request body
  (contents, tools, config; never headers or tokens) for wire inspection,
  the Gemini counterpart of `MIXDOG_OAI_WS_DUMP_DIR`; `mixdog exec` also
  passes `MIXDOG_XAI_CACHE_TRACE` and `MIXDOG_XAI_RESPONSES_CACHE_SCOPE`
  through for xAI cache probes.
- xAI Responses requests no longer send a per-session `prompt_cache_key` by
  default (`MIXDOG_XAI_RESPONSES_CACHE_SCOPE` now defaults to `none`, Grok
  Build's literal body): the session key split the service cache into lanes
  and measured two cold rounds per run against one, and no cross-session
  prefix reuse. `session` and `prefix` remain selectable.
  `MIXDOG_ANTIGRAVITY_FC_MODE=AUTO|ANY|VALIDATED` overrides the Antigravity
  function-calling mode for A/B runs, and
  `benchmarks/terminal-bench-2.1/analysis/tool-batching-by-model.mjs` reports
  multi-call and array-argument rates per model from `agent-trace.jsonl`.
- `mixdog exec` binds the OAuth account selected in the host's
  provider-accounts pool (the credential sign-in writes today), falling back to
  the single legacy credential file; previously only the legacy file or an
  explicit `*_CREDENTIALS_PATH` was accepted, so pool-only hosts failed with
  "credentials are unavailable". `mixdog exec` also no longer sits 2–4 minutes
  past its answer before emitting `result`: the pristine-root removal retried
  on Windows for the full rmSync budget (50 linear retries ≈ 128s, twice when
  the postmaster path re-ran it) while the usage ledger's SQLite handle and a
  winding-down memory daemon's `pg.log` were still open. The ledger is closed
  before removal and exec passes a 10-retry (≈5.5s) budget
  (`cleanup({ rootRemovalRetries })`); a straggling root is left to the
  periodic orphan sweep instead of the caller.

## v0.9.169 - 2026-09-16

- Code Tidy: Install now downloads the core engines (Biome, ruff, shfmt,
  shellcheck, PSScriptAnalyzer) with progress, and the built-in card lists
  every engine with its version, language, source and size; engines picked
  up later by a project appear in the same list. Engines missing at tidy time
  download automatically by default (`tidy.downloads` still honors `ask` and
  `never`). PSScriptAnalyzer is a sha256-verified managed download from the
  PowerShell Gallery instead of a host-only module, and C# gets a real
  dotnet-format runner. Fixes: rustfmt 1.9 diff headers and `\\?\` paths are
  parsed, large Biome reports no longer collapse to zero findings when the
  output is chunked, fixability is classified through `biome explain`, and
  the history-comment rule only removes comments that are entirely history
  and never extends past the comment (it could delete the next statement).
- Sidebar rows share one status tag next to the title across built-ins,
  plugins, skills, MCP servers, schedules, webhooks and agents: nothing when
  enabled, otherwise `Not used`, `Not installed`, `Installing… N%`, `Failed`
  or `Not connected`. Disabled agents keep their model line.
- FastDirect refuses to repack or install an `app.asar` whose production
  dependency closure is incomplete and falls back to a full build, so a
  broken updater (`Cannot find module 'graceful-fs'`) is no longer inherited
  by every incremental update.
- Agent workers that were reaped are no longer resurrected by session scans
  or by the desktop agent list; re-registered finished sessions keep their
  real finish time, so leases expire instead of restarting every hour.
- Orchestration modes `none`, `focused`, `balanced` and `swarm` replace the
  Solo workflow and are chosen per session; settings are localized.
- Desktop: local path links in markdown open in the editor, and the editor
  opens files outside the project.
- Browser Use serializes snapshots per page and hardens the settle and
  capture paths.
- Computer Use: a frozen overlay renderer is retired and replaced, input
  recovery state survives the switch, and the overlay fixtures no longer exit
  early on a single-display machine.
- Shell: PowerShell hosts no longer hard-block `grep`, `sed` and `awk` in
  preflight; the tool description routes dedicated-tool work instead. Rules,
  skills, README and the new `docs/context-efficiency.md` are refreshed.
- The repository is formatted with Biome 2.5.13 (`biome.json` pins the
  existing style), rustfmt, dotnet-format and PSScriptAnalyzer; unused
  imports, dead helpers and in-file-only exports are removed.

## v0.9.168 - 2026-09-16

- Closing a Computer Use session always sends its own release request. The
  idle timer's speculative release used to be inherited when it was still in
  flight, so a refused early release could leave the closing session's worker
  and window claims pinned until the app restarted.

- Computer Use overlay: two controls, Stop and Resume. The pause button is
  gone (touching the desktop already hands control to the user); the pill now
  shows why a control is unavailable or why a request failed instead of
  reacting silently. Stop recovers a latched cleanup failure once every input
  worker has exited, so the host no longer needs an app restart, and worker
  exit confirmation waits up to 5 seconds instead of 1.
- Computer Use captures a window from its own rendered surface rather than
  copying the desktop, with a bounded capture budget; an unconfirmed resource
  release retires that worker. Background keyboard and type are checked
  before any input is sent, so an unsupported route does nothing. A new
  command waits until the previous session release is confirmed. Stop also
  waits for agent-turn cancellation, independently of native input cleanup.
- Browser Use waits honor cancel and refuse to mix a URL with text from a
  later document; a failed full-page screenshot restore is terminal. CSS
  selectors keep interior whitespace, refuse oversized match sets, and
  address each match uniquely. Concurrent downloads share one session byte
  total; approval prompts describe actions and addresses, never form values.
- Code Tidy is an installable built-in, like Office: Settings → Built-in
  installs and toggles it, and the `code-tidy` skill drives the `tidy` tool.
  Scan detects a project's languages and resolves each formatter or linter
  from project config, then project-local binaries, PATH, or a sha256-verified
  managed download (ask, auto, or never). It runs Biome, ruff, clang-format,
  shfmt, shellcheck, StyLua, gofumpt, dprint, Air, and Mago, plus toolchain
  rustfmt, gofmt, and PSScriptAnalyzer, and applies structural packs
  (history-comment removal, `debugger`, empty catch, TODO markers) across 31
  languages. `fix` is dry-run unless apply is set, and writes go through the
  same pipeline as other edits. Engine licenses ship with the tool.
- `code_graph` callers and callees come from parsed call sites, not text
  search; call-shaped references use those sites too. An older graph binary
  that cannot emit them fails with a rebuild remedy instead of an empty
  answer. Outline rows use one kind vocabulary, mark exports, show
  signatures, and nest members under their parent. `find_symbol` prefers an
  implementation file over a companion `.d.ts` and reports when the
  declaration sits outside the requested files. Identifier tokens come from
  the parse tree, so a name that appears only in a comment no longer counts
  as a reference. Solidity, Haskell, and HCL join the extraction set with
  import edges (24 extraction languages, 31 parsed). Call-site data lives in
  a sidecar cache so the main graph cache stays the same size.
- The native graph binary embeds tree-sitter 0.27 and ast-grep 0.45.3, adds
  `--scan`, `--langs`, and `--outline` modes, and extracts symbols, imports,
  and identifier tokens from YAML rules.
- The desktop editor's graph-fallback outline parses the new symbol rows into
  a nested outline with kind icons.
- Structure questions (exports, signatures, members, callers, importers) go
  to `code_graph` before `read` or `grep`; the tool-workflow parallelism
  wording is one rule.
- Memory maintenance no longer promotes conversation summaries into standing
  instructions: there is no third cycle. Cycle 2 reviews search history for
  duplicates and lineage without rewriting summaries. Standing memory stays
  user-curated through `memory`; `recall` searches all history by default,
  including previously archived rows.
- Antigravity Gemini usage shows shared 5-hour and weekly windows from the
  account quota summary, not per-model catalog counters, and requests use the
  daily channel without automatic host failover.
- The Agents pane expands only rows you open, shows a descendant count on
  the lead, and says "Waiting for agents" while descendants are still
  working instead of treating the parent as idle or complete.
- The composer offers a small slash-command palette for frequent commands
  (`/new`, `/model`, `/compact`, `/context`, `/goal`, `/inherit`, `/fast`);
  the full registry still runs when typed directly.
- Conversation file mentions stay plain text until the path is confirmed in
  the owning Project; folders and documents still open in the OS, and editor
  opens pass an access token.
- The sidebar usage roster aligns provider labels, meters, percentages, and
  reset times on one grid; the model catalog keeps seven recents.
- A new session waits until pending settings saves finish, and MCP tools
  that left the current catalog are not called mid-turn.

## v0.9.167 - 2026-09-15

- Session start reports which common shell tools are present ("Shell tools
  at startup"), measured in the login shell on POSIX and in the process PATH
  on Windows, so a model no longer guesses `python` against `python3` or calls
  `file` where it is absent; an unknown answer renders nothing.
- `read` renders overlapping windows of one file once, no longer reports
  unread edit ranges as already delivered, and never inherits a stale
  whole-body-delivered mark after a file changes; array reads honor their
  no-stub option and the description states the real output caps.
- `git` runs `&&`-chained commands as an ordered array (up to 10) instead of
  rejecting them, and recognizes bare repositories.
- The session read cache honors the tool allowlist, detects `ctime`-only
  changes, never stores a body captured before a mid-read change, keeps public
  and legacy offset hints apart, and covers public array reads.
- `web_search` arrays keep partial and total failures flagged as errors.
- Rules and built-in tool descriptions are shorter with the same behavior: the
  `shell` description carries the command→tool map and forbids tool names as
  shell commands; `timeout_ms` guidance covers throwaway checks; Lead guidance
  that only applies with the `agent` tool is omitted from delegation-free
  workflows; rules ask for every independent action the current evidence
  requires in one response, patching directly from decisive evidence, one
  sample before parsing logic, and bounded slices for large or binary data.
- Desktop runtime synchronized with the current browser and computer harness
  work, and tool contract tests hardened accordingly.

## v0.9.166 - 2026-09-14

- Studio recognizes the selected ChatGPT account after provider login and
  account switches, using the same credential path as chat without falling
  back to another account's credentials.

## v0.9.165 - 2026-09-14

- The Source Control dock keeps its row window bound to the live list: a
  rebuilt dock (tab switch, first-run surface to list) no longer scrolls into
  empty rows.
- macOS release assets upload through the delete-then-retry script on both
  architectures, so a recovery run no longer fails on an asset that already
  exists on the hidden draft.
- Release gate: every lane runs green on the hosted runners. Linux installs
  NanumGothic for Hangul PDFs and the current LibreOffice for rendered
  reviews; the Windows cursor check pins its motion preference; test
  expectations follow the shipped contracts.

## v0.9.164 - 2026-09-14

- Compact the shared and Lead rules and the built-in tool descriptions to the
  same behavior in fewer tokens; the `shell` description keeps only its role,
  the boundary with the dedicated file/search/Git tools, and the background
  task contract.
- Headless (`mixdog exec`) runs state that no user intervenes mid-run: the
  request is treated as approved and carried out to the end before reporting,
  instead of stopping to ask a question nobody can answer.
- `apply_patch` typed into the shell is no longer rerouted to the patch
  engine; the model calls `apply_patch`/`edit` directly.
- A stopped Goal retires like a completed one: the user's next prompt
  archives it, and confirming a stop archives it at once.
- Usage stats attribute measured tokens and cost per request in the ledger,
  and the desktop usage explorer shows the resulting breakdown.
- Cursor provider wire fixes.

## v0.9.163 - 2026-09-10

- Refine UI localization, startup language selection, native menus, and
  translated formatting; keep the web language bootstrap fresh across updates.
- Harden Computer Use input ownership and observation-only checks, confirm
  Electron text targets before typing, and improve cursor and session handling.
- Improve native file search and ranged reads, and prevent invalidated or
  cancelled in-flight computations from repopulating the result cache.
- Include search benchmarks, regression coverage, localization audits, and
  generated project and document deliverables.

## v0.9.162 - 2026-09-09

- The Set-a-goal dialog opens centered in the pane whose composer raised it,
  dimming only that pane; sibling panes stay visible and usable and the title
  bar is no longer dimmed. Outside a pane it falls back to the window layer.
- A focused pane no longer covers the split handle on its own edge: a browser
  pane (or any focused pane) can be resized from its left/top boundary again.
- Web fetch reports a stage that times out at the total deadline as
  `FETCH_TIMEOUT` instead of `STAGE_TIMEOUT`.
- Computer Use defaults to background delivery for supported semantic input;
  `foreground_unavailable` now asks the user to activate the target window
  instead of describing a foreground-lock failure.
- The v0.9.162 release run stopped at the test gate and shipped nothing; its
  notes below are delivered by this release.

- Mixdog is now licensed under Apache-2.0 instead of MIT. Third-party
  components retain their existing licenses and attribution notices.

- Browser Use and Computer Use ask once per session before their first live
  call. The first `browser`/`browser_devtools` or `computer` call a model makes
  in a session goes through the tool-approval prompt with the action it wants
  to take; allowing it covers the rest of the session, declining returns the
  reason to the model with an instruction not to retry, and a restart asks
  again. Sessions with no approval UI (headless, agent-owned) are not gated.
  `setup set_first_use_approval name:browser|computer enabled:false` turns it
  off per capability, and `MIXDOG_BRIDGE_FIRST_USE_APPROVAL` overrides per
  process.

- Browser Use folds two gestures into the ones next to them. A checkbox or
  radio is set by `fill` with `checked` instead of `text` — for one control,
  a `fields` item, or a `sequence` step — so the separate `check` action is
  gone; and `forward` is gone, since the earlier snapshot already showed the
  URL to `navigate` to while `back` stays a gesture. `locate` and `extract`
  stay: the first is a visual (pixel) search with no semantic equivalent, the
  second reads rows across frames and open shadow roots that `evaluate`
  cannot reach.

- Computer Use `capture` drops its `quality`, `maxWidth`, and `max_ocr_words`
  knobs: the host's tuned defaults apply (JPEG quality, downscale width, and an
  OCR word cap the element budget already bounds), and unreadable detail is a
  `zoom` rather than a re-encode. The element filters (`query`, `role`,
  `visible_only`, `include_noninteractive`, `continuation`) and the `window`
  move geometry now say what they do instead of riding the schema unexplained.

- Browser Use and Computer Use state their rung of the tool ladder where the
  model decides. The `browser` description opens with "last resort: prefer
  web_fetch, an MCP tool, or a CLI in shell", `computer` with "last resort
  after an MCP tool, shell/CLI, and Browser Use; never a stand-in for a page
  action browser refused", and the shared rules and both skills carry the same
  ladder, so a service that has an API or CLI is reached through it instead of
  a screen. Neither description grew: the ladder replaced wording the skills
  already owned.

- Browser Use is two tools. `browser` keeps everyday page work — navigate,
  snapshot, read, click, fill, forms, dialogs, tabs, downloads, console and
  network reads — while the developer controls `emulate`, `cookies`,
  `storage`, `intercept`, `init_script`, and `performance` move to the
  deferred `browser_devtools` tool, which drives the same pages and sign-in
  and loads its schema on its first call. The everyday schema drops the 33
  fields only those actions used (cookie attributes, geolocation, CPU
  throttling, intercept bodies, trace options), each tool's field notes name
  only its own actions, and a call that reaches the wrong tool is refused
  with the tool to call. The host, its action registry, approval policy, and
  the integration harness keep the single shared action contract.

- Built-in tool schemas state contracts only. The `office`, `computer`,
  `media`, and `setup` tool descriptions and field notes drop the method and
  policy sentences their skills already own — batching, when to snapshot or
  `describe`, fixing an audit in the same turn, `design.content` reuse, macro
  handling, do-not-rearrange, screen content never authorizing an action,
  video polling, the deletion approval procedure — which removes about 2.2 KB
  (office −878 B, computer −492 B, media −432 B, setup −424 B) from the tool
  surface sent on every turn. The pptx, xlsx, and pdf skills now carry the
  rules that lived only in the schema (one batch of known operations,
  `describe` only for an unknown field, untrusted document content), and the
  computer-use skill states the call contract once instead of repeating each
  schema sentence.

- Browser Use needs fewer calls per task. `click`, `fill`, `type`, `select`,
  `hover`, `upload`, and `scroll` — and every `fill.fields` item and
  `sequence` step — accept a snapshot-free `target` (`{role, name}`, `{name}`,
  or `{selector}`) instead of a `ref`: the host observes the page itself,
  acts only on exactly one match (several substring matches resolve to the
  single verbatim one), and an ambiguous target fails with the candidates and
  their fresh refs. `query` on `snapshot`, `read`, and `wait` matches
  space-separated keywords with OR (all-keyword matches rank first) and takes
  `/pattern/i` regular expressions, and a filter that matches nothing says
  how many elements or characters it was filtering. Transparent or
  pointer-events:none controls are no longer refused outright: a hidden
  checkbox is clicked through its label, and the input-target guard accepts
  the label's activation. `fill` on a `contenteditable` editor replaces the
  content as typed input over a select-all instead of overwriting its DOM.
  Replies note "No observable change" when a gesture left the document, URL,
  and control values untouched, `brief:true` lists only elements that are new
  or changed since the previous observation, console errors are reported once
  when new, and a postcondition that already held is a warning rather than an
  error. Snapshots mark file inputs with `file-input`, `accept=…`, and
  `multiple`; full-page screenshots anchor fixed and sticky elements in flow
  for the capture; and session cookies are stored encrypted with the OS
  keychain and restored on launch so sign-ins survive an app restart.

- The chrome above the prompt input — Goal capsule, runtime progress, tool
  approval, the draft context bar, and the turn-review slot — now lives in one
  `ComposerDock`, and the transcript no longer bobs when that chrome resolves:
  the review slot stays reserved while a scope's first authoritative worker
  read is in flight, so a diff landing after the transcript is shown fills
  existing geometry instead of resizing the viewport again. Freed space is
  never held on a timer. The desktop host also stops re-reading a whole
  session after every accepted prompt (the daemon-log "missing baseline"
  recovery): a reply or lane frame that repeats the revision the projection
  already holds is applied state, not a crossed baseline. Goal capsule
  mount/unmount flips are attributable under `MIXDOG_DESKTOP_PERF=1`.

- A Goal capsule no longer pops in and vanishes on its own. Two publication
  paths produced the blink: the 2s route pulse read the raw Goal record while
  a completed Goal's user-input archive was still being written, so the
  retired capsule came back for one frame; and on Windows a Goal read that
  landed inside the atomic file replace (`EPERM`/`EACCES`/`EBUSY`, or the
  runtime's own in-flight write) surfaced as "no Goal" for that frame. Route
  publications now read the Goal through the goal-continuation archive mask,
  and Goal storage answers such reads from the last committed record.

- Browser Use no longer stops for approval: the desktop "Allow once" dialog
  that guarded `upload` and shared cookie/localStorage `clear` is gone, the
  `confirm` field leaves the browser tool contract, and the browser-use skill
  drops its in-conversation go-ahead rules. `MIXDOG_BROWSER_CONFIRM_ACTIONS`
  and `MIXDOG_BROWSER_DENY_ACTIONS` remain the only way to confirm or refuse
  named actions.

- The pane reading column — composer, transcript, and the Studio dock — no
  longer waits for a 1536px pane to widen: from 768px it holds 800px until
  the pane passes 1000px, then follows 80% of the pane up to the 1000px
  ceiling at 1250px, so 1536/1680 windows and 1920 with a side panel open
  stop parking at 800px, and a divider crossing the step no longer snaps
  the column by 200px.

- The Sessions panel leads with two fixed launcher rows, `New task` and
  `New Studio`, pinned above the session list. Studio therefore leaves the
  activity rail: its launcher-only rail entry and the launcher exceptions in
  the side-view layout, pane dock, and dock toggles are retired, and a stored
  rail layout drops the `studio` id on load.

- The activity rail's Workflows destination folds into the Projects panel: a
  `Project | Workflow` toolbar — the Extensions panel's section switch, now
  shared as one `SidebarSectionToolbar` component — swaps between the project
  list and the workflow packs, default agents, and agent definitions; the
  header `+` follows the Project tab; `/workflow` and `/websearch` open the
  Workflow tab; and a stored rail layout drops the retired `workflows` view
  on load.

- The pptx skill's kit gains a design vocabulary in the manner of token-based
  design systems: `palette()` derives three line strengths (`lineSubtle`,
  `line`, `lineStrong`) and four state colors (`T.state.positive | warning |
  critical | informative`, each as `solid` / `weak` / `text`, contrast-
  guaranteed and kept under the reviewer's saturated band so a verdict column
  never trips `accent_hue_overuse`); every distance sits on one spacing ladder
  (`SPACE`) named by relation (`GAP.bind` / `within` / `between`, `GUTTER`,
  `PAD`, `M`); each text role carries a fixed leading; the repeating carriers
  (badge, callout, chevron run, stat, table) read their anatomy from `SPEC`
  with `tone` variants, a `stat` scale step, and a `statBand()` helper; icons
  map to four size bands; and a new `references/writing.md` fixes sentence,
  register, number, date, money, unit, and translation-room rules, linked
  from the docx and xlsx skills. Each spec carrier signs its shape, and the
  composition receipt reads the signatures back (`slides[].specs`,
  `deck.specs`: count, slides, variants, anatomies) so a carrier whose type
  size or face drifted between slides shows as a second anatomy.

- Office design tokens derive the same four state colors (`positive`,
  `warning`, `critical`, `informative`, each with a `Weak` field and a `Text`
  step, contrast-checked against the canvas, the light panel, and the field);
  the docx and xlsx decision gates draw Release and Stop on the positive and
  critical states instead of a literal tint and the second accent, and a
  `compose_document` section's `calloutTone` puts its callout on a state.
  A `compose_sheet` dashboard's print area now follows the decision panel,
  so a Stop gate in a column past the canvas is no longer cut from the
  rendered and exported page.

## v0.9.161 - 2026-09-06

- Office audits measure Arial, Helvetica, Times New Roman, Courier New,
  Calibri, Cambria and Georgia in their metric-compatible open faces
  (Liberation, Arimo/Tinos/Cousine, Carlito, Caladea, Gelasio) wherever the
  original is not installed, instead of reporting the font unavailable and
  approximating the fit — a Linux machine with the Liberation faces now
  audits a deck the way Windows does. The root package gains `test:slow` and
  `test:live` lanes, and the CI runtime lanes install the Liberation faces.

- Source Control commits take a summary typed by hand plus an optional
  description: commit-message presets, format checks, autocomplete and AI
  generation leave the Git & GitHub card and the commit form, and the legacy
  `desktop.git` preferences are neither read nor written.

- Computer Use drops the settings-side authorization editor (window and
  action lock, expiry): it stays unrestricted by default with the standing
  guards — input guards, elevation handling, user takeover, environment
  guards — and a saved authorization file can no longer expire into a
  lock-out. In-process narrowing survives for an embedding host through
  `MIXDOG_COMPUTER_POLICY_FILE` and `host.updateAuthorization`, nothing is
  persisted, and the failure-diagnostics export stays. The tool gains
  `wait_for_user`: when the user takes control, the model waits for a
  bounded interval and captures fresh state afterwards instead of guessing
  at permissions.

- Every Extensions and Built-in card opens the same detail dialog — identity
  plate and title, sections on one rhythm, a footer ladder with the
  destructive action parked left, one action button style — and the Projects
  add/edit dialogs join it. The Git & GitHub card carries the GitHub account
  (gh sign-in by device code); the Local Provider
  card lists installed models with size, context and running state, a Model
  loading section for idle unloading, and live facts (runtime build, GPU,
  free memory, server), while repair and verification stay chat-driven
  through the local-provider skill. Status/platform facts leave the dialogs
  because the header control and the list badge already say them. The
  extension stylesheets split into `extension-list.css`,
  `extension-dialog.css`, `extension-editors.css` and `rail-controls.css`.

- Goal: resuming a paused Goal and starting its approved task are one durable
  write — `resume` accepts task updates and additions, marking a task
  `in_progress` resumes the Goal, and bookkeeping alone never grants
  approval. A paused Goal's state reaches the model when the request is
  prepared, after hydration, instead of a one-off reminder on the user's
  reply, so no turn can lose the fact that a Goal is waiting.

- Phones synchronize their views on reconnect: after the secure handshake the
  browser asks the desktop for one consistent baseline of its open sessions
  (snapshot, session list, agent pool, session states) and live publications
  are held until it lands, so a reconnected phone no longer paints a stale
  transcript or misses the tail of a turn. The transcript handed to phones
  omits provider replay material in deltas and baselines alike.

- New-task creation survives a dropped remote connection: each request
  carries a durable receipt, so a retry after a timeout or reconnect lands on
  the same reserved session instead of creating a duplicate, and the project
  store watcher recovers on its own and reconciles the catalog while it is
  down.

- Conversations and tab strips reveal without a jump: a visited transcript
  shows once its visible rows and end offset agree across frames (bounded by
  one second, so streaming or a slow font never hides it), and a tab strip
  decides overflow from the destination layout rather than a half-grown tab.

- The Local Provider catalog actions (`searchLocalProviderModels`,
  `inspectHuggingFaceModel`, `registerHuggingFaceModel`) exist on the
  session surface the daemon resolves them on, so a setup call routed through
  the desktop no longer fails as an unavailable session action.

- Desktop UI language catalogs are back in step with the renderer: strings
  the source control views and slash commands read through `t()` were
  missing from every catalog (the tab read "History" in Korean), the retired
  legacy translation pack's Korean phrases are migrated into `ko.json` so
  dynamic labels ("Ln 42", "Callers of …") translate again, and the native
  menu and dialog strings are generated from the same catalogs. Korean is
  complete; the other ten languages fall back to English for the newer
  phrases until they are translated.

- The browser importer build replaces a half-written upstream checkout under
  TEMP instead of failing on it. Test harness: renderer suites can import
  modules that pull in a feature stylesheet (a `.css` import resolves to an
  empty module under Node), the built-artifact daemon import check runs in
  the live lane after a build, and the settings-store path fixtures resolve
  in the host's own path grammar.

- The pdf skill and runtime take the inspect-first discipline of the
  reference PDF skills. Reading: a snapshot reports `encrypted` and
  `passwordRequired` instead of pdf-lib's own error, `open`/`snapshot` with
  `password` read a locked file's text for that call without keeping the
  password, every edit on an encrypted file points at `secure` → decrypt,
  pages carry their size and rotation, bookmarks come back under `outline`
  with the page each opens, and text extraction (office snapshots, chat
  attachments, the read tool) keeps line ends as newlines so paragraphs and
  table rows survive. Forms: fields expose the
  `text|checkbox|radio|dropdown|optionlist` type, `options`, `readOnly`, and
  `multiline` a fill needs; `fill_form` names an unknown field or option
  together with what exists and reports `filled`; `add_form_field` and
  `create` accept `optionlist`, `required`, `readOnly`, `maxLength`, and
  `fontSize`; the lint flags a box too small to use (`formIssues` on create,
  `field_too_small` in `issues`); `preview_fields` writes a copy with every
  field and any proposed box outlined and named so a render shows placement
  before a fill; a dropdown or list with Korean options no
  longer fails at creation because the widget is painted with the embedded
  face from the start; and a multiline field defaults to 11 pt instead of
  pdf-lib's auto size, which drew the first line huge and dropped the rest.
  Fonts: `create`, `add_text`, `watermark`, `fill_form`, and OCR embed an
  installed Unicode font on their own when the text is Korean, CJK,
  Cyrillic, or Greek (`pdf-fonts.mjs`; `fontPath` still chooses; `detect`
  names the face as `portable.pdfUnicodeFont`). Writing: `create` wraps
  unspaced prose by character, honours `\n`, wraps table cells and grows
  rows, repeats the header after a page break, numbers multi-page output,
  and accepts `columnWidths`, heading `level`, image `align`, `orientation`,
  `footer`, and more page sizes. Editing: `merge_pdf` takes `sources:[path | { path,
  pages, title }]`, `index`, and `bookmarks:true`; `add_bookmark` writes an
  outline entry; `extract_pages` writes to `output` and `split_pages` one
  numbered file per page or per `every` pages without touching the session
  document; `extract_attachment` round-trips embedded files; `rotate_pages`
  adds to the current rotation; `delete_pages` keeps one page; `compress`
  reports `bytesBefore`/`bytesAfter`; `add_text` takes `align:'center'|'right'`
  and numbers an existing file through `{page}`/`{pages}`; `highlight` marks
  every match of `find` (or one box; `wholeWord`, `regex`, and `first` narrow
  it) with a multiply-blend mark that leaves the text legible; `add_link`
  lays an invisible link over a match that opens a URL or another page, or
  with `urls:true` makes every http(s) address in the text open itself;
  `stamp_image` fits inside the margins unless sized;
  `issues` no longer reports a scanned page twice and names active content
  (`active_content`: JavaScript, Launch, actions on open, links to files or
  other non-web schemes) without following it. Analysis: `pdf-layout` with
  `query` returns only the matches with their boxes; its text boxes follow
  the run on rotated pages and for diagonal text, it and the snapshot report
  `origin` when a page box does not start at 0,0. Marks by `find` invert the
  display transform to handle both origin offsets and 90/180/270-degree page
  rotations without reorienting the document; `first:true` preserves document
  row order at every rotation. The layout lists each page's
  links (`url` or the target `page`) and adds each page's rules (`lines`) and
  `boxes` (small squares flagged `checkbox`), which is what filling a form
  that has no fields needs; `pdf-tables` reads a bordered table from its
  cell rectangles (`source:'ruled'`, wrapped cells intact) before the
  text-alignment guess (`source:'alignment'`) and writes one CSV per table
  when `output:<dir>` is given, as `pdf-images` writes PNG files and reports
  where each picture sits on the page; OCR fits
  each invisible word to its box so the text layer keeps single spaces. Page
  previews (`render`, `qa`, `finalize`) hand pdf.js its bundled standard
  fonts, so a page set in Helvetica or Times no longer renders
  letter-spaced. The adapter is split into `pdf-writer`, `pdf-forms`,
  `pdf-draw`, and `pdf-fonts`, and the skill is rewritten as inspect →
  create → edit → secure → verify with the qpdf requirement (PATH or
  `MIXDOG_QPDF_PATH`), the permission-bits caveat, and the in-place-text
  limit stated.

- The xlsx skill and runtime take the modelling discipline a reader expects
  of a spreadsheet: a backend-neutral formula audit (shared by portable
  `issues` and the quality review) reports an unquoted multi-word sheet
  reference, an external-workbook link, a percentage stored as a whole
  number, a year under a thousands separator, and a figure stored as text
  for every workbook (plus, as information, a long sheet whose header is
  not frozen and a table column of numbers under General), and
  under `auditProfile:'financial-model'` an inline rate in a formula, an
  unguarded division, a lone formula that breaks its row or column pattern,
  a single reference past the sheet's populated extent (the off-by-one that
  recalculates cleanly), a hardcode inside a formula row, and inputs
  indistinguishable from
  formulas, plus an input a formula reads that carries no source note and a
  Checks-sheet tie-out that evaluates FALSE — on both backends, since Excel's
  `issues` now folds the shared audit into the host's own findings. Snapshots
  expose each styled cell's number format, font, color, and fill (Excel's BGR
  integers normalize to the same RRGGBB shape), legacy notes per cell and per
  sheet, Excel tables per sheet (records inside one are data the table
  sources, so the audit asks for a note only on assumptions outside it),
  merged ranges and freeze panes in Excel's shape,
  booleans as booleans, the workbook `defaultStyle`, and a
  `document.conventions` summary (default face, faces in use, number formats
  by column, input markers, sample inputs) so an edit can match the file's
  own conventions; `set_formula` quotes the multi-word sheet names the
  workbook holds (and, on both backends, any multi-word name written
  before `!` and a reference) and reports the `normalizedFormula`, LibreOffice
  recalculation returns a `status` with `totalErrors`, an `errorSummary` by
  error type and cell, and the `unparsedFormulas` LibreOffice wrote back in
  lower case, and `finalize` refuses a workbook whose recalculation found any
  error even when the review was skipped. The skill rewrites its rules around zero
  formula errors, formulas over pasted results, literal specs, documented
  assumptions, the fill-in legend, and matching an existing file's
  conventions, with `references/model-conventions.md` for colors, number
  formats, structure, the Checks sheet, and sourcing.

- The pptx skill opens with a route table — a new deck is an `author`
  script, an existing deck is `open` → `snapshot` → `batch`, and reading is a
  paged `snapshot` or the source extractor — and resolves its script paths
  through `${MIXDOG_SKILL_DIR}`, so page QC, the independent reviewer, and
  `source-extract.mjs` (moved into the skill with a test) run from any
  Project. The editing section names the pitfalls the runtime actually has:
  a duplicated slide shares its chart part with its source, template
  decoration stays where the placeholder's line count put it, and a script
  that declares its own `pres` inherits pptxgenjs's 10 × 5.625 in canvas.
  The docx, xlsx, and pdf skills add the triggers users actually write
  ("Word", "Excel", "PDF 읽어", "PDF 만들어"), and the docx skill says how a
  snapshot shows a line break.

- Portable PowerPoint editing resolves a chart's relationship target the way
  the package does: pptxgenjs writes it as an absolute part name
  (`/ppt/charts/chart1.xml`), which `set_chart_data` and the other chart
  operations on an authored deck used to report as a missing part. Portable
  snapshots now keep line breaks and paragraph ends as newlines — a deck's
  shape and notes text, and a Word document's paragraph, cell, comment,
  revision, note, and content-control text — instead of running "4주차" and
  "잔존율" together.

- Pane tab strips animate adds and closes on the chrome clock: a new tab grows
  in from nothing while its neighbours shrink, so the run never overflows the
  strip and slides back, and a closed tab collapses in place while the
  survivors glide into its space instead of jumping. A draft promoted to its
  session still swaps instantly, and the strip drops its unused width-hold
  state.

- Office authoring gains three output-quality structures: `author` and
  `batch` return a measured `audit` (fit, bounds, contrast, spacing, package)
  with per-slide counts and a same-turn fix mandate that counts its rounds;
  `author` refuses to land a deck whose figures have no fact behind them
  (`facts_gate`) unless the brief declares `facts: sample`, which carries an
  illustrative-figures disclosure through qa and finalize; and the pptx skill
  ships `scripts/qc-pages.mjs`, a per-page fixer that runs one fresh session
  per slide with the office tool alone and adopts its working copy only when
  the page's measured defects did not grow and no other slide changed.

- Skills split their listing line into a one-sentence description and a
  `when_to_use` trigger; the model's skill list shows `description — trigger`
  cut at 250 characters, the skill editor gains a separate Trigger field, the
  skill-creator validator warns when a listing line will be cut, and every
  built-in skill is rewritten to the new shape.

- The session Goal island aligns its task list with the collapsed header,
  separates rows with hairlines, and collapses on outside click or Escape.

- The phone surface follows the desktop chrome: the context gauge sits beside
  the composer's model trigger, the toolbar marks share the lucide family,
  and the right sheet opens as one dock unit whose header carries the same
  view toggles as the desktop strip.

- Built-in skills ship from a bundled skill source, and the Office guides
  become pptx, docx, xlsx, and pdf skills gated on the feature they drive.
  Settings group dependent skills, MCP servers, and hooks under their plugin
  or built-in feature.

- Office authors PPTX decks from pptxgenjs scripts with a design guide,
  helper kit, layout menu, and model-led visual QA, and tolerates
  presentation and chart child order differences.

- Tool calls coerce JSON-text arguments to their declared schema shape,
  including internal registry schemas.

- Browser Use splits URL, tab, partition, redaction, and snapshot-script
  policy into dedicated modules; Computer Use refines the overlay model,
  input backend, and session coordination.

- Desktop boot warmup, side-dock restore, usage reset timing, bridge-owned
  discovery files, and session transport recovery keep cold starts and
  reconnects responsive. FastDirect deploys prewarm the installed runtime.

- The test runner separates fast, slow, and live tiers with timing reports;
  session stores cache transcript summaries and listing sweeps; provider
  request utilities harden Anthropic, Cursor, and OpenCode wire handling.

## v0.9.160 - 2026-09-02

- The TUI now installs its patched Ink runtime from a versioned release asset.
  Production builds, frame harnesses, and load probes resolve the installed
  package while preserving the custom cursor, selection, and render behavior.

- Desktop startup now reveals usable pane shells before slower catalog and
  runtime hydration completes. Browser, Terminal, Editor, and side-dock
  surfaces restore independently, with focused readiness probes and deferred
  host services keeping cold starts responsive.

- Browser Use and Computer Use now have role-based host modules instead of
  flat monoliths. Browser actions share explicit routing, guest lifecycle, and
  reply contracts with stronger file chooser and dialog handling, while
  Computer Use separates discovery, observation, input, session, overlay, and
  backend responsibilities with expanded safety coverage.

- Office runtime modules are organized by core, design, quality, portable,
  PDF, COM, and benchmark roles. Freeform composition, reference-driven layout
  selection, authored PowerPoint scenes, and rendered assurance checks improve
  visual quality without weakening editable output or transaction boundaries.

- Anthropic OAuth sessions now learn a provider-required minimum CLI version,
  persist only safe upward updates, and retry the rejected request once without
  overriding explicit version configuration.

## v0.9.159 - 2026-09-01

- Windows release acceptance now checks the canonical 16-item settings
  inventory instead of the stale pre-navigation count.

- Computer Use now coordinates foreground target leases, recaptures after
  window transitions, validates bounded action sequences, and exposes a
  user-takeover overlay. Capture, keyboard, targeting, and recovery paths are
  split into focused modules with broader host and bridge coverage.

- Browser Use gains session-scoped registries and persistent per-conversation
  surfaces. Browser, diff, and utility views can stay attached to each
  conversation's side dock, while local file reads replace the retired
  duplicate folder-explorer path.

- Fresh-context compaction now carries a bounded Memory handoff, preserves
  active-turn continuation and tool-envelope state, and keeps provider cache
  layouts stable across compaction. Memory ingestion projects the compacted
  transcript consistently instead of relying on the retired fast-track path.

- Office deck generation adds creative direction, layout grammar, semantic
  visual flow, rendered-aesthetic review, and a release-quality score so
  presentation output is more varied and catches weak composition earlier.

- Verification and release plumbing churn drops sharply: the 3,500-line
  tool-smoke monolith is now fourteen focused `node --test` suites under
  `scripts/tool-contracts/` with brittle exact-wording assertions relaxed to
  key-phrase contracts, CI path selection is single-sourced in
  `scripts/release-paths.mjs` for both the release gate and deploy planning,
  and a release skips re-running the critical lane when the gate already
  verified the exact same commits.

- No suite can rot silently any more: the remaining test monoliths
  (provider-toolcall, session-transport, shell-hardening) are per-domain
  suites under `scripts/`, the release gate now executes the tool-contract
  and compaction (recall-fasttrack) contracts on every gated push, and a
  weekly `suite-health` sweep runs every registered `test:*`/`smoke:*`
  script through an opt-out catalog that opens a tracked issue on failure.

## v0.9.158 - 2026-08-31

- The Extensions hub now gives Git, Memory, Browser Use, Computer Use, Office,
  and voice a consistent install, progress, enable, and disable flow. Optional
  runtimes are prepared on demand, Office can install LibreOffice through the
  platform package manager, and disabling voice preserves downloaded assets.
- Desktop runtime packaging is smaller and more deterministic: optional feature
  payloads stay out of the base app, runtime code is prepared once, snapshot
  deploys tolerate concurrent edits, and release CI shares one cross-platform
  runtime build with explicit Git and Computer Use gates.
- Studio preserves per-item drafts and makes detail editing, selection, and
  keyboard interactions resilient across navigation. Context usage and voice
  dictation controls also report their current state more consistently.
- The OpenAI OAuth route leaves WebSocket prompt prewarming off by default,
  avoiding an unnecessary warmup request unless it is explicitly enabled.
- Terminal-Bench 2.1 publishes the full Codex CLI `k=5` comparison with raw
  Harbor artifacts, source-commit verification, recovered-cost provenance, and
  reproducible report generation.

## v0.9.157 - 2026-08-31

- Browser Use gains a smaller, more reliable host split across tabs, downloads,
  interception, permissions, snapshots, dialog reporting, and page lifecycle.
  Chromium profile import now includes offline App-Bound v20 cookie decryption
  through the packaged native importer without exposing decrypted secrets to
  the renderer or agent.
- Computer Use is decomposed into bounded capture, discovery, targeting,
  observation, input, and worker modules. Fairer resource ownership, fresher
  post-action state, stricter input guards, and expanded repeat scenarios make
  long-running native and Chromium sessions faster and safer.
- Memory moves to a compact E5 embedding runtime with incremental latest-first
  backfill, cache compression and retention, Korean-aware lexical ranking, and
  idle worker reclamation. The old token native addon and heavier legacy model
  path are removed from the shipped runtime.
- Session recovery promotes the checkpoint journal to the durable resume
  boundary, preserving provider usage, compaction anchors, recall handoff, and
  Anthropic thinking replay across interruption, retry, and restart without
  duplicating context.
- Office authoring adds model-authored composition plans, a reusable design
  library, document preview, and broader portable Word, Excel, and PowerPoint
  primitives while retaining structural and rendered assurance checks.
- Desktop and mobile web surfaces gain remote Browser Use, share-target intake,
  push notifications, richer document editing and preview, quieter startup
  restoration, and more predictable service-worker cache updates.
- Native search now bounds broad inventory leases and fairly admits concurrent
  find, glob, and grep work. Release automation incrementally rebuilds changed
  native and voice assets, verifies packaged sidecars, and reuses unchanged
  platform runtime artifacts.

## v0.9.156 - 2026-08-29

- Portable Office authoring gains chart rendering and text metrics, so more
  PPTX and XLSX work completes without handing off to the Office COM host.
- Browser Use and Computer Use tool contracts are revised together with the
  desktop settings store, IPC validation, and transcript tool formatting.
- Desktop virtual scrolling now tracks the upstream packages, and the
  transcript's bottom pin relies on the core's own scrolling deferral.
- Development deploys can run from a frozen snapshot of the working tree
  (`update:dev:snapshot`), which lets an install succeed while other sessions
  keep editing the repository instead of failing the input-fingerprint check.

## v0.9.155 - 2026-08-29

- PPTX slide import, image replacement, and table data authoring now run in the
  portable engine, so those operations no longer require the Office COM host.
- Office authoring gains portable packaging, composition, sheet-style, and
  slide-shape modules behind the existing assurance and quality pipeline.
- Goal tracking gains reminder and text extraction handling for continuations,
  and the desktop keeps session metadata in sync with a bounded renderer cache
  budget for unread-session state.

## v0.9.154 - 2026-08-29

- Computer Use sessions are reclaimed on every exit path instead of depending on
  an unref'd timer a departing runtime never fires: daemon and worker shutdown
  release them, a closing session releases its own, idle host workers expire on
  the same clock as the window claims they hold, and a dropped client connection
  aborts in-flight input rather than letting it drive the desktop until the
  command timeout. The client also retries once against a republished bridge, so
  restarting the desktop app no longer fails the next command outright.
- A crashed Browser Use page recovers on the next command instead of failing it.
  Refs bound to the dead document are dropped with it, so recovery can never
  hand back coordinates from a page that no longer exists.
- Compaction that runs between a prompt and the provider request no longer hangs
  when the memory runtime stalls: the recall-fasttrack memory call is bounded for
  every caller, not just the one path that happened to wire a timeout in.
- The Windows Explorer hidden-entry parser splits attrib.exe output with Windows
  path rules on any host, and the commit-hook capability probe now works across
  git versions that disagree about whether a non-native hook name needs a flag.
- Deploy stops rebuilding byte-identical platform runtimes. Test sources leave
  both the published package and the runtime cache key, so a test-only change
  hits the prepared-runtime cache instead of paying a seven-minute Windows
  rebuild. Desktop suites run as parallel gate jobs, including a Windows leg that
  finally exercises Computer Use in CI, and the 240-second git suite no longer
  sits in the default local run.

## v0.9.153 - 2026-08-28

- Windows Computer Use now runs a smaller CUA-style observation loop: compact
  accessibility and a plain screenshot are returned together by default,
  post-action state is immediately refreshed, AX and fallback OCR share one
  strict element budget, unusable black, white, or mismatched captures never
  issue a coordinate frame, mutations invalidate prior pixel frames, one new
  same-process popup becomes the deterministic verification target, app-owned
  Electron text fields use renderer-native background insertion, recovery names
  one next escalation rung, and dangerous session-ending keys, shell payloads,
  or shell/script-host launches are blocked at the host boundary. A 23-scenario Windows dashboard now covers
  native, Electron, Chrome, Korean OCR, secondary-display, stale-state, focus,
  popup, safety, and cleanup paths.
- Computer Use observations and turns are faster without weakening the input
  boundary: lightweight Win32 transition/frame snapshots, exact-window capture,
  bounded modern Chromium accessibility, adaptive launch polling, capture
  resource guards, and verified focus/cursor recovery replace repeated full app
  enumeration and unbounded fallbacks. Element-targeted literal typing can
  focus and type in one action, and bounded OCR can be included in the mandatory
  post-action capture. The final 23-scenario × 10 source-host matrix reached
  230/230 semantic passes and reduced baseline p50/p95 scenario latency by
  90.55%/94.01%; a separate dense/minimized/stale-target stress matrix passed
  40/40. All 30 redundant post-action recaptures were removed, and calls fell
  36.84% in the five batchable action workflows. Arbitrary mutation batching
  remains unsupported.
- Computer Use now exposes one strict 15-action contract instead of 28
  overlapping actions or a flat optional-field schema. Observation/search/zoom
  use `capture`, window and clipboard lifecycle use operation fields, and one
  shared `capture_after` object configures automatic verification. Reference-
  aligned guidance requires fresh exact targets, prefers semantic elements,
  and keeps Browser Use separate. The final schema was 2,644 estimated tokens
  before the frontier extensions; the pre-removal frontier contract passed
  36/36 first-call model scenarios. The current direct-dispatch contract is
  3,210 estimated tokens and 14,485 wire bytes. Read-only
  `diagnose` reports Windows OCR/UIA readiness without screen pixels; bounded
  `sequence` stops on failure or target transition and returns one final fresh
  state; strict call cardinality prevents parallel cross-target mutations both
  in model guidance and before runtime eager dispatch. Extra same-turn
  `computer` calls are not executed and receive a fresh-state recovery error.
  Natural-language selection passed 4/4 safe focus chains and 4/4 transition
  boundaries. In 10 repetitions, a two-action continuation used 50% fewer
  model-facing calls and captures, with p50/p95 latency down 12.34%/32.31%.
  Model-facing Computer Use confirmation and Office transaction approval
  prompts were removed; user-requested actions now execute directly while
  blocked key, payload, and script-host patterns remain hard errors.
  Measured provider usage is 5,150 input tokens and 4,026 ms p50 per model
  call. A 12-action post-observation schema reduced input 18.16% at 27/27
  accuracy but was rejected because repeated latency outliers and mid-loop
  schema changes would break the immutable provider-prefix cache contract.
  Semantic actions with deterministic exact-window transitions now report
  confirmed verification. No legacy call-shape fallback remains. After one
  development deployment, installed-app validation confirmed that left
  `click(ref)` uses semantic activation and that a native file-association
  launch returns its selected target with fresh state; marks and coordinates
  remain explicit pointer operations.
- Browser Use can import Chromium passwords, cookies, and history, suggest only
  masked accounts for the current HTTPS origin, and fill a selected login form
  inside an isolated CDP world without exposing the stored password to the
  renderer, agent, diagnostics, or logs. Utilities now defaults to the first
  right-side tab, migrates the old default placement without resetting custom
  layouts, and includes the Browser entry point.
- FastDirect now fingerprints, stages, backs up, and atomically restores the
  browser-import native sidecars together with `runtime.asar`, so incremental
  development updates cannot leave the installed app without its importer.
- Session context usage now records a canonical post-compaction snapshot that
  survives persistence and restart until the next turn invalidates it. Goal
  state and compaction recovery stay consistent across restarted services
  instead of repainting stale token usage or losing resumable work.
- Office generation now shares a semantic content model, structural and
  rendered assurance checks, prompt-injection review, checklist gates, and a
  polish pipeline across Word, Excel, and PowerPoint. Spreadsheet page/view
  controls, template-capacity selection, native chart data persistence, and
  live save-and-reopen verification strengthen release-quality documents.

## v0.9.152 - 2026-08-27

- Goal mode can now carry a long-running objective across turns with durable
  completion conditions, pause and resume controls, time limits, automatic
  continuation, model-facing management tools, and a session-scoped Desktop
  status island.
- Browser Use and Windows Computer Use are available as opt-in built-in
  capabilities. Browser Use can inspect and operate in-app or background pages,
  while Computer Use combines UI Automation, screenshots, keyboard, pointer,
  scroll, and window actions with DPI-aware input and safety guards.
- Provider recovery now preserves the original order of reasoning, text, and
  tool calls across Anthropic, Gemini, OpenAI, and compatible streams, including
  retries, stalled turns, saved sessions, remote projection, and compaction.
- Compaction starts a fresh read-cache epoch after it changes the transcript,
  and existing sessions synchronize newly available runtime tools at turn
  boundaries instead of keeping a stale tool catalog.
- Desktop and mobile navigation is cleaner and more predictable: mobile
  relaunches start from one New task while reconnects retain the current panes,
  pane swipes work across rich content and overlays, and side pages, extensions,
  Markdown, status labels, and trailing actions share tighter responsive
  layouts.

## v0.9.151 - 2026-08-26

- Editing a symbolic link now changes the file it points at instead of being
  refused: patch and edit follow the link through every engine, write
  atomically beside the real target, and leave the link itself intact.
- Headless and benchmark runs no longer leave temporary databases and processes
  behind. Each run gets an isolated runtime root, shutdown waits for the session
  daemon instead of reporting success ahead of it, and orphaned clusters are
  swept on the way out.
- Conversation compaction keeps everything it should. Automatic, manual, and
  cleared compaction share one path, the stored summary leads with full raw
  history behind it, and the most recent turns survive verbatim instead of being
  trimmed by a row or size cap.
- Exploration reads the original file before deciding how to parse, count, or
  summarize it, so a format guess no longer drives the answer.
- Desktop polish: attached images open in the system viewer, the usage panel's
  quota rows read in a natural order, and context and route panels lose their
  leftover frames and focus outlines.
- Terminal-Bench 2.1 results are republished from a `k=5` run of all 89 tasks,
  with the raw verification artifacts for every published run committed
  alongside the harness and metric scripts.

## v0.9.150 - 2026-08-25

- Tool results stay scannable and honest about size: search output and
  multi-file reads hold to a fixed budget instead of flooding an answer with
  thousands of lines, and a path that simply does not exist — or an ordinary
  repository state verdict — comes back as the answer rather than a failure
  that sends the assistant into recovery.
- Sessions no longer carry a stale provider fingerprint across a restart, and a
  new message immediately wakes a turn that is waiting on a background task, so
  a reply lands instead of sitting behind the wait.
- Terminal text selection recovers from a drag whose button was released
  outside the window, and a selection dragged past the top or bottom edge
  follows normal start-of-line and end-of-line behavior instead of freezing at
  the last column the pointer held.
- Voice dictation asks for confirmation before installing its runtime, tool
  cards and diff frames line up on the shared theme, and ten interface
  languages are refreshed.

## v0.9.149 - 2026-08-24

- OpenAI OAuth sessions now speak the reference client's wire shape by default:
  stable installation and thread identity, the lighter request form on current
  models, and provider-correct handling of a socket that reaches its lifetime
  limit mid-session.
- Session startup reserves its pre-warmed connection for the first turn only
  when the prompt it warmed still matches, so a turn whose environment or tool
  surface changed starts clean instead of resending the whole request.
- Directory listings return a first page sized for scanning rather than a dump,
  and code structure lookups fetch full symbol bodies only when the exact
  implementation is needed.

## v0.9.148 - 2026-08-24

- Desktop and mobile conversations preserve drafts, history, follow behavior,
  pane gestures, and remote state more reliably while reducing relay transfer
  and renderer deployment overhead.
- Agent sessions recover provider streams, compaction, worker state, and tool
  results more consistently, with clearer Git conflict and environment
  outcomes and more accurate search telemetry.
- Voice input gains a verified cross-platform runtime release path, while
  memory retrieval, native process handling, and packaged runtime preparation
  are hardened.
- Release automation, FastDirect deployment, and benchmark reporting now reuse
  unchanged artifacts and compare model calls, cost, and final context with
  provider-correct accounting.

## v0.9.147 - 2026-08-21

- Long OpenAI sessions now keep their response chain and turn-state pin intact
  across reconnects, item reordering, and compaction, so the provider prefix
  cache survives a session instead of restarting mid-task.
- Session startup pre-warms the provider prefix and separates environment
  details from the shared instruction prefix, cutting cold starts and repeated
  upload of identical context.
- Tool-use rules read shorter with the same guarantees: routing clauses now
  disappear with the tools they name, and shell results are classified by the
  runner that produced them.
- Desktop tool cards and result summaries are localized, and the context gauge
  reports the post-compaction estimate instead of the discarded prefix.
- Benchmark runs gain fast route presets and a grok CLI reference adapter, so
  reference numbers come from the same containers and verifier.

## v0.9.146 - 2026-08-21

- Mobile web conversations now keep touch scrolling, streaming Markdown
  measurement, tab swipes, compact composer controls, and responsive overlays
  stable across native gestures, rotation, and small-screen layouts.
- Sessions can carry a full conversation into the currently selected model
  when it fits that model's context boundary, while context usage and inherited
  route details remain explicit.
- Transcript tool groups preserve their original calls, arguments, outputs, and
  completion state for detailed inspection, with localized image previews and
  clearer activity presentation.

## v0.9.145 - 2026-08-21

- Mobile web sessions now keep native viewport scale, pairing recovery, remote
  state projection, and transcript scrolling stable across touch gestures,
  streaming row measurements, app restores, and slow connections.
- Desktop panes, source-control refreshes, tool activity, command surfaces, and
  session state recover more consistently while preserving responsive layouts
  and clearer loading or interruption feedback.
- Agent tool routing now applies tighter argument guards, Git mutation policy,
  provider-prefix handling, evidence projection, and shell output recovery
  across the shared runtime and TUI.
- Release, benchmark, localization, and diagnostic tooling now validate their
  contracts with broader regression coverage and more compact runtime reports.

## v0.9.144 - 2026-08-21

- Desktop interaction now follows keyboard and pointer focus more reliably,
  improves mobile pane swipes and transcript/status presentation, and reports
  background shell task state with safer recovery behavior.
- Git diff panes reveal their own loading state immediately, coalesce
  overlapping refreshes, and render repository text without invoking configured
  external diff or textconv commands.
- Solo is now the default workflow, tool-use rules preserve evidence while
  batching work more tightly, and bounded read/grep windows reduce unnecessary
  context without hiding pagination.

## v0.9.143 - 2026-08-20

- Session execution now shares one supervised runtime worker instead of a
  process-shard pool. Background agents stay in-process, provider waits yield
  their local CPU admission slot, and machine-wide spawn limits and runtime
  health recovery remain enforced.
- Remote device approvals appear only while Settings → Connection is open,
  recover pending requests when that panel opens, and finish only after the
  browser proves its authenticated E2EE connection.

## v0.9.142

- Linux desktop packaging validates the target architecture in the ABI
  prebuild directory that `node-pty` actually loads, while compiled Windows and
  macOS packages keep their `build/Release` validation path. - 2026-08-20

- Installed web apps resume one pending desktop approval across reloads, while
  the desktop replaces stale prompts, expires them with the relay request, and
  accepts each decision only after the service confirms it.
- FastDirect reuses fresh build targets, a persistent production renderer
  cache, prepared runtime output, and an extracted ASAR shell template. Live
  relay deploys independently fingerprint renderer/server changes and upload
  only verified renderer deltas before the atomic VPS swap.
- Inline code follows the surrounding prose font and size, leaving color as
  its only inline distinction while fenced code remains monospace.

## v0.9.141 - 2026-08-20

- Desktop task creation works under Electron 41 and Node 24: the agent shard
  router now copies immutable ESM session-manager exports into a writable
  facade before installing its remote-session overrides.

## v0.9.140 - 2026-08-20

- Studio deletes take effect on the first click: a finished run releases its
  grid slot as soon as its asset is indexed, so deleting that asset no longer
  revives the slot as a phantom "generating" tile. The gallery is no longer
  capped at 2,000 entries — an asset leaves the store only through an explicit
  delete — and a run that fails, starts without a job, or loses its runtime
  snapshot now reports that instead of spinning silently.
- The mobile tab switcher reads as a card grid and earns a filter field only
  once the list is long enough to need one, while phone chrome restates the
  composer discs, the status island, and panel sheets at touch proportions and
  brings hover-only controls within reach.
- An installed web app can pair itself: it opens a device-routed entry URL,
  asks that desktop for approval behind a two-digit code shown on both
  screens, and receives pairing material sealed to its own throwaway key.
  Paired browsers now register which push lanes they read, so a connected
  phone no longer pays for terminal, editor, and file traffic it never shows.
- The code-graph search server serves shared-pipe clients with per-connection
  response queues and client-scoped request ids, and exits on its own after an
  idle window so a force-killed owner stops leaving warm servers behind.
- Tool calls survive provider argument noise: an omitted optional base path
  resolves to the current Project instead of failing the call, task arguments
  are narrowed to the chosen action, and git output keeps its final progress
  frame and its trailing fatal line instead of burying the reason under redraw
  frames.
- The renderer loads one UI language catalog instead of eleven, settles the
  language before the first app module evaluates, and prefetches a surface
  chunk on selection; /inherit carries an existing conversation into a new
  session on the currently selected route.
- Third-party credit is carried by LICENSES and NOTICE alone.

## v0.9.139 - 2026-08-20

- Antigravity OAuth arrives as a provider: one Google login exposes Gemini 3.x
  and Claude through the Cloud Code Assist gateway, with login, token refresh,
  and endpoint failover following the existing OAuth provider shape.
- Agents now have exactly two states, a pinned model or off, and Web Search
  resolves the Main Model when its route is left unset.
- Paired browsers reach the desktop operation surface — project instructions,
  folder browsing and places, and the git contract — through one shared
  argument-validation module, while relay session state travels as
  client-scoped compact deltas inside binary E2EE frames.
- The web app now ships precompressed brotli and gzip assets, holds back
  background warmups and fonts on metered or slow links, resizes image
  attachments and dictation audio before upload, drops the pinned status
  island's live blur on phones, and paints the brand accent in Google blue.
- Windows runtime staging and asar packing survive repo lifecycle scripts and
  transient antivirus file locks, and the TUI status line computes its running
  shell count directly on the instant path.

## v0.9.138 - 2026-08-19

- Remote web sessions now use client-scoped subscriptions, binary E2EE frames,
  compact state/catalog deltas, terminal batching, and paint-latency probes,
  reducing transfer volume while preserving live recovery on slow links.
- Web transcript scrolling and composer input remain visually stable during
  concurrent remote snapshots, session switches, and mobile rendering.
- Runtime context, provider request recovery, background task notifications,
  and completion restoration are hardened across long-running sessions.

## v0.9.137 - 2026-08-19

- Remote reconnect recovery now refreshes session catalogs and mounted
  transcript lanes, and the update control leads the title-bar button group.

## v0.9.136 - 2026-08-19

- Retired Discord/Telegram messaging and channel-session plumbing are removed,
  while mobile system bars remain consistently black.

## v0.9.135 - 2026-08-18

- Desktop now preserves pane layouts, sidebar state, panel geometry, and
  composer drafts across reloads and FastDirect restarts, with expanded
  renderer regression coverage.
- Shell execution now hardens environment scrubbing, warm standby, background
  completion recovery, native process handling, and tool routing across
  interactive and headless sessions.
- Native spawn Linux releases are statically linked, graph search and recall
  reporting are hardened, and Terminal Bench routing and report tooling are
  updated.

## v0.9.134 - 2026-08-17

- Desktop now ships the selected brand mark, a unified model route editor with
  model parameters and persisted list order, and unpacks node-pty beside the
  packaged daemon.
- Session compaction is hard-locked by owner: agent sessions stay semantic,
  user sessions use recall-fasttrack. Settings no longer lists Core memories
  (they live on the project), and the Windows acceptance inventory matches.

- Provider and tool integrations now include OAuth lifecycle and token recovery
  across Anthropic, Cursor, Grok, and OpenAI, Grok-specific tool schema
  normalization, and decomposed search and grep path/pattern fan-out.
- Session orchestration and TUI workflows now enforce owner-session scoping,
  preserve completed handoff and background completion cards across restores,
  retain externalized queued prompts, and classify outcomes across command
  failures, tool errors, and benign misses.
- Desktop workspace navigation now preserves pane session titles during drag
  interactions, adds cold-start workspace restoration retries that prevent
  dropped tabs, and updates onboarding and capability configuration panels.

## v0.9.133 - 2026-08-16

- Provider-only evidence projection now aliases repeated typed file paths
  within mutation epochs, preserving exact tool envelopes and reconstructable
  paths while reducing cumulative context in long sessions.
- Git execution now shares one mutation policy across orchestration and
  evidence projection, serializes repository-wide writes against file edits,
  uses tree-owned native processes, and makes queued locks abortable.

## v0.9.132 - 2026-08-16

- Tool execution now exposes complete shell exit status, adds a dedicated Git
  surface, strengthens atomic patch creation and diagnostics, and improves
  search, list, code-graph, and native graph integrity under concurrent load.
- Session compaction, provider/image recovery, evidence tracking, shard health,
  and Lead runtime cleanup now preserve state across failures without masking
  degraded workers or triggering unnecessary fallback work.
- Desktop routing, agent activity, restored pane state, and streamed Markdown
  rendering now remain responsive and visually consistent across live and
  resumed conversations.

## v0.9.131 - 2026-08-14

- Release gates now run automatically with incremental path selection, desktop
  platform runtimes prepare ahead of packaging, native graph builds use a
  faster reproducible profile, and production web/relay deployment includes
  atomic rollback plus hash and health verification.
- Desktop release lanes now package as soon as their matching runtime is ready,
  graph compiler caches stay isolated between reproducibility builds, relay
  installs are lockfile-pinned, and release timing warns on 10% regressions.
- Agent cleanup no longer mistakes Lead pool projections for child workers, so
  disposing another runtime cannot close the active desktop conversation or
  discard an accepted follow-up message.

## v0.9.130 - 2026-08-14

- Provider and session recovery now classifies transient stream failures
  consistently, retries image-rejected turns without losing user intent, and
  preserves interruption, summary, and terminal outcome state across Gemini
  and OpenAI transports.
- Tool failures are persisted without test-trace pollution, shell policy avoids
  quoted-script false positives, and native search/read/list/stat paths share
  cancellable work while preserving fresh watcher invalidation and exact-file
  grep/glob behavior under load.
- Desktop Studio, usage, agent activity, pane layout, localization, and worker
  tag presentation now stay aligned across restored and live sessions.

## v0.9.129 - 2026-08-14

- Headless exec now runs a true solo surface by default: web search and
  memory tools stay off unless --web-search / --memory opt back in, shell
  child processes inherit an enforced no-egress proxy (loopback stays
  reachable), and the session environment line states network=offline so
  models never attempt web access.

## v0.9.128 - 2026-08-14

- Exploration tools now finish at the search round: grep spends its output
  budget on ranked source blocks (rare-branch matches first), find drops
  noise-only fuzzy results, and code_graph symbol outlines filter before
  capping and honor body requests.
- Agent guidance batches one best-routed call per unknown instead of
  speculative multi-tool fanout, cutting benchmark token use by a third with
  no pass-rate change.
- Session recovery and runtime resilience hardening across native search,
  shell contract, and read/list tooling.

## v0.9.127 - 2026-08-14

- Native binaries now have one canonical home in GitHub Releases: npm ships
  only the CLI, while CLI runs verify and cache assets on demand and Desktop
  builds embed the same verified platform assets.

## v0.9.126 - 2026-08-14

- Native search now handles the complete internal grep/find contract, preserves
  regex recovery errors, and overlaps first-turn search and code-graph warmup.

## v0.9.125 - 2026-08-13

- Shell and background-task execution now use one hash-pinned native process
  manager across Windows, Linux, and macOS, with no environment, local-build,
  file-registry, standby-shell, or Node process fallback.
- Native search, patch, download, media, recall, webhook, and session paths now
  enforce bounded resources, stricter ownership, and hardened transport and
  release-supply-chain checks.
- Memory runtime extraction now accepts verified in-archive links while still
  rejecting traversal, external links, and special tar entries.
- Desktop project, terminal, update, remote pairing, relay, and pane behavior
  now include the consolidated security, recovery, and responsive-layout fixes.

## v0.9.124 - 2026-08-12

- Desktop agent activity now groups every active session independently of the
  focused tab, while restored session panes prewarm correctly and existing
  sessions accept follow-up input without waiting for host acknowledgement.
- Desktop and daemon session transport now survives startup races, stale
  control sessions, transient socket loss, and in-place stream recovery while
  keeping remote ownership global across session focus changes.
- Git commit preferences now separate the visible example from AI
  instructions, serialize overlapping saves, and validate then correct
  Conventional Commit output before accepting it.
- Core memory now mirrors curated and generated context into an atomic,
  revision-guarded file so sessions can load scoped memory without cold-starting
  the memory runtime, with mutations refreshing the mirror.
- TUI transcript anchoring and Escape selection handling avoid visual jumps and
  accidental queue restoration, while Terminal-Bench refusal fallback follows
  the runtime termination reason even after streamed narration.

## v0.9.123 - 2026-08-12

- Desktop provider setup now recovers stale control sessions without exposing
  raw transport failures, and prompt history engages only from an empty draft.
- Path search avoids cold full-tree sweeps, coalesces watcher prewarms, and
  tightens native search deadlines, bulk concurrency, and process snapshots.
- Async shell timeout guidance now distinguishes unlimited background work from
  explicit kill deadlines.

## v0.9.122 - 2026-08-11

- Tool routing rules now centralize path conventions, remove duplicate batching
  guidance, and require read-only inspection only when evidence is at risk.
- Anthropic benchmark preflight now resolves provider imports correctly from
  isolated temporary harness snapshots.

## v0.9.121 - 2026-08-11

- Tool execution rules and shell diagnostics now distinguish conclusive path
  misses, trust verified envelopes, keep same-turn value checks, and surface
  command-not-found facts from stderr.
- Desktop transcript virtualization now pins native text-selection endpoints
  during drag autoscroll, while utility launchers align their icon and copy in
  content-sized rows.

## v0.9.120 - 2026-08-11

- Background shell tasks now retain their owner session and daemon after every
  view detaches, so idle eviction cannot cancel the task before its completion
  is delivered.

## v0.9.119 - 2026-08-11

- Native Graph and Token reproducibility builds now run on independent runners
  in parallel, while macOS Intel DMG and ZIP uploads overlap and abandon
  stalled transfers promptly.
- Desktop project navigation, utility surfaces, transcript focus, and vendored
  virtualization behavior are refined alongside tighter tool execution styles
  and filesystem process reuse.
- Discord and Telegram attachment handling preserves bounded media delivery
  and validates Telegram upload behavior directly.

## v0.9.118 - 2026-08-11

- Desktop consolidates Agents, Search, and Source Control in the utility dock,
  keeps Utilities selected while launching tools, and aligns warning versus
  failure treatment across restored and live tool cards.
- File listing and native search now coalesce concurrent enumeration, support
  cancellable persistent requests and process snapshots, and preserve bounded
  fallback behavior under heavy filesystem fan-out.
- Code-graph batching, PowerShell standby reuse, shell process-tree tracking,
  and cache invalidation are hardened against concurrent work and stale state.

## v0.9.117 - 2026-08-11

- Desktop prompt submission now supports immediate Enter queueing and precise
  Esc restoration of pending text and attachments, while transcript scrolling
  defers virtualizer corrections during active reader motion.
- Desktop Utilities now presents direct Studio, Terminal, and Explorer
  launchers with localized descriptions, while the activity rail uses the
  creative Utilities identity and refreshed usage presentation.
- Obsolete model-facing channel actions and their provider-dispatch plumbing
  are removed so the advertised tool catalog matches the runtime surface.
- Tool execution guidance tightens batched evidence and same-turn verification,
  while concurrent filesystem, graph, patch, and shell bursts gain bounded
  threadpool, spawn-lane, and reachability-pressure handling.

## v0.9.116 - 2026-08-11

- Terminal-Bench H5 round analysis adds rewarded task traces and aggregate
  round counts for the final high-effort comparison.

## v0.9.115 - 2026-08-11

- Terminal-Bench H4 round analysis records successful high-effort task probes
  and their retrieval, patch, and verification cadence.
- Tool execution guidance now treats task facts and proven checks as durable
  known state and keeps patch verification in the same execution turn.

## v0.9.114 - 2026-08-11

- Guessed tool identities are now verified before dependent calls, with an H3
  Terminal-Bench round analysis recording the resulting retrieval patterns.

## v0.9.113 - 2026-08-11

- Tool guidance now batches distinct evidence samples and avoids redundant
  deferred-tool or project activation, with Terminal-Bench round analysis
  capturing remaining serial-probe patterns.

## v0.9.112 - 2026-08-11

- Desktop utility, activity, transcript, settings, and repository surfaces are
  simplified around focused feature configuration and compact regressions.
- Provider recovery, shell/list diagnostics, and release verification are
  consolidated into smaller ship-critical suites without weakening their
  transport, asset, or packaging contracts.

## v0.9.111 - 2026-08-11

- Repository navigation now uses the direct built-in tool surface without a
  separate explorer agent, reducing routing overhead and legacy configuration.
- OpenAI WebSocket retry decisions preserve current auth, throttling, and
  cancellation errors, while session transport recovery and completion
  deduplication are hardened.
- Tool batching, graph fan-out, progress reporting, and desktop transcript,
  settings, and utility-dock behavior are streamlined with focused regressions.
- Terminal-Bench 2.1 profiles, resumable runs, immutable harness snapshots, and
  cost accounting are tightened for reproducible native comparisons.

## v0.9.110 - 2026-08-11

- Provider transports now bound Anthropic non-stream stalls, distinguish
  retryable transport failures from model refusals, preserve OpenAI reasoning
  continuity on recovery, and prewarm compatible WebSocket sessions.
- Patch, list, and shell tools recover unique path or context mismatches in one
  call while retaining ambiguity, symlink, and destructive-command safeguards.
- Session-title completion and Markdown source fallback handling are more
  resilient, with focused provider, renderer, tool, and routing regressions.
- Terminal-Bench 2.1 diagnostics, fair native baselines, usage accounting, and
  reproducible reasoning-replay experiments are expanded.

## v0.9.109 - 2026-08-10

- Shell commands that complete with a non-zero exit are treated as command
  results rather than tool failures, with consistent runtime and TUI status.
- Tool routing, explorer limits, output-style contracts, and their regression
  suites are tightened to avoid redundant work while preserving concise
  user-facing reports.
- Compact patch roots now establish both the write boundary and relative path
  coordinate frame, including clearer recovery guidance.

## v0.9.108 - 2026-08-10

- Compact patch parsing accepts legacy Begin/End wrappers around compact
  sections while leaving canonical V4A input unchanged.

## v0.9.107 - 2026-08-10

- Non-interactive automation and benchmark sessions explicitly use implicit
  approval context, while interactive workflows keep their user approval gate.

## v0.9.106 - 2026-08-10

- MCP clients, tool discovery, instructions, execution, deferred refresh, and
  teardown are isolated by runtime scope so same-named servers cannot leak
  across concurrent sessions or standalone agents.

## v0.9.105 - 2026-08-10

- Remote access is web-app only: the retired Capacitor/Android package,
  APK download routes, native-shell hooks, and mobile release version wiring
  are removed, while relay deployment gains an explicit renderer staging step.
- Tool calls now normalize current-project inputs to compact relative paths,
  reject mismatched or redundant scopes consistently, and preserve parity
  across shell, patch, graph, explore, and built-in tool contracts.
- Context reporting separates provider-visible usage from compaction pressure
  and configured reserve, while Anthropic adaptive thinking leaves its display
  mode to the API unless an operator explicitly overrides it.
- New-task drafts keep their own project tab when selecting or registering a
  project, and successful session Fast changes seed the next matching draft
  without replacing a different model choice.

## v0.9.104 - 2026-08-09

- Tool routing now locates unknown repository coordinates once, assigns each
  evidence facet to one dedicated tool, batches only independent calls, and
  keeps text edits and verification behind the patch execution barrier.
- Directory inspection exposes dotfiles and file metadata without Shell
  exploration, while delegation-free workflows omit the unused Lead brief and
  use a smaller, capability-aligned tool surface.

## v0.9.103 - 2026-08-08

- Desktop navigation, composer, Studio, settings, and transcript surfaces now
  share a tighter responsive layout, with stronger virtual-scroll following,
  local-file handling, and expanded DOM regression coverage.
- The remote renderer ships as an installable web app with a stable manifest,
  icon, and network-only service worker, while the relay serves those assets
  with the required manifest and service-worker content types.
- Solo execution no longer carries obsolete debugger, scheduler-task, or
  webhook-handler agent definitions and removes their stale routing/cache
  protocol, keeping built-in services separate from editable custom agents.
- Hosted Codex image generation explicitly selects the image tool for supported
  models, with focused request-body coverage.

## v0.9.102 - 2026-08-08

- Maintenance version bump; no functional changes over v0.9.101.

## v0.9.101 - 2026-08-08

- Escape now recalls queued, still-unprocessed messages into the composer
  before anything else — queue order first — so a mid-turn Esc edits the
  waiting follow-up instead of interrupting the turn; a second press still
  cancels.
- Workflows are pure working-style definitions: packs no longer carry an
  agent roster. Every defined agent (built-in and custom) is available to any
  delegating workflow, Solo stays delegation-free via `delegation: none`, and
  deleting a custom agent removes it from every surface at once, including
  spawn-by-name.
- Settings → General gained independent Web search, Explorer, and Memory
  toggles; Memory now gates the memory/recall tools plus core-memory
  injection, while background memory cycles moved to Context as their own
  switch.
- Headless role runs and bench sessions start with explorer, web search, and
  memory off (classic surface) and opt back in per run via flags or
  MIXDOG_FEATURE_* variables.
- The shared tool policy drops the mandatory post-edit verification round,
  takes the cheapest sufficient evidence per lookup, and defines explore as a
  plain source search over source trees and files with one concrete target per
  query.

## v0.9.100 - 2026-08-07

- Context command styling no longer depends on opening Settings first or
  collides with Monaco's global context class, and transcript reattachment no
  longer rolls back a small reader wheel movement.
- Desktop packagers now restore npm downloads with a dependency-only cache key,
  so release version stamps do not cold-start every platform installation.
- Hidden drafts are treated as resumable work rather than published releases,
  preventing failed releases from consuming an extra patch version.

## v0.9.99 - 2026-08-07

- Desktop transcript typography now separates content, operational status, and
  metadata into a steadier hierarchy, while Fast uses a compact stateful icon.
- Explorer retrieval now fans out every concrete locator facet once, preserves
  returned paths verbatim, and stops bounded recovery instead of returning a
  weak or reconstructed anchor.
- Synchronous model-catalog reads no longer launch an implicit global network
  request. Session warmup remains the single owner of remote catalog I/O, so
  provider-injected transports stay hermetic on a cold installation.
- The isolated release lane now prepares one verified native code-graph runtime
  explicitly instead of depending on an ambient binary left by an earlier job.
- Intel macOS release assets use bounded, file-by-file HTTP/1.1 uploads with
  remote completion checks and retries, preventing one stalled CLI transfer
  from holding the entire release indefinitely.
- Unpublished same-version release recovery now folds its accumulated notes
  into that version before publishing instead of leaving shipped work marked
  as Unreleased.

## v0.9.98 - 2026-08-07

- Remote browser pairing now establishes an authenticated end-to-end encrypted
  channel before any session state, terminal data, or RPC payload can cross the
  relay; unencrypted media lanes remain closed.
- Desktop attachments preserve file identity and metadata through the session
  boundary, with bounded image/PDF extraction and shared media normalization
  for provider inputs.
- Desktop onboarding and related settings copy are localized across every
  shipped language, while IME composition, virtual transcript following, and
  fast-mode controls behave consistently in long-running panes.
- Session recovery, pending-message delivery, provider catalog caching, title
  generation, worktree snapshots, and bounded runtime metrics are tightened
  around the unified session service.
- Release validation is split into parallel lanes, desktop compilation overlaps
  the gates, prepared runtimes are cached, and platform packages upload to one
  hidden draft before atomic publication. Renderer-only dependencies are no
  longer duplicated in the desktop archive, cutting the Windows installer by
  roughly one third.

## v0.9.97 - 2026-08-07

- Session protocol 1 now carries an explicit compatibility index, allowing
  newer clients to reject older daemons while older clients can attach through
  the supported compatibility surface without parallel engine/backend stacks.
- Desktop, terminal, channel, OAuth, and memory flows now share the unified
  machine-wide session daemon; obsolete engine/backend transports, fallbacks,
  and compatibility shims have been removed from the development line.
- Session ownership and tool workload gates now coordinate parallel shell,
  patch, read, code-graph, memory, and channel work with fair admission,
  lower duplicate I/O, and stronger cancellation/recovery coverage.
- Desktop multi-pane focus, tab dragging, review state, notifications, provider
  naming, updater diagnostics, and developer update packaging have been
  tightened, with expanded renderer and session-transport regression tests.
- Terminal-Bench reproduction commands and cost validation now point to the
  exact archived run and fail clearly when a requested trial set is absent.

## v0.9.96 - 2026-08-07

- Release discipline now requires every app package to be pre-bumped when the
  engine wire protocol changes, keeps workspace versions synchronized, and
  publishes that pending identity without an accidental second increment.
- Development and installed surfaces continue to share the existing data and
  authentication store; protocol/version discipline prevents same-version
  daemon skew without hiding credentials behind a new profile.
- Release validation now gates platform packaging and removes a duplicate
  code-graph run, avoiding five expensive package jobs when a focused gate fails.
- Desktop protocol conflicts now explain the update/close-and-reopen recovery
  path instead of surfacing a raw session transport exception.
- The unified protocol-1 daemon removes the duplicate desktop session host,
  restores daemon reconnect/resync behavior, and preserves completed tool work
  across timeout and cancellation boundaries.

## v0.9.95 - 2026-08-06

- A machine-global process owns every live session, and the terminal TUI plus
  every desktop window attach as views over a 127.0.0.1 HTTP+SSE transport, so
  there is no owner/viewer role to negotiate between surfaces.
- Submitted prompts can no longer be lost between surfaces. A daemon view's
  submit keeps its synchronous answer but is retried until the engine takes it
  (and re-delivered after a daemon restart), a live-share submit is
  acknowledged by the owner and falls back to the durable spool when it is
  refused or unacknowledged, and the queue drops a re-delivered submission id
  instead of posting the message twice.
- Cross-client editing: resuming a session another view already holds adopts
  that live engine instead of loading a second copy, engine frames fan out to
  every view, and an engine only ends with its LAST viewer — so a terminal and
  a desktop window can drive one session turn by turn.

## v0.9.94 - 2026-08-05

- Desktop tab strip shrinks tabs together toward the active/inactive floors
  with every tab visible instead of scrolling, and touch shells collapse to a
  title + count switcher list.
- Streaming markdown heals the live tail (unclosed `**`, `` ` ``, `~~`) and
  scopes the fenced-code geometry lock to its own chunk, so headings, lists,
  and bold format while the model is still typing.
- Turn review moved into the scrolled timeline (turn diffs ride the
  thread), ending the composer-stack shift on session entry; warn-tone
  notices now use the amber status pair instead of the neutral one.
- Native caption band is transparent so the DOM titlebar and dialog scrims
  dim it directly; the ◀ ▶ pane-cycle pair is retired (Alt+Left/Right keeps
  the focus cycle) and project dialogs hold the titlebar dim claim.
- Desktop UI capture drives New task and Settings through Ctrl+N / Ctrl+,,
  pins the capture language, and asserts the 360px narrow settings layout.
- TUI transcript window and jitter harness refinements, plus desktop
  session-selection race probes.

## v0.9.93 - 2026-08-04

- Dependency audit to zero across core and desktop: `npm audit fix` for
  fast-uri, ip-address, hono/@hono/node-server, root undici, and
  brace-expansion; discord.js nested undici override raised to 6.28.0;
  desktop `dompurify` override `^3.4.12` clears the Monaco XSS batch.
- README feature audit: desktop workbench section, memory subsystem detail,
  QR relay pairing, quiet-hours cron and local Whisper transcription,
  parallel pane sessions, onboarding wizard.
- Discord: removed the last registered slash command (`/stop`); startup still
  clears stale global/guild command sets.
- Terminal-Bench 2.1: corrected results, replacement comparison charts, and
  reproduction/verification scripts.
- CI: Deploy is now the single release entry point (token supply chain folded
  in, tag-push side doors removed) with a changelog release gate.
- Unified package versions at 0.9.92 (mobile/relay aligned) and squashed the
  repository history to a clean root.

## v0.9.92 - 2026-08-02

- Baseline release: npm package, desktop installers, and native supply-chain
  assets (runtime, patch, graph, token, voice runtime).
