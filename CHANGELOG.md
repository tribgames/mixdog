# Changelog

Notable changes, newest first. The Deploy pipeline refuses to release while
the Unreleased section is empty, and stamps it with the released version.

## Unreleased

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
  view detaches, matching CC notification lifetime semantics so idle eviction
  cannot cancel the task before its completion is delivered.

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
  before anything else — Claude Code's order — so a mid-turn Esc edits the
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

- Desktop tab strip follows Chromium's `tab_strip_layout`: tabs shrink
  together toward the active/inactive floors with every tab visible instead
  of scrolling, and touch shells collapse to a title + count switcher list.
- Streaming markdown heals the live tail (unclosed `**`, `` ` ``, `~~`) and
  scopes the fenced-code geometry lock to its own chunk, so headings, lists,
  and bold format while the model is still typing.
- Turn review moved into the scrolled timeline (OpenCode `session-turn-diffs`
  parity), ending the composer-stack shift on session entry; warn-tone
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
