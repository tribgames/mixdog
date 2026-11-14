# Migration base (X-BASE, G0)

Integration clone `D:/mixdog-build/mig/int` (a `git clone` of `C:/mixdog-build/tmp/ft-desk`), branch `mig/int`.
Engineers cut worktrees from `mig/int` under `D:/mixdog-build/mig/wt/<task id>`
(`git -C D:/mixdog-build/mig/int worktree add D:/mixdog-build/mig/wt/<task id> -b mig/<task id> mig/int`),
with `CARGO_TARGET_DIR` under `D:/mixdog-build/mig/target/`.

## Sources (recorded 2026-11-14)

| source | where | ref | SHA |
|---|---|---|---|
| w31 desktop + working tree | `C:/Users/tempe/side/pool/w31` (read only) | `k1-desktop-reads` -> clone `refs/remotes/w31/k1-desktop-reads` | `0b05dd132d47e60aaf751285d388460ad6d1b694` |
| w31 working-tree patch | `D:/mixdog-build/mig/w31-worktree.patch` (`git diff HEAD --binary`, 337 files) | - | sha256 `E8A8813C01AE805FF2DE4641FE4CA029CEE559EC783667FACFE2CC928B143FA3` |
| w31 untracked files (12) | copies in `D:/mixdog-build/mig/w31-untracked/` | - | - |
| core (native/core, native/mixdog-spawn) | `C:/mixdog-build/tmp/ft-fix` | `main` -> clone `refs/remotes/ftfix/main` | `5bb270aad95fabf152d6f1af2e63aadfb33924bf` (planning cited af3f254d3; 5bb270aad is af3f254d3 + 1) |
| helper (native/mixdog-computer) | `C:/mixdog-build/tmp/ft-desk` | `wincu-int` (local branch in the clone) | `e0a1df2b573e4aa8c8c44b18e2c8b6780c4503a1` |
| desk-r5 | ft-desk | `desk-r5` (local branch in the clone) | `10614b96fc80bd4960c424e275197c84dc3f151f` |
| 3-way base for desktop merges | merge-base(mig/int, wincu-int) | - | `08b7df616d6d69e502757d9d8402ae443d83e323` |
| ft-desk k1-desktop-reads (stale) | clone `origin/k1-desktop-reads` | - | `08b7df616d6d69e502757d9d8402ae443d83e323` |

ft-fix `main` moved past the SHA used: at the G0 check (2026-11-14) it is `1755165c4400834187fc3f0e0410136d7bc0201a` (`5bb270aad` + 7 commits: c25b21707, f67251003, eb3ca2449, 9304dc1d5, 622533877, 4fd89c678, 1755165c4). They are not in mig/int and come over as patches; `native/mixdog-spawn` is the same tree at both SHAs.

Port check of w31 commits that ft-fix carries in another form:

- `0b05dd132` (live transcript archived rows) = ft-fix `eb3ade28ef76dbd652af016e88c16f3fe4afe309`: identical `git patch-id --stable` (`7f1e4cfdb9b88ea21f8bb37d75a234ecb2780126`); nothing ported by hand.
- `448a87ffe` (delegated worker session surface): present in another form (`SessionDirectory::create_agent_session` in mixdog-core-session `session/directory.rs`; `NewThreadTools::seed_agent` for `LeadSurfaceHost` in mixdog-core `run_host/surface_host.rs`, which tests `reaction_disabled(header, true)` instead of a synthetic session map).
- `08b7df616` (memory cycle hidden role dispatch session): every added line found in the ft-fix core.

## Commits on mig/int

| commit | SHA | content |
|---|---|---|
| base-w31 | `38ce8129b138b49a89062e530486d9f14f175ca4` | w31 `0b05dd132` + w31 working tree patch + 12 untracked files (349 status entries, same paths as `git -C w31 status --short`) |
| base-core | `753d5dec210ed24e8f43116c18a8de17ee43a541` | `native/core` and `native/mixdog-spawn` = tree of ft-fix `5bb270aad` (exact; `git diff 5bb270aad -- native/core native/mixdog-spawn` is empty) |
| base-helper | `f8e96d54400515345a611d5ded3ef5b126568b52` | `native/mixdog-computer` = tree of wincu-int `e0a1df2b5` |
| base-proto | `4e88f1270ca89ca9bd636723e754ca46f34ce33a` | `packages/protocol/src/index.ts` regenerated (`MIXDOG_UPDATE_PROTOCOL_GOLDEN=1 cargo test -p mixdog-app-protocol`); `schema/*.json` came out unchanged |
| base-fix | `1d42de5c7d349b4a310625f1a9c38962dc2ee110` | protocol-client test files typecheck (see below) |
| this document | the commit that adds it | migration-base.md |

`apps/desktop`, `apps/mobile`, `packages/protocol-client`, `src` and `native/mixdog-window` are the w31 working tree (base-w31).

### base-fix commits

1. `1d42de5c7d` base-fix: `packages/protocol-client/test/rows.test.ts` (non-null assertions on four recorded card fields under `noUncheckedIndexedAccess`) and `test/scoped-binary.test.ts` (re-widens `clientClose` after `assert.equal(conn.clientClose, undefined)` narrowed it to `never`). Test-only; these errors come from the w31 tree itself, not from the regenerated protocol (the regeneration changed one doc comment in `QuotaResume`).

No desktop fix was needed: `npm run typecheck` in apps/desktop passed against the regenerated protocol.

## Checks at base

| check | result |
|---|---|
| `cargo-gate.ps1 check --locked --workspace` (native/core, CARGO_TARGET_DIR=D:\mixdog-build\mig\target\int) | pass |
| `cargo --locked --offline check` (native/mixdog-computer, host x86_64-pc-windows-msvc) | pass |
| `cargo-gate.ps1 test --locked -p mixdog-app-protocol` | pass |
| apps/desktop `npm run typecheck` | pass |
| packages/protocol-client `npm run typecheck` | pass after base-fix |
| packages/protocol-client tests (252) | pass when run with tsx from apps/desktop/node_modules; `npm test` fails here because the root node_modules (junction to w31) has no `tsx` |
| apps/mobile `npm run typecheck` | fails: `@capacitor/*` and `@capacitor-mlkit/barcode-scanning` are not installed anywhere reachable (no apps/mobile/node_modules in w31; installing is not allowed) |
| `cargo-gate.ps1 test --locked -p mixdog-core-session` (G0 check) | plain `cargo test`: 11-18 of 985 fail per run, a different set each run (process-global state shared between tests of one process: `AlreadyInstalled`, injected EIO, barrier faults; each passes alone). `cargo-gate.ps1 nextest run -p mixdog-core-session -p mixdog-app-protocol`: 1014/1014 pass. Same tree as ft-fix `5bb270aad`: baseline. Set `MIXDOG_GATE_ISO_BASE=D:\mixdog-build\mig\iso`: with the gate's default temp base (`D:\mixdog-build\tmp`, a junction to C:) the worktree tests fail with `WORKTREE_PROJECT_MISMATCH` (D: path vs its C: target) |
| apps/desktop `npm test` (fast lane, G0 check) | 8 failures, all baseline (inputs byte-identical to the w31 working tree): 7 from the `remote-protocol-chat-*.core/` fixture manifests, recorded against an older `packages/protocol-client/src/client.ts` (sha256 443b20b3... in the manifest, 3298a348... in w31 and here); 1 `session-history-boundary.test.mjs` expects `main/protocol/service-route.ts` and finds `main/protocol/session-lane.ts` |
| `node scripts/test.mjs smoke` (G0 check) | fails as run: no `tsx` in the root node_modules (w31's). With `node --import <apps/desktop tsx> --test`, `MIXDOGD_BIN` (mixdogd built in target\int) and `MIXDOG_TREE_HELPER` (treerun built in target\int): 7/7 pass |

## node_modules

`node_modules` and `apps/desktop/node_modules` are junctions into w31 (`D:/mixdog-build/mig/link.ps1`), read-only use. Never delete or write through them; never `npm install`/`npm ci`; keep them out of commits and of `git clean`.

## Symbol anchors

Line numbers cited by area plans refer to w31 or ft-fix before X-BASE. Locate edits by symbol; the line is where the symbol starts at base (`1d42de5c7d`). Kinds: Rust top-level items and table macros, TOML sections, TS top-level declarations.

### protocol

#### `native/core/crates/mixdog-app-protocol/src/methods.rs` (4374 lines)

| kind | symbol | line at base |
|---|---|---|
| macro table | `client_request_definitions!` | 10 |

#### `native/core/crates/mixdog-app-protocol/src/server_requests.rs` (116 lines)

| kind | symbol | line at base |
|---|---|---|
| macro table | `server_request_definitions!` | 12 |

#### `native/core/crates/mixdog-app-protocol/src/notifications.rs` (494 lines)

| kind | symbol | line at base |
|---|---|---|
| struct | `ErrorNotificationParams` | 40 |
| struct | `WarningParams` | 54 |
| struct | `FsChangedParams` | 68 |
| struct | `SearchUpdatedParams` | 78 |
| struct | `SearchCompletedParams` | 87 |
| struct | `ProcessOutputDeltaParams` | 95 |
| struct | `ProcessExitedParams` | 113 |
| struct | `LoginUpdatedParams` | 124 |
| macro table | `notification_definitions!` | 130 |
| struct | `TerminalInputParams` | 250 |
| struct | `TerminalResizeParams` | 259 |
| struct | `ProcessInputParams` | 273 |
| enum | `ClientNotification` | 282 |
| static | `CLIENT_NOTIFICATIONS` | 359 |
| impl | `ClientNotification` | 462 |
| fn | `section_notification_methods` | 490 |

#### `native/core/crates/mixdog-app-protocol/src/inventory.rs` (3645 lines)

| kind | symbol | line at base |
|---|---|---|
| enum | `InventoryList` | 8 |
| enum | `Target` | 22 |
| static | `INVENTORY` | 49 |

#### `native/core/crates/mixdog-app-protocol/src/free_text.rs` (355 lines)

| kind | symbol | line at base |
|---|---|---|
| enum | `Kind` | 20 |
| static | `FREE_TEXT` | 33 |
| fn | `matches` | 285 |
| fn | `is_free_text` | 301 |
| fn | `refused` | 311 |
| mod | `tests` | 316 |

#### `native/core/crates/mixdog-app-protocol/src/v1.rs` (228 lines)

| kind | symbol | line at base |
|---|---|---|
| struct | `ClientInfo` | 14 |
| struct | `HostCapabilities` | 29 |
| struct | `InitializeCapabilities` | 62 |
| struct | `InitializeParams` | 86 |
| enum | `CoreState` | 95 |
| enum | `CapabilityState` | 114 |
| struct | `ServerCapabilities` | 123 |
| struct | `RemoteCapabilities` | 140 |
| struct | `ConnectionInfo` | 177 |
| struct | `DefaultsSeparation` | 190 |
| impl | `Default` | 197 |
| struct | `InitializeResponse` | 206 |
| struct | `InitializedParams` | 228 |

#### `native/core/crates/mixdog-app-protocol/src/v2/mod.rs` (11 lines)

| kind | symbol | line at base |
|---|---|---|
| mod | `approval` | 3 |
| mod | `config` | 4 |
| mod | `domain` | 5 |
| mod | `feed` | 6 |
| mod | `host` | 7 |
| mod | `model_proxy` | 8 |
| mod | `op` | 9 |
| mod | `params` | 10 |
| mod | `thread` | 11 |

#### `native/core/crates/mixdog-app-protocol/src/v2/host.rs` (1099 lines)

| kind | symbol | line at base |
|---|---|---|
| struct | `HostClaimParams` | 16 |
| enum | `HostStateSetParams` | 25 |
| impl | `HostStateSetParams` | 32 |
| enum | `VisualizeHostValue` | 49 |
| struct | `VisualizeHostEvent` | 60 |
| struct | `VisualizeHostState` | 88 |
| fn | `null_or_value` | 101 |
| struct | `VisualizeHostTab` | 113 |
| struct | `VisualizeHostPane` | 156 |
| enum | `VisualizePaneKind` | 179 |
| enum | `VisualizeInlineKind` | 193 |
| struct | `VisualizeInlineContent` | 205 |
| struct | `VisualizeVersionView` | 221 |
| struct | `VisualizeVersionTurn` | 236 |
| enum | `VisualizeProblemKind` | 246 |
| struct | `VisualizeProblem` | 264 |
| struct | `VisualizeAnnotation` | 281 |
| enum | `VisualizeHistoryKind` | 292 |
| struct | `VisualizeHistoryItem` | 311 |
| struct | `VisualizeGoneOpen` | 326 |
| struct | `HostRemoteTargetSetParams` | 336 |
| struct | `HostHumanOnlyBeginParams` | 348 |
| struct | `HostHumanOnlyBeginResult` | 356 |
| struct | `HostHumanOnlyEndParams` | 364 |
| struct | `HostCommandParams` | 377 |
| struct | `HostNotificationStatusParams` | 389 |
| struct | `HostNotificationStatus` | 395 |
| struct | `HostComputerCaptureParams` | 408 |
| struct | `HostComputerImage` | 416 |
| struct | `HostComputerCaptureResult` | 426 |
| struct | `HostComputerDisplaysParams` | 436 |
| struct | `HostComputerDisplay` | 441 |
| struct | `HostSystemProxyResolveParams` | 452 |
| struct | `HostSystemProxyResolveResponse` | 458 |
| enum | `UpdaterAction` | 466 |
| struct | `HostUpdateCommandParams` | 475 |
| struct | `UpdateDesktopCommandParams` | 487 |
| impl | `crate` | 496 |
| struct | `HostFilesTrashItemParams` | 506 |
| struct | `HostFileSnapshotParams` | 515 |
| struct | `HostFileSnapshot` | 526 |
| enum | `LocalPageScope` | 538 |
| struct | `HostLocalPageUrlParams` | 548 |
| enum | `VisualizeAction` | 559 |
| struct | `HostVisualizeCommandParams` | 577 |
| struct | `HostNotificationShowParams` | 589 |
| struct | `HostBrowserViewFramesParams` | 605 |
| struct | `BrowserWebrtcSignalParams` | 622 |
| struct | `HostBrowserPageParams` | 634 |
| struct | `BrowserStreamParams` | 654 |
| struct | `BrowserStreamAckParams` | 666 |
| struct | `BrowserFrameParams` | 678 |
| struct | `HostBrowserFrameParams` | 687 |
| struct | `ScreenDisplaysParams` | 699 |
| enum | `LiveControlKind` | 705 |
| struct | `HostBrowserLiveControlParams` | 722 |
| struct | `HostBrowserSurfaceParams` | 736 |
| impl | `From` | 752 |
| enum | `PowerEvent` | 769 |
| struct | `HostPowerParams` | 776 |
| struct | `HostUpdateReportParams` | 783 |
| struct | `HostNotificationClickedParams` | 790 |
| struct | `ClientActivityParams` | 797 |
| struct | `ClientPerfLogParams` | 804 |
| enum | `UiOpenRequestedParams` | 814 |
| struct | `UiOpenBrowser` | 825 |
| struct | `UiOpenTerminal` | 852 |
| struct | `UiTerminalTab` | 873 |
| struct | `UiOpenVisualize` | 888 |
| struct | `UiNewTabCreatedParams` | 918 |
| struct | `UiTerminalRunClaimedParams` | 934 |
| struct | `UiScreenSessionsChangedParams` | 965 |
| struct | `RemoteConnectionTimelineParams` | 985 |
| struct | `CoreDrainParams` | 994 |
| struct | `DrainRunning` | 1004 |
| struct | `RemotePointerParams` | 1014 |
| struct | `ModelProxyExecuteParams` | 1023 |
| struct | `ModelProxyResult` | 1031 |
| struct | `ModelProxyEventParams` | 1039 |
| struct | `ModelProxyHeartbeatParams` | 1048 |
| struct | `ModelProxyRunParams` | 1056 |
| fn | `required_list` | 1067 |
| struct | `ModelProxyRunEventParams` | 1078 |
| struct | `ModelProxyCancelParams` | 1088 |
| struct | `ModelProxyRunCancelParams` | 1097 |

#### `native/core/crates/mixdog-app-protocol/src/v2/params.rs` (6422 lines)

676 top-level declarations (generated or flat type list): locate by name with `git grep -n "<Name>" -- native/core/crates/mixdog-app-protocol/src/v2/params.rs`. New param structs are appended near the type of the same method family.

#### `native/core/crates/mixdog-app-protocol/tests/it/free_text_fields.json` (4618 lines)

JSON data file: edits are rows located by their key (method name / pointer), not by line.

#### `native/core/crates/mixdog-protocol/src/section.rs` (229 lines)

| kind | symbol | line at base |
|---|---|---|
| enum | `SectionFeed` | 14 |
| impl | `SectionFeed` | 27 |
| macro_rules | `sections` | 42 |
| macro table | `sections!` | 75 |
| struct | `SectionStub` | 154 |
| struct | `SectionUpdate` | 169 |
| trait | `Section` | 184 |
| struct | `RemotePairCode` | 195 |
| struct | `ComputerSessionSection` | 207 |
| struct | `ComputerSection` | 216 |
| impl | `Section` | 226 |

#### `native/core/crates/mixdog-core-api/src/host.rs` (294 lines)

| kind | symbol | line at base |
|---|---|---|
| enum | `HostCapability` | 21 |
| impl | `HostCapability` | 44 |
| struct | `Lease` | 79 |
| impl | `Lease` | 84 |
| const | `NO_CLAIMANT` | 92 |
| const | `CLAIMANT_CLOSED` | 94 |
| const | `NOT_CLAIMED` | 96 |
| const | `LEASE_LAPSED` | 98 |
| fn | `model_proxy_unavailable_text` | 103 |
| enum | `HostError` | 118 |
| impl | `From` | 132 |
| trait | `HostChannel` | 139 |
| struct | `HostClaim` | 223 |
| trait | `ClaimedHostChannel` | 232 |
| trait | `ConnectionNotifier` | 255 |
| trait | `DesktopPresence` | 263 |
| trait | `ClientEpoch` | 271 |
| trait | `ApprovalPresence` | 278 |
| trait | `ApprovalSurfaces` | 286 |
| trait | `HostMediaSink` | 292 |

#### `packages/protocol/src/index.ts` (17267 lines)

867 top-level declarations (generated or flat type list): locate by name with `git grep -n "<Name>" -- packages/protocol/src/index.ts`. Generated: never edited by hand; regenerate with MIXDOG_UPDATE_PROTOCOL_GOLDEN=1 cargo test -p mixdog-app-protocol.

#### `packages/protocol-client/src/method-table.ts` (59 lines)

| kind | symbol | line at base |
|---|---|---|
| type | `OpScopeRule` | 6 |
| function | `fieldPath` | 9 |
| function | `scopeOf` | 15 |
| const | `methods` | 32 |
| const | `sectionMethods` | 35 |
| const | `scopedMethods` | 39 |
| const | `isScopedMethod` | 45 |
| const | `offeredRequests` | 47 |
| const | `isOfferedRequest` | 55 |
| const | `methodInfo` | 57 |
| const | `isSectionMethod` | 59 |

#### `packages/protocol-client/src/actions/method-args.generated.mjs` (249 lines)

| kind | symbol | line at base |
|---|---|---|
| const | `METHOD_ARGS` | 3 |

#### `packages/protocol-client/src/actions/method-args.generated.d.mts` (1 lines)

| kind | symbol | line at base |
|---|---|---|
| const | `METHOD_ARGS` | 1 |

#### `native/core/crates/mixdog-app-protocol/src/boundary/window_methods.json`

not present in mig/int at this commit (created by a later task).


### core

#### `native/core/Cargo.toml` (273 lines)

| kind | symbol | line at base |
|---|---|---|
| section | `[workspace]` | 13 |
| section | `[workspace.package]` | 73 |
| section | `[workspace.lints.rust]` | 80 |
| section | `[workspace.lints.clippy]` | 84 |
| section | `[profile.dev]` | 95 |
| section | `[profile.dev.package."*"]` | 104 |
| section | `[workspace.dependencies]` | 108 |
| section | `[patch.crates-io]` | 270 |

#### `native/core/crates/mixdog-workspace-hack/Cargo.toml` (185 lines)

| kind | symbol | line at base |
|---|---|---|
| section | `[package]` | 5 |
| section | `[dependencies]` | 17 |
| section | `[build-dependencies]` | 87 |
| section | `[target.x86_64-unknown-linux-gnu.dependencies]` | 107 |
| section | `[target.x86_64-unknown-linux-gnu.build-dependencies]` | 131 |
| section | `[target.x86_64-apple-darwin.dependencies]` | 138 |
| section | `[target.x86_64-apple-darwin.build-dependencies]` | 149 |
| section | `[target.aarch64-apple-darwin.dependencies]` | 153 |
| section | `[target.aarch64-apple-darwin.build-dependencies]` | 164 |
| section | `[target.x86_64-pc-windows-msvc.dependencies]` | 168 |
| section | `[target.x86_64-pc-windows-msvc.build-dependencies]` | 181 |

#### `native/core/crates/mixdog-app-server-daemon/Cargo.toml` (154 lines)

| kind | symbol | line at base |
|---|---|---|
| section | `[package]` | 1 |
| section | `[lints]` | 7 |
| section | `[features]` | 10 |
| section | `[dependencies]` | 15 |
| section | `[target.'cfg(unix)'.dependencies]` | 70 |
| section | `[target.'cfg(windows)'.dependencies]` | 73 |
| section | `[dev-dependencies]` | 88 |
| section | `[target.'cfg(windows)'.dev-dependencies]` | 152 |

#### `native/core/crates/mixdog-app-server-daemon/src/compose_flip.rs` (3603 lines)

| kind | symbol | line at base |
|---|---|---|
| const | `ROOM_RECOVERY_REPUBLISH` | 32 |
| struct | `Built` | 35 |
| struct | `Real` | 98 |
| type | `StopStep` | 193 |
| impl | `Real` | 195 |
| impl | `Real` | 229 |
| fn | `workers_step` | 380 |
| fn | `retirement_paths` | 391 |
| fn | `config_file` | 397 |
| fn | `real_core` | 401 |
| fn | `prompt_config_slice` | 3490 |
| fn | `tracked_secret_store` | 3502 |
| struct | `CatalogBuiltinSkills` | 3512 |
| impl | `mixdog_core_session` | 3514 |
| struct | `CatalogSessions` | 3522 |
| impl | `mixdog_workspace` | 3528 |
| mod | `tests` | 3573 |

#### `native/core/crates/mixdog-app-server-daemon/src/lib.rs` (303 lines)

| kind | symbol | line at base |
|---|---|---|
| mod | `acquired` | 13 |
| mod | `agent_lifecycle` | 14 |
| mod | `barrier` | 15 |
| mod | `boot_coordinator` | 16 |
| mod | `boot` | 17 |
| mod | `catalog` | 18 |
| mod | `channel_router` | 19 |
| mod | `compat` | 20 |
| mod | `compose` | 21 |
| mod | `compose_test_support` | 23 |
| mod | `compose_core` | 24 |
| mod | `lead_request_tests` | 26 |
| mod | `compose_mcp` | 27 |
| mod | `connection_close` | 28 |
| mod | `effort_judge_host` | 29 |
| mod | `fencing_ownership` | 30 |
| mod | `code_graph_trust` | 31 |
| mod | `worktree_cache_cleanups` | 32 |
| mod | `compose_flip` | 33 |
| mod | `replay_stores_settled` | 35 |
| mod | `feature_probes` | 36 |
| mod | `held_home_draft` | 37 |
| mod | `host_runtime_draft` | 38 |
| mod | `late_lifecycle` | 39 |
| mod | `memory_agent_watch` | 40 |
| mod | `prewarm_world` | 41 |
| mod | `setup_host` | 42 |
| mod | `warmup_schedulers_replay` | 44 |
| mod | `compose_domains` | 45 |
| mod | `late_live_route` | 46 |
| mod | `late_route_positions` | 47 |
| mod | `late_setup_actions` | 48 |
| mod | `late_agent_cells` | 49 |
| mod | `late_session` | 50 |
| mod | `late_seams` | 51 |
| mod | `late_tool_surface` | 52 |
| mod | `os_probe` | 53 |
| mod | `restart_sweep` | 54 |
| mod | `control` | 55 |
| mod | `crash_record` | 56 |
| mod | `stale_temps` | 57 |
| mod | `daemon_log` | 58 |
| mod | `desktop_defaults` | 59 |
| mod | `discovery` | 60 |
| mod | `domain_seams` | 61 |
| mod | `js_runtime` | 62 |
| mod | `event_pipeline` | 63 |
| mod | `held_requests` | 64 |
| mod | `held_runs_tests` | 66 |
| mod | `workers_stop_tests` | 68 |
| mod | `session_host_replay_tests` | 70 |
| mod | `memory_callers` | 71 |
| mod | `hook_rule_setup` | 72 |
| mod | `setup_status` | 73 |
| mod | `lifecycle` | 74 |
| mod | `mcp_surface` | 75 |
| mod | `live_view` | 76 |
| mod | `live_view_streams` | 77 |
| mod | `media` | 78 |
| mod | `exec` | 79 |
| mod | `exec_events` | 80 |
| mod | `ownership` | 81 |
| mod | `office_startup` | 82 |
| mod | `pair_code` | 83 |
| mod | `project_workspaces` | 84 |
| mod | `server` | 85 |
| mod | `serving` | 86 |
| mod | `server_ensure` | 87 |
| mod | `session_retention` | 88 |
| mod | `session_sweep` | 89 |
| mod | `shell_name` | 90 |
| mod | `signals` | 91 |
| mod | `system_proxy_claim` | 92 |
| mod | `terminal_folder_release` | 93 |
| mod | `startup` | 94 |
| mod | `stop_watch` | 95 |
| mod | `sweep_store` | 96 |
| mod | `update_installer` | 97 |
| mod | `verdict` | 98 |
| enum | `ServeError` | 101 |
| fn | `boot_executors` | 129 |
| fn | `run` | 138 |
| fn | `serve` | 152 |

#### `native/core/crates/mixdog-tools/Cargo.toml` (95 lines)

| kind | symbol | line at base |
|---|---|---|
| section | `[package]` | 1 |
| section | `[lints]` | 7 |
| section | `[features]` | 10 |
| section | `[dependencies]` | 14 |
| section | `[dev-dependencies]` | 64 |
| section | `[target.'cfg(windows)'.dependencies]` | 89 |
| section | `[target.'cfg(unix)'.dependencies]` | 94 |

#### `native/core/crates/mixdog-tools/src/desktop/mod.rs` (16 lines)

| kind | symbol | line at base |
|---|---|---|
| mod | `browser` | 4 |
| mod | `computer` | 5 |
| mod | `computer_backend` | 6 |
| mod | `computer_gnome` | 7 |
| mod | `computer_linux` | 8 |
| mod | `computer_recovery` | 9 |
| mod | `computer_screen` | 10 |
| mod | `host` | 11 |
| mod | `mail_links` | 12 |
| mod | `pending` | 13 |
| mod | `reveal` | 14 |
| mod | `terminal` | 15 |
| mod | `visualize` | 16 |

#### `native/core/crates/mixdog-core-domains/src/domains/mod.rs` (186 lines)

| kind | symbol | line at base |
|---|---|---|
| mod | `ai_account` | 16 |
| mod | `ai_admin` | 17 |
| mod | `blob` | 18 |
| mod | `client` | 19 |
| mod | `diagnostics` | 20 |
| mod | `feedback` | 21 |
| mod | `host` | 22 |
| mod | `instructions` | 23 |
| mod | `remote_access` | 24 |
| mod | `remote_push` | 25 |
| mod | `update` | 26 |
| mod | `visualize_export` | 27 |
| const | `CORE_NAMESPACES` | 33 |
| fn | `table_methods` | 45 |
| enum | `DomainsError` | 53 |
| struct | `DomainsBuilder` | 61 |
| impl | `DomainsBuilder` | 65 |
| struct | `Domains` | 104 |
| impl | `Domains` | 108 |
| mod | `tests` | 115 |

#### `native/core/crates/mixdog-core-domains/src/notify/mod.rs` (13 lines)

| kind | symbol | line at base |
|---|---|---|
| mod | `audience` | 4 |
| mod | `decision` | 5 |
| mod | `desktop_notice` | 6 |
| mod | `engine` | 7 |
| mod | `held` | 8 |
| mod | `presence` | 9 |
| mod | `preview` | 10 |
| mod | `screen` | 11 |
| mod | `service` | 12 |
| mod | `timeline` | 13 |

#### `native/core/crates/mixdog-core-domains/Cargo.toml` (99 lines)

| kind | symbol | line at base |
|---|---|---|
| section | `[package]` | 1 |
| section | `[lints]` | 7 |
| section | `[lib]` | 10 |
| section | `[dependencies]` | 13 |
| section | `[features]` | 50 |
| section | `[dev-dependencies]` | 55 |

#### `native/core/crates/mixdog-connections/Cargo.toml`

not present in mig/int at this commit (created by a later task).


### desktop

#### `apps/desktop/src/main/index.ts` (3044 lines)

| kind | symbol | line at base |
|---|---|---|
| const | `desktopProcessStartedAt` | 207 |
| const | `desktopBootId` | 226 |
| const | `desktopBootScenario` | 227 |
| const | `DESKTOP_WINDOW_SHOW_DEADLINE_MS` | 230 |
| const | `desktopWindowHeldHidden` | 233 |
| let | `launchFollowsUpdate` | 234 |
| const | `launchVersionPath` | 235 |
| const | `launchRecordWriteFailure` | 236 |
| const | `paneLayoutFileFailure` | 241 |
| const | `PACKAGED_USER_DATA_DIRECTORY` | 256 |
| const | `desktopBrand` | 274 |
| const | `desktopUserData` | 275 |
| let | `crashReporterStatus` | 284 |
| let | `crashReporterErrorName` | 285 |
| let | `stopCrashHandlerWatch` | 308 |
| function | `startCrashHandlerWatch` | 309 |
| const | `gpuFallbackEnvironment` | 369 |
| const | `gpuFallbackMarker` | 374 |
| const | `softwareRenderingThisLaunch` | 375 |
| const | `configuredRendererHeapMb` | 400 |
| const | `rendererHeapMb` | 401 |
| const | `acceptanceDebugPort` | 416 |
| let | `diagnostics` | 473 |
| const | `bootTimeline` | 474 |
| const | `writeBootDiagnostic` | 475 |
| let | `loginShellEnvironmentReady` | 477 |
| function | `adoptLoginShellEnvironment` | 480 |
| const | `portForwardStore` | 508 |
| function | `runWithHostSettings` | 511 |
| const | `connectionDependencies` | 515 |
| const | `connectionPool` | 615 |
| const | `windowRoutes` | 617 |
| const | `ipcRouter` | 618 |
| const | `localConnection` | 622 |
| const | `localService` | 631 |
| const | `ENV_SSH_CONNECTION_ID` | 634 |
| const | `envSshConfig` | 635 |
| const | `connectionWindows` | 636 |
| const | `withGrace` | 637 |
| const | `sshConnections` | 638 |
| const | `serverWindowRestore` | 677 |
| const | `serverNotifiers` | 692 |
| let | `daemonServiceStartedAt` | 696 |
| let | `daemonServiceBootReported` | 697 |
| function | `reportDaemonServiceStart` | 698 |
| function | `startDaemonService` | 705 |
| const | `settingsStore` | 729 |
| let | `mainWindow` | 730 |
| let | `browserHost` | 731 |
| let | `desktopPet` | 733 |
| let | `browserHostDisposal` | 734 |
| let | `browserControlEnabled` | 737 |
| let | `browserAutoSignIn` | 739 |
| let | `browserHidDevices` | 741 |
| let | `browserPermissionPolicy` | 743 |
| let | `computerHost` | 744 |
| let | `computerUseOverlay` | 745 |
| let | `computerControlEnabled` | 746 |
| let | `computerControlApplied` | 748 |
| let | `computerObserveOnly` | 751 |
| const | `windowIpcDisposers` | 753 |
| const | `userInputReporters` | 756 |
| let | `primaryWindowStarted` | 757 |
| const | `primaryActivation` | 758 |
| function | `activatePrimaryWindow` | 770 |
| const | `liveNotifications` | 775 |
| const | `requestTerminalRun` | 783 |
| const | `terminalRuns` | 792 |
| const | `TERMINAL_CLAIM_GRACE_MS` | 795 |
| const | `terminalBridge` | 796 |
| let | `browserFeatureInstalled` | 810 |
| let | `hostRoleReady` | 811 |
| const | `reportVisualizePublishFailure` | 813 |
| const | `visualize` | 819 |
| const | `visualizeBridge` | 842 |
| let | `localPageFrameOrigin` | 848 |
| const | `awakeService` | 856 |
| let | `turnAttention` | 857 |
| let | `unsubscribeAwake` | 858 |
| let | `unsubscribeServiceSettings` | 859 |
| let | `unsubscribeTakeovers` | 860 |
| let | `unsubscribeUpdaterRelay` | 861 |
| const | `pcNotificationView` | 866 |
| let | `notificationVolume` | 867 |
| const | `playNotificationSound` | 868 |
| const | `nativeSessionTitleLabels` | 885 |
| const | `turnNotifier` | 886 |
| let | `latestSessions` | 919 |
| let | `latestAgentPool` | 921 |
| const | `approvalSources` | 922 |
| const | `notificationConversation` | 924 |
| const | `showTestNotification` | 927 |
| const | `browserApprovalGrants` | 942 |
| let | `unsubscribeTurnNotifier` | 992 |
| function | `createServerWindowNotifier` | 996 |
| const | `applyDesktopSettings` | 1035 |
| function | `applyComputerControlSetting` | 1052 |
| function | `applyComputerObserveOnlySetting` | 1073 |
| const | `browserLogin` | 1086 |
| const | `takeoverCapture` | 1102 |
| const | `onTakeoverState` | 1111 |
| const | `localProtocol` | 1155 |
| const | `hostRole` | 1157 |
| const | `sendToMainWindow` | 1233 |
| let | `quitAfterDispose` | 1255 |
| let | `runInBackground` | 1257 |
| let | `quitApproved` | 1260 |
| let | `desktopTray` | 1261 |
| const | `backgroundWindow` | 1262 |
| function | `trayIconPath` | 1267 |
| function | `syncDesktopTray` | 1278 |
| let | `disposalPromise` | 1290 |
| const | `DESKTOP_DISPOSE_TIMEOUT_MS` | 1291 |
| const | `windowStates` | 1294 |
| let | `windowStateFlush` | 1295 |
| let | `diagnosticsMemoryTimer` | 1296 |
| let | `idleReclaim` | 1297 |
| let | `diagnosticsEventLoopTimer` | 1298 |
| let | `deferredServicesPromise` | 1299 |
| let | `deferredServicesScheduled` | 1300 |
| let | `gpuCrashTimes` | 1301 |
| let | `gpuFallbackScheduled` | 1302 |
| let | `gpuFallbackPromptOpen` | 1303 |
| function | `currentProcessMemory` | 1305 |
| function | `rendererWorkingSetKb` | 1325 |
| function | `currentSystemMemory` | 1336 |
| const | `RENDERER_RECLAIM_SETTLE_MS` | 1348 |
| const | `DIAGNOSTICS_EVENT_LOOP_INTERVAL_MS` | 1350 |
| const | `DIAGNOSTICS_EVENT_LOOP_LAG_MS` | 1351 |
| function | `startDiagnosticsEventLoopMonitor` | 1353 |
| function | `installDesktopMenu` | 1368 |
| function | `startDeferredDesktopServices` | 1384 |
| function | `remoteAccessInfo` | 1407 |
| function | `rotateRemoteAccess` | 1413 |
| let | `sharedSecureDesktopInstaller` | 1421 |
| function | `secureDesktopInstaller` | 1422 |
| const | `accountIsAdmin` | 1434 |
| let | `pcAccess` | 1438 |
| function | `windowsPcAccess` | 1439 |
| function | `revokeRemoteAccessClient` | 1455 |
| function | `showLocalConnectionSettings` | 1464 |
| let | `remoteHostWindows` | 1471 |
| function | `remoteHostsHandle` | 1472 |
| function | `scheduleDeferredDesktopServices` | 1501 |
| function | `disposeDesktopResources` | 1533 |
| let | `localCoreProcess` | 1614 |
| const | `quitSequence` | 1618 |
| function | `handleGpuChildCrash` | 1645 |
| function | `configuredDevelopmentUrl` | 1713 |
| function | `resolveRendererTarget` | 1728 |
| function | `createMainBrowserWindow` | 1767 |
| function | `connectionStorageKey` | 1806 |
| function | `connectionWindowStatePath` | 1810 |
| function | `connectionPaneLayoutFile` | 1819 |
| function | `connectionPartition` | 1832 |
| let | `rendererBootScriptHash` | 1837 |
| const | `policedRendererSessions` | 1838 |
| function | `installRendererSessionPolicy` | 1842 |
| function | `rendererDiagnosticListener` | 1895 |
| function | `installRendererConsoleErrorTail` | 1928 |
| function | `installRendererCrashRecovery` | 1964 |
| function | `installNavigationGuards` | 2008 |
| function | `createWindowPresentation` | 2025 |
| function | `createDesktopPetController` | 2131 |
| function | `windowsRemoteScreens` | 2216 |
| function | `reclaimRendererMemory` | 2244 |
| function | `installLocalWindowFeatures` | 2263 |
| const | `showConnectionWindow` | 2422 |
| function | `createWindow` | 2435 |
| function | `installWindowIpc` | 2577 |
| function | `installRendererLoadDiagnostics` | 2641 |
| function | `installWindowCloseCleanup` | 2679 |
| function | `startDesktopDiagnostics` | 2713 |
| function | `subscribeSessionLanes` | 2752 |
| function | `watchPowerAndNetwork` | 2783 |
| function | `registerLocalSshHostIpc` | 2821 |

#### `apps/desktop/src/main/ipc.ts` (497 lines)

| kind | symbol | line at base |
|---|---|---|
| interface | `DesktopIpcMain` | 59 |
| type | `IpcHandle` | 67 |
| const | `SERVICE_OPERATION_NAMES` | 69 |
| interface | `DesktopIpcDependencies` | 135 |
| function | `registerDesktopIpc` | 219 |

#### `apps/desktop/src/main/host/index.ts` (106 lines)

| kind | symbol | line at base |
|---|---|---|
| interface | `DesktopHostOptions` | 20 |
| function | `createDesktopHost` | 48 |

#### `apps/desktop/src/main/host/connection.ts` (80 lines)

| kind | symbol | line at base |
|---|---|---|
| const | `HOST_METHOD` | 8 |
| interface | `HostConnection` | 25 |
| class | `HostRpcError` | 39 |
| const | `HOST_COMMAND_FAILED` | 51 |
| const | `HOST_INVALID_PARAMS` | 53 |
| const | `HOST_CAPABILITIES` | 56 |
| type | `WireFields` | 72 |
| function | `objectParams` | 75 |

#### `apps/desktop/src/preload/index.ts` (807 lines)

| kind | symbol | line at base |
|---|---|---|
| function | `invokeIpc` | 29 |
| function | `additionalArgument` | 37 |
| const | `bootId` | 42 |
| const | `processStartedAt` | 43 |
| const | `bootScenario` | 44 |
| const | `afterUpdate` | 45 |
| function | `bootContextValue` | 47 |
| const | `bootContext` | 56 |
| function | `connectionValue` | 59 |
| const | `connection` | 71 |
| const | `STATE_WIRE_CONTROL_KEYS` | 74 |
| function | `streamingTailFrom` | 83 |
| function | `subscribeIpc` | 88 |
| const | `notificationOpenSessions` | 98 |
| const | `heldNotices` | 104 |
| const | `noticeListeners` | 105 |
| const | `api` | 113 |

#### `apps/desktop/src/shared/contract-ipc.ts` (350 lines)

| kind | symbol | line at base |
|---|---|---|
| const | `DESKTOP_IPC` | 3 |

#### `apps/desktop/src/shared/contract.ts` (1236 lines)

| kind | symbol | line at base |
|---|---|---|
| interface | `DesktopShellStopResult` | 204 |
| interface | `DesktopAgentMemoryEntry` | 213 |
| interface | `DesktopApi` | 221 |

#### `apps/desktop/src/renderer/main.tsx` (82 lines)

| kind | symbol | line at base |
|---|---|---|
| const | `remoteBrowser` | 17 |
| const | `remoteShimReady` | 22 |
| let | `launchApplication` | 23 |

#### `apps/desktop/src/main/ipc-state-bridge.ts` (341 lines)

| kind | symbol | line at base |
|---|---|---|
| interface | `DesktopUpdater` | 27 |
| interface | `DesktopStateBridgeOptions` | 34 |
| type | `SessionProvenance` | 43 |
| const | `REQUESTED_READ_FRAME_GRACE_MS` | 48 |
| const | `SESSION_RECOVERY_COALESCE_MS` | 50 |
| class | `DesktopStateBridge` | 52 |

