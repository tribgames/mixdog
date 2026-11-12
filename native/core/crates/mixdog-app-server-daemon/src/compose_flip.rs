//! DRAFT, not filed: the real core `compose()` builds in place of `MockCore` (the "flip").
//!
//! Every part that exists in the tree (HEAD `ad3aefe06`) or in a filed request is called with the
//! signature read from its source. Every part with no implementation is a `compile_error!` that
//! names its owner and the `compose-seams.md` row, so the flip cannot build until each lands.
//! `MINE` marks work that is wp-run-host's own (an ordering cycle through the late directory,
//! or a constructor argument list still to be filled); `OWNER <wp>` marks another owner's row.
//! The remaining list, with status, is `flip-brief.md` ("Flip draft: remaining parts").
//!
//! Order matters: the session directory is built last (`TurnPath::new`) but many earlier parts
//! need it, so they read it through [`LateDirectory`] and it is bound once at the end.

use std::sync::Arc;
use mixdog_rt::LaneToken;

use mixdog_core::run_host::compose_parts::{
    self, ConfigHostsIn, EarlyIn, LateDirectory, LateHeaders, LateThreads, Owed, ReadyIn, early_rows, pending_rows, ready_rows,
    secret_input, turn_path_parts,
};
use mixdog_core::run_host::process::{ProcessInputs, ProcessServices};
use mixdog_core::run_host::turn_path::TurnPath;
use mixdog_core_base::state::StateRuntime;
use mixdog_core_config::config::{Config, ConfigLanes};

use crate::compose::{ComposeError, Models};
use crate::compose_core::{McpParts, PolicyParts, build_mcp, build_policy};
use crate::compose_domains::{DomainInputs, DomainPaths, DomainSeams, OpScopeSource, PluginSeams, PostSeams, build_local_provider, compose_domains_post, compose_domains_pre};
use crate::compose_mcp::{AgentSeams, McpInputs, SetupSeams, build_agents, mcp_services};

/// How long the start-up's catalog republish after the rooms' first load may take: every room mutation that awaited that load waits
/// for it (`ready::recover`), so it is bounded (Node's `republishCatalog` only starts its listing, `session-host.ts:353-356`).
const ROOM_RECOVERY_REPUBLISH: std::time::Duration = std::time::Duration::from_secs(60);

/// What `compose()` has built before the real core starts.
pub struct Built {
    /// What `real_core` registers a release for as it acquires it; `compose` runs them if `real_core` fails.
    pub acquired: Arc<crate::acquired::Acquired>,
    pub tokens: mixdog_rt::LaneTokens,
    pub data_dir: std::path::PathBuf,
    pub user_data_dir: std::path::PathBuf,
    /// `ComposeConfig::runtime_root`.
    pub runtime_root: std::path::PathBuf,
    pub package_root: std::path::PathBuf,
    pub js_runtime: crate::compose::JsRuntime,
    #[cfg(test)]
    pub pg_install: Option<mixdog_services::memory::boot::PgInstall>,
    pub env: mixdog_core::run_host::run_seams::EnvReader,
    pub app_feed: Arc<mixdog_core_base::feed::CoreFeed>,
    pub scoped_feeds: Arc<dyn mixdog_core_api::feed::ScopedFeeds>,
    pub host: Arc<dyn mixdog_core_api::HostChannel>,
    /// The same desktop channel with the claim query the secret fill asks (Outgoing is both): the fill's channel.
    pub claimed_host: Arc<dyn mixdog_core_api::ClaimedHostChannel>,
    /// The connection table's desktop presence (`Outgoing` again): the terminal tool's `ui/openRequested` feed.
    pub presence: Arc<dyn mixdog_core_api::DesktopPresence>,
    /// The same connection table as the approval presence (Outgoing again): LateApprovalSurfaces asks it who is attached to a thread.
    pub approval_presence: Arc<dyn mixdog_core_api::ApprovalPresence>,
    /// The connection table once more (`Outgoing`): the model-proxy client generation `HostProxyProviders` waits on.
    pub client_epoch: Arc<dyn mixdog_core_api::ClientEpoch>,
    /// The connection table again (`Outgoing`): `ModelProxyService` sends `modelProxy/run/event` to the asking connection through it.
    pub notifier: Arc<dyn mixdog_core_api::ConnectionNotifier>,
    /// The host media router: the live view binds its streams' targets here.
    pub host_media: Arc<mixdog_app_server::HostMedia>,
    pub server_requests: Arc<dyn mixdog_core_api::ServerRequestSink>,
    pub ext_host: Arc<mixdog_exthost::ExtHostPool>,
    pub process_manager: Arc<dyn mixdog_core_api::domain::process::ProcessManager>,
    /// The concrete manager `process_manager` wraps (`LocalProcessManager` is `Clone`): `ProcessFeeds`, `ProcessService` and `TerminalService` take it by value.
    pub local_processes: mixdog_spawn::LocalProcessManager,
    pub tidy_processes: mixdog_services::tidy::process::Processes,
    pub models: Models,
    pub catalog: Arc<mixdog_ai::catalog::CatalogService>,
    /// The catalog warm-up loop: the busy probe is bound here and the sessions' busy-state changes wake it.
    pub catalog_warmup: Arc<crate::catalog::CatalogWarmup>,
    pub exec: Arc<mixdog_tools::exec::ExecRuntime>,
    pub shell_control: Arc<mixdog_tools::exec::ShellControl>,
    pub files: Arc<dyn mixdog_core_api::domain::fs::FileService>,
    pub gates: Vec<(&'static str, mixdog_core_base::ops::OpGate)>,
    pub cancel: tokio_util::sync::CancellationToken,
    /// The one daemon log `serve()` built at startup (run-host-24): the resume timer and every other writer share it.
    pub log: crate::daemon_log::DaemonLog,
    /// The exec runtime's own wake hub and shell setting (`Exec.wakes`, `Exec.configured_shell`, built once in `build_exec`).
    pub wakes: Arc<mixdog_tools::exec::WakeHub>,
    pub configured_shell: Arc<crate::domain_seams::settings_effects::ConfiguredShell>,
    /// `state/core.sqlite` as `compose()` opened it: the approval-id counter reserves its blocks in it.
    pub core_state: mixdog_store::state::CoreState,
    /// The data-dir lock (`Started.ownership`): every log writer revalidates it before it writes.
    pub ownership: Arc<dyn mixdog_core_api::domain::ownership::Ownership>,
    /// The late `ThreadOpGates` cell (wp-session-28): `compose()` builds it first and gives it to `CoreOpIndex::new(gates, thread_gates)`; the
    /// op-scope source takes the same one; bound once to `directory.thread_ops()` below.
    pub thread_gates: Arc<crate::late_seams::LateThreadGates>,
    /// `ComposedCore::sections()`: the app feed's one section state (run-host-27); `serving::start` takes the same.
    pub sections: Arc<mixdog_core_base::state::SectionFeedState>,
}

/// The pieces `ComposedCore` keeps from the real core.
///
/// `compose()` registers `core.on_stop("session directory shutdown", real.session_shutdown_step(core.stop_reason()))` first among the stop steps: Node's
/// `sessionService.stop` (daemon.mjs, right after the heartbeat) closes every runtime, and each close begins with `setCloseRequested(true)`.
pub struct Real {
    /// How this start's desktop defaults separation ended; the server's `initialize` reply carries it to the desktop.
    pub defaults_separation: mixdog_app_protocol::v1::DefaultsSeparation,
    /// The control route's follow of the config (`RouteService::follow_config`), kept for the core's life: dropping it ends the follow.
    pub control_route_sync: mixdog_core_config::config::AdoptionGuard,
    /// The cell `compose()` puts into `ComposedCore` as its `lifecycle` (flip-caller-1): `serving::start` binds the built `Lifecycle` into it.
    pub late_lifecycle: Arc<crate::late_lifecycle::LateLifecycle>,
    /// The five owners of per-connection state, bound by `real_core` and read by `CoreHandle::connection_closed` through `ComposedCore::connection_owners()`.
    pub connection_owners: crate::connection_close::ConnectionOwnersCell,
    /// The dialer for a phone served by this core: `serving::start` binds it once the connection hub exists (it is verified there, before the listener accepts).
    pub local_dialer: Arc<crate::domain_seams::remote::LateDialer>,
    /// The remote access runtime and the one device registry: `serving::attach` opens the relay with them, and `CoreHandle::connection_opened` records local clients in the registry.
    pub remote: crate::domain_seams::remote::BuiltRemote,
    /// Ends the idle-time maintenance schedule (cancelled by the first stop step; awaiting `maintenance_loop` is the end of the schedule).
    pub maintenance_stop: tokio_util::sync::CancellationToken,
    /// Taken once by the stop step: awaiting it is the end of the schedule (it admits no further task after the cancel and ends the in-flight tick within its grace).
    pub maintenance_loop: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// The `worktree-cleanup` registration, kept for the schedule's life.
    pub worktree_task: mixdog_core_base::maintenance::TaskRegistration,
    /// Cancelled by the first stop step, BEFORE the directory shuts down: the worktree maintenance (startup reconcile, hourly cleanup) reads the directory.
    pub worktree_stop: tokio_util::sync::CancellationToken,
    /// The quota resume timer: `start()` at the boot step, `stop()` on the session-service stop path.
    pub resume_timer: Arc<mixdog_core_session::session::quota_resume_scheduler::QuotaResumeScheduler>,
    /// Goal recovery's source, for the boot coordinator (`recoverActiveGoals`, `daemon.mjs:1131`).
    pub goal_recovery: Arc<mixdog_core_session::session::goal_recovery_host::SessionGoalRecovery>,
    /// Node's `closeRequested`: cancelled when the directory's shutdown step starts (see `session_shutdown_step`).
    pub close_requested: tokio_util::sync::CancellationToken,
    pub directory: Arc<mixdog_core_session::session::SessionDirectory>,
    /// The `cycle1-agent` / hidden-role dispatch and its provider host: aborted, then closed, by the first stop step.
    pub agent_dispatch: Arc<mixdog_core::run_host::agent_dispatch::InlineAgentDispatch>,
    pub agent_host: Arc<mixdog_core::run_host::agent_world::AgentHost>,
    /// Written out by the first stop step after the directory shut down (`GraphCache::drain`).
    pub code_graph_cache: Arc<mixdog_tools::code_graph::GraphCache>,
    /// The shell registry; the first stop step removes its shell snapshots after the directory shut down.
    pub exec: Arc<mixdog_tools::exec::ExecRuntime>,
    pub maintenance_io: mixdog_rt::MaintenanceIo,
    pub domains: mixdog_core_domains::domains::Domains,
    pub config: Config,
    /// The runtimes `runtime_stop_steps` stops, in the order of Node's shutdown (daemon.mjs:272).
    pub ledgers: Arc<mixdog_core::run_host::ledger_source::LedgerSource>,
    pub computer: Option<Arc<mixdog_core::run_host::native_tools::ComputerSessionPool>>,
    pub terminal: Arc<mixdog_spawn::service::TerminalService>,
    /// The core's entry in the room host registry; ending it detaches the room host (`unregisterAgentRoomHost`).
    pub room_host: mixdog_core_rooms::rooms::room_hosts::Registration,
    pub channels: Arc<mixdog_services::channels::runtime::ChannelRuntime>,
    /// The `channel/call` dispatch: it holds the remote-control binding the boot restores.
    pub channel_calls: Arc<mixdog_services::channels::CallDispatch>,
    /// The channels' config hot reload, for the core's life.
    pub channel_config_follow: mixdog_core_config::config::ChannelConfigFollow,
    pub memory: Arc<mixdog_services::memory::boot::MemoryStack>,
    pub log: crate::daemon_log::DaemonLog,
    /// What the exec event consumers publish into (`exec_events::consume`).
    pub publisher: Arc<dyn mixdog_core_api::state::StatePublisher>,
    /// `gatewaySessionRoutesSettled`'s store, drained by `runtime_stop_steps`.
    pub gateway_routes: mixdog_core_session::session::gateway_routes::GatewaySessionRoutes,
    /// The model proxy's PC end: `close_step` aborts its relayed calls first of all.
    pub model_proxy: Arc<mixdog_core_domains::domains::ai_admin::model_proxy_service::ModelProxyService>,
    /// The webhook event pipeline: `serve` runs it once startup has finished (`EventPipeline::run` takes the proof).
    pub event_pipeline: Arc<crate::event_pipeline::EventPipeline>,
    /// The session index the idle sweep lists (CatalogSweepRows) and the heartbeat's catalog reads.
    pub catalog_index: Arc<mixdog_store::sqlite::SqliteStore>,
    /// `state/core.sqlite`, closed with the index by [`Real::close_data_files`].
    pub core_state: mixdog_store::state::CoreState,
    /// `MIXDOG_DAEMON_SKIP_MEMORY=1` (daemon.mjs `registerMemoryRuntimeLazy`): no memory runtime in this process, so nothing starts PostgreSQL.
    pub skip_memory: bool,
    /// Mixy's heartbeat, built here; start_heartbeat puts it on its timers once startup has finished.
    pub heartbeat: Arc<mixdog_services::bots::beat::Heartbeat>,
    /// The running timers, set by start_heartbeat; the stop steps read it (Node's stopHeartbeat?.() is null-safe: a stop before the start stops nothing).
    pub heartbeat_run: Arc<std::sync::OnceLock<mixdog_services::bots::beat::RunningHeartbeat>>,
    /// The sub-agent retention cycle, set by `start_sub_agent_retention`; the stop step takes and ends it.
    pub sub_agent_retention: Arc<std::sync::Mutex<Option<crate::session_retention::Running>>>,
    /// The core's one archive stamp counter (`ThreadSettingsParts::archive_stamps`): the retention cycle's automatic archive takes its stamps too.
    pub archive_stamps: Arc<mixdog_core_session::session::thread_settings::ArchiveStamps>,
    /// The writer of `<data>/gateway-usage.local.jsonl`, the sessions' too.
    pub gateway_usage: mixdog_core_session::session::gateway_usage::GatewayUsage,
    /// Replay-only: the write-behind writers `replay/storesSettled` drains besides the session store.
    #[cfg(feature = "replay-controls")]
    pub(crate) replay_writers: crate::replay_stores_settled::WriteBehind,
    /// The core's turn review and the tool pool its sessions run, as composed (the review is what the tools in the pool are wired to). Kept for
    /// the replay of Node's review recording against the composition (compose::review_restart_tests); a release core does not carry them.
    #[cfg(test)]
    pub turn_review: Arc<mixdog_core_review::turn_review::TurnReview>,
    #[cfg(test)]
    pub tool_pool: Vec<Arc<dyn mixdog_core_api::domain::tool::Tool>>,
}

/// A named stop step.
pub type StopStep = (&'static str, std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>);

impl Real {
    /// The first stop step: closing is requested (the warm-up timers and the other `isCloseRequested` readers stop at once), then every
    /// loaded thread stops (`SessionDirectory::shutdown`, Node `teardown.mjs:192`).
    pub fn session_shutdown_step(&self, reason: Arc<crate::compose::StopReasonCell>) -> impl std::future::Future<Output = ()> + Send + 'static {
        let (closing, worktrees, maintenance, directory) = (self.close_requested.clone(), self.worktree_stop.clone(), self.maintenance_stop.clone(), self.directory.clone());
        let (dispatch, host) = (self.agent_dispatch.clone(), self.agent_host.clone());
        let (graph_cache, maintenance_io) = (self.code_graph_cache.clone(), self.maintenance_io);
        let exec = self.exec.clone();
        let schedule_end = self.maintenance_loop.lock().unwrap_or_else(|e| e.into_inner()).take();
        async move {
            closing.cancel();
            worktrees.cancel(); // the maintenance stops before the directory it reads is shut down
            maintenance.cancel();
            // The schedule ends before the directory shuts down: a running cleanup tick reads the directory.
            if let Some(schedule_end) = schedule_end {
                let _ = schedule_end.await;
            }
            // The hidden-role runs end while the sessions they run on still exist, then their provider connections close.
            // Node aborts each run with the daemon's stop reason: `agent-dispatch.mjs:60` `abortAll(reason)` is `controller.abort(new Error(reason))`, and `reason` is
            // `daemon.mjs:272` `shutdown(reason)` (via `:316` `sessionRuntimeHost.close(reason)`). The release states it before its first step (run-host-42:
            // `CorePort::release_started` -> `ComposedCore::set_stop_reason`): a signal's name, or `ReleaseCause::node_text()`.
            let reason = reason.get().expect("the release states the stop reason before its first step (ComposedCore::set_stop_reason)");
            dispatch.abort_all(reason);
            host.close();
            // `shutdown_for(reason)` (flip-agent-worlds-11): only a process-exit reason closes every session's agents first (`teardown.mjs:226-237`).
            directory.shutdown_for(reason).await;
            if let Err(error) = graph_cache.drain(maintenance_io, &tokio_util::sync::CancellationToken::new()).await {
                tracing::warn!(%error, "[code_graph] the cache could not be written at stop");
            }
            // Node's `process.once('exit', drainShellSnapshots)` (shell-snapshot.mjs): the sessions' shells are gone, so the snapshots they sourced go too.
            exec.drain_snapshots(&tokio_util::sync::CancellationToken::new()).await;
        }
    }
}
impl Real {
    /// After ready: a data directory that already holds a PostgreSQL cluster starts it off the request path (Node's `startPostgresInBackground`).
    pub fn open_memory_in_background(&self) {
        if self.skip_memory {
            self.log.log("memory runtime skipped (MIXDOG_DAEMON_SKIP_MEMORY=1)");
            return;
        }
        self.memory.open_in_background();
    }

    /// After ready (daemon.mjs:1284-1293): the session a manual Remote ON pinned before the last stop is bound again, off the boot path.
    pub fn restore_remote_intent(&self) {
        let (calls, log) = (self.channel_calls.clone(), self.log.clone());
        if calls.pinned_session().is_none() {
            return;
        }
        mixdog_rt::spawn("remote-intent-restore", mixdog_rt::TaskClass::Work, async move {
            if !calls.restore_intent().await {
                log.log("remote intent restore declined (session unavailable)");
            }
        });
    }

    /// Closes `state/core.sqlite` and `index/store.sqlite` after the stop steps, so a core composed on a folder the process
    /// removes while it lives on (the exec's private root) leaves no file open in it. Blocks until both writers are done.
    pub fn close_data_files(&self) {
        self.catalog_index.close();
        self.core_state.close();
    }

    /// Mixy's heartbeat on its timers (daemon.mjs:1212, `startMixyHeartbeat`: first check after `FIRST_TICK`, then every `TICK`). Idempotent: a second call starts nothing.
    pub fn start_heartbeat(&self) {
        self.heartbeat_run.get_or_init(|| mixdog_services::bots::beat::start_mixy_heartbeat(self.heartbeat.clone(), mixdog_services::bots::beat::FIRST_TICK, mixdog_services::bots::beat::TICK));
    }

    /// The sub-agent retention cycle (`_retainSubAgents` of the idle cleanup): first pass an interval after the start. Idempotent.
    pub fn start_sub_agent_retention(&self) {
        let mut running = self.sub_agent_retention.lock().unwrap_or_else(|e| e.into_inner());
        if running.is_none() {
            let host = Arc::new(mixdog_core_session::session::sub_agent_retention::DirectoryRetention::new(self.directory.clone(), self.catalog_index.clone(), self.archive_stamps.clone()));
            *running = Some(crate::session_retention::start(host, Arc::new(mixdog_core_session::session::sub_agent_retention::now_ms)));
        }
    }

    /// Cancels the retention cycle and awaits it, before the directory it works through shuts down. A stop before the start ends nothing.
    pub fn sub_agent_retention_step(&self) -> StopStep {
        let running = self.sub_agent_retention.clone();
        ("sub-agent retention", Box::pin(async move {
            let taken = running.lock().unwrap_or_else(|e| e.into_inner()).take();
            if let Some(cycle) = taken {
                cycle.end().await;
            }
        }))
    }

    /// The idle sweep's store (session/manager/idle-cleanup.mjs): rows from the session index, closes through the directory; `stop` is its shutdown.
    pub fn sweep_store(&self, data_dir: &std::path::Path, stop: tokio_util::sync::CancellationToken) -> Arc<crate::sweep_store::DirectorySweepStore> {
        let rows = Arc::new(crate::sweep_store::CatalogSweepRows::new(self.catalog_index.clone(), data_dir.join("sessions")));
        Arc::new(crate::sweep_store::DirectorySweepStore::new(rows, self.directory.clone(), stop))
    }

    /// The very first stop step (daemon.mjs:285, `stopHeartbeat?.()`): the timers are cleared at once and no check begins after it.
    pub fn heartbeat_halt_step(&self) -> StopStep {
        let run = self.heartbeat_run.clone();
        ("heartbeat timers", Box::pin(async move { if let Some(running) = run.get() { running.halt(); } }))
    }

    /// wait heartbeatEnded (daemon.mjs:312): the check that was running ends after the model proxy closed, before the session service stops. `flushHeartbeatState` needs no step: `HeartbeatStore::update` awaits its write in its caller.
    pub fn heartbeat_ended_step(&self) -> StopStep {
        let run = self.heartbeat_run.clone();
        ("heartbeat check", Box::pin(async move { if let Some(running) = run.get() { running.ended().await; } }))
    }

    /// The first stop step (`daemon.mjs:302`): `modelProxyBridge.close`, before the session service stops, so the relayed calls settle while what they depend on exists.
    /// Node ends the heartbeat's timers just before it (heartbeat_halt_step).
    pub fn close_step(&self) -> StopStep {
        let proxy = self.model_proxy.clone();
        ("model proxy", Box::pin(async move { proxy.close().await }))
    }

    /// The stop steps after the directory's, in the order of Node's `shutdown(reason)` (`daemon.mjs:272`); each failure is logged as Node logs it and the next step runs.
    /// - the durable-write drain (`:339`, `drainProcessWrites`): the usage ledger's queued rows land, then its writers are released (`closeUsageLedgers`);
    /// - `gatewaySessionRoutesSettled` (`:345`), the statusline route changes queued by the closed sessions;
    /// - `releaseAllComputerSessions` (`:356`);
    /// - the room host: Node's desktop service unregisters its room host when it ends (`desktop-service.ts:792`); here the core's registration ends, so a relay refuses with Node's text;
    /// - the terminals: Node's desktop host disposes its terminal manager when it ends (`desktop-operations.ts:681` `terminals.disposeAll`); here the core owns the tabs;
    /// - `channels.stop` (`:370`), which stops the scheduler and the channel services;
    /// - `memoryRuntime.stop` (`:377`), whose PostgreSQL stop follows its last user (`pgStop.finish()`, `:383`);
    /// - the voice installer's held locks, the last step of the stop.
    /// The hook bus has no stop in Node or here: it owns no task, timer or connection between calls. The MCP servers are not closed by Node's shutdown either
    /// (`disconnectAll` has no caller on that path); they end with the process.
    pub fn runtime_stop_steps(&self, reason: Arc<crate::compose::StopReasonCell>) -> Vec<StopStep> {
        let (ledgers, log) = (self.ledgers.clone(), self.log.clone());
        let drain: StopStep = ("usage ledger", Box::pin(async move {
            if let Some(open) = ledgers.if_open() {
                if let Err(error) = open.writer.settle_writes().await {
                    log.log(&format!("durable write drain failed: {error}"));
                }
            }
            ledgers.close_all();
        }));
        let routes = self.gateway_routes.clone();
        let gateway: StopStep = ("gateway routes", Box::pin(async move { routes.settled().await }));
        let computer = self.computer.clone();
        let computers: StopStep = ("computer sessions", Box::pin(async move {
            if let Some(pool) = computer {
                pool.release_all().await;
            }
        }));
        let room_host = self.room_host.clone();
        let detach: StopStep = ("room host", Box::pin(async move { room_host.unregister() }));
        let terminal = self.terminal.clone();
        let terminals: StopStep = ("terminals", Box::pin(async move { terminal.tabs().dispose_all() }));
        let (channels, log) = (self.channels.clone(), self.log.clone());
        let channel_step: StopStep = ("channels", Box::pin(async move {
            let reason = reason.get().expect("the release states the stop reason before its first step (ComposedCore::set_stop_reason)");
            // A deferred automation start (save or boot) ends and is joined first, so it cannot start services after the teardown.
            channels.shutdown_scheduled_start().await;
            if let Err(error) = mixdog_services::channels::tools::ChannelLifecycle::stop_owned_runtime(&*channels, reason).await {
                log.log(&format!("channels.stop failed: {error}"));
            }
        }));
        let memory = self.memory.clone();
        let memory_step: StopStep = ("memory", Box::pin(async move { memory.stop_for_quit().await }));
        let (lane, log) = (self.maintenance_io, self.log.clone());
        let voice: StopStep = ("voice installer locks", Box::pin(async move {
            // The release removes lock files: a blocking call, so a lane job.
            let job = lane.submit(&tokio_util::sync::CancellationToken::new(), |_| mixdog_services::voice::release_held_locks());
            match job {
                Ok(job) => {
                    if let Err(error) = job.await {
                        log.log(&format!("voice installer lock release failed: {error}"));
                    }
                }
                Err(_) => log.log("voice installer lock release failed: the maintenance lane is full"),
            }
        }));
        // `settleGatewayUsageWrites` (the teardown's `settlePersistence`): the buffered gateway usage events land and their
        // compaction runs. The process's `exit` hook (`flushGatewayUsageEventsSync`) is not a stop step: a stuck step skips the
        // steps, so `compose::flush_at_exit` writes what was recorded since on every release path.
        let usage = self.gateway_usage.clone();
        let settle: StopStep = ("gateway usage", Box::pin(async move { usage.settle().await }));
        vec![settle, drain, gateway, computers, detach, terminals, channel_step, memory_step, voice]
    }
}

/// Where the boot retirement reads the shipped files (`defaults/shipped-history.json`, skills, agents, ...): the one root every reader of
/// the shipped files uses, `MIXDOG_ROOT` or else `<package>/src`. A packaged desktop sets `MIXDOG_ROOT` to the unpacked tree, as the
/// archive itself cannot be read as files.
pub(crate) fn retirement_paths(package_root: &std::path::Path, data_dir: &std::path::Path, env: &dyn Fn(&str) -> Option<std::ffi::OsString>) -> mixdog_core_config::workflow::WorkflowPaths {
    mixdog_core_config::workflow::WorkflowPaths { root: mixdog_store::paths::Paths::plugin_root_of(package_root, env), data: data_dir.to_path_buf() }
}

/// The configuration file of the data directory the core is composed over (`configPath()` of `shared/config.mjs`, which reads
/// `MIXDOG_DATA_DIR` when it is called: the core's data directory is the one it was started with).
pub(crate) fn config_file(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join(mixdog_core_config::user_data::CONFIG_FILE)
}

pub async fn real_core(b: Built) -> Result<Real, ComposeError> {
    // ---- 1. state, config ---------------------------------------------------------------------
    // The app feed has ONE section state: the composed one (`ComposedCore::sections()`, which `serving::start` takes too); a second would split the sections.
    let routes = Arc::new(mixdog_core_base::state::ScopedRouteTable::default());
    let state = Arc::new(StateRuntime { publisher: Arc::new(mixdog_core_base::state::StateHub::new(b.sections.clone(), routes.clone())), routes, app: b.sections.clone() });
    // Node's `prepareStandaloneEnvironment` (once per process and data dir, at the first runtime start, before any config load) retires the user's untouched copies of
    // shipped skills, workflows, agents, output styles and orchestration modes into `backups/`, so the shipped versions apply again.
    {
        let paths = retirement_paths(&b.package_root, &b.data_dir, &|name| (b.env)(name).map(std::ffi::OsString::from));
        mixdog_core_base::support::on_lane(b.tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
            mixdog_core_config::workflow::retire::retire_seeded_copies(lane, &paths, &|| mixdog_rt::utc_now!().to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        })
        .await
        .map_err(|e| ComposeError::Config(format!("{e:?}")))?
        .map_err(ComposeError::Config)?;
    }
    let (config, _config_changes) = Config::open(
        config_file(&b.data_dir),
        state.publisher.clone(),
        ConfigLanes { read: b.tokens.interactive_io, write: b.tokens.durability_io },
    )
    .await
    .map_err(|e| ComposeError::Config(format!("{e:?}")))?;
    // Node's boot runs `ensureDefaultsSeparated` before any session reads the config: a file from before the separation is backed up and
    // rewritten with only what differs from the defaults (the agent roster as a delta: advisor starts off) and takes the marker.
    let boot_ms = mixdog_core_session::session::Clock::now_ms(&mixdog_core_session::session::SystemClock);
    config.separate_defaults(boot_ms).await.map_err(|e| ComposeError::Config(format!("{e:?}")))?;
    // From K1 the daemon is the only config writer, so the desktop's one-time `desktop` section separation
    // (`DesktopSettingsStore.separateDefaults`, which Node's app ran at app-ready, after the daemon had separated the file) runs here, as
    // a pass of its own with its own backup. Once this returns the `desktop` section is separated, or (as in Node, where the app's catch wrote
    // `defaults-separation-failed` to its diagnostics log and went on) the failure is on record, the marker unset for the next start's retry.
    let desktop_ms = mixdog_core_session::session::Clock::now_ms(&mixdog_core_session::session::SystemClock);
    let defaults_separation = crate::desktop_defaults::separate(&config, desktop_ms).await;
    // Node's notification store stamps `migratedAt: now` when it first loads with no document; so does the boot (notify owner: `audience.rs`
    // reads `migrated_at()` and no longer sees 0 for a store nobody wrote).
    config.stamp_notifications(boot_ms).await.map_err(|e| ComposeError::Config(format!("{e:?}")))?;
    // Node's `surfaceGeneration`: the extension and feature seams move it, the Lead's surface host checks an empty thread against it.
    let surface_generation = mixdog_core::run_host::surface_host::SurfaceGeneration::default();

    // ---- 2. policy, hub, hook bus; the late views and the one secret input ---------------------
    let PolicyParts { policy: _, connectors, grants, connector_policy } = build_policy(&b.tokens, &b.data_dir);
    // The hook event log (`createHookEventLog`, the hook bus's observer) and the one `HookStatus` over it that the doctor and the `hooks` status read; the first
    // config lookup starts at the process's directory. The bus emits into this log (run-host-34).
    let startup_cwd = std::env::current_dir().map_err(ComposeError::StateDir)?; // the folder the daemon started in: a session with no folder of its own runs hooks here
    let hook_log = crate::domain_seams::hook_status::HookEventLog::new(startup_cwd.clone());
    let hook_status = crate::domain_seams::hook_status::HookStatus::new(b.data_dir.clone(), b.tokens.maintenance_io, hook_log.clone(), hook_log.clone());
    let McpParts { hub, hook_bus } = build_mcp(&b.tokens, &b.data_dir, b.process_manager.clone(), hook_log.clone());
    // The one `DesktopNotices` (the `notice` section): the sessions report turn ends and failed saves, the connector hub its sign-in problems (flip-gaps-ai-3).
    let desktop_notices = mixdog_core_domains::notify::desktop_notice::DesktopNotices::new(state.publisher.clone());
    hub.set_sign_in_notices(Arc::new(mixdog_core::run_host::desktop_notices::ConnectorDesktopNotices(desktop_notices.clone())));
    let late = Arc::new(LateDirectory::default());
    hook_bus.bind_scopes(compose_parts::hook_scope(late.clone())).map_err(|_| ComposeError::AlreadyBound("hook scopes"))?;
    // The PreToolUse bridge (`attachSessionHooks` `beforeToolHook`): the tool gate asks the hook bus before every call, so a hook's deny or ask reaches the model and the failure log.
    let policy = {
        let common = compose_parts::hook_common(late.clone());
        let source: mixdog_mcp::pre_tool::CommonSource = Arc::new(move |thread: &mixdog_protocol::ThreadId| common(thread.as_str()));
        Arc::new(mixdog_tools::policy::ToolPolicy::new(grants.clone(), connectors.clone()).with_hook(Arc::new(mixdog_mcp::pre_tool::BusPreToolHook::new(hook_bus.clone(), source))))
    };
    // The heartbeat state file: the user-activity probe and the `session` tool's suggestions share the one store.
    let heartbeat_store = mixdog_services::bots::beat::HeartbeatStore::new(mixdog_services::bots::state_json::StateJson::new(b.data_dir.join("heartbeat.json"), b.tokens.durability_io));
    // The one UserActivity: the setup/user-activity domain and Mixy's heartbeat both read it (heartbeat-1).
    let user_activity = mixdog_services::bots::beat::UserActivity::new(heartbeat_store.clone(), Arc::new(mixdog_services::scheduler::SystemClock));
    // The lifecycle serving::start builds after compose() (flip-caller-1): the fencing ownership below, the service-call count and the memory-agent run watch read it. The flip hands this Arc to
    // ComposedCore (its lifecycle field) so serving::start binds the same cell; it is not in erify_bound (bound after compose(), before the listener accepts).
    let late_lifecycle = Arc::new(crate::late_lifecycle::LateLifecycle::default());
    // flip-caller-3: the ONE ownership every consumer takes: the data-dir lock whose failed revalidation at a durability barrier moves the core to Fenced (Node's owner-lock watcher, replaced per LR §2.3-2.4).
    let ownership: Arc<dyn mixdog_core_api::domain::ownership::Ownership> = Arc::new(crate::fencing_ownership::FencingOwnership::new(
        b.ownership.clone(),
        late_lifecycle.clone(),
        b.data_dir.join(crate::ownership::LOCK_FILE),
        b.log.line_log(),
    ));
    let late_setup_ui = Arc::new(crate::late_session::LateSetupUi::default());
    let live_route = Arc::new(crate::late_live_route::LateLiveRoute::default()); // flip-ce-2
    // The schedule table and the webhook endpoint table: rows are meta keys in the core state store; ONE instance each, shared by every consumer
    // (`StoreRoutineRecords`, the channel runtime/admin, the home schedule runner, the webhook service). Production, no new code (flip-ce-misc).
    let schedule_store = Arc::new(mixdog_services::scheduler::StateScheduleStore::new(b.core_state.clone(), Arc::new(mixdog_services::scheduler::SystemClock)));
    let schedules: Arc<dyn mixdog_services::scheduler::ScheduleRecords> = schedule_store.clone();
    let webhook_store = Arc::new(mixdog_services::webhooks::records::StateWebhookStore::new(b.core_state.clone(), Arc::new(mixdog_services::scheduler::SystemClock)));
    let webhooks: Arc<dyn mixdog_services::webhooks::EndpointRecords> = webhook_store.clone();
    let tool_surface = Arc::new(crate::late_tool_surface::LateToolSurface::default()); // flip-ce-2
    // The unattended-run registry the setup tool's held requests read AND the turn path takes (run-host-29), over the late run stamps; and the tool exclusions
    // the pool's catalog, the sessions' surfaces and the path share.
    let unattended = mixdog_core::run_host::unattended::UnattendedRunRegistry::new(Arc::new(mixdog_core::run_host::compose_parts::LateRunStamps(late.clone())));
    let exclusions = Arc::new(mixdog_core_session::session::SessionToolExclusions::new());
    // The three seams whose impls need the directory, in parts built before it (wp-session-28, `late_seams.rs`): bound right after `TurnPath::new`.
    let agent_evidence = Arc::new(crate::late_seams::LateAgentEvidence::default());
    let session_facts = Arc::new(crate::late_seams::LateSessionFacts::default());
    // Node's `rt.closeRequested`: set by `quiesce()` first thing in the runtime close (teardown.mjs:99-100), which the session service's stop
    // reaches (`entries.destroy` -> close, session-service.mjs:263-271). Here: cancelled at the start of the session directory's shutdown step
    // (`Real::session_shutdown_step`), not at the end of the stop (`b.cancel`).
    let close_requested = tokio_util::sync::CancellationToken::new();
    let maintenance_stop = b.cancel.child_token();
    let worktree_stop = b.cancel.child_token(); // `WorktreeMaintenance::start(.., cancel)` takes this; the boot step starts it with the maintenance schedule
    // One instance each of what several seams share.
    let heartbeats = mixdog_services::bots::HeartbeatSessions::new();
    let extension_host = crate::compose_mcp::LateExtensionHost::new();
    let late_dialer = Arc::new(crate::domain_seams::remote::LateDialer::default());
    let build_version = crate::compose_domains::package_version(&b.package_root, b.tokens.interactive_io).await.map_err(ComposeError::ComposeDomains)?;
    let plugins_announce = crate::domain_seams::plugin_announce::plugins_announce(b.data_dir.clone(), b.tokens.durability_io);
    let late_threads = Arc::new(LateThreads(late.clone()));
    let late_headers = Arc::new(LateHeaders(late.clone()));
    let secret = secret_input();
    let clock: Arc<dyn mixdog_core_session::session::Clock> = Arc::new(mixdog_core_session::session::SystemClock);
    // The agent crate's `Clock` trait is a second trait with the same one method; this is the one clock under it.
    let clock_agent: Arc<dyn mixdog_agent::env::Clock> = Arc::new(crate::compose_mcp::AgentClock(clock.clone()));

    // `os.homedir()` and the folder unclassified tasks run in (`<userData>/workspace/unclassified`, `session-host.ts`).
    let documents = Arc::new(mixdog_exthost::ExtDocumentText::new(b.ext_host.clone()));
    let home = std::env::home_dir().ok_or(ComposeError::NoHome)?;
    // `mixdogHome()`: `MIXDOG_HOME`, else `~/.mixdog` (the layout `server_ensure` hands the daemon); the conversation transcripts live under its `projects`.
    let mixdog_home = (b.env)("MIXDOG_HOME").filter(|v| !v.is_empty()).map(std::path::PathBuf::from).unwrap_or_else(|| home.join(".mixdog"));
    let task_workspace = b.user_data_dir.join("workspace").join("unclassified");
    crate::compose::create_dir(&b.tokens, task_workspace.clone()).await.map_err(ComposeError::StateDir)?;
    // The local provider needs only the data folder, the process manager, the config and the stop token.
    let local_provider = build_local_provider(&b.data_dir, &b.tidy_processes, &config, &b.cancel).map_err(ComposeError::ComposeDomains)?;
    // The one network stack (wp-ai-svc-13): after Config is open, before `ProcessServices` and `compose_domains`.
    let net = mixdog_ai::netproxy::stack::NetworkStack::new(mixdog_ai::transport::KeepaliveSchedule::SPEC);
    net.start(&mixdog_ai::service::network_proxy::NetworkProxyStore::network_proxy(&config)).await;
    let _network_follow = net.follow(Arc::new(config.clone()), config.changes()); // kept for the daemon's life
    let (network_proxy, routed_clients) = (net.policy.clone(), net.clients.clone());
    // The one usage ledger source (wp-ai-admin-1 `LedgerSource::get()`): `ProcessInputs.ledger` (the registry's accounting) and
    // `LocalSeams.media_ledger` (wp-svc-misc-24 `QueuedLedger`) both write through it, and it is asked per row, as Node asks `getUsageLedger()`.
    // The `usage` section (DS §15 P7): every ledger the source opens publishes its statistics and, once `usage_push.dashboard` is bound below, the dashboard,
    // through the one publisher; the statistics are read with the clock `getUsageStats` uses.
    let usage_push = mixdog_core::run_host::usage_stats_feed::UsagePush::new(state.publisher.clone(), Arc::new(mixdog_core_domains::domains::ai_account::usage::now_ms));
    let ledger_source = mixdog_core::run_host::ledger_source::LedgerSource::new(
        Arc::new(mixdog_ai::registry::keys::ProcessEnv),
        b.data_dir.clone(),
        b.tokens.clone(),
        Arc::new(mixdog_core_base::pricing::ledger_pricer::CatalogPricer::ungated(&b.catalog)),
        usage_push.clone(),
    );
    let usage_sink: Arc<dyn mixdog_ai::registry::accounting::UsageSink> = Arc::new(crate::compose_mcp::SourcedSink(ledger_source.sink()));
    let now_ms_epoch: Arc<dyn Fn() -> u64 + Send + Sync> = mixdog_ai::client_versions::system_clock(); // Date.now() for the OAuth wiring
    let now_ms: Arc<dyn Fn() -> i64 + Send + Sync> = {
        let clock = clock.clone();
        Arc::new(move || clock.now_ms())
    };
    // ---- 3. the local provider, process services, registry and readiness (plain build order) --
    // The three stores several parts share, each built once: the blob store (its pins are in-memory, so one instance), the process's sensitive-value
    // store (memory's search copy and the session turns share it), and the route exclusions the tool pool's catalog and the sessions' tool surfaces read.
    let blobs = mixdog_store::blobs::BlobStore::new(&b.data_dir);
    // The attachment ports (flip-attach-1..4), all over the ONE `blobs`: the reader is the one `ProcessInputs.attachments` takes.
    let attachments: Arc<dyn mixdog_ai::service::model_proxy_inline::AttachmentReader> = Arc::new(mixdog_core_domains::domains::ai_admin::model_proxy::StoreAttachments { store: blobs.clone(), interactive: b.tokens.interactive_io });
    let store_blobs: Arc<dyn mixdog_agent::compact::blob_reads::BlobReads> = Arc::new(mixdog_core::run_host::attachment_store::StoreBlobs::new(blobs.clone(), &b.tokens));
    let attachment_files = Arc::new(mixdog_core::run_host::attachment_store::StoreFiles::new(blobs.clone(), &b.data_dir, &b.tokens));
    let attachment_facts: Arc<dyn mixdog_core::run_host::media::AttachmentFacts> = Arc::new(mixdog_core::run_host::attachment_store::StoreFacts::new(blobs.clone(), &b.tokens).with_documents(documents.clone()));
    // The one observed-file / read-cache state of the read, edit and apply_patch tools (and the purge hooks, the workspace host): persisted under
    // `<data>/read-snapshots`. NOT here: `FileSnapshotPersist::sweep_stale` (30-day sweep, blocking `std::fs`): it must run once at boot as a lane job.
    let snapshot_persist = Arc::new(mixdog_core::run_host::read_snapshots::FileSnapshotPersist::new(&b.data_dir));
    let read_state = Arc::new(mixdog_tools::fs::ReadState::new(Some(mixdog_tools::fs::read_state::Persistence::new(snapshot_persist.clone(), b.tokens.durability_io))));
    let sensitive = Arc::new(mixdog_services::memory::sensitive::SensitiveStore::default());
    let process = ProcessServices::production(ProcessInputs {
        attachment_facts: attachment_facts.clone(),
        config: config.clone(),
        catalog: b.catalog.clone(),
        listing: mixdog_ai::catalog::ListingLookup::new(),
        network: network_proxy.clone(),
        lanes: b.tokens.clone(),
        plugin_data: b.data_dir.clone(),
        home_dir: home.clone(),
        build_version: build_version.clone(),
        ledger: ledger_source.sink(),
        sessions: Arc::new(compose_parts::DirectoryHeaders(late.clone())),
        local_provider: local_provider.clone(),
        documents: documents.clone(),
        attachments: attachments.clone(),
    })
    .await
    .map_err(ComposeError::Process)?;
    // One `ConfiguredShell` and one `Warmer` per process: the settings effects, the purge hooks and
    // (for the shell) the exec shell resolver share them.
    let configured_shell = b.configured_shell.clone(); // the exec runtime's own, not a second one
    // The registry's builder inputs, keeping the link, the client versions and the identity they were built with (the media layer reuses them).
    let (builder_env, builder_shared) = mixdog_core::run_host::builder_env::builder_env_shared(&process);
    // Read from the builder inputs before the registry takes them: the media lanes' key store and the provider gate switch.
    let (media_keys, gated_off) = (builder_env.keys.clone(), builder_env.gated_off.clone());
    let (registry, default_builder) = compose_parts::provider_registry(&process, builder_env, Arc::new(mixdog_exthost::ExtImageCodec::new(b.ext_host.clone()))); // run-host-26
    // The registry's own routed link, `ClientVersions` and client identity (`builder_env.http`, per wp-ai-svc), not a second set.
    let (http_send, client_versions, client_ids) = (builder_shared.http.clone(), builder_shared.versions.clone(), builder_shared.identity.clone());
    let readiness = mixdog_ai::catalog::ProviderReadiness::new(registry.clone(), b.catalog.clone());
    // The providers of the loaded config (`loadConfig().providers`): the runtime's own provider config that
    // `ensure_providers_ready(None)` initializes, and the view the dashboards and the model lists read.
    let effective = Arc::new(mixdog_ai::registry::effective::EffectiveProviders::new(default_builder.clone(), media_keys.clone(), process.env.clone()));
    // `getConfig()` of the runtime: the loaded config, which the Main route resolves over and the sync task rebuilds.
    let loaded_config = Arc::new(mixdog_core_domains::domains::ai_admin::provider_sync::LoadedConfig::new(
        mixdog_core_domains::domains::ai_admin::provider_sync::load_config(&config, &effective).await.map_err(ComposeError::Providers)?,
    ));
    let loaded_providers = loaded_config.get().get("providers").and_then(serde_json::Value::as_object).cloned().unwrap_or_default();
    readiness.set_providers(loaded_providers.clone());
    // The runtime's own provider config follows the loaded config.
    let _provider_sync = mixdog_core_domains::domains::ai_admin::provider_sync::spawn_provider_sync(config.clone(), effective.clone(), readiness.clone(), loaded_config.clone(), b.cancel.child_token());

    // The stores the warm gate, the resume timer, the media layer and the provider admin share (built here, ahead of step 5: the warmer\n    // needs the gate, and the gate needs the registry above).
    // The one `quota-resume.json` store: the setup tool's switch (`DomainSeams.quota_resume`, wp-config-setup-1), the goal
    // suspension notes and the resume timer all hold this `Arc`.
    let quota_store = Arc::new(
        mixdog_core_base::quota_resume::QuotaResumeStore::open(&b.data_dir, b.tokens.durability_io, b.cancel.child_token()).await.map_err(ComposeError::QuotaResume)?,
    );
    // The `quotaAutoResume` switch going off, by whichever writer, drops every pending resume (Node's `setQuotaAutoResumeEnabled`); held for
    // the daemon's life and stopped with the daemon's token.
    let _quota_follow = mixdog_core_agents::setup::QuotaAutoResume::new(config.clone(), quota_store.clone()).follow(b.cancel.child_token());
    // The one `AccountStore` over the data dir: `ProviderAdmin`, the provider layer's default credential files and the selected-account fact share it.
    let credential_io = mixdog_ai::oauth::CredentialIo { read: b.tokens.interactive_io, write: b.tokens.durability_io };
    let account_store = mixdog_ai::accounts::AccountStore::new(b.data_dir.clone(), credential_io);
    // wp-ai-svc-21 (`ai_account/production.rs`): every input is the host's one instance. Order: builder -> registry -> effects -> admin.
    let oauth_wiring = Arc::new(mixdog_core_domains::domains::ai_account::production::OAuthWiring {
        accounts: account_store.clone(),
        http: http_send.clone(), // BuilderEnv.http (`builder_shared.http`)
        pace: Arc::new(mixdog_ai::oauth::SystemPace),
        file: mixdog_core_domains::domains::ai_account::production::OAuthWiring::files_of(account_store.clone()),
        io: credential_io,
        plugin_data: b.data_dir.clone(),
        versions: client_versions.clone(),
        now_ms: { let epoch = now_ms_epoch.clone(); Arc::new(move || epoch() as i64) },
        env: process.env.clone(),
        cli_auth: mixdog_core_domains::domains::ai_account::production::OAuthWiring::default_cli_auth(),
    });
    // The one `OAuthUsage` (`mixdog_ai::service::oauth_usage`, `OAuthUsage::new(UsageDeps)`): the warm gate's snapshots, the account rotation,
    // `ProviderAdmin`, the account services and the quota usage reading all hold this Arc. The constructor exists; its four ports have test fakes only.
    let oauth_usage = mixdog_ai::service::oauth_usage::OAuthUsage::new(mixdog_ai::service::oauth_usage::UsageDeps {
        http: Arc::new(mixdog_ai::service::usage_ports::RoutedUsageHttp::new(http_send.clone())), // wp-ai-admin-7: `redirect: 'error'` over the routed link
        source: Arc::new(mixdog_ai::service::usage_ports::ProviderUsageSource::new(account_store.clone(), http_send.clone()).with_versions(client_versions.clone())),
        grok: Arc::new(mixdog_ai::service::usage_ports::GrokVersionHeaders::new(client_versions.clone())), // the minimum learned from a 426 reaches the next usage request
        history: Arc::new(mixdog_core::run_host::quota_history::LedgerQuotaHistory::new(ledger_source.clone())),        store: account_store.clone(),
        io: credential_io,
        log: b.log.line_log(),
        data_dir: b.data_dir.clone(),
    });
    // The one model broker, and with it the one `Admission` (wp-ai-svc-24): `AccountGate`, `ProviderEffects` and every send take
    // `broker.admission()`; nothing else calls `Admission::new()`.
    let broker = Arc::new(mixdog_ai::broker::ModelBroker::new(Arc::new(mixdog_ai::admission::Admission::new()), Arc::new(mixdog_ai::retry::StandardRetryDecider)));
    let admission = broker.admission().clone();
    // The provider setup chain (wp-ai-svc-23/-25): oauth providers -> gatherer -> cached setup -> dashboards -> effects -> refresh.
    let oauth_providers = mixdog_core_domains::domains::ai_account::production::oauth_providers(&oauth_wiring); // the same Vec `ProviderAdmin` holds
    // wp-ai-svc-27: ONE tracked secret store. The vault goes over it (`AnnouncingStore`, below, at the config-setup seam) and the status holder reads it, so the retry
    // probe notes its outcome. The desktop notice raise is the daemon's `notice` section (`DesktopNotices`, the one built at the top of this function).
    let secret_changes = mixdog_core_config::config::secret_changes::SecretChanges::open(config.clone()).await;
    let (keychain_store, keychain_tracker) = tracked_secret_store(b.tokens.durability_io, &b.data_dir, &desktop_notices);
    let keychain_live: Arc<dyn mixdog_core_domains::domains::ai_account::setup_cache::KeychainLive> =
        Arc::new(mixdog_core_domains::domains::ai_account::keychain_live::HolderLive::new(keychain_tracker, keychain_store.clone(), b.tokens.durability_io, b.data_dir.clone()));
    // The catalog service's own failure store (never a second one: refresh records into it and `invalidate_accounts` clears it).
    let catalog_failures: Arc<dyn mixdog_core_domains::domains::ai_account::setup_overlays::CatalogFailures> = b.catalog.catalog().failures().clone();
    let overlays = Arc::new(mixdog_core_domains::domains::ai_account::setup_overlays::LiveOverlays { failures: catalog_failures, keychain: keychain_live.clone() });
    let gatherer = Arc::new(mixdog_core_domains::domains::ai_account::setup_world::SetupGatherer {
        // `displayConfig: () => getConfig()` (config-lifecycle.mjs:399): the live config the daemon holds, never a re-read from disk.
        config: {
            let config = config.clone();
            Arc::new(move || serde_json::Value::Object(config.agent()))
        },
        developer: {
            let config = config.clone();
            Arc::new(move || config.agent().get("developer").cloned().unwrap_or(serde_json::Value::Null))
        },
        env: process.env.clone(),
        keys: media_keys.clone(), // the registry's `ApiKeyStore`
        vault: process.vault.clone(),
        accounts: account_store.clone(),
        providers: oauth_providers,
        builder: default_builder.clone(),
        keychain: keychain_live.clone(),
        local: Arc::new(crate::compose_mcp::LocalStatusOf(local_provider.clone())),
        proxy: Arc::new(mixdog_core::run_host::proxy_providers::HostProxyProviders::new(b.host.clone(), b.client_epoch.clone(), now_ms.clone())),
    });
    // The warm-up slot and the host around the setup (`setup_host.rs`). The slot warms the setup that holds the host: a true cycle, bound below.
    let setup_warmup = crate::setup_host::SetupWarmup::new(
        crate::setup_host::warmup_delay_ms(&*b.env),
        {
            let closing = close_requested.clone();
            Arc::new(move || closing.is_cancelled())
        },
        Arc::new(crate::setup_host::TracedMarks),
    );
    let setup_host = Arc::new(crate::setup_host::DaemonSetupHost { env: b.env.clone(), config: config.clone(), warmup: setup_warmup.clone() });
    let provider_setup = Arc::new(mixdog_core_domains::domains::ai_account::setup_cache::CachedProviderSetup::new(gatherer, keychain_live.clone(), overlays, setup_host));
    setup_warmup.bind(provider_setup.clone()).map_err(|_| ComposeError::AlreadyBound("provider setup warm-up"))?;
    let dashboards = mixdog_core_domains::domains::ai_account::dashboards::Dashboards::new(Arc::new(crate::setup_host::SetupSourceOf { setup: provider_setup.clone(), config: config.clone(), effective: effective.clone() }));
    // The provider model cache's warm (`scheduleProviderModelWarmup` and the account flows' `warmProviderModelCache`): built here for the effects, bound to the list and the gates below.
    let model_warmup = mixdog_core_domains::domains::ai_admin::model_warmup::ModelWarmup::new(mixdog_core_domains::domains::ai_admin::model_warmup::WarmupConfig::from_env(&*b.env));
    // The statusline usage warm-up (`scheduleStatuslineUsageWarmup`): built here for the prewarm signals, bound to the route and the usage service once those exist.
    let statusline_warmup = mixdog_core_domains::domains::ai_admin::statusline_warmup::StatuslineWarmup::new(&*b.env);
    // The provider initialization warm (`scheduleProviderWarmup`, opt-in): built here for the prewarm signals, bound with the gates below.
    let provider_warmup = mixdog_core_domains::domains::ai_admin::provider_warmup::ProviderWarmup::new(mixdog_core_domains::domains::ai_admin::provider_warmup::ProviderWarmupConfig::from_env(&*b.env));
    let provider_init = Arc::new(crate::prewarm_world::DaemonProviderInit { keychain: keychain_live.clone(), config: config.clone(), loaded: loaded_config.clone(), readiness: readiness.clone() });
    let provider_effects = mixdog_core_domains::domains::ai_account::auth_refresh::ProviderEffects::new(config.clone(), readiness.clone(), admission.clone(), dashboards.clone(), model_warmup.clone());
    // Node's one `invalidateProviderCaches()` also drops the setup cache: the effects the flow runs are `ProviderEffects` plus that drop.
    let refresh: Arc<dyn mixdog_core_domains::domains::ai_account::collaborators::AuthRefresh> = mixdog_core_domains::domains::ai_account::auth_refresh::AuthRefreshFlow::new(Arc::new(
        crate::setup_host::CachesWithSetup { inner: provider_effects, setup: provider_setup.clone() },
    ));
    // The one side-question store and what a capture reads; `SideWiring` hands out the request source, the next-request source (the warmer's and `TurnPathParts.next`) and the questions service.
    let warm_ledger = mixdog_ai::registry::warm::WarmLedger::new();
    let side_store = Arc::new(mixdog_core::run_host::side_question_store::SideQuestionStore::new());
    let side_wiring = mixdog_core::run_host::side_wiring::SideWiring::new(mixdog_core::run_host::side_requests::SideRequests {
        store: side_store.clone(),
        caching: Arc::new({
            let catalog = b.catalog.clone();
            move |provider: &str, model: &str| catalog.prompt_caching(provider, model) // `getCachedModelInfo(model) ?? getModelMetadataSync(model, provider)` (catalog/service.rs)
        }),
        docs: documents.clone(),
        reader: attachments.clone(),
        facts: attachment_facts.clone(),
        clock: clock_agent.clone(),
    });
    // wp-ai-svc-warm-1..-7: the gate a warm passes before it spends a model call.
    let rotation = Arc::new(mixdog_ai::accounts::rotation::AccountRotation::new(account_store.clone(), Arc::new(oauth_usage.clone()), Arc::new(mixdog_ai::oauth::SystemPace)));
    let account_gate = Arc::new(mixdog_ai::warmer::gate::AccountGate::new(
        admission.clone(),
        mixdog_ai::admission::provider_lane_settings((b.env)("MIXDOG_PROVIDER_ADMISSION_MAX_QUEUE").as_deref()),
        account_store.clone(),
        rotation.clone(),
        Arc::new(mixdog_ai::warmer::gate::GatedOff(gated_off)), // the registry's builder's own live reader (wp-ai-svc-warm-6)
        quota_store.clone(),
        oauth_usage.clone(),
    ));
    // The warmer: `ProcessWarmDeps` over the ports of `run_host/warm_ports.rs`; `WarmProviders::send` goes through `account_gate`.
    let now_wall: mixdog_ai::warmer::stores::Now = { let epoch = now_ms_epoch.clone(); Arc::new(move || epoch() as f64) }; // Date.now()
    let warm_log: mixdog_ai::warmer::stores::Log = b.log.line_log();
    let warm_touches = Arc::new(mixdog_ai::warmer::stores::TouchStore::open(b.data_dir.join("prompt-cache-touches.json"), b.tokens.durability_io, warm_log.clone(), now_wall.clone()).await.map_err(ComposeError::WarmStore)?);
    let warm_gaps = Arc::new(
        mixdog_ai::warmer::stores::GapStore::open(
            b.data_dir.join("prompt-cache-idle-gaps.json"),
            b.tokens.durability_io,
            mixdog_ai::warmer::stores::GapRules {
                lookback_ms: mixdog_ai::warmer::plan::IDLE_RETURN_LOOKBACK_MS,
                window_ms: mixdog_ai::warmer::plan::IDLE_RETURN_WINDOW_MS,
                min_ms: mixdog_ai::warmer::plan::warm_delay_ms(5.0 * 60_000.0),
            },
            warm_log.clone(),
            now_wall.clone(),
        )
        .await
        .map_err(ComposeError::WarmStore)?,
    );
    let warmer: Arc<mixdog_ai::warmer::Warmer> = mixdog_ai::warmer::Warmer::new(
        Arc::new(mixdog_ai::warmer::process::ProcessWarmDeps {
            now: now_wall,
            timers: mixdog_ai::warmer::process::TokioTimers,
            config: Arc::new(mixdog_core::run_host::warm_ports::ConfigWarm::new(config.clone())),
            sessions: Arc::new(mixdog_core::run_host::warm_ports::SessionsWarm::new(
                side_wiring.next(), // the ONE `Arc<NextRequestSource>` that is `TurnPathParts.next`, bound by `build_directory`; read at call time
                registry.clone(),
                mixdog_core::run_host::builder_env::CatalogCaps::new(b.catalog.clone(), &*process.env),
                side_wiring.next(), // as `Arc<dyn WarmTail>`: the session's language and role per warm (`cache-warm.mjs:207`)
            )),
            providers: Arc::new(mixdog_core::run_host::warm_ports::ProvidersWarm::new(
                registry.clone(),
                b.catalog.clone(),
                account_gate.clone(),
                mixdog_ai::warmer::send::deadlines_from_env(|name| (b.env)(name)),
                warm_log.clone(),
            )),
            pricing: Arc::new(mixdog_ai::catalog::pricing::CatalogPricing(b.catalog.clone())),
            ledger: { let ledger_source = ledger_source.clone(); Arc::new(move || (ledger_source.sink())()) },
            log: warm_log,
        }),
        warm_touches,
        warm_gaps,
        warm_ledger.clone(), // the ONE `WarmLedger` the registry's warm use reads
    );
    // ---- 4. the live gauge and the one auth refresh -------------------------------------------
    let gauge = mixdog_core::run_host::live_gauge::LiveGauge::new(); // wu-context-status-13 (FILED)

    // ---- 5. the agents, the hosts and the domain seams ------------------------------------------------------------------
    let facts = Arc::new(mixdog_core_domains::domains::ai_admin::chain::CatalogFacts { catalog: b.catalog.clone(), readiness: readiness.clone(), config: config.clone() });
    let routes = compose_parts::live_routes(config.clone(), facts.clone());
    // wp-ai-admin-19/-22: the Main route of thread-less reads (`MainRoute`: the live config route at every call), the model list both `model/list` and the web-search rows call, and the
    // web-search route (`webSearchRouteOrDefault` over the stored config route). `cells` is the route cell of every conversation (the one `routes`).
    let unsupported = process.unsupported.clone(); // the SAME Arc<UnsupportedEfforts> as the route wirer and the effort judge
    let main_route = Arc::new(mixdog_core::run_host::main_route::MainRoute::new(loaded_config.clone(), { let facts = facts.clone(); Arc::new(move |provider: &str, config: &serde_json::Map<String, serde_json::Value>| mixdog_core_domains::domains::ai_admin::chain::RouteFacts::is_known(&*facts, provider, config)) }));
    let model_list = Arc::new(mixdog_core_domains::domains::ai_admin::model_list::ModelListService {
        catalog: b.catalog.clone(),
        config: config.clone(),
        primary_provider: { let main = main_route.clone(); Arc::new(move || main.provider()) },
        unsupported: unsupported.clone(),
        host: Some(mixdog_core_domains::domains::ai_admin::model_list::ListHost::new(
            readiness.clone(),
            effective.clone(),
            config.clone(),
            { let main = main_route.clone(); Arc::new(move || main.route()) },
            loaded_providers.clone(),
        )),
    });
    // The `modelCatalog` section (`model/catalog/updated`): the `model/list` rows, pushed when they change.
    let model_catalog = mixdog_core_domains::domains::ai_admin::model_catalog_feed::ModelCatalogFeed::start(model_list.clone(), state.publisher.clone(), _provider_sync.applied.clone());
    let web_search_models = Arc::new(mixdog_core_domains::domains::ai_admin::web_search_models::WebSearchModelsService::new(
        b.catalog.clone(),
        config.clone(),
        model_list.clone(),
        mixdog_core_domains::domains::ai_admin::web_search_models::WebSearchRoutes {
            cells: routes.clone() as Arc<dyn mixdog_core_ports::ports::route::LiveRoute>,
            main_route: { let main = main_route.clone(); Arc::new(move || serde_json::Value::Object(main.route())) },
            web_search_route: {
                let config = config.clone();
                Arc::new(move || mixdog_ai::service::routes::web_search_route_or_default(&[&config.agent().get("webSearchRoute").cloned().unwrap_or(serde_json::Value::Null)]).unwrap_or(serde_json::Value::Null))
            },
        },
    ));
    // The ONE readiness invalidation (Node `invalidateProviderCaches()`, wp-ai-svc-24): every cache Node drops there, in one closure.
    // The feed is told last, of every invalidation but a settled startup catalog refresh's (Node sends no hint then).
    readiness.bind_invalidation(Arc::new(mixdog_core_domains::domains::ai_admin::model_catalog_feed::FeedToldDrop {
        drop: Arc::new({
            let (setup, dashboards, web_search_models, model_list) = (provider_setup.clone(), dashboards.clone(), web_search_models.clone(), model_list.clone());
            move || {
                model_list.invalidate();
                setup.invalidate();
                dashboards.invalidate();
                web_search_models.invalidate(None);
            }
        }),
        feed: model_catalog.clone(),
    })).map_err(|_| ComposeError::AlreadyBound("readiness invalidation"))?;
    // The re-warm a settled startup catalog refresh starts (`warmProviderModelCache({ loadSecrets: true })`,
    // provider-readiness.mjs:166).
    readiness.bind_rewarm(Arc::new({
        let model_list = Arc::downgrade(&model_list);
        move || {
            if let Some(model_list) = model_list.upgrade() {
                model_list.warm_cache(true);
            }
        }
    })).map_err(|_| ComposeError::AlreadyBound("readiness re-warm"))?;
    // `model/list` and `account/listWebSearchModels` are registered with the domains at the flip (`model_list` / `web_search_models` are the services).    // `resolveRoute(config, {})` for the agent definitions: the same Main route the chain resolves (`CatalogRouteContext`).
    let route_context = Arc::new(mixdog_core_domains::domains::ai_admin::chain::CatalogRouteContext { config: config.clone(), facts: facts.clone() });
    // flip-gaps-agent: `AgentEffects`. Two cycles are cut by late cells: effects -> `ServiceChannels` -> `DefinitionAgents(definitions)` (the channel stack is bound once it exists)
    // and effects -> `ChatRoutes(route_service)` -> `SessionRouteAdapter(directory)` (bound once `route_service` exists). Both are in `verify_bound`.
    let agent_profile = Arc::new(crate::domain_seams::profile_changes::AgentProfileChanges::default()); // also `InstructionsAnnounce` and the session layer's `ProfileListener`
    let agent_channels = Arc::new(crate::late_agent_cells::LateRoutineChannels::default());
    let chat_routes = Arc::new(crate::late_agent_cells::LateChatRoutes::default());
    let route_setter = Arc::new(mixdog_core_domains::domains::ai_admin::agent_route_service::AgentRouteSetter {
        routes: mixdog_core_config::config::agent_routes::AgentRoutes::new(config.clone(), b.data_dir.clone()),
        config: config.clone(),
        context: route_context.clone(),
        publisher: mixdog_core_session::session::agent_route::SessionRoutePublisher::new(Arc::new(mixdog_core_ports::ports::route::AgentRouteFollow::new(
            Arc::new(mixdog_core::run_host::late_chats::LateAgentChats(late.clone())),
            chat_routes.clone(),
        ))),
        hidden: mixdog_core_config::config::hidden_agents::hidden_agents(),
    });
    // A saved, archived or restored definition also wakes the `agents` section (the pushed `listAgents`).
    let agent_list_changed = Arc::new(tokio::sync::Notify::new());
    let agent_effects: Arc<dyn mixdog_core_agents::agents::AgentEffects> = Arc::new(mixdog_core_agents::agents::section::AnnouncingEffects {
        inner: Arc::new(crate::domain_seams::agent_effects::DaemonAgentEffects::new(agent_profile.clone(), agent_channels.clone(), route_setter.clone())),
        changed: agent_list_changed.clone(),
    });
    // The agent definitions are built once, before `ConfigHosts` and `mcp_services` (both take this `Arc`).
    let agents = build_agents(
        &b.tokens,
        &config,
        &b.package_root,
        &b.data_dir,
        &task_workspace,
        AgentSeams {
            evidence: agent_evidence.clone(),
            effects: agent_effects.clone(),
            main_route: {
                let route_context = route_context.clone();
                Arc::new(move || {
                    mixdog_core_domains::domains::ai_admin::chain::RouteContext::resolve_main(&*route_context).map(serde_json::Value::Object).unwrap_or(serde_json::Value::Null)
                })
            },
            now: {
                let clock = clock.clone();
                Arc::new(move || mixdog_agent::agent_tool::stamp::iso_from_ms(clock.now_ms()))
            },
        },
    );
    let agent_listed: Arc<std::sync::OnceLock<mixdog_core_agents::agents::section::ListedHook>> = Arc::new(std::sync::OnceLock::new());
    // Every `thread/deleted` (the explicit delete and a row that stopped being listed) leaves through this one publisher, which tells the paired
    // phones' downloads the conversation is gone in the same step, before the notification (bound once the workspace exists).
    let thread_deletions = mixdog_core_session::session::thread_edges::ThreadDeletions::new(b.sections.clone());
    mixdog_core_agents::agents::section::spawn_agents_section(
        agents.clone(),
        config.changes(),
        agent_list_changed.clone(),
        mixdog_core_config::section_watch::Watched {
            roots: vec![b.package_root.join("src").join("agents"), b.data_dir.join("agents")],
            files: Vec::new(),
        },
        agent_listed.clone(),
        state.publisher.clone(),
        b.cancel.clone(),
    )
    .map_err(|error| ComposeError::ComposeDomains(crate::compose_domains::ComposeDomainsError::Watch(mixdog_core_config::config::ConfigError::Io(std::io::Error::other(error)))))?;
    let config_hosts = compose_parts::config_hosts(ConfigHostsIn {
        config: config.clone(),
        routes: routes.clone(),
        gauge: gauge.clone(),
        agents: agents.clone(), // flip-home: the shared Arc<AgentDefinitions> is also the home directory's
        facts: facts.clone(),
        refresh: refresh.clone(),
        env: b.env.clone(),
        surface: surface_generation.clone(),
    });

    // The remote runtime (relay off until the user turns it on). `state` exists since step 1, so the
    // publisher is bound at once; the dialer is bound by `serving::start` once the connection hub exists.
    let remote_publisher = Arc::new(crate::domain_seams::remote::LatePublisher::default());
    remote_publisher.bind(state.publisher.clone());
    let built_remote = crate::domain_seams::remote::build_remote(crate::domain_seams::remote::RemoteInputs {
        dir: b.data_dir.clone(),
        relay_env: (b.env)("MIXDOG_RELAY_URL"),
        app_version: (build_version.clone(), None),
        durability: b.tokens.durability_io,
        dialer: late_dialer.clone(),
        publisher: remote_publisher,
    })
    .map_err(ComposeError::Remote)?;

    // The notify domain (WP-NOTIFY-ROOMS), built right after the remote runtime it reads: the phone audience (`RuntimePresence` over the roster and the
    // UI screen sessions), the engine, and the sink every push goes through. The held-request push and `notify/*` share them (flip-home-2).
    let screen = Arc::new(mixdog_core_domains::notify::screen::ScreenSessions::new(built_remote.registry.clone()));
    let notify_engine = Arc::new(mixdog_core_domains::notify::engine::NotificationEngine::new(
        // flip-rooms-1: the volume is read at toast time (`ToastStyleReader`); `sound` follows it (`none` at 0).
        Arc::new({
            let config = config.clone();
            move || mixdog_core_domains::notify::engine::ToastStyle::for_volume(config.desktop_settings().notification_volume)
        }),
    ));
    let audience = Arc::new(mixdog_core_domains::notify::audience::LiveAudience::new(
        Arc::new(config.clone()),
        Arc::new(mixdog_core_domains::notify::presence::RuntimePresence::new(built_remote.runtime.clone(), screen.clone())),
        b.host.clone(),
    ));
    let push_sink = Arc::new(mixdog_core_domains::domains::remote_push::RemotePushSink::new(built_remote.runtime.clone()));
    // The held-request phone push (flip-home-2): ids and the agent's name only; fired only while the daemon is not closing.
    let held_notifier: crate::held_home_draft::HeldNotifier = {
        let held_push = mixdog_core_domains::notify::held::HeldPushNotifier::new(
            notify_engine.clone(),
            audience.clone(),
            push_sink.clone(),
            Arc::new({
                let closing = close_requested.clone();
                move || !closing.is_cancelled()
            }),
            now_ms.clone(),
            b.log.line_log(),
        );
        Arc::new(move |p: &crate::held_requests::HeldPush| {
            held_push.notify(mixdog_core_domains::notify::held::HeldRequestEvent {
                session_id: p.session_id.clone(),
                agent_id: p.agent_id.clone(),
                agent_name: p.agent_name.clone(),
                request_id: p.request_id.clone(),
            })
        })
    };
    // The surface check is a late form (the held home exists before the directory): flip-home-1.
    let held_home = crate::held_home_draft::ProcessHeldHome::new(
        unattended.clone(),
        Arc::new(mixdog_core::run_host::compose_parts::LateApprovalSurfaces { directory: late.clone(), presence: b.approval_presence.clone() }),
        b.tokens.interactive_io,
        b.data_dir.clone(),
        held_notifier,
        grants.clone(), // the store the tool gate audits in: an answered held request is audited in it too
    );
    // The held-request registry: Mixy's heartbeat counts it (pendingHeldRequests) and every run's approval asks pass its gate (`TurnPathParts.approvals`).
    let held_requests = crate::held_requests::HeldRequests::new(held_home.clone(), now_ms.clone());

    // The one bridge fact: the skill gate (`McpInputs.bridges`) and `DomainSeams.feature_activity` both read this value.
    // wp-mcp-4: nothing is up until `bridge_files.start(watcher)` runs below, once the core's one FolderWatcher exists.
    let bridge_files = crate::mcp_surface::BridgeFiles::new(crate::mcp_surface::discovery_dir(&b.env, &home), b.tokens.maintenance_io);
    let bridges: Arc<dyn crate::compose_mcp::BridgeFeatures> = Arc::new(crate::mcp_surface::SharedBridgeFiles(bridge_files.clone()));

    // The media generator and its ledger (wp-svc-misc-12..-29, wp-ai-svc-18, wp-ws-2). One routed JSON post, one `FileAccountProbe`.
    let selected_accounts: Arc<dyn mixdog_services::media::SelectedAccounts> = Arc::new(crate::compose_mcp::AccountPoolSelected(account_store.clone())); // async trait (wp-svc-misc-13): read per call, no snapshot
    let json_post = Arc::new(mixdog_services::media::adapter_http::RoutedJsonPost::new(routed_clients.clone()));
    let provider_layer = Arc::new(mixdog_services::media::provider_layer::ProviderLayer::new(
        http_send.clone(),
        json_post.clone(),
        credential_io,
        mixdog_services::media::provider_layer::ProviderLayer::default_file_of(account_store.clone()),
        client_versions.clone(),
        registry.clone(),
        mixdog_ai::client_versions::system_clock(),
        mixdog_services::media::provider_layer::CodexClient {
            user_agent: client_ids.codex.user_agent.clone(),
            version: client_ids.codex.version.clone(),
            originator: mixdog_services::media::provider_layer::CodexProviderSession::originator_of(b.env.clone()),
            random_hex: Arc::new(|| rand::random::<[u8; 16]>().iter().map(|byte| format!("{byte:02x}")).collect()),
        },
    ));
    let file_probe = Arc::new(mixdog_services::media::FileAccountProbe::new(mixdog_services::media::ProbeParts {
        data_dir: b.data_dir.clone(),
        lane: b.tokens.durability_io,
        now: now_ms.clone(),
        env: b.env.clone(),
        keys: Arc::new(mixdog_services::media::provider_layer::StoreKeys(media_keys.clone())), // the registry's own `ApiKeyStore`
        settings: Arc::new(mixdog_services::media::provider_layer::ConfigSettings {
            agent: {
                let config = config.clone();
                Arc::new(move || serde_json::Value::Object(config.agent()))
            },
            // The developer gate: `oauth_status::oauth_available` over the stored `agent.developer` (wp-ai-svc-18).
            developer: {
                let config = config.clone();
                Arc::new(move |provider| {
                    mixdog_core_domains::domains::ai_account::oauth_status::oauth_available(
                        provider,
                        &config.agent().get("developer").cloned().unwrap_or(serde_json::Value::Null),
                    )
                })
            },
        }),
        provider_auth: provider_layer.clone(),
        http: Arc::new(mixdog_services::media::RoutedCatalogHttp::new(routed_clients.clone())),
        revision: mixdog_services::media::provider_layer::catalog_revision(registry.clone()),
    }));
    let probe = Arc::new(mixdog_services::media::AccountedProbe(file_probe.clone()));
    // The layer's late cell: it asks this probe whether a login exists. Bound once, right here; `verify_bound` checks it.
    provider_layer.attach_probe(probe.clone());
    // `CodexProviderSession::for_account(&layer, file)`: a missing login answers Node's "OpenAI OAuth not authenticated" at `auth()`.
    let default_codex_file = account_store.credential_file("openai-oauth", "default").map_err(|e| ComposeError::AccountFile(e.to_string()))?; // new variant, with the flip
    let codex_sessions: mixdog_services::media::generator::CodexSessions = {
        let layer = provider_layer.clone();
        Arc::new(move |file: Option<&std::path::Path>| {
            let credential = match file {
                Some(path) => mixdog_ai::oauth::CredentialFile::new(path.to_path_buf(), credential_io),
                None => default_codex_file.clone(),
            };
            Arc::new(mixdog_services::media::provider_layer::CodexProviderSession::for_account(&layer, credential)) as Arc<dyn mixdog_services::media::codex_image::CodexSession>
        })
    };
    let antigravity_sessions: mixdog_services::media::generator::AntigravitySessions = {
        let layer = provider_layer.clone();
        Arc::new(move |file: Option<&std::path::Path>| {
            Arc::new(mixdog_services::media::provider_layer::AntigravityProviderSession {
                layer: layer.clone(),
                account: file.map(std::path::Path::to_path_buf),
                random_uuid: Arc::new(mixdog_ai::registry::accounting::random_uuid),
            }) as Arc<dyn mixdog_services::media::antigravity_image::AntigravitySession>
        })
    };
    // Empty `host`: the credential bindings a pristine unattended run hands the generator; the daemon is never one.
    let media_generator: Arc<dyn mixdog_services::media::MediaGenerator> = Arc::new(mixdog_services::media::StudioGenerator::new(mixdog_services::media::GeneratorParts {
        data_dir: b.data_dir.clone(),
        host: Vec::new(),
        selected: selected_accounts.clone(),
        accounts: probe.clone(),
        http: json_post.clone(),
        public: Arc::new(mixdog_services::media::RoutedPublicFetch::new(
            routed_clients.clone(),
            // The `WebLanes` the web tools are composed with (a plain pair of lane tokens, `mixdog_tools::web::WebLanes`).
            mixdog_tools::web::WebLanes { extract: b.tokens.cpu_interactive, dns: b.tokens.interactive_io },
        )),
        pacer: Arc::new(mixdog_services::media::TokioPacer),
        probe: file_probe.clone(),
        provider_auth: provider_layer.clone(),
        codex: codex_sessions,
        antigravity: antigravity_sessions,
    }));
    let media_ledger: Arc<dyn mixdog_services::media::MediaUsageLedger> = Arc::new(mixdog_services::media::QueuedLedger {
        sink: usage_sink.clone(),
        pricing: Arc::new(mixdog_ai::catalog::CatalogPricing(b.catalog.clone())),
        now: now_ms.clone(),
        new_id: Arc::new(mixdog_ai::registry::accounting::random_uuid),
        account_of: mixdog_services::media::ledger_account_of(b.data_dir.clone(), Vec::new(), selected_accounts.clone()),
    });

    // The one `ProviderAdmin`: the account services (`AccountActions::over`, the account domain) and `DomainSeams.provider_roster` hold this same
    // `Arc` (`impl ProviderRoster for ProviderAdmin`, wp-ai-admin-4). `new` takes `refresh`, `registry` and `config` (all built above) plus:
    let provider_admin: Arc<mixdog_core_domains::domains::ai_account::admin::ProviderAdmin> =
        mixdog_core_domains::domains::ai_account::admin::ProviderAdmin::production(mixdog_core_domains::domains::ai_account::production::AdminParts {
            oauth: oauth_wiring,
            builder: default_builder.clone(),
            vault: process.vault.clone(),
            config: config.clone(),
            refresh: refresh.clone(),
            registry: registry.clone(),
            oauth_usage: oauth_usage.clone(),
            io: credential_io,
        });
    // The one settings effects: `DomainSeams.settings_effects` and the MCP inputs hold this `Arc`.
    let settings_effects = crate::domain_seams::settings_effects::DaemonSettingsEffects::new(
        configured_shell.clone(),
        warmer.clone(),
        config.clone(),
        readiness.clone(),
        registry.clone(),
    );
    // wp-svc-misc-9: the voice runtime installer. The manifest is the raw JSON of the bundled file (`local.rs::voice_manifest` parses the same file for the voice service; read twice, once per owner).
    let voice_manifest: serde_json::Value = {
        let path = b.package_root.join("src").join("runtime").join("channels").join("data").join("voice-runtime-manifest.json");
        let shown = path.display().to_string();
        #[allow(clippy::disallowed_methods, reason = "the body of an interactive-io lane job")]
        let text = mixdog_core_base::support::on_lane(b.tokens.interactive_io, &mixdog_rt::CancellationToken::new(), move |_lane| std::fs::read_to_string(path))
            .await
            .map_err(|error| ComposeError::VoiceManifest(format!("reading {shown}: {error:?}")))?
            .map_err(|error| ComposeError::VoiceManifest(format!("reading {shown}: {error}")))?;
        serde_json::from_str(&text).map_err(|error| ComposeError::VoiceManifest(format!("{shown} is not valid: {error}")))?
    };
    let voice_installer: Arc<dyn mixdog_services::voice::VoiceInstaller> = {
        Arc::new(mixdog_services::voice::ManagedVoiceInstaller::new(mixdog_services::voice::InstallerParts {
            data_dir: b.data_dir.clone(),
            manifest: voice_manifest.clone(),
            platform_keys: mixdog_services::tidy::install::platform_key_candidates(),
            env_vars: std::env::vars().collect(),
            pid: std::process::id(),
            durability: b.tokens.durability_io,
            bulk: b.tokens.cpu_bulk,
            now: now_ms.clone(),
        }))
    };
    let visualize_panes = Arc::new(mixdog_exthost::VisualizePanes::default());
    let seams = DomainSeams {
        provider_roster: provider_admin.clone(),
        quota_resume: quota_store.clone(),
        feature_activity: Arc::new(crate::compose_mcp::BridgeActivity::new(b.env.clone(), bridges.clone())),
        live_route: live_route.clone(), // a late cell: SessionRoutePositions::new takes the built directory (flip-ce-2 LateLiveRoute)
        settings_effects: settings_effects.clone(),
        feature_effects: crate::domain_seams::feature_effects::DaemonFeatureEffects::new(
            crate::domain_seams::office_fonts::OfficeFonts::new(
                Arc::new(mixdog_services::local_provider::assets::ReqwestFetcher::default()),
                b.tidy_processes.clone(),
                b.tokens.durability_io,
                crate::domain_seams::office_fonts::FontDirs::for_host(&|name| (b.env)(name), &home),
                std::env::vars().collect(),
            ),
            config.clone(),
            readiness.clone(),
            registry.clone(),
            gauge.clone(),
            surface_generation.clone(),
        ),
        local: crate::compose_domains::LocalSeams {
            media_generator,
            media_ledger,
            voice_installer,
            // wp-svc-misc-31: the hint line of the thread that asked for `voice/toggleVoice` (Node `setProgressHint`); published through the directory's ThreadState (late form here).
            voice_progress: Arc::new(crate::domain_seams::thread_progress_hints::ThreadProgressHints::new(Arc::new(mixdog_core::run_host::compose_parts::LateThreads(late.clone())))),
        },
        user_activity: user_activity.clone(),
        remote: built_remote.runtime.clone(),
        local_target: late_dialer.clone(), // bound by `serving::start` once the connection hub exists (true cycle: hub is built after compose)
        notification_clicks: Arc::new(crate::domain_seams::notification_clicks::LoggedClicks),
        browser_surfaces: Arc::new(crate::domain_seams::browser_surfaces::FeedSurfaces::new(
            mixdog_core_session::session::terminal_host::AppFeedOpen::new(b.sections.clone(), b.presence.clone()),
        )),
        visualize_panes: visualize_panes.clone(),
        instructions_changed: crate::domain_seams::profile_changes::InstructionsAnnounce::new(gauge.clone(), Arc::default()),
        plugins: PluginSeams {
            host: extension_host.clone(),
            git: crate::domain_seams::git::ProcessGit::new(b.tidy_processes.clone(), tokio::runtime::Handle::current(), b.data_dir.clone()),
            announce: plugins_announce.clone(),
        },
        setup_ui: late_setup_ui.clone(), // TRUE CYCLE (pool -> setup tool -> SetupRequests -> setup_ui -> directory -> pool): bound after `TurnPath::new`
        network_proxy,
        routed_clients,
        system_proxy: net.system.clone(),
        session_cwds: Arc::new(crate::compose_domains::HeaderCwds(late_headers.clone())),
        compaction_host: config_hosts.clone(),
        workflow_host: config_hosts.clone(),
    };

    // ---- 6. the config-side domains -----------------------------------------------------------
    let domain_inputs = DomainInputs {
        voice_manifest,
        tokens: b.tokens.clone(),
        paths: DomainPaths {
            data_dir: b.data_dir.clone(),
            user_data_dir: b.user_data_dir.clone(),
            package_root: b.package_root.clone(),
            node: b.js_runtime.program.clone(),
            electron: b.js_runtime.electron,
        },
        env: b.env.clone(),
        app_feed: b.app_feed.clone(),
        state: state.clone(),
        config: config.clone(),
        scoped_feeds: b.scoped_feeds.clone(),
        host: b.host.clone(),
        ext_host: b.ext_host.clone(),
        processes: b.tidy_processes.clone(),
        catalog: b.catalog.clone(),
        models: Models { tick: b.models.tick.clone(), embeddings: b.models.embeddings.clone(), effort_judge: b.models.effort_judge.clone() },
        scopes: OpScopeSource::new(b.gates.clone(), b.thread_gates.clone()),
        limits: Default::default(),
        cancel: b.cancel.clone(),
        local_provider: local_provider.clone(),
        seams,
    };
    // Stage one needs nothing of the directory; stage two runs after `TurnPath::new` (below).
    // The `agents` status reader reads the route positions of the live threads through a late cell bound after `TurnPath::new` (`SessionRoutePositions` takes the directory).
    let route_positions = Arc::new(crate::late_route_positions::LateRoutePositions::default());
    let pre = compose_domains_pre(&domain_inputs).await.map_err(ComposeError::ComposeDomains)?;
    // `thread/setWorkflow`, `thread/setOutputStyle` and the other settings of a thread read the same workflow config and output styles as the config service.
    let workflow_config = pre.workflow_config.clone();
    let output_styles = pre.output_styles.clone();

    // The one quota auto-resume switch (config key `quotaAutoResume`, on unless `false`). It is built here, ahead of the goals
    // that `SessionQuota::over_config` needs, because the providers status reader (step 7) reads it too: `SessionQuota { goals, auto_resume }`
    // below takes this same closure, as does the resume timer, so every reader sees one switch (wp-session-22 `auto_resume_enabled`).
    let auto_resume: Arc<dyn Fn() -> bool + Send + Sync> = {
        let config = config.clone();
        Arc::new(move || mixdog_core_session::session::quota_lane::auto_resume_enabled(&config))
    };
    let _quota_switch = crate::compose_mcp::QuotaSwitch(auto_resume.clone()); // -> `ProvidersStatus::new(provider_setup, provider_admin, Arc::new(quota_switch))` (wp-ai-admin-5, a status reader below)

    // ---- 7. MCP / skills / agents / setup -----------------------------------------------------
    // The core's one FolderWatcher (`FolderWatcher::new(sink)` takes ONE `ChangeSink`): the sink fans out to every watch owner, each of which keeps only
    // its own watch ids (`bridge_files` keeps `mcp.bridge`; the skills watch and the transcript watcher likewise).
    let skills_watch = Arc::new(mixdog_mcp::skills_watch::SkillsWatch::new());
    let transcript_sink = mixdog_services::memory::transcript::watcher::TranscriptSink::default();
    let core_watcher = Arc::new(
        mixdog_workspace::watcher::FolderWatcher::new(Arc::new(crate::compose_mcp::FanOutSink(vec![bridge_files.sink(), skills_watch.sink(), transcript_sink.change_sink()])))
            .map_err(|e| ComposeError::Watcher(e.to_string()))?,
    );
    bridge_files.start(core_watcher.clone()).await; // wp-mcp-4: nothing is up until the watcher exists    // The change marker of stored secrets (`mixdog-secrets-changed.json` beside the config); read as the baseline, announced on `Config::changes`.
    // flip-ce-misc + flip-gaps-agent: the ONE channel runtime and admin (`AgentEffects`' `ServiceChannels`, the doctor, `SetupSeams.automation`). Nothing here needs the directory
    // except `LateRoutineSessions`, bound after `TurnPath::new`.
    let channel_work = mixdog_services::channels::RunningWork::default();
    let channel_clock: Arc<dyn mixdog_services::scheduler::Clock> = Arc::new(mixdog_services::scheduler::SystemClock);
    let routine_sessions = Arc::new(mixdog_core::run_host::late_routine_sessions::LateRoutineSessions::default());
    let routine_agents: Arc<dyn mixdog_core::run_host::routine_host::RoutineAgents> = Arc::new(mixdog_core::run_host::routine_host::DefinitionAgents::new(agents.clone()));
    let routine_host = mixdog_core::run_host::routine_host::SessionRoutineHost::new(routine_agents.clone(), routine_sessions.clone(), heartbeats.clone());
    let routine_records: Arc<dyn mixdog_services::bots::runtime::RoutineRecords> = Arc::new(mixdog_services::bots::runtime::StoreRoutineRecords::new(schedules.clone(), webhooks.clone()));
    let local_tz: chrono_tz::Tz = mixdog_js::time::local_zone(); // the process zone Node's `Date` local fields use (`TZ`, else the OS zone)
    let routines = mixdog_services::bots::runtime::RoutineRuntime::new(routine_host, routine_records.clone(), channel_clock.clone(), local_tz);
    let scheduler = mixdog_services::scheduler::Scheduler::new(schedule_store.clone(), Arc::new(mixdog_services::bots::runner::HomeScheduleRunner::new(routines.clone())), channel_clock.clone(), channel_work.clone(), local_tz, Vec::new());
    let channel_settings: Arc<dyn mixdog_services::channels::ChannelSettings> = Arc::new(crate::domain_seams::channel_stack::ConfigChannelSettings::new(config.clone()));
    let relay_url_env = (b.env)("MIXDOG_RELAY_URL");
    let public_base: Arc<dyn mixdog_services::channels::PublicBase> = Arc::new(crate::domain_seams::channel_stack::HookIdentityBase::new(b.tokens.durability_io, b.data_dir.clone(), relay_url_env.clone()));
    let channel_agent_runtime: Arc<dyn mixdog_services::channels::AgentRuntime> = Arc::new(crate::domain_seams::channel_stack::RegistryAgentRuntime::new(config.clone(), registry.clone()));
    // The webhook event rules (`config.events`): the queue under `<data>/events`, the pipeline, and the sink that hands a fired event to the Lead as a `webhook` channel notification.
    // The Lead `webhook` channel injection (flip-channel-router-1): `injectAndRecord` + the daemon's channel router over the late directory. A webhook has no target session, as in Node's
    // daemon (`getSessionId: () => null`), so the sink is not pinned.
    let event_sink: Arc<dyn crate::event_pipeline::EventSink> = crate::channel_router::ChannelEventSink::over_directory(late.clone());
    let event_pipeline = crate::event_pipeline::EventPipeline::new(
        crate::event_pipeline::QueueFiles { fs: b.files.clone(), read: b.tokens.interactive_io, write: b.tokens.durability_io, root: mixdog_core_api::domain::common::AbsPath::new(b.data_dir.join("events")).expect("the data dir is absolute") },
        event_sink,
        config.full().get("events").unwrap_or(&serde_json::Value::Null),
        now_ms.clone(),
    );
    let webhook_events: Option<Arc<dyn mixdog_services::bots::runner::WebhookEvents>> = Some(event_pipeline.clone());
    let webhook_service = Arc::new(mixdog_services::webhooks::handler::WebhookService::new(
        webhook_store.clone(),
        Arc::new(mixdog_services::bots::runner::HomeWebhookDispatch::new(routines.clone(), webhooks.clone(), webhook_events, channel_work.clone())),
        channel_settings.webhook_config().await.map_err(ComposeError::Channels)?,
        channel_work.clone(),
        now_ms.clone(),
    ));
    let tunnels: Arc<dyn mixdog_services::webhooks::lifecycle::TunnelStarter> = Arc::new(mixdog_services::webhooks::relay::RelayTunnelStarter::new(b.tokens.durability_io, b.data_dir.clone(), relay_url_env));
    let webhook_automation: Arc<dyn mixdog_services::channels::ports::AutomationServices> = Arc::new(mixdog_services::channels::ports::WebhookAutomation::new(
        channel_settings.clone(),
        webhook_service.clone(),
        Arc::new(crate::domain_seams::channel_stack::ServerListener::new(webhook_service.clone(), tunnels)),
    ));
    let channel_runtime = mixdog_services::channels::runtime::ChannelRuntime::new(scheduler, schedules.clone(), webhook_automation, channel_agent_runtime);
    // The channels' config hot reload (Node's worker `configReloadWatch`): an edit of `channels` or `voice`, from any process, reloads the runtime.
    let channel_config_follow = mixdog_core_config::config::ChannelConfigFollow::start(config.clone(), channel_runtime.clone());
    let channel_admin = mixdog_services::channels::ChannelAdmin::new(mixdog_services::channels::AdminDeps {
        schedules: schedules.clone(),
        webhooks: webhooks.clone(),
        owned: Arc::new(mixdog_services::channels::routines_db::OwnedRoutines::new(b.core_state.clone())),
        routines: routines.clone(),
        runtime: channel_runtime.clone(),
        settings: channel_settings,
        base: public_base,
        probe: Arc::new(mixdog_services::channels::ports::ReqwestProbe::new(reqwest::Client::new())),
        clock: channel_clock.clone(),
        local_tz,
        channel_start_disabled: mixdog_services::memory::cycles::config::env_flag((b.env)("MIXDOG_DISABLE_CHANNEL_START").as_deref(), false),
        close_requested: close_requested.clone(),
    });
    // The effects' channel cell: the stack exists now (it was the cycle with `definitions`).
    agent_channels.bind(Arc::new(crate::domain_seams::agent_effects::ServiceChannels { admin: channel_admin.clone(), runtime: channel_runtime.clone() })).map_err(|_| ComposeError::AlreadyBound("agent channels"))?;
    // `skills/skillsStatus{options:{projectPath}}`: bound with the workspace and the worktree manager, which are built after the skills.
    let project_workspaces = Arc::new(crate::project_workspaces::LateProjectWorkspaces::default());
    let mcp = mcp_services(McpInputs {
        project_workspaces: project_workspaces.clone(),
        tokens: b.tokens.clone(),
        data_dir: b.data_dir.clone(),
        package_root: b.package_root.clone(),
        home: process.home_dir.clone(),
        process_env: std::env::vars().collect(),
        env: b.env.clone(),
        hub: hub.clone(),
        config: config.clone(),
        tool_modules: pre.tool_modules.clone(),
        extensions: pre.extensions.clone(),
        extension_host: extension_host.clone(),
        plugins: pre.plugins.clone(),
        workflow: pre.workflow.clone(),
        secret_store: mixdog_core_config::config::secret_changes::AnnouncingStore::new(keychain_store.clone(), secret_changes.clone()), // a saved/forgotten secret announces itself on the config's signal
        verifier: Arc::new(mixdog_mcp::gmail_verify::GmailAppPassword::default()),
        surface: crate::mcp_surface::DaemonMcpSurface::new(
            mixdog_core_session::session::UserCwd::new(b.data_dir.clone(), b.tokens.interactive_io),
            Arc::new(mixdog_core::run_host::compose_parts::LateHeaders(late.clone())),
            tool_surface.clone(),
            pre.extensions.clone(),
            plugins_announce.clone(), // cloned before it is moved to `announce:` below
            crate::mcp_surface::UrlOpener::new(b.tokens.spawn_io, (b.env)("SystemRoot").or_else(|| (b.env)("WINDIR")), crate::mcp_surface::UrlOpener::is_wsl(&b.env)),
            surface_generation.clone(),
        ),
        scoped_feeds: b.scoped_feeds.clone(),
        toasts: Arc::new(crate::compose_mcp::LateSessionToasts(late.clone())),
        bridges: bridges.clone(),
        hooks: hook_status.clone(),
        hook_observer: hook_log.clone(),
        skills_watch: skills_watch.clone(),
        git: crate::domain_seams::git::ProcessGit::new(b.tidy_processes.clone(), tokio::runtime::Handle::current(), b.data_dir.clone()),
        announce: plugins_announce,
        settings_effects: settings_effects.clone(),
        agents: agents.clone(),
        setup: SetupSeams {
            sessions: Arc::new(crate::late_session::LateCallerSessions(late.clone())), // TRUE CYCLE (setup tool -> callers -> directory -> pool)
            heartbeat: heartbeats.clone(),
            runs: held_home.clone(),
            facts: session_facts.clone(),
            desktop: pre.setup_requests.clone(),
            // wp-svc-misc-28: `VoiceToggle` over the one `VoiceSetup` that `compose_domains` built for the voice service (`PreDomains.voice_setup`, see the brief).
            voice: Arc::new(crate::compose_domains::VoiceToggle(pre.voice_setup.clone())),
            // Every other owner's `SetupActions` as `compose_domains` collected them (wp-config-setup-1: `SettingsSetup`, ...);
            // `SetupService::with_actions` takes them one at a time (compose_mcp.rs).
            other_actions: pre.setup_actions.clone(),
            automation: channel_admin.clone(), // `schedules` / `webhooks` status and actions (`AutomationActions`)
            // wp-config's `ConfigStatus` (the config-backed domains) first, then each other owner's reader; one reader per domain.
            other_status: {
                let mut readers = pre.status_readers.clone();
                readers.push(Arc::new(crate::domain_seams::media_status::MediaStatus::new(pre.media_store.clone()))); // wp-svc-misc-29 `MediaStatus` (`domains() = ["media"]`), built over the media store
                readers.push(Arc::new(mixdog_core_agents::setup::AgentsStatus::new(agents.clone(), pre.late.clone(), route_positions.clone()))); // wp-agent: `status agents`
                // `status providers` (wp-ai-admin-5): pushed into `other_status`, never `with_status` on a built service; `config` is the `QuotaAutoResumeSetting` (`quotaAutoResume !== false`, wp-ai-admin-20).
                readers.push(Arc::new(mixdog_core::run_host::provider_status_reader::ProvidersStatusReader::new(mixdog_core_domains::domains::ai_admin::provider_status::ProvidersStatus::new(
                    provider_setup.clone(),
                    provider_admin.clone(),
                    Arc::new(config.clone()),
                ))));
                readers
            },
        },
    });
    // The runtime scope connects while the daemon boots, without holding the boot up (boot/tools.mjs:57).
    drop(mcp.glue.start_runtime_scope());

    // ---- 8. the tool pool and the early rows --------------------------------------------------
    // The agent job board: finished jobs are delivered through the (late-bound) session directory. FINDING: `on_change(owner)` is Node's session
    // activity signal and no Rust consumer of it exists yet (SessionDirectory has no activity-touch API), so it stays `None` until wp-session adds one.
    // The one agent-status listener over the late directory (flip-ce-6): the job board, `StoreWorkers` and `SessionDeps.agent_signals` (flip-ce-10) share it.
    let activity = mixdog_core::run_host::agent_activity::AgentActivity::new(late.clone());
    let job_board = mixdog_agent::agent_tool::board::JobBoard::new(
        clock_agent.clone(),
        Some(Arc::new(crate::compose_mcp::LateBoardNotifier(late.clone()))),
        // The session-activity signal: the one `AgentActivity` listener (flip-ce-6); unbound, no thread is loaded, so nothing hears it, as in Node.
        Some(activity.name_listener()),
    );
    let early = early_rows(EarlyIn {
        data_dir: b.data_dir.clone(),
        durability: b.tokens.durability_io,
        threads: late_threads,
        clock: clock.clone(),
        board: job_board.clone(),
        exec: b.exec.clone(),
    });
    // The `git` tool's `SessionWorktrees` (`WorktreeServices.sessions`): a late cell, bound right after `SessionWorkspaces` is built (it needs the directory) and in `verify_bound`.
    let late_workspaces = Arc::new(crate::late_session::LateWorkspaces::default());
    // ---- the tool pool: `orch::register::tools(Services{..})` ----
    // Inputs the pool and the later stages both hold (moved up from where they were first needed): the one SCM engine, the turn review, the config document.
    // The ONE SCM engine (git and `gh` through the process manager): the turn review's git runner, `Worktrees` (and so the worktree maintenance, the workspace
    // sessions, the project service, the setup and the git tool) and the scm domain service take the same `Arc`. `<data>/scm-scratch` is review scratch only
    // (flip-worktree-2): commit scratch is `<os tmp>/mixdog-commit-<pid>-*`, swept per commit by dead pid, so there is no boot sweep (`boot_sweep` is removed).
    let scm = mixdog_scm::engine::Scm::new(b.process_manager.clone(), b.tokens.maintenance_io, b.data_dir.join("scm-scratch"));
    let review_bases = Arc::new(mixdog_scm::worktree::review_bases::CapturedBases::new());
    let turn_review = Arc::new(mixdog_core_review::turn_review::TurnReview::over_scm(scm.clone(), b.tokens.clone(), &b.data_dir, |name| (b.env)(name), review_bases.clone()));
    mixdog_core_review::turn_review::seams::follow_read_state(turn_review.clone(), &read_state);
    // `getConfigSnapshot({ secrets: false })` (the route hop's `HopDeps.config`, the summary, explorer, maintainer and title hosts): the live agent config. The hosts read its
    // `providers`, `agents`, `default` and the agent roster (`agent_disabled`), all of which are keys of the `agent` section, not of the file's root.
    let config_snapshot: mixdog_core_run::run_host::hop_host::ConfigSnapshot = {
        let config = config.clone();
        Arc::new(move || config.agent())
    };
    // The ONE secret fill (`approval/provideSecret`'s slots, the takeover gates, Computer Use commands on the session's helper, the claimed desktop channel): the redactor of each session's computer backend and the
    // handoff env's `fill` (`compose-seams.md`, "secret redaction in tool replies"). TRUE CYCLE: the fill types on the helper pool and the pool wraps its backends with the fill's redaction: the pool is bound into `late_computer_hosts` right after it is built.
    let late_computer_hosts = Arc::new(crate::late_session::LateComputerHosts::default());
    let fill = Arc::new(mixdog_core_session::session::secret_input::SecretFill::new(
        secret.slots.clone(),
        Arc::new(mixdog_core_session::session::secret_input::TakeoverGates::new(Arc::new(crate::late_session::LateHolds(late.clone())))),
        Arc::new(mixdog_core_session::session::secret_input::HostComputerCommands::new(late_computer_hosts.clone())),
        b.claimed_host.clone(),
    ));
    // The helper binary (`MIXDOG_COMPUTER_BIN`, else bundled `native-tools/`, else the local build); `cached` is `None`: nothing in this core downloads a native tool (the Computer places do not include the download).
    let native_paths = Arc::new(mixdog_core::run_host::native_tools::NativeToolPaths::new(
        b.env.clone(),
        b.package_root.clone(),
        Arc::new(mixdog_core::run_host::native_tools::FileServiceExists { files: b.files.clone(), lane: b.tokens.interactive_io }),
        None,
    ));
    let computer_pool: Option<Arc<mixdog_core::run_host::native_tools::ComputerSessionPool>> = native_paths
        .computer_sessions(b.process_manager.clone(), Arc::new({
            let fill = fill.clone();
            move |session: &str, inner: Arc<dyn mixdog_core_api::domain::computer::ComputerBackend>| {
                Arc::new(mixdog_core_session::session::secret_input::RedactingComputerBackend::new(inner, mixdog_core_api::ids::ThreadId::from(session), fill.clone())) as Arc<dyn mixdog_core_api::domain::computer::ComputerBackend>
            }
        }), pre.state.publisher.clone())
        .await;
    late_computer_hosts.bind(computer_pool.clone()).map_err(|_| ComposeError::AlreadyBound("computer hosts"))?;
    // Directory-side inputs of the pool, bound after `TurnPath::new` (true cycles, `flip-brief.md`): the `call_tool` dispatcher resolves through the pool it sits in, the session catalog reads the surface
    // host that holds the pool, the react tool's reactions open threads on the directory, and the `agent` tool needs the `AgentPort` of `assemble(AgentParts{..})` (flip-agent-worlds-15 `LateAgentPort`).
    let late_dispatcher = Arc::new(crate::late_session::LateDispatcher::default());
    let late_catalog = Arc::new(crate::late_session::LateCatalog::default());
    let late_list_catalog = Arc::new(crate::late_session::LateListCatalog::default()); // the `session` tool's list reads the thread list service, bound once it is built (below); in `verify_bound`
    let late_skills = Arc::new(crate::late_session::LateSkills::default());
    let late_reactions = Arc::new(crate::late_session::LateReactions::default());
    let late_agent_port = Arc::new(mixdog_core::run_host::late_agent_port::LateAgentPort::default());
    // The process, terminal and pending-wait services the pool's `terminals`/`pending` are built over (compose-seams.md 'process, terminal, system'): ONE `PendingWaits` (also registered as a domain service
    // for `ui/newTab/created` and `ui/terminalRun/claimed`; `cancel_all` at shutdown), ONE `TerminalService` whose tabs the `terminal` tool shares with the desktop's.
    let pending_waits = mixdog_tools::desktop::pending::PendingWaits::new(mixdog_rt::ticker().clone(), mixdog_tools::desktop::pending::NEW_TAB_WAIT, mixdog_tools::desktop::pending::TERMINAL_CLAIM_WAIT);
    let process_feeds = mixdog_spawn::service::ProcessFeeds::new(b.local_processes.clone(), b.scoped_feeds.clone());
    let terminal = mixdog_spawn::service::TerminalService::new(
        b.local_processes.clone(),
        process_feeds.clone(),
        pre.state.publisher.clone(),
        mixdog_spawn::service::TerminalServiceConfig { shell_integration_dir: Some(b.user_data_dir.join("shell-integration")) }, // `join(userDataPath, 'shell-integration')`, desktop-operations.ts:625
    );
    // The one "a folder is going away" hook set: `project/delete` (workspace) and worktree removal run it; the terminals register here (`termDisposeUnder`), the language servers where they are built.
    let folder_releases = mixdog_workspace::release::FolderReleases::new();
    folder_releases.add(Arc::new(crate::terminal_folder_release::TerminalFolderRelease::new(terminal.tabs().clone())));
    // Browser/handoff host: the desktop channel, its replies redacted, and the runtime-only secret actions served by the fill (compose-seams.md 'secret redaction in tool replies').
    let pool_host: Arc<dyn mixdog_tools::desktop::host::HostCommands> = Arc::new(mixdog_core_session::session::secret_input::SecretHostCommands::new(
        Arc::new(mixdog_core_session::session::secret_input::RedactingHostCommands::new(mixdog_tools::desktop::host::ChannelHostCommands::new(b.host.clone()), fill.clone())),
        fill.clone(),
    ));
    let tool_io = mixdog_core_api::domain::tool::ToolIo { interactive: b.tokens.interactive_io, durability: b.tokens.durability_io, maintenance: b.tokens.maintenance_io };
    // The explorer (flip-agent-worlds-15): `AgentExplorer::standalone` over the shared lanes; the host is bound to the finished pool below.
    let explorer_host = Arc::new(mixdog_core::run_host::explorer_host::ConfigExplorerHost::new(config_snapshot.clone(), registry.clone()));
    let explorer = Arc::new(
        mixdog_core::run_host::explorer_env::ExplorerEnv {
            clock: clock_agent.clone(),
            cwd: mixdog_core_api::domain::common::AbsPath::new(startup_cwd.clone()).ok_or_else(|| ComposeError::Config("the startup folder is not absolute".to_owned()))?,
            files: b.files.clone(),
            processes: b.process_manager.clone(),
            io: tool_io,
        }
        .explorer(explorer_host.clone()),
    );
    let contacts = Arc::new(mixdog_core_agents::agents::ContactIds::new(mcp.agents.clone()));
    let thread_state = Arc::new(LateThreads(late.clone()));
    let (dispatch_policy, dispatch_connectors) = (policy.clone(), connectors.clone()); // both move into the turn path parts
    // The project registry file (`projects.json`): the code-graph trust reads it strictly, the `session` tool's project listing tolerantly (`crate::code_graph_trust::RegistryProjects`).
    let project_registry = Arc::new(mixdog_store::registry::Registry::new(mixdog_home.join("projects.json")));
    let project_list: Arc<dyn mixdog_core::run_host::tool_pool::session_port::ProjectList> = Arc::new(crate::code_graph_trust::RegistryProjects { registry: project_registry.clone(), lane: b.tokens.maintenance_io });
    let bot_ids: Arc<dyn mixdog_core::run_host::tool_pool::session_port::BotIds> = Arc::new(mixdog_core::run_host::tool_pool::session_port::ContactBotIds::new(mcp.agents.clone(), contacts.clone()));
    // What `session bots` reads besides the catalog; its report watches are the home delivery's, bound once that exists (in `verify_bound`).
    let bot_world = Arc::new(crate::late_session::DaemonBotWorld::new(bot_ids.clone(), config.clone(), channel_admin.clone(), held_requests.clone()));
    let mut tool_pool: Vec<Arc<dyn mixdog_core_api::domain::tool::Tool>> = mixdog_tools::orch::register::tools(mixdog_tools::orch::register::Services {
        facts: Arc::new(mixdog_core::run_host::tool_pool::callers::ThreadCallers::new(thread_state.clone(), heartbeats.clone(), unattended.clone())),
        sessions: Arc::new(mixdog_core::run_host::tool_pool::session_port::DirectorySessionPort::new(mixdog_core::run_host::tool_pool::session_port::SessionPortParts {
            callers: Arc::new(mixdog_core::run_host::tool_pool::callers::ThreadCallers::new(thread_state.clone(), heartbeats.clone(), unattended.clone())),
            threads: thread_state.clone(),
            requests: Arc::new(crate::late_session::LateRequests(late.clone())),
            titles: Arc::new(mixdog_core_session::session::session_title::StoredTitles::new(thread_state.clone(), thread_state.clone(), clock_agent.clone())),
            ai_titles: Arc::new(config.clone()),
            projects: project_list.clone(),
            bots: bot_ids.clone(),
            world: bot_world.clone(),
            quota: quota_store.clone(),
            suggestions: Arc::new(mixdog_core::run_host::tool_pool::session_port::HeartbeatSuggestions::new(heartbeat_store.clone(), now_ms.clone())),
            catalog: late_list_catalog.clone(),
            clock: clock_agent.clone(),
            io: b.tokens.interactive_io,
        })),
        agents: late_agent_port.clone(),
        explorer: explorer.clone(),
        skills: late_skills.clone(), // `CatalogSkillPort`, bound once the surface host exists (skills-producers-1)
        catalog: late_catalog.clone(),
        dispatcher: late_dispatcher.clone(),
        setup: mcp.setup.clone(),
        media: Arc::new(mixdog_services::media::tool::MediaToolService::new(
            Arc::new(mixdog_services::media::tool::StudioGraph {
                jobs: pre.media_jobs.clone(),
                store: pre.media_store.clone(),
                accounts: Some(Arc::new(mixdog_services::media::accounts::StudioAccounts { data_dir: b.data_dir.clone(), host: Vec::new(), selected: selected_accounts.clone(), probe: probe.clone() })),
            }),
            b.tokens.durability_io,
            // `getSession(sessionId)?.sourceType`: the loaded session's header (a session that is not loaded has none).
            Arc::new({
                let late = late.clone();
                move |session: &str| {
                    use mixdog_core::run_host::session_catalog::RunningHeaders as _;
                    let directory = late.directory().expect("session directory bound (compose::verify_bound)");
                    directory.header(&mixdog_core_api::ids::ThreadId::from(session)).and_then(|header| header.get("sourceType").and_then(serde_json::Value::as_str).map(str::to_owned)).unwrap_or_default()
                }
            }),
        )),
        tidy: Arc::new(mixdog_services::tidy::front::TidyToolService(mixdog_services::tidy::tool::TidyTool::new(
            Arc::new(mixdog_core::run_host::tidy_write_host::ProcessTidyHost {
                plugin_data: b.data_dir.clone(),
                native: native_paths.clone(),
                write_host: Arc::new(mixdog_core::run_host::tidy_write_host::ReviewedWriteHost::new(b.files.clone(), tool_io, read_state.clone(), turn_review.clone())),
                outline_source: Arc::new(mixdog_services::tidy::graph_outline::GraphOutlineSource::new(b.tokens.cpu_bulk)),
                fetcher: Arc::new(mixdog_services::local_provider::assets::ReqwestFetcher::default()),
            }),
            b.tidy_processes.clone(),
        ))),
        ext_pool: b.ext_host.clone(),
        office_writes: Arc::new(mixdog_tools::orch::office_writes::TurnReviewWrites::new(Arc::new(mixdog_core_review::turn_review::seams::ToolReviewRecorder::new(
            turn_review.clone(),
            Arc::new(crate::late_session::LiveThreadCwd(late.clone())),
        )))),
        data_dir: b.data_dir.to_string_lossy().into_owned(),
        todos: early.todos.clone(),
        goals: early.goals.clone(),
        reactions: late_reactions.clone(),
        handoff: Arc::new(mixdog_core::run_host::handoff_env::SessionHandoffEnv::new(
            unattended.clone(),
            grants.clone(),
            fill.clone(),
            late_computer_hosts.clone(),
            Arc::new(crate::late_session::LateAborts(late.clone())),
        )),
        ids: Arc::new(|| format!("secret_{}", mixdog_ai::registry::accounting::random_uuid())),
        host: pool_host,
        pending: pending_waits.clone(),
        terminals: Arc::new(mixdog_tools::desktop::terminal::TabsTerminalPort::new(
            terminal.tabs().clone(),
            Arc::new(mixdog_tools::desktop::reveal::RevealingTerminalHost::new(
                Arc::new(mixdog_core_session::session::terminal_host::DirectoryCwds::new(late.clone())),
                Arc::new(mixdog_core_session::session::terminal_host::AppFeedOpen::new(pre.state.app.clone(), b.presence.clone())),
                pending_waits.clone(),
            )),
        )),
        command_policy: Arc::new(mixdog_tools::desktop::terminal::ExecPolicyGate::node()),
        computer: computer_pool.clone().map(|pool| pool as Arc<dyn mixdog_core_api::domain::computer::ComputerSessions>),
    });
    // The `code_graph` tool: built here (the pool's `Services` does not carry it) so the composition keeps the Arc: the prewarm timer, the workspace `project/codeGraph` adapter
    // and the cache's exit drain share it. `GraphCache::drain` is a stop step (`Real::session_shutdown_step`).
    let code_graph_cache = Arc::new(mixdog_tools::code_graph::GraphCache::new(b.data_dir.join("code-graph-cache")));
    let code_graph = Arc::new(mixdog_tools::code_graph::CodeGraphTool::new(
        Arc::new(crate::code_graph_trust::UserTrustedRoots {
            registry: project_registry,
            user_cwd: mixdog_core_session::session::UserCwd::new(b.data_dir.clone(), b.tokens.interactive_io),
            lane: b.tokens.maintenance_io,
        }),
        code_graph_cache.clone(),
    ));
    tool_pool.push(code_graph.clone());
    // The built-in file, process, git and web tools, the explorer's bind and the ready rows follow the worktrees (below): the `git` tool needs them, and the ready rows and the explorer keep a snapshot of the finished pool.

    // ---- 10. memory, session deps, owed parts, the turn path ----------------------------------
    // The one catalog index (`<data>/index/store.sqlite`): `StoreThreads` and `DirectoryImportSessions` hold this handle. Its open
    // (a boot purge, a rebuild from the logs when needed) blocks, so it is a maintenance lane job.
    let catalog_index = {
        let (data, thread, read) = (b.data_dir.clone(), b.tokens.sqlite_writer_thread, b.tokens.interactive_io);
        b.tokens
            .maintenance_io
            .submit(&b.cancel, move |lane| mixdog_store::sqlite::SqliteStore::open(lane, thread, read, &data))
            .map_err(|_| ComposeError::CatalogIndex("the maintenance lane refused the job".to_owned()))? // new variant, added with the flip
            .await
            .map_err(|_| ComposeError::CatalogIndex("the open job was dropped".to_owned()))?
            .map_err(|e| ComposeError::CatalogIndex(e.to_string()))?
    };
    // The bundled PostgreSQL runtime (downloaded first when the active one is missing or damaged, `ensureRuntime`), then the memory stack.
    // Node installs the runtime inside the memory start (`supervisor.mjs:484`), which runs at the first memory use and never at daemon boot: so the install is handed to the
    // stack as what it runs when the database is first opened, not awaited here (a fresh profile downloads about 22 MB and runs `initdb`).
    let pg_runtime = {
        use mixdog_services::memory::pg::runtime_install as pg;
        let (data_dir, release_repositories, durability, bulk, now) = (b.data_dir.clone(), pg::repositories_env(|name| (b.env)(name)), b.tokens.durability_io, b.tokens.cpu_bulk, now_ms.clone());
        let production: mixdog_services::memory::boot::PgInstall = Arc::new(move |cancel| {
            let (data_dir, release_repositories, now) = (data_dir.clone(), release_repositories.clone(), now.clone());
            Box::pin(async move {
                let options = pg::InstallOptions {
                    data_dir,
                    manifest: pg::Manifest::bundled().map_err(|e| mixdog_services::memory::error::MemoryError::Runtime(e.to_string()))?,
                    platform: pg::Platform::current(),
                    release_repositories,
                    durability,
                    bulk,
                    now,
                    progress: None,
                };
                pg::ensure_runtime(&options, &cancel).await.map(|installed| installed.runtime_dir).map_err(|e| mixdog_services::memory::error::MemoryError::Runtime(e.to_string()))
            })
        });
        #[cfg(test)]
        let production = b.pg_install.clone().unwrap_or(production);
        mixdog_services::memory::boot::PgRuntimeSource::Install(production)
    };
    let store_threads = Arc::new(mixdog_core_session::session::StoreThreads::new(
        &b.data_dir,
        blobs.clone(),
        catalog_index.clone(),
        mixdog_store::log::WriterDeps { io: Arc::new(mixdog_store::log::OsIo), blobs: blobs.clone(), ownership: ownership.clone(), index: Arc::new(catalog_index.clone()) },
        b.tokens.maintenance_io,
    ));
    // One instance for the actors and the logs: what a log rewrites after a mark is what the actors hold in full.
    let sensitive_marks: Arc<dyn mixdog_core_session::session::SensitiveMarks> = Arc::new(mixdog_core_session::session::store::SensitiveMarksOf::new(sensitive.clone()));
    if store_threads.redact_with(sensitive_marks.clone()).is_err() {
        unreachable!("the thread store is bound once, here");
    }
    // Before any thread is served (no directory can open a log yet): marks a previous run journaled and did not apply
    // everywhere are marked again and their sessions rewritten.
    store_threads.settle_marks(b.tokens.durability_io).await.map_err(|e| ComposeError::Config(format!("sensitive marks: {e:?}")))?;
    // The stored sessions, shared with the search backfill and `StoredConsumers`; the snapshot cleanups, built once.
    let session_lanes = || mixdog_core_session::session::SessionLanes { cpu: b.tokens.cpu_interactive, io: b.tokens.interactive_io, durability: b.tokens.durability_io };
    let stored_sessions = Arc::new(mixdog_core_session::session::search_backfill::StoredSearchSessions::new(
        store_threads.clone(),
        session_lanes(),
    ));
    let late_cycle_llm = Arc::new(crate::late_session::LateCycleLlm::default()); // bound after `TurnPath::new` (the memory stack is an input of it)
    let memory = mixdog_services::memory::boot::MemoryStack::start(mixdog_services::memory::boot::MemoryBoot {
        data_dir: b.data_dir.clone(),
        pg_runtime,
        embedder: b.models.embeddings.clone(),
        embedding_provider: config.full().get("embedding").and_then(|e| e.get("provider")).and_then(serde_json::Value::as_str).map(str::to_owned),
        flags: mixdog_services::memory::runtime::RuntimeFlags::from_env(&*b.env),
        progress: None,
        sensitive: sensitive.clone(),
        lane: b.tokens.durability_io,
        maintenance: b.tokens.maintenance_io,
        transcripts: Some(mixdog_services::memory::boot::TranscriptWatch {
            projects_root: mixdog_home.join("projects"),
            folders: core_watcher.clone(),
            sink: transcript_sink,
            timer: Arc::new(mixdog_services::bots::delivery::env::SleepRetry),
        }),
        cycles: Some(mixdog_services::memory::boot::CycleBoot {
            config: Arc::new(mixdog_services::memory::cycles::config::DocCycleConfig::new({ let config = config.clone(); Arc::new(move || config.full()) }, mixdog_services::memory::cycles::config::process_env())),
            llm: late_cycle_llm.clone(),
            timer: Arc::new(mixdog_services::bots::delivery::env::SleepRetry),
        }),
        backfill: Some(mixdog_services::memory::boot::BackfillBoot { stored: stored_sessions.clone(), timer: Arc::new(mixdog_services::bots::delivery::env::SleepRetry) }), // the same `StoredSearchSessions` as `StoredConsumers` and `StoredWorktreeSessions`
        processes: b.tidy_processes.clone(),
        cancel: b.acquired.token(), // a stop during startup ends the `initdb` and the PostgreSQL start wait
    })
    .await
    .map_err(|e| ComposeError::MemoryRuntime(e.to_string()))?;
    // Every later failure of this composition stops the stack, PostgreSQL last (`memoryRuntime.stop`, `daemon.mjs:377,383`); a composed core stops it in its own stop step.
    b.acquired.on_release("memory", {
        let memory = memory.clone();
        async move { memory.stop_for_quit().await }
    });
    // The one session-search writer of the memory service: `SessionDeps.search` and the import sessions ingest through it.
    // Under `MIXDOG_DAEMON_SKIP_MEMORY=1` the process has no memory runtime, and its session-search copy would start one.
    let skip_memory = (b.env)("MIXDOG_DAEMON_SKIP_MEMORY").as_deref() == Some("1");
    let session_search = Arc::new(mixdog_core_session::session::SessionSearchTurns::new((!skip_memory).then(|| memory.search())));
    let pending = |directory: &Arc<mixdog_core_session::session::SessionDirectory>| pending_rows(directory, clock.clone());
    let _ = pending;
    // The thread store: `StoreThreads::over_data_dir` with the ONE `BlobStore` (its pins are in-memory) instead of a second one it would make itself:
    // the sessions directory first (a maintenance job), then the writer deps the same way `over_data_dir` builds them.
    {
        let sessions_dir = b.data_dir.join("sessions");
        b.tokens
            .maintenance_io
            .submit(&b.cancel, move |_lane| mixdog_store::fsio::create_dir_durable(&sessions_dir))
            .map_err(|_| ComposeError::StateDir(std::io::Error::other("the maintenance lane refused the sessions directory")))?
            .await
            .map_err(|e| ComposeError::StateDir(std::io::Error::other(e)))?
            .map_err(|e| ComposeError::StateDir(std::io::Error::other(format!("{e:?}"))))?;
    }
    let worktrees = Arc::new(
        mixdog_scm::worktree::manager::Worktrees::new(scm.clone(), b.data_dir.clone())
            .with_root_cleanup(Arc::new(mixdog_scm::worktree::release::FolderReleaseCleanup::new(folder_releases.clone())))
            .with_settings(Arc::new(mixdog_core_config::config::ConfigWorktreeSettings::new(config.clone())))
            .with_activity(Arc::new(mixdog_scm::worktree::activity::Activity::new(&b.data_dir))),
    );
    let snapshot_cleanups = mixdog_core_session::session::worktree::SnapshotCleanups::new();
    // The sessions the worktree jobs and the workspaces ask about (wu-scm-10), and the live-session ids, each ONE value shared by `WorktreeMaintenance`,
    // `SessionWorkspaces` and `ProjectService`. `live` reads the late directory: `LateDirectory` is in `verify_bound`; an unbound read must never answer
    // "no live sessions" (maintenance could then reclaim a live worktree), and `verify_bound` makes it unreachable.
    let worktree_sessions: Arc<dyn mixdog_scm::worktree::maintenance::SessionSource> =
        Arc::new(mixdog_core_session::session::worktree::worktree_sessions::StoredWorktreeSessions::new(stored_sessions.clone(), b.shell_control.tasks().clone()));
    let live_ids: Arc<dyn Fn() -> Vec<String> + Send + Sync> = {
        let late = late.clone();
        Arc::new(move || late.directory().expect("session directory bound (compose::verify_bound)").loaded_ids().into_iter().map(|id| id.as_str().to_owned()).collect())
    };
    let worktree_maintenance = Arc::new(mixdog_core_session::session::worktree::worktree_maintenance::WorktreeMaintenance::new(
        worktrees.clone(),
        worktree_sessions.clone(),
        { let ids = live_ids.clone(); Arc::new(move || ids().into_iter().collect()) },
        snapshot_cleanups.cancel_hook(),
    ));
    // ---- the built-in file, process, git and web tools (prompt-seed-1 §2) ------------------------------------------------------------------------------
    // Node's `BUILTIN_TOOLS` in its order (`builtin-tools.mjs:95`: read, edit, shell, git, github, task, grep, glob, find, list), then `PATCH_TOOL_DEFS` (`apply_patch`), then the web defs
    // (`collectStandaloneToolDefs`: web_search, web_fetch, local_fetch, image_fetch), after `code_graph`; the surfaces sort them into route order (`session_tools::route_rank`).
    // `read`, `edit` and `apply_patch` share the ONE `ReadState`; `shell` and `task` the ONE `ExecRuntime`; `git` the engine's repository locks and the ONE `Worktrees`.
    // Not here: `recall` and `memory`, which have no `Tool` implementation anywhere in the tree.
    let ext_pool: Arc<dyn mixdog_core_api::domain::ext::ExtPool> = b.ext_host.clone();
    let image_resizer: Arc<dyn mixdog_core_api::domain::ext::ImageResizer> = Arc::new(mixdog_exthost::ExtImageCodec::new(ext_pool.clone()));
    tool_pool.push(Arc::new(mixdog_tools::fs::ReadTool::new(Some(ext_pool), Some(image_resizer)).with_state(read_state.clone())));
    tool_pool.push(Arc::new(mixdog_tools::fs::EditTool::new().with_state(read_state.clone())));
    tool_pool.push(Arc::new(mixdog_tools::exec::ShellTool::new(b.exec.clone())));
    tool_pool.push(Arc::new(mixdog_tools::git::GitTool::with_locks(scm.locks.clone()).with_worktrees(Arc::new(mixdog_tools::git::WorktreeServices {
        worktrees: worktrees.clone(),
        stored: worktree_sessions.clone(),
        live: { let ids = live_ids.clone(); Arc::new(move || ids().into_iter().collect()) },
        sessions: late_workspaces.clone(), // bound right after `SessionWorkspaces` is built; in `verify_bound`
    }))));
    // The agent's `github` is the desktop's GitHub client (one write queue per repository), its raw results kept in the data directory.
    tool_pool.push(Arc::new(mixdog_tools::github::GithubTool::new(scm.github.clone(), Some(b.data_dir.clone()))));
    tool_pool.push(Arc::new(mixdog_tools::exec::TaskTool::new(b.exec.clone())));
    tool_pool.push(Arc::new(mixdog_tools::fs::GrepTool::new()));
    tool_pool.push(Arc::new(mixdog_tools::fs::GlobTool::new()));
    tool_pool.push(Arc::new(mixdog_tools::fs::FindTool::new()));
    tool_pool.push(Arc::new(mixdog_tools::fs::ListTool::new()));
    tool_pool.push(Arc::new(mixdog_tools::fs::ApplyPatchTool::new().with_state(read_state.clone())));
    // The web tools over one `WebService`: pages render in the shared render browser, and the page and search caches persist in `cache.local.json` of the data directory (`web-search/lib/config.mjs`).
    // `search` stays unset: the hosted search needs a `SearchHost` (the live Main route and the asking session), which has no implementation in the tree yet, so `web_search` answers Node's
    // "web search provider unavailable" (`web/search.rs`); `web_fetch`, `local_fetch` and `image_fetch` do not depend on it.
    let web_lanes = mixdog_tools::web::WebLanes { extract: b.tokens.cpu_interactive, dns: b.tokens.interactive_io };
    let page_renderer: Arc<dyn mixdog_tools::web::PageRenderer> = mixdog_tools::web::BrowserRenderer::new(Arc::new(b.ext_host.render_browser()), &build_version, web_lanes)
        .map_err(|e| ComposeError::Config(format!("the web page renderer could not be built: {e}")))?;
    let mut web_config = mixdog_tools::web::WebConfig::new(build_version.clone(), web_lanes);
    web_config.renderer = Some(page_renderer);
    web_config.cache_file = Some(mixdog_tools::web::CacheFile { path: b.data_dir.join("cache.local.json"), lane: b.tokens.maintenance_io });
    // The hosted web search (`createNativeWebSearch`, `boot/providers.mjs:201-222`): one host for every thread; the asking thread picks the route cell and the session.
    let search_host = Arc::new(mixdog_core_domains::domains::ai_admin::web_search_host::RegistrySearchHost {
        cells: routes.clone() as Arc<dyn mixdog_core_ports::ports::route::LiveRoute>, // the route cell of every conversation (the one `routes`)
        config: config.clone(),
        catalog: b.catalog.clone(),
        readiness: readiness.clone(),
        registry: registry.clone(),
    });
    let search_usage = mixdog_tools::web::NativeSearchUsageSinks::new();
    let search_sender = mixdog_tools::web::ProviderSearchSender::new(
        search_host.clone(),
        mixdog_tools::web::SenderDeps {
            broker: broker.clone(), // the one broker (`broker.admission()` lanes, shared with the main sends)
            pricing: Arc::new(mixdog_ai::catalog::CatalogPricing(b.catalog.clone())),
            ledger: Some(usage_sink.clone()), // the one ledger source, asked per row
            sinks: search_usage.clone(), // the registry the runs register their turn in (`TurnPathParts.search_usage`)
            lane: mixdog_tools::web::SenderDeps::default_lane(&broker),
            account: Arc::new(account_store.clone()), // the roster each row's account is read from
            now: mixdog_tools::web::SenderDeps::system_clock(),
        },
    );
    let hosted_search: Arc<dyn mixdog_tools::web::NativeWebSearch> =
        mixdog_tools::web::HostedWebSearch::new(mixdog_tools::web::ConfiguredSearchRoutes::new(search_host), search_sender);
    web_config.search = Some(hosted_search);
    let web = mixdog_tools::web::WebService::new(web_config).map_err(|e| ComposeError::Config(format!("the web tools could not be built: {e}")))?;
    tool_pool.extend(web.tools());
    // After `tools(..)` (the pool holds `explore`, which holds the host) and after the last read-only tool is registered: `bind` keeps one snapshot, and Node's
    // `readOnlyFilesystemTools()` (`tool-resolution.mjs:96`) is `code_graph, find, glob, list, grep, read`.
    explorer_host.bind(&tool_pool);
    tool_pool.extend(memory.tools(Arc::new(crate::memory_callers::ThreadMemoryCallers::new(
        Arc::new(crate::late_session::LateCallerSessions(late.clone())),
        mcp.callers.clone(),
        held_home.clone(),
    ))));
    #[cfg(test)]
    let kept_tool_pool = tool_pool.clone();
    // ---- 9. the ready rows --------------------------------------------------------------------
    let ready = ready_rows(
        &process,
        ReadyIn {
            data_dir: b.data_dir.clone(),
            env: b.env.clone(),
            tool_pool: tool_pool.clone(),
            hub: hub.clone(),
            skills: mcp.catalog.clone(),
            heartbeats: heartbeats.clone(),
            blobs: blobs.clone(),
        },
    );
    let (ready_resolver, ready_allow_all) = (ready.resolver.clone(), ready.allow_all.clone()); // the dispatcher is built from the very values the turn path holds
    let approval_ids = Arc::new(mixdog_core_base::approvals::StoreApprovalIds::open(b.core_state.clone()).await.map_err(ComposeError::State)?);
    // The one side-question store and what a capture reads; `SideWiring` hands out the request source, the next-request source and the questions service.
    let sections = b.sections.clone(); // the composed one (`ComposedCore::sections()`), the same `serving::start` takes
    // The purge hooks a deleted session runs (warm cache, read state, transcript offsets, provider connections, worker turns, the worker index).
    // The worker index (flip-ce-7): `turn_starts` binds to it, the `Owed` rows and the host runtime read it. `StoreWorkers` hears the status signals (flip-ce-10).
    let reap = Arc::new(mixdog_core::run_host::agent_inputs::ConfigReap::new(config.clone())); // the one reap `recover` also takes
    let store_workers = Arc::new(mixdog_core_session::session::agent_registry::StoreWorkers::new(
        catalog_index.clone(),
        Arc::new(LateThreads(late.clone())),
        b.tokens.interactive_io,
        // The rows of sessions deleted while they still count, kept in the core's state as Node's index file keeps them.
        Arc::new(mixdog_core_session::session::agent_registry::KeptRows::new(b.core_state.clone())),
    ));
    store_workers.bind_signals(activity.signals()).map_err(|_| ComposeError::AlreadyBound("store worker signals"))?;
    #[cfg(feature = "replay-controls")]
    let replay_workers = store_workers.clone();
    let agent_registry = Arc::new(mixdog_core_session::session::agent_registry::AgentRegistry::new(
        store_workers,
        Arc::new(mixdog_core::run_host::agent_inputs::LateLiveSessions(late.clone())),
        reap.clone(),
        clock.clone(),
    ));
    // flip-gaps-pool-3: the computer-use helper pool (`Services.computer` of the tool pool) and its two lifetime hooks. The shells compose hands out as `Arc<dyn OwnedShells>`
    // (`SessionDeletion.shells`, `SessionClose::new`, `AgentSessions::new`, the context-switch host) are the `ReapingShells` decorator, which releases the closing owner's computer
    // session; `SessionDeps.snapshots` is `SettlingSnapshots`, which ends the turn's computer execution and defers the release. Without a helper (`None`) both are the plain values.
    let owned_shells: Arc<dyn mixdog_core_session::session::shell_jobs::OwnedShells> = match &computer_pool {
        Some(pool) => Arc::new(mixdog_core::run_host::native_tools::ReapingShells::new(b.shell_control.clone(), pool.clone())),
        None => b.shell_control.clone(),
    };
    let shell_strips: Arc<dyn mixdog_core_session::session::shell_jobs::ShellStrips> = b.shell_control.clone();
    // The one archive retention (`desktop.retentionState`): `ThreadSettingsParts.retention` and `PurgeOwners.retention` (wp-session-33/-40).
    let archive_retention = Arc::new(mixdog_core_session::session::thread_settings::ConfigArchiveRetention::new(config.clone(), Arc::new(|| mixdog_rt::utc_now!().timestamp_millis())));
    // flip-gaps-agent: the agent tool's `WorkerTurns` (the SAME value is `AgentParts.turns` and `PurgeOwners.worker_turns`); `changed` is `statusMayHaveChanged`.
    let worker_turns = mixdog_agent::agent_tool::flow::worker_turns::WorkerTurns::new(
        Arc::new(mixdog_core::run_host::agent_inputs::LateTurnSource(late.clone())),
        agent_registry.clone(),
        agent_registry.clone(),
        clock_agent.clone(),
        { let activity = activity.clone(); Arc::new(move || activity.everyone()) },
    );
    // The conversation transcripts' writers, one per process: the sessions append through them, a delete stops them, and a marked
    // value is redacted in their files through memory's ingest (its read position kept on the same line).
    let transcript_files = mixdog_core_session::session::transcript_writer::TranscriptFiles::new(&mixdog_home, b.tokens.durability_io, clock.clone(), sensitive.clone());
    transcript_files.attach_ingest(memory.transcripts() as Arc<dyn mixdog_core_session::session::purge::IngestOffsets>);
    let purge = mixdog_core_session::session::delete::PurgeHooks::new(mixdog_core_session::session::purge::PurgeOwners {
        data_dir: b.data_dir.clone(),
        mixdog_home: mixdog_home.clone(),
        maintenance: b.tokens.maintenance_io,
        read_state: read_state.clone(),
        warm: warmer.clone(),
        ingest_offsets: Some(memory.transcripts() as Arc<dyn mixdog_core_session::session::purge::IngestOffsets>), // accessor in HEAD (hang-lanes)
        transcripts: Some(transcript_files.clone()),
        providers: registry.clone(),
        worker_turns: worker_turns.clone(),
        retention: archive_retention.clone(), // wp-session-40: the SAME Arc as `ThreadSettingsParts.retention`
        agents: agent_registry.clone(),
    });
    // The compaction world, built once: the session compactors take it (run-host-33, passed into the path), and so does the inheritance fit below.
    // One summary host per process (`summary_host.rs`); no tool is offered to a summary, so its file/process services and progress sink are never used by it.
    let summaries = Arc::new(mixdog_core::run_host::summary_host::SummaryServices::new(mixdog_core::run_host::summary_host::SummaryDeps {
        registry: registry.clone(),
        catalog: b.catalog.clone(),
        config: config_snapshot.clone(),
        env: b.env.clone(),
        clock: clock_agent.clone(),
        data_dir: mixdog_core_api::domain::common::AbsPath::new(b.data_dir.clone()).ok_or_else(|| ComposeError::Config("the data dir is not absolute".to_owned()))?,
        files: b.files.clone(),
        processes: b.process_manager.clone(),
        progress: Arc::new(mixdog_core::run_host::summary_host::DroppedProgress), // Node emits no summary progress (run-host-38, D-sp-1)
        io: mixdog_core_api::domain::tool::ToolIo { interactive: b.tokens.interactive_io, durability: b.tokens.durability_io, maintenance: b.tokens.maintenance_io },
    }));
    // The attachment ports are shared by the compaction world and the context world's per-thread lowering (flip-attach).
    let route_traits = Arc::new(mixdog_core::run_host::compaction_world::RegisteredRouteTraits::new(registry.clone()));
    let compaction_services = mixdog_core::run_host::compaction_world::CompactionServices {
        config: config.clone(),
        sensitive: sensitive.clone(),
        docs: documents.clone(),
        reader: attachments.clone(),
        attachment_facts: attachment_facts.clone(),
        files: attachment_files.clone(),
        routes: mixdog_core::run_host::compaction_world::RegisteredRouteTraits::new(registry.clone()),
        requests: mixdog_core::run_host::compaction_world::ProcessSessionRequests::new(warm_ledger.clone(), rotation.clone(), clock_agent.clone(), side_store.clone()),
        summaries: summaries.clone(),
        };
    let compaction_world = Arc::new(mixdog_core::run_host::compaction_world::ProcessCompactionWorld::new(compaction_services));
    let compactors = Arc::new(mixdog_core::run_host::compactors::SessionCompactors::new(compaction_world.clone(), clock_agent.clone()));
    let config_seams = Arc::new(mixdog_core::run_host::run_seams::ConfigRunSeams::new(config.clone(), agents.clone(), b.package_root.join("src"), b.data_dir.clone(), b.env.clone()).with_main_route({ let main = main_route.clone(); Arc::new(move || main.route()) }).with_settings_changes(mixdog_core::run_host::settings_changes::SettingsChanges::start(config.clone(), secret_changes.clone()))); // run-host-28
    let late_route_session = Arc::new(crate::late_session::LateRouteSession::default());
    // The route service is built after the directory and reads it: the route a `thread/start` thread begins on and the pick held for a turn start are late cells, bound where it is built.
    let late_new_route = Arc::new(mixdog_core::run_host::route_start::LateNewRoute::default());
    let late_new_place = Arc::new(crate::late_session::LateNewPlace::default());
    let late_draft_settings = Arc::new(crate::late_session::LateDraftSettings::default());
    let late_pending_route = Arc::new(mixdog_core::run_host::route_start::LatePendingRoute::default());
    // flip-surface: the one production `SurfaceHost`. It is built BEFORE the directory (it goes into `SessionDeps.new_tools` and the compaction world), so the
    // directory-side reads are the late forms (`LateThreads`: `ThreadState` + `ThreadMessages`; `LateLiveSessions`), not `directory`/`SessionThreads` as the wiring row writes.
    // The same `core_memory` value feeds the prompt rebuild and the host runtime.
    let core_memory = mixdog_services::memory::core::context::CoreMemoryContext::new(
        b.tokens.durability_io,
        b.data_dir.clone(),
        {
            // `featureEnvOverride('MIXDOG_BOOT_CORE_MEMORY') === false`, asked on every load: an explicit opt-out skips only this prompt block.
            let env = b.env.clone();
            Arc::new(move || mixdog_core_config::tool_modules::value::feature_env_override(&*env, "MIXDOG_BOOT_CORE_MEMORY") == Some(false))
        },
    );
    // The workflow surface (flip-workflow-4): the `WorkflowSurface`, the `FeatureDenied` and the connector/contact reads of `LeadSurfaceHost`, one value.
    // The standalone tools are the pool's own (`wireToolSurface`); the one delegation tool is `agent`.
    // The prompt composition's shared inputs (ComposedPrompt and the host runtime's `workspace_context`).
    let prompt_io = mixdog_core_api::domain::tool::ToolIo { interactive: b.tokens.interactive_io, durability: b.tokens.durability_io, maintenance: b.tokens.maintenance_io };
    let startup_probes = Arc::new(mixdog_core::run_host::prewarm::StartupProbes::new(prompt_io, b.process_manager.clone()));
    let startup_observed = Arc::new(mixdog_core_prompt::prompt::probes::StartupObservations::new(clock_agent.clone()));
    let prompt_facts = Arc::new(mixdog_core::run_host::prewarm::PromptFacts::from_process(b.package_root.join("src"), b.data_dir.clone(), config.stored_instruction_files()));
    let run_workflow_surface = Arc::new(mixdog_core::run_host::workflow_surface::RunWorkflowSurface::new(mixdog_core::run_host::workflow_surface::SurfaceParts {
        lane: b.tokens.interactive_io,
        paths: mixdog_core_config::workflow::WorkflowPaths { root: b.package_root.join("src"), data: b.data_dir.clone() },
        config: config.clone(),
        agents: agents.clone(),
        probes: Arc::new(crate::feature_probes::HostFeatureProbes::new(bridges.clone(), b.tokens.interactive_io, b.env.clone(), clock_agent.clone())),
        env: b.env.clone(),
        tool_profile: mixdog_app_protocol::v2::thread::ToolProfile::Interactive, // `normalizeToolProfile(undefined)`: the daemon's lead runtime is interactive; headless and heartbeat sessions carry their own profile in the header
        // `standaloneTools`, not the whole pool: the built-ins, `todo` and `call_tool` are no standalone tools (`collectStandaloneToolDefs`).
        standalone: mixdog_core::run_host::session_tools::internal_tools(&tool_pool),
        agent_tools: vec!["agent".to_owned()],
    }));
    // The connected servers' tools per folder, read by the surface host and by the route change's tool refill (ResumeTools).
    let session_mcp: Arc<dyn mixdog_core::run_host::session_tools::SessionMcp> = Arc::new(mixdog_core::run_host::session_tools::HubMcp { hub: hub.clone(), scopes: Arc::new({ let config = config.clone(); move || mixdog_mcp::scopes::ExtensionScopes::from_config(config.agent().get("extensionScopes").unwrap_or(&serde_json::Value::Null)) }) });
    let hub_surface_host = Arc::new(mixdog_core::run_host::surface_host::HubSurfaceHost::new(&tool_pool, hub.clone())); // the bridge definitions and MCP instructions (`tool_surface::SurfaceHost`)
    let surface_host = Arc::new(
        mixdog_core::run_host::surface_host::LeadSurfaceHost::new(mixdog_core::run_host::surface_host::SurfaceSources {
            mode: mixdog_core_session::session::thread_settings::normalize_tool_mode("").to_owned(), // `normalizeToolMode(undefined)`: the runtime default; a thread's own `toolMode` is read from its header by `mode(Some(&header))`
            pool: tool_pool.clone(),
            agent_tools: std::collections::HashSet::from(["agent"]),
            mcp: session_mcp.clone(),
            scopes: mcp.glue.clone(), // a new thread's own MCP scope (`rt.mcpScopeId`), opened on the hub by the glue
            cwd: startup_cwd.clone(), // `rt.currentCwd` before any session exists
            routes: routes.clone() as Arc<dyn mixdog_core_ports::ports::route::LiveRoute>,
            feature_denied: run_workflow_surface.clone(), // `Arc<dyn FeatureDenied>`, read fresh per use
            connectors: connector_policy.clone(),         // the `HostServices.connectors` Arc
            orchestration_mode: Arc::new({
                let config = config.clone();
                move || mixdog_core_config::workflow::ids::configured_orchestration_mode(&config.agent())
            }),
            hidden_agent: Arc::new(|agent| agent.is_some_and(|a| mixdog_core_config::config::hidden_agents::hidden_agents().contains(a))),
            prompt: Arc::new(mixdog_core::run_host::prompt_rebuild::ComposedPrompt {
                io: prompt_io,
                probes: startup_probes.clone(),
                observed: startup_observed.clone(),
                facts: prompt_facts.clone(),
                config: Arc::new({ let config = config.clone(); move || prompt_config_slice(&config.full()) }),
                core_memory: core_memory.clone(),
                skills: Arc::new(mixdog_core::run_host::prompt_rebuild::CatalogPromptSkills(mcp.catalog.clone())),
            }),
            skills: Arc::new(mixdog_core::run_host::mcp_seams::CatalogSkillsListed(mcp.catalog.clone())),
            tool_host: hub_surface_host.clone(),
            clock: clock_agent.clone(),
            threads: Arc::new(mixdog_core::run_host::compose_parts::LateThreads(late.clone())),
            messages: Arc::new(mixdog_core::run_host::compose_parts::LateThreads(late.clone())),
            live: Arc::new(mixdog_core::run_host::agent_inputs::LateLiveSessions(late.clone())),
            workflow: run_workflow_surface.clone(),
            config_revision: Arc::new({ let config = config.clone(); move || config.revision() }),
            surface_generation: surface_generation.clone(),
        })
        .map_err(ComposeError::SurfaceVariant)?, // fallible: a `git`/`task` tool without the Lead text is refused (`VariantError`)
    );
    // The one context world: the manual compaction and `thread/contextStatus` read it.
    let context_world = Arc::new(mixdog_core::run_host::context_world::LiveContextWorld {
        threads: Arc::new(mixdog_core::run_host::compose_parts::LateThreads(late.clone())),
        messages: Arc::new(mixdog_core::run_host::compose_parts::LateThreads(late.clone())),
        routes: routes.clone() as Arc<dyn mixdog_core_ports::ports::route::LiveRoute>,
        session: late_route_session.clone(), // a late cell: the adapter needs the directory, bound where `hop_sessions` builds it
        host: surface_host.clone(),
        // `MediaLowering` is the one meter and the image identities of a thread on a provider (compaction's own, `compaction_world.rs`).
        lowering: Arc::new({
            let (docs, reader, facts, route_traits) = (documents.clone(), attachments.clone(), attachment_facts.clone(), route_traits.clone());
            move |thread: &mixdog_core_api::ids::ThreadId, provider: &str| {
                let lowering = Arc::new(mixdog_core::run_host::media::MediaLowering::new(
                    thread.clone(),
                    docs.clone(),
                    reader.clone(),
                    facts.clone(),
                    route_traits.no_documents(provider),
                    mixdog_protocol::ProviderId::from(provider),
                ));
                (lowering.clone() as Arc<dyn mixdog_agent::compact::estimate::MediaMeter>, lowering as Arc<dyn mixdog_agent::compact::pressure::ImageIdentities>)
            }
        }),
    });
    // The route change of the session's route adapter and the fallback hop: context windows from the catalog, the cache policy of `autoClear` (read live),
    // the tool surface a new route rebuilds through the surface host. `prepare_tools` is Node's `_prepareResumeTools`.
    let route_facts_ai = Arc::new(mixdog_core::run_host::route_surface::AiRouteFacts {
        catalog: b.catalog.clone(),
        auto_clear: Arc::new({ let config = config.clone(); move || config.agent().get("autoClear").cloned().unwrap_or(serde_json::Value::Null) }),
        surface_host: hub_surface_host.clone(),
        clock: clock_agent.clone(),
        // wp-session-43/-46 (ResumeTools; AiRouteFacts.prepare_tools is then an Arc<dyn PrepareTools>): the same pool, MCP view and skill listing the surface host holds.
        prepare_tools: Arc::new(mixdog_core::run_host::resume_tools::ResumeTools {
            pool: tool_pool.clone(),
            mcp: session_mcp.clone(),
            mcp_names: hub.clone(),
            skills: Arc::new(mixdog_core::run_host::mcp_seams::CatalogSkillsListed(mcp.catalog.clone())),
            policy: Arc::new(mixdog_core::run_host::rules::ConfigRulesPolicy), // run-host-44
        }),
        hidden_agent: Arc::new(|agent| agent.is_some_and(|a| mixdog_core_config::config::hidden_agents::hidden_agents().contains(a))),
        scopes: mcp.glue.clone(), // a resumed thread takes (or opens) its MCP scope
    });
    let route_facts: Arc<dyn mixdog_core::run_host::route_change::RouteFacts> = route_facts_ai.clone();
    let delegated = mixdog_core_session::session::delegated_host::DelegatedApprovalHost::new(); // also the hub below and `HostHandoffs`
    let handoff_hub = mixdog_core_session::session::runtime_hooks::HandoffQuestionsHub::new(delegated.clone()); // `SessionDeps.runtime_hooks`; the room approvals ask the same hub
    let late_agent_status = Arc::new(crate::late_session::LateAgentStatus::default()); // `SessionDeps.agent_status`, bound once the agent registry and the shell jobs exist
    let late_turn_admission = Arc::new(crate::late_session::LateTurnAdmission::default()); // `SessionDeps.turn_admission`, bound with the session workspaces
    let late_live_workspace = Arc::new(crate::late_session::LateLiveWorkspace::default()); // `SessionDeps.live_workspace`, bound with the session workspaces
    let late_room_members = Arc::new(mixdog_core::run_host::room_approvals::LateRoomMembers::default()); // `SessionDeps.room_members`: bound to the rooms below
    let route_change = Arc::new(mixdog_core::run_host::route_change::RunHostRouteChange::new(route_facts, clock_agent.clone()));
    // The manual compaction and the inheritance fit (composition values, built before the path: they need the compaction world and the hook bus).
    let manual_compaction: Arc<dyn mixdog_core_session::session::turn_ops::ManualCompaction> = Arc::new(mixdog_core::run_host::manual_compaction::HostManualCompaction::new(mixdog_core::run_host::manual_compaction::ManualParts {
            world: context_world.clone(),
            threads: Arc::new(mixdog_core::run_host::compose_parts::LateThreads(late.clone())),
            config: config_seams.clone(),
            compactors: compactors.clone(),
            directory: late.clone(),
            hooks: Arc::new(mixdog_core::run_host::compact_hooks::BusCompactHooks::new(hook_bus.clone(), {
                        // `session.cwd` and `hookCommonPayload` of the loaded session (`common_of_header`); a session that is not loaded runs hooks in the startup folder with Node's defaults.
                        let (late, startup_cwd) = (late.clone(), startup_cwd.clone());
                        Arc::new(move |thread: &mixdog_core_api::ids::ThreadId| match late.live_header(thread.as_str()) {
                            Some(header) => (
                                header.get("cwd").and_then(|v| v.as_str()).filter(|c| !c.is_empty()).map_or_else(|| startup_cwd.clone(), std::path::PathBuf::from),
                                mixdog_core::run_host::compose_parts::common_of_header(&header),
                            ),
                            None => (startup_cwd.clone(), mixdog_mcp::hook_bus::HookCommon { permission_mode: Some("default".to_owned()), ..Default::default() }),
                        })
                    })),
            gauge: gauge.clone(),
            clock: clock_agent.clone(),
            recover: {
                // `recoverAgentWorkers()` (`session-ops.mjs:28-31`): the dead-row settlement, the restart notices (unawaited) and the tag refresh, on a Work task, never inline.
                let (late, agent_registry, reap, clock, board) = (late.clone(), agent_registry.clone(), reap.clone(), clock.clone(), job_board.clone());
                Arc::new(move |thread: &mixdog_core_api::ids::ThreadId| {
                    let Some(directory) = late.directory() else { return };
                    let pid = mixdog_core_session::session::agent_registry::LiveSessions::header(&*directory, thread.as_str())
                        .and_then(|header| mixdog_agent::agent_tool::scope::positive_int(header.get("clientHostPid")))
                        .unwrap_or(u64::from(std::process::id()));
                    let (agent_registry, reap, clock, board) = (agent_registry.clone(), reap.clone(), clock.clone(), board.clone());
                    drop(mixdog_rt::spawn("agent-recover", mixdog_rt::TaskClass::Work, async move {
                        let live = mixdog_core_session::session::agent_registry::restart::Liveness {
                            probe: &crate::os_probe::OsProbe,
                            own_pid: u64::from(std::process::id()),
                            running: &|id| mixdog_core_session::session::agent_registry::LiveSessions::running(&*directory, id),
                            reap: &*reap,
                            now_ms: clock.now_ms(),
                        };
                        if let Err(error) = agent_registry.recover_stale_worker_rows(true, &live).await {
                            tracing::warn!(%error, "[agent] restart settlement failed");
                        }
                        {
                            let (agent_registry, directory, board, stamp) = (agent_registry.clone(), directory.clone(), board.clone(), mixdog_agent::agent_tool::stamp::iso_from_ms(clock.now_ms()));
                            drop(mixdog_rt::spawn("agent-restart-notify", mixdog_rt::TaskClass::Work, async move {
                                if let Err(error) = mixdog_core_session::session::agent_registry::restart::notify_restart_failures(&agent_registry, &*directory, &board, &stamp).await {
                                    tracing::warn!(%error, "[agent] restart notices failed");
                                }
                            }));
                        }
                        mixdog_agent::agent_tool::host::Registry::refresh_tags_from_sessions(&*agent_registry, true, &mixdog_agent::agent_tool::scope::Scope { caller_session_id: None, host_pid: Some(pid) }).await;
                    }));
                })
            },
            io: mixdog_core_api::domain::tool::ToolIo { interactive: b.tokens.interactive_io, durability: b.tokens.durability_io, maintenance: b.tokens.maintenance_io },
            data_dir: b.data_dir.clone(),
            blobs: store_blobs.clone(),
        }));
    let snapshot_source = side_wiring.next();
    let inheritance_fit: Arc<dyn mixdog_core_session::session::inheritance::InheritanceFit> = Arc::new(mixdog_core::run_host::inheritance_fit::HostInheritanceFit::process(b.catalog.clone(), config_seams.clone(), side_wiring.next(), compaction_world.clone()));
    let turn_starts = Arc::new(mixdog_core_session::session::LateTurnStarts::default()); // bound to the `AgentRegistry` once wp-agent's constructor exists    // `writeStatuslineRoute` / `clearGatewaySessionRoute`: ONE value, cloned (a clone shares the write queue): the route hop and the session deletion.
    let gateway_routes = mixdog_core_session::session::gateway_routes::GatewaySessionRoutes::new(&b.data_dir, b.tokens.maintenance_io);
    let gateway_settle = gateway_routes.clone(); // the stop procedure's drain (`gatewaySessionRoutesSettled`)
    let liveness = mixdog_services::task_reports::runtime_state::RuntimeLiveness::new();
    // flip-ce-12 + batch i: the code-graph prewarm timer over the runtime's side, built before the session deps because `SessionDeps.code_graph_prewarm` holds it (the sessions' busy-state changes, first
    // visible output and cwd applications reach it: `prewarm_signals.rs`). Its busy probe reads the liveness map, which the composition makes first (`TurnPathParts.liveness`): no cycle through the path.
    let runtime_cwd = Arc::new(std::sync::Mutex::new(startup_cwd.to_string_lossy().into_owned()));
    let prewarm_world = Arc::new(crate::prewarm_world::DaemonPrewarmWorld {
        tool: code_graph.clone(),
        io: b.tokens.maintenance_io,
        close_requested: close_requested.clone(),
        cancel: b.cancel.child_token(),
        liveness: liveness.clone(),
        directory: late.clone(),
        cwd: runtime_cwd,
        env: b.env.clone(),
    });
    let prewarm_lazy = prewarm_world.lazy();
    let code_graph_prewarm = mixdog_core::run_host::code_graph_prewarm::CodeGraphPrewarm::new(prewarm_world);
    // The catalog warm-up defers while a turn runs or a session is being created (the same probe) and is woken with the prewarm.
    b.catalog_warmup.bind_gates(Arc::new(crate::prewarm_world::DaemonWarmupGates { liveness: liveness.clone(), directory: late.clone(), close_requested: close_requested.clone() }));
    model_warmup.bind(model_list.clone(), Arc::new(crate::prewarm_world::DaemonWarmupGates { liveness: liveness.clone(), directory: late.clone(), close_requested: close_requested.clone() })).map_err(|()| ComposeError::AlreadyBound("provider model warm-up"))?;
    provider_warmup
        .bind(provider_init, Arc::new(crate::prewarm_world::DaemonWarmupGates { liveness: liveness.clone(), directory: late.clone(), close_requested: close_requested.clone() }))
        .map_err(|()| ComposeError::AlreadyBound("provider warm-up"))?;
    let warmup_schedulers = Arc::new(crate::prewarm_world::WarmupSchedulers {
        providers: provider_warmup.clone(),
        models: model_warmup.clone(),
        setup: setup_warmup.clone(),
        catalog: b.catalog_warmup.clone(),
        statusline: statusline_warmup.clone(),
    });
    let session_prewarm: Arc<dyn mixdog_core_session::session::prewarm_signals::CodeGraphPrewarmSignals> = Arc::new(crate::prewarm_world::WarmupSignals {
        prewarm: mixdog_core::run_host::code_graph_prewarm::SessionPrewarm { prewarm: code_graph_prewarm, lazy: prewarm_lazy },
        schedulers: warmup_schedulers.clone(),
        channel_admin: channel_admin.clone(),
    });
    // The deferred channel start parks on the same busy probe (`channel-start.mjs:50-56`) and is woken with the warm-ups.
    channel_admin.bind_busy({
        let (liveness, late) = (liveness.clone(), late.clone());
        Arc::new(move || crate::prewarm_world::busy_reason(&liveness, &late))
    });
    // The third wake source: a provider catalog refresh settling (failed or not) wakes every parked background warm-up
    // (`provider-readiness.mjs` `settle` -> `rt.wakeDeferredWarmups()`), the same wake the sessions' busy-state changes give.
    b.catalog.on_refresh_settled({
        let signals = session_prewarm.clone();
        Arc::new(move || signals.wake())
    });
    let gateway_usage = mixdog_core_session::session::gateway_usage::GatewayUsage::new(
        &b.data_dir,
        b.tokens.durability_io,
        clock.clone(),
        Arc::new(mixdog_ai::catalog::CatalogPricing(b.catalog.clone())),
        Arc::new(mixdog_core_session::session::gateway_usage::TokioScheduler),
    );
    let owed = Owed {
        approvals: Arc::new(crate::held_requests::HeldGates(held_requests.clone())),
        liveness: liveness.clone(),
        search_usage,
        tokens: b.tokens.clone(),
        clock: clock_agent.clone(),
        paths: mixdog_store::paths::Paths { plugin_root: b.package_root.join("src"), data_dir: b.data_dir.clone() },
        effort_judge: b.models.effort_judge.clone(),
        side: side_wiring.requests(),
        next: side_wiring.next(),
        files: b.files.clone(),
        processes: b.process_manager.clone(),
        policy,
        connectors,
        agents: agents.clone(),
        hub: hub.clone(),
        blobs: store_blobs.clone(),
        mcp: Arc::new(mixdog_core::run_host::session_tools::HubMcp {
            hub: hub.clone(),
            scopes: {
                let config = config.clone();
                Arc::new(move || mixdog_mcp::scopes::ExtensionScopes::from_config(config.agent().get("extensionScopes").unwrap_or(&serde_json::Value::Null)))
            },
        }),
        skills: mcp.catalog.clone(),
        ext_pool: b.ext_host.clone(),
        hook_bus: hook_bus.clone(),
        config: config_seams.clone(),
        // `SessionDeps`, built once the run factory exists. Every field is a constructor read from the tree;
        // a `compile_error!` names the input that is not wired yet (all of them mine unless an owner is named).
        // wp-session-22: `auto_resume` is `quota_lane::auto_resume_enabled` (config `quotaAutoResume`, on unless `false`).
        // The resume timer takes this same closure, so the sessions and the timer read one switch.
        deps: Box::new({
            // `deps` is a `move` closure: it takes its own clones, so the composition below still holds every one of these.
            let (config, gateway_routes, exclusions, registry, worktree_maintenance, surface_host, worktrees, owned_shells, job_board, blobs) = (config.clone(), gateway_routes.clone(), exclusions.clone(), registry.clone(), worktree_maintenance.clone(), surface_host.clone(), worktrees.clone(), owned_shells.clone(), job_board.clone(), blobs.clone());
            let (late_agent_status, late_turn_admission, late_room_members, handoff_hub, activity, turn_review, computer_pool) = (late_agent_status.clone(), late_turn_admission.clone(), late_room_members.clone(), handoff_hub.clone(), activity.clone(), turn_review.clone(), computer_pool.clone());
            let late_new_route = late_new_route.clone();
            let late_live_workspace = late_live_workspace.clone();
            let late_draft_settings = late_draft_settings.clone();
            let office_startup = crate::office_startup::OfficeStartup::new(
                handoff_hub.clone(), b.ext_host.clone(), b.data_dir.to_string_lossy().into_owned(),
            );
            let mcp_glue = mcp.glue.clone();
            let (early_todos, early_work) = (early.todos.clone(), early.work.clone());
            let (process_unsupported, early_cycles, early_goals, hop_codex_declared, hop_source, mcp_catalog, memory_module, memory_search) = (process.unsupported.clone(), early.cycles.clone(), early.goals.clone(), ready.hop.codex_declared.clone(), ready.hop.source.clone(), mcp.catalog.clone(), memory.module(), memory.search());
            // `SessionQuota::over_config(goals, config)` is exactly `{ goals, auto_resume: over_config }`; the closure is the one hoisted above.
            let quota = mixdog_core_session::session::quota_lane::SessionQuota {
                goals: mixdog_core_goal::goal::quota::GoalQuotaResume::new(quota_store.clone(), early_goals.clone() /* batch-d: `early_rows` returns `Arc<GoalRuntime>` */),
                auto_resume: auto_resume.clone(),
            };
            let session_surface = surface_generation.clone();
            let store_threads = store_threads.clone();
            let thread_deletions = thread_deletions.clone();
            let transcript_files = transcript_files.clone();
            let task_workspace: Arc<dyn mixdog_core_session::session::TaskWorkspace> = agents.clone();
            let new_place = late_new_place.clone();
            let gateway_usage = gateway_usage.clone();
            let mixdog_home = mixdog_home.clone();
            let sensitive = sensitive.clone();
            // A turn's PDFs meet Node's intake limits before the message is accepted (`preparePromptSubmissionForProvider`).
            let prompt_intake: Arc<dyn mixdog_core_session::session::PromptIntake> = Arc::new(mixdog_core::run_host::prompt_intake::PdfPromptIntake {
                reader: attachments.clone(),
                docs: documents.clone(),
                native_pdf: {
                    let routes = route_traits.clone();
                    Arc::new(move |provider: &str| routes.native_pdf(provider))
                },
            });
            let live_workspace: Arc<dyn mixdog_core_session::session::worktree::LiveWorkspace> = late_live_workspace.clone();
            let context_status: Arc<dyn mixdog_core_session::session::thread_context::ContextStatusHost> = Arc::new(mixdog_core_session::session::thread_context::LiveContextStatus::new(context_world.clone()));
            let (data_dir, tokens, clock, features, route_change, quota, session_search) = (b.data_dir.clone(), b.tokens.clone(), clock.clone(), (b.server_requests.clone(), built_remote.registry.clone()), route_change.clone(), quota, session_search.clone());
            move |runs| mixdog_core_session::session::SessionDeps {
                store: store_threads,
                codec: Arc::new(mixdog_core_session::session::StoreCodec),
                transcript: Arc::new(mixdog_core_session::session::transcript::RecordTranscript::new()),
                prompts: Arc::new(mixdog_core_session::session::FilePromptHistory::new(&data_dir)),
                runs,
                surfaces: Arc::new(mixdog_core_session::session::HeaderToolSurfaces::new(exclusions.clone())), // the same exclusions the tool pool's catalog takes
                wakes: b.wakes.clone(), // `Exec.wakes`
                effort: Arc::new(mixdog_core_session::session::effort_prewarm::JudgePrewarm::new(
                    b.models.effort_judge.clone(),
                    config.clone(),
                    registry.clone(),
                    hop_source.clone(), // run-host-28
                    process_unsupported.clone(),
                    hop_codex_declared.clone(),
                )),
                search: session_search,
                memory: Arc::new(mixdog_core_session::session::MemoryCloseIngest::new((!skip_memory).then(|| memory_module.clone()), sensitive.clone())),
                transcripts: Some(transcript_files.clone()),
                sensitive: sensitive_marks.clone(),
                user_cwd: mixdog_core_session::session::UserCwd::new(data_dir.to_path_buf(), tokens.interactive_io),
                attachments: mixdog_core_session::session::user_facts::AttachmentStore(blobs.root().to_path_buf()),
                session_grants: mixdog_tools::policy::SessionGrantRegistry::new(),
                staged_originals: Arc::new(mixdog_core_session::session::staged_originals::StagedOriginals::new(&data_dir)),
                prompt_intake,
                feeds: Arc::new(mixdog_core_session::session::CoreThreadFeeds::new(&Default::default(), tokens.cpu_interactive)),
                server_requests: features.0,
                approval_ids,
                devices: Arc::new(mixdog_core_base::approvals::devices::RegistryDevices::new(features.1)),
                clock: clock.clone(),
                turn_starts: turn_starts.clone(),
                turn_review: turn_review.clone(),
                side: side_wiring.questions(),
                compaction: manual_compaction,
                inherit: inheritance_fit,
                route_change,
                deletion: Arc::new(mixdog_core_session::session::purge::SessionDeletion {
                    deleted: thread_deletions.clone(),
                    search: Some(memory_search.clone()),
                    worktrees: worktree_maintenance.clone(),
                    board: job_board.clone(),
                    gateway_routes: gateway_routes.clone(),
                    shells: owned_shells.clone(),
                    tool_events: Arc::new(mixdog_core_session::session::tool_events::ToolEventsLog::new(&data_dir, tokens.maintenance_io, clock.clone())),
                    mcp_scopes: mcp_glue.clone(), // a closed session's MCP scope goes with it
                }),
                purge,
                goals: early_goals.clone(),
                todos: early_todos.clone(),
                work: early_work.clone(),
                cycles: early_cycles.clone(),
                quota,
                agent_signals: activity.clone(),
                warm: Arc::new(mixdog_core::run_host::warm_ports::WarmedTurns::new(warmer.clone())), // flip-channel-router-2: the turn-start warmer note (`ask-session.mjs:198-201,313`); the one `Arc<Warmer>`
                notices: Arc::new(mixdog_core::run_host::desktop_notices::SessionDesktopNotices(desktop_notices.clone())), // flip-gaps-ai-3
                surface: session_surface.clone(),
        builtin_skills: Arc::new(CatalogBuiltinSkills(mcp_catalog.clone())), // turn-failure-4: the built-in skill names of the catalog the pool's Skill tool reads
                shell_strips,
                code_graph_prewarm: session_prewarm.clone(), // batch i: the sessions' busy-state, first-visible and cwd events reach the one timer
                agent_status: late_agent_status.clone(),
                live_workspace: live_workspace.clone(),
                context_status: context_status.clone(), // the load's status pass fills the display fields from the one context world
                turn_admission: late_turn_admission.clone(),
                runtime_hooks: office_startup,
                resumed_tools: route_facts_ai.clone(), // `AiRouteFacts` is the `ResumedTools` too
                room_members: late_room_members.clone(),
                new_tools: surface_host.clone(), // `thread/start` composes its tools and prompt through it (flip-surface-2, -6)
                new_tasks: mixdog_core_session::session::new_task::NewTaskReceipts::new(&data_dir.join("userdata"), tokens.durability_io), // the receipts of `thread/start` new tasks (<data>/userdata/new-task-receipts)
                new_place, // the registered Projects (`thread/fork`) and the draft's worktree step (`thread/start`); bound with the workspaces
                task_workspace, // `thread/start` of `kind: task` begins in it (Node `taskWorkspace()`, `AgentDefinitions::task_workspace`)
                empty_surface: surface_host.clone(), // `thread/clear` with `rebuildPrompt` rebuilds the emptied thread's surface and prompt through it
                new_route: late_new_route.clone(), // `thread/start` settles its route first (the draft's pick, else the default) and seats it once created
                draft_settings: late_draft_settings.clone(), // the new task's draft workflow and mode, through `thread/setWorkflow` / `thread/setOrchestrationMode` (bound below)
        snapshots: { let worktree_snapshots: Arc<dyn mixdog_core_session::session::turn_snapshots::TurnSnapshots> = Arc::new(mixdog_core_session::session::turn_snapshots::WorktreeTurnSnapshots::new(snapshot_cleanups.clone(), worktrees.clone())); match &computer_pool { Some(pool) => Arc::new(mixdog_core::run_host::native_tools::SettlingSnapshots::new(worktree_snapshots, pool.clone())), None => worktree_snapshots } }, // wp-session-30; `directory.shutdown()` ends with `snapshots.dispose()`
                lanes: mixdog_core_session::session::SessionLanes { cpu: tokens.cpu_interactive, io: tokens.interactive_io, durability: tokens.durability_io },
                limits: Default::default(),
                gateway_usage,
            }
        }),
        compactors: compactors.clone(), // run-host-33
        hop_sessions: {
            let (config, bots, gauge, clock, route_change, gateway_routes, late_route_session) = (config.clone(), ready.bots.clone(), gauge.clone(), clock.clone(), route_change.clone(), gateway_routes.clone(), late_route_session.clone());
            Box::new(move |directory| {
                let adapter = Arc::new(
                    mixdog_core_session::session::route_session::SessionRouteAdapter::new(
                        directory.clone(),
                        Arc::new(mixdog_core_session::session::thread_state::SessionThreads::new(directory.clone())),
                        route_change,
                        Arc::new(gateway_routes),
                        gauge,
                        Arc::new(mixdog_core::run_host::route_config::ConfigRouteConfig::new(config, bots)),
                        clock,
                    ),
                );
                // A fresh cell bound once, by the one call of this closure.
                late_route_session.bind(adapter.clone()).expect("the route session cell is bound once, by the directory build");
                Arc::new(mixdog_core_session::session::route_session::SessionHops::new(adapter))
            })
        },
        directory: late.clone(),
        tool_pool,
        shells: Some(b.shell_control.clone()),
        unattended: unattended.clone(),
        exclusions: exclusions.clone(),
    };
    let route_bots = ready.bots.clone(); // read again after the path (route positions); `ready` moves into the parts
    let path = TurnPath::new(turn_path_parts(&process, registry.clone(), early, ready, owed)).map_err(ComposeError::TurnPath)?;
    let directory = path.directory.clone();
    late.bind(&directory);
    // A config reload or a settings save moves the loaded sessions onto the saved compaction (`adoptFullConfig` -> `syncSessionCompaction`); the daemon's config is never injected.
    drop(mixdog_rt::spawn(
        "compaction-follow",
        mixdog_rt::TaskClass::Work,
        mixdog_core::run_host::compaction_follow::follow(config.clone(), false, Arc::new(LateThreads(late.clone())), {
            let directory = directory.clone();
            Arc::new(move || directory.loaded_ids())
        }),
    ));
    // The idle-time maintenance schedule (Node `startDaemonMaintenance`, daemon.mjs:938-980): one idle probe, the hourly `worktree-cleanup` task, a 60 s tick.
    // Idle = no loaded session has a turn running or a stage still owning provider/tool work (`IN_FLIGHT_STAGES`, runtime-state.mjs:13: connecting,
    // requesting, streaming, tool_running, cancelling). `WorktreeMaintenance::start` also spawns the startup reconcile off the boot path (daemon.mjs:1001-1015) and
    // registers `worktree-cleanup` with `interval 60 * 60_000`, `initialDelay 3 * 60_000` (daemon.mjs:972-976; worktree_maintenance.rs CLEANUP_INTERVAL /
    // CLEANUP_INITIAL_DELAY). The tick is `DEFAULT_TICK` = 60_000 ms (maintenance-schedule.mjs:19). Both lines log to the daemon log.
    let maintenance_schedule = mixdog_core_base::maintenance::MaintenanceSchedule::new();
    {
        use futures::FutureExt;
        let late = late.clone();
        maintenance_schedule.register_idle_probe(Arc::new(move || {
            let late = late.clone();
            async move {
                const IN_FLIGHT_STAGES: [&str; 5] = ["connecting", "requesting", "streaming", "tool_running", "cancelling"];
                use mixdog_core_session::session::agent_registry::LiveSessions;
                // Unbound must never read as idle (cleanup would run with no live-session view): `verify_bound` makes it unreachable.
                let directory = late.directory().expect("session directory bound (compose::verify_bound)");
                !LiveSessions::loaded(&*directory).into_iter().any(|id| {
                    let stage = LiveSessions::runtime_stage(&*directory, &id).unwrap_or_default();
                    LiveSessions::running(&*directory, &id) || IN_FLIGHT_STAGES.contains(&stage.as_str())
                })
            }
            .boxed()
        }));
    }
    let worktree_task = worktree_maintenance.start(&maintenance_schedule, &now_ms, b.log.line_log(), worktree_stop.clone());
    let maintenance_loop = maintenance_schedule.start(mixdog_core_base::maintenance::DEFAULT_TICK, now_ms.clone(), maintenance_stop.clone());
    // The ReadState 30-day sweep (Node `sweepStaleSnapshotScopes`), once at start, best effort, a maintenance-lane job (hang-lanes-143); not on the readiness path.
    {
        let (persist, lane) = (snapshot_persist.clone(), b.tokens.maintenance_io);
        mixdog_rt::spawn("read-snapshot-sweep", mixdog_rt::TaskClass::Work, async move { persist.sweep_stale(lane, mixdog_rt::wall_clock!()).await });
    }
    // The eight inputs of `AgentHomeDelivery::new` (flip-home): one `LiveSurface` for the heartbeat tick, the doctor and the delivery; one delegated-approval host.
    let live_surface = mixdog_core::run_host::heartbeat_parts::DirectoryLiveSurface::new(directory.clone());
    let live_slot = mixdog_services::bots::delivery::env::LiveSlot::new();
    live_slot.set(Some(live_surface.clone()));
    let scheduler_clock: Arc<dyn mixdog_services::scheduler::Clock> = Arc::new(mixdog_services::scheduler::SystemClock);
    let routine_queue = Arc::new(mixdog_services::bots::delivery::queue::RoutineResultQueue::new(
        mixdog_services::bots::state_json::StateJson::new(b.data_dir.join("routine-results.json"), b.tokens.durability_io),
        mixdog_services::bots::delivery::queue::HOME_QUEUE_LIMIT,
        mixdog_services::bots::delivery::queue::QUEUE_CAPS,
        scheduler_clock.clone(),
        mixdog_core_session::session::delegated_host::HostHandoffs::new(delegated.clone()),
    ));
    // Node's `agentRoomHost()` registry: the delivery asks it on every relay, and it refuses with Node's text while no host is registered. The rooms stack below
    // registers its `MemberRelay` once the rooms are recovered, and `Real::runtime_stop_steps` unregisters it (the desktop service's dispose in Node).
    let room_hosts = Arc::new(mixdog_core_rooms::rooms::room_hosts::RoomHostRegistry::default());
    let home_delivery = mixdog_services::bots::delivery::home::AgentHomeDelivery::new(
        Arc::new(mixdog_core_session::session::home_threads::DirectoryHomeThreads::new(directory.clone())),
        Arc::new(mixdog_core::run_host::home_directory::DefinitionsDirectory::new(agents.clone())),
        live_slot.clone(),
        room_hosts.clone(),
        routine_queue,
        scheduler_clock,
        Arc::new(mixdog_services::bots::delivery::env::SleepRetry),
        mixdog_services::bots::delivery::env::DeliveryConfig::node(),
    );
    home_delivery.redact_with(sensitive.clone());
    held_home.bind_delivery(home_delivery.clone()).map_err(|_| ComposeError::AlreadyBound("held home delivery"))?;
    bot_world.bind(home_delivery.clone()).map_err(|_| ComposeError::AlreadyBound("bot world delivery"))?;
    b.thread_gates.bind(directory.thread_ops()).map_err(|_| ComposeError::AlreadyBound("thread op gates"))?; // `thread_ops()` is called exactly once, here
    agent_evidence
        .bind(Arc::new(mixdog_core_session::session::agent_evidence::SessionAgentEvidence::new(
            directory.clone(),
            Arc::new(mixdog_services::bots::StoreRoutineRecords::new(schedules.clone(), webhooks.clone())), // the same value `RoutineRuntime::new` takes
        )))
        .map_err(|_| ComposeError::AlreadyBound("agent evidence"))?;
    let switches = Arc::new(mixdog_core_session::session::thread_switches::SessionSwitchAdapter::new(directory.clone(), run_workflow_surface.clone()));
    session_facts
        .bind(Arc::new(mixdog_core_session::session::setup_facts::SessionSetupFacts::new(directory.clone(), switches.clone(), b.data_dir.clone())))
        .map_err(|_| ComposeError::AlreadyBound("session facts"))?;
    // The quota resume timer, plain build order after the directory. `start()` is Node's `startQuotaResume` boot step (daemon.mjs:1132); `stop()` runs on the
    // session-service stop path, before the store's token is cancelled. Kept in `Real`: a block-local one was dropped at the end of its block.
    let quota_usage: Arc<dyn mixdog_core_session::session::quota_resume_host::QuotaUsage> = Arc::new(mixdog_core::run_host::quota_usage::ProviderQuotaUsable::new(
        process.env.clone(),
        Arc::new(mixdog_core::run_host::quota_channel::HostQuotaChannel::new(b.host.clone())),
        Arc::new(mixdog_core::run_host::quota_usage::UsageReadings { store: account_store.clone(), usage: oauth_usage.clone() }),
        now_ms.clone(),
    ));
    let resume_timer = Arc::new(mixdog_core_session::session::quota_resume_scheduler::QuotaResumeScheduler::new(
        quota_store.clone(),
        Arc::new(mixdog_core_session::session::quota_resume_host::SessionResumeHost::new(directory.clone(), quota_usage)),
        Arc::new(mixdog_core_session::session::quota_resume_scheduler::SystemResumeClock),
        auto_resume.clone(), // the one switch
        b.log.line_log(),    // `ResumeLog`
    ));
    let goal_recovery = Arc::new(mixdog_core_session::session::goal_recovery_host::SessionGoalRecovery::new(
        directory.clone(),
        mixdog_core_goal::goal::recovery::StoredGoals::new(b.data_dir.to_string_lossy().into_owned(), b.tokens.durability_io),
        b.log.line_log(),
    ));
    late_setup_ui
        .bind(Arc::new(mixdog_core_session::session::setup_ui::SessionSetupUi::new(directory.clone())))
        .map_err(|_| ComposeError::AlreadyBound("setup ui"))?;
    warmup_schedulers.schedule_provider_warmup(); // the boot's scheduleProviderWarmup() (session.mjs:121)
    warmup_schedulers.schedule_provider_model_warmup(); // the boot's scheduleProviderModelWarmup() (session.mjs:122): after the model list, the gates and the wakes exist
    // The boot's scheduleAutomationAutostart() (session.mjs:126) without its 1.5 s timer: the compose has finished, so probe once and start enabled automation now.
    channel_admin.schedule_automation_autostart();
    warmup_schedulers.schedule_provider_setup_warmup(None); // the boot's scheduleProviderSetupWarmup() (session.mjs:123), default 300 ms
    warmup_schedulers.schedule_model_catalog_warmup(&|name| std::env::var(name).ok()); // the boot's scheduleModelCatalogWarmup() (session.mjs:124)
    // The pool's directory-side cells (true cycles, bound once, in `verify_bound`): the dispatcher is built from the very values the turn's own gate takes (`policy`, `connectors`, the resolver, `HostGateEnv`, the bus dispatch).
    late_dispatcher
        .bind(Arc::new(mixdog_core::run_host::tool_pool::dispatcher::PipelineDispatcher::new(
            directory.clone(),
            dispatch_policy,
            dispatch_connectors,
            ready_resolver,
            Arc::new(mixdog_core::run_host::mcp_seams::HostGateEnv::new(unattended.clone(), path.contacts.clone(), ready_allow_all, hub.clone())),
            Arc::new(mixdog_core::run_host::mcp_seams::BusPostToolDispatch::new(hook_bus.clone(), compose_parts::hook_common(late.clone()))),
        ).with_mcp(path.turn_settings.clone())))
        .map_err(|_| ComposeError::AlreadyBound("tool dispatcher"))?;
    late_catalog
        .bind(Arc::new(mixdog_core::run_host::session_catalog::SessionCatalog::new(directory.clone(), Arc::new(LateThreads(late.clone())), exclusions.clone(), hub_surface_host.clone(), clock_agent.clone()).with_refresh(path.turn_settings.clone())))
        .map_err(|_| ComposeError::AlreadyBound("session catalog"))?;
    late_skills
        .bind(Arc::new(mixdog_mcp::skill_port::CatalogSkillPort::new(
            mcp.catalog.clone(),
            Arc::new(mixdog_core::run_host::skill_session::HeaderSkillArm::new(Arc::new(LateThreads(late.clone())), Arc::new(LateThreads(late.clone())), exclusions.clone(), connector_policy.clone(), hub_surface_host.clone(), clock_agent.clone())),
            Arc::new(mixdog_core::run_host::skill_session::ThreadTranscript::new(late_route_session.clone(), Arc::new(LateThreads(late.clone())))),
        )))
        .map_err(|_| ComposeError::AlreadyBound("skill port"))?;
    late_reactions
        .bind(Arc::new(mixdog_core::run_host::session_reactions::SessionReactions::new(directory.clone(), path.reaction_targets.clone())))
        .map_err(|_| ComposeError::AlreadyBound("reactions"))?;
    // `late_agent_port.bind(assembled.port())` belongs right after `assemble(AgentParts{..})` (flip-agent-worlds-15), below.    // flip-surface-11: every turn start reconciles through the late `TurnSettings`; an unbound cell is a typed failure and is in `verify_bound` below.
    // Node's turn preparation applies the route pick held for the turn (`applyPendingRoute`) before it reconciles the settings.
    // The workflow and mode choices a thread made while its last turn ran apply from the next one (`applyPendingSessionSwitches`), after the held route pick and before the settings reconcile.
    let session_switches = Arc::new(mixdog_core_session::session::thread_switches::SessionSwitchAdapter::new(directory.clone(), run_workflow_surface.clone()));
    path.turn_settings
        .bind(Arc::new(mixdog_core::run_host::route_start::TurnStart { route: late_pending_route.clone(), switches: session_switches.clone(), settings: surface_host.clone() }))
        .map_err(|_| ComposeError::AlreadyBound("turn settings"))?;
    // The tool status the `tools/*` service and the MCP surface read (flip-ce-2): `preview` is async/fallible and `mode` takes the thread's header, no wiring change.
    tool_surface
        .bind(Arc::new(
            mixdog_core_ports::ports::tools_status::SessionToolStatus::new(Arc::new(mixdog_core_session::session::thread_state::SessionThreads::new(directory.clone())), surface_host.clone())
                // `tools/toolsStatus` with `snapshot`: the provider request the thread's next send would carry.
                .with_snapshots(snapshot_source),
        ))
        .map_err(|_| ComposeError::AlreadyBound("tool surface"))?;
    // flip-gaps-agent, after the directory: the session-close seams, the `cycle1-agent` dispatch (and with it the memory cycles' late LLM), the route positions.
    let runtime_release = Arc::new(mixdog_core_session::session::runtime_release::ThreadRuntimeRelease::new(read_state.clone(), liveness.clone(), worktrees.clone(), worktree_stop.clone()));
    let session_turns = Arc::new(mixdog_core_session::session::agent_registry::flow::SessionTurns::new(directory.clone(), runtime_release).with_shells(b.shell_control.clone()).with_admission(agent_registry.clone())); // flip-agent-worlds-8: without it a turn is not admission-checked (agent-turns.mjs:96,108,116)
    let session_close = Arc::new(mixdog_core_session::session::close::SessionClose::new(directory.clone(), registry.clone(), owned_shells.clone(), read_state.clone()));
    let agent_host = Arc::new(mixdog_core::run_host::agent_world::AgentHost::new(config.clone(), registry.clone())); // kept concrete: `close()` at shutdown
    // The `stall_abort` rows of a stopped dispatch join the tool-failure log, the one buffer and file of this data directory.
    let stall_failures = mixdog_core_run::run_host::failure_log::FailureWriter::for_data_dir(
        &b.data_dir,
        mixdog_core_api::domain::tool::ToolIo { interactive: b.tokens.interactive_io, durability: b.tokens.durability_io, maintenance: b.tokens.maintenance_io },
        clock_agent.clone(),
    );
    let stall_log: mixdog_core::run_host::agent_world::StallLog = Arc::new(move |ctx| stall_failures.record_watchdog_abort(&ctx));
    let agent_world = Arc::new(mixdog_core::run_host::agent_world::AgentWorld::new(config.clone(), Arc::new(mixdog_core::run_host::agent_world::CatalogWindows(b.catalog.clone())), b.env.clone(), clock_agent.clone(), stall_log));
    // ONE admission, also `AgentParts.admission`.
    let agent_admission = Arc::new(mixdog_core::run_host::admission::ResourceAdmission::new(
        mixdog_core::run_host::admission::Limits::from_env(std::thread::available_parallelism().map_or(1, std::num::NonZeroUsize::get), &*b.env),
        clock_agent.clone(),
    ));
    let dispatch_sessions = Arc::new(mixdog_core::run_host::dispatch_sessions::SessionDispatch::new(
        Arc::new(mixdog_core_session::session::dispatch_sessions::DispatchThreads::new(directory.clone(), session_turns.clone(), session_close.clone(), Some(b.shell_control.clone()))),
        registry.clone(),
    ));
    let hidden_runner = Arc::new(mixdog_core::run_host::agent_dispatch::HiddenRoleRunner::new(agent_admission.clone(), dispatch_sessions, agent_world));
    let agent_dispatch = Arc::new(mixdog_core::run_host::agent_dispatch::InlineAgentDispatch::new(hidden_runner, agent_host.clone(), Arc::new(crate::memory_agent_watch::MemoryAgentWatch { lifecycle: late_lifecycle.clone(), log: b.log.line_log() }))); // flip-caller-2
    // Shutdown: `Real::session_shutdown_step` aborts the dispatch, then closes the host, before the directory shuts down.
    late_cycle_llm.bind(Arc::new(mixdog_core::run_host::cycle1_dispatch::Cycle1Dispatch::new(agent_dispatch.clone()))).map_err(|_| ComposeError::AlreadyBound("cycle llm"))?;
    // The owner teardown (flip-agent-worlds-11, replaces the -9 shutdown line): a process-exit stop closes each loaded owner's agents through `AgentSessions::teardown_owner`.
    let agent_sessions = Arc::new(mixdog_core_session::session::agent_registry::sessions::AgentSessions::new(directory.clone(), Arc::new(LateThreads(late.clone())), agent_registry.clone(), Arc::new(gateway_routes.clone()), clock.clone(), owned_shells.clone(), read_state.clone())); // `AgentParts.sessions` and the owner teardown
    directory
        .set_owner_teardown(Arc::new(mixdog_core_session::session::agent_registry::sessions::AgentOwnerTeardown { sessions: agent_sessions.clone(), board: job_board.clone() }))
        .map_err(|_| ComposeError::AlreadyBound("owner teardown"))?;
    // Teardown's `closeOwnSession` (`teardown.mjs:258`): the stop closes each loaded session with the stop's reason, which bumps its generation (`lifecycle-barriers.mjs:272`).
    directory.set_exit_close(session_close.clone()).map_err(|_| ComposeError::AlreadyBound("exit close"))?;
    // `AgentParts.send_world` (flip-agent-send-1, -3): the agent tool's send path over the directory. The runtime facts, the blob sizes (a lane job over the blob store) and
    // the session clock are `flip-agent-send-3`'s three fields; the queue has no `pending` any more. `assemble(AgentParts{..})` (flip-agent-worlds) takes this value.
    let agent_send_world = Arc::new(mixdog_core::run_host::agent_send_world::AgentSendWorld {
        sessions: agent_registry.clone(),
        live: directory.clone(),
        runtime: directory.clone(),
        blob_sizes: Arc::new(mixdog_core::run_host::agent_send_world::StoreBlobSizes { blobs: blobs.clone(), io: b.tokens.interactive_io }),
        clock: clock.clone(),
        config: Arc::new(config.clone()),
        bots: route_bots.clone(),
        routes: chat_routes.clone(),
        queue: Arc::new(mixdog_core::run_host::agent_send_world::DirectoryQueue { directory: directory.clone() }),
        records: directory.clone(),
        runs: unattended.clone(),
        headers: Arc::new(mixdog_core::run_host::agent_send_world::ThreadHeaders(Arc::new(mixdog_core_session::session::thread_state::SessionThreads::new(directory.clone())))),
    });
    // The route positions: the `agents` status reader's third argument and the live-route facade's.
    let route_positions_impl = Arc::new(mixdog_core_session::session::route_setup::SessionRoutePositions::new(
        directory.clone(),
        route_bots.clone(),
        config_snapshot.clone(), // the one the run's hops read (`HopDeps.config`): the agent config
    ));
    route_positions.bind(route_positions_impl.clone()).map_err(|_| ComposeError::AlreadyBound("route positions"))?;
    live_route
        .bind(Arc::new(mixdog_core_session::session::route_setup::SessionLiveRoute::new(route_positions_impl, routes.clone() as Arc<dyn mixdog_core_ports::ports::route::LiveRoute>)))
        .map_err(|_| ComposeError::AlreadyBound("live route"))?;
    // The routine sessions of the channel stack (`LateRoutineSessions`): `CoreRoutineSessions::new(directory, unattended, spawn_flow, attachment_files, delivery)`.
    // Daemon start (`settleAgentResults`, `daemon.mjs:1108`): dead-owner worker rows are settled and their failure notices queued, awaited (Node's resolves once the notices are queued).
    {
        let live = mixdog_core_session::session::agent_registry::restart::Liveness {
            probe: &crate::os_probe::OsProbe,
            own_pid: u64::from(std::process::id()),
            running: &|id| mixdog_core_session::session::agent_registry::LiveSessions::running(&*directory, id),
            reap: &*reap,
            now_ms: clock.now_ms(),
        };
        agent_registry.recover_stale_worker_rows(true, &live).await.map_err(ComposeError::AgentRecover)?;
        mixdog_core_session::session::agent_registry::restart::notify_restart_failures(&agent_registry, &*directory, &job_board, &mixdog_agent::agent_tool::stamp::iso_from_ms(clock.now_ms()))
            .await
            .map_err(ComposeError::AgentRecover)?;
    }
    // The maintenance pass's deadline timer: a worker row leaves the index when its reap deadline comes, not at the next agent event.
    drop(mixdog_rt::spawn(
        "agent-row-deadlines",
        mixdog_rt::TaskClass::Work,
        mixdog_core_session::session::agent_registry::AgentRegistry::keep_deadlines(Arc::downgrade(&agent_registry)),
    ));
    // The directory's `ThreadState` + `ThreadMessages` (`thread/header/read|patch`, messages): the memory recall source, the rooms' `DirectorySessions`, the prompt reroot and the workspace host share it.
    let threads = Arc::new(mixdog_core_session::session::thread_state::SessionThreads::new(directory.clone()));
    // flip-ce-13 + run-host-41: the pool's production inputs. `liveness` is the map the runs write; `ShellJobs` answers `waitedJobSilence` and the awaited
    // owners over the whole job table (Node's task registry is process-wide, so no filter by loaded sessions). The pool is read by `AgentHomeService`.
    let shell_jobs = Arc::new(mixdog_core::run_host::shell_jobs::ShellJobs(b.exec.clone()));
    late_agent_status.bind(Arc::new(mixdog_core_session::session::agent_registry::status_rows::AgentToolStatus::new(agent_registry.clone(), job_board.clone(), directory.clone(), shell_jobs.clone(), clock.clone()))).map_err(ComposeError::AlreadyBound)?;
    let agent_pool = Arc::new(mixdog_core_agents::agents::AgentPool::new(
        Arc::new(mixdog_core::run_host::pool_inputs::RegistryPoolStore::new(agent_registry.clone(), threads.clone())),
        Arc::new(mixdog_core::run_host::pool_inputs::DirectoryPoolLive::new(
            directory.clone(),
            liveness.clone(),
            shell_jobs.clone(),
            clock.clone(),
            shell_jobs.clone(),
            mixdog_core::run_host::group_usage_tokens::GroupUsageTokens::new(ledger_source.clone(), Arc::new({ let activity = activity.clone(); move || activity.everyone() })),
            b.env.clone(),
        )),
    ));
    // The `agentPool` section: the rows `agent/pool/list` answers, re-listed on every agent status signal (the pool is shared with `AgentHomeService`, whose idle stamps it keeps).
    mixdog_core_agents::agents::pool_section::spawn_pool_section(agent_pool.clone(), activity.changed(), state.publisher.clone(), b.cancel.clone());
    // ---- 10b. the post-directory domain stage: the two seams that read the directory ----
    let composed = compose_domains_post(
        &domain_inputs,
        PostSeams {
            session_attachments: Arc::new(mixdog_core_session::session::attachments::SessionAttachmentLinks::new(directory.clone())),
            // The import service moves into this stage (follow-up after wp-svc-misc-26/28/29): plain build order, no late cell.
            import_sessions: Arc::new(mixdog_core_session::session::import_sessions::DirectoryImportSessions::new(
                directory.clone(),
                Arc::new(catalog_index.clone()),
                Arc::new(mixdog_core_domains::domains::ai_admin::chain::CatalogRouteContext { config: config.clone(), facts: facts.clone() }),
                clock.clone(),
                session_search.clone(),
                readiness.clone(),
            )), // six arguments (wp-session-26 removed `KeychainReady`)
            doctor: crate::domain_seams::doctor::DaemonDoctorHost::new(crate::domain_seams::doctor::DoctorInputs {
                data_dir: b.data_dir.clone(),
                package_root: b.package_root.clone(),
                interpreter: crate::domain_seams::doctor::JsInterpreter { program: b.js_runtime.program.clone(), electron: b.js_runtime.electron },
                processes: b.tidy_processes.clone(),
                io: b.tokens.interactive_io,
                providers: provider_setup.clone(),
                routes: config_hosts.clone(),
                channel_runtime: channel_runtime.clone(),
                channel_admin: channel_admin.clone(),
                hooks: hook_status.clone(),
                bridge: bridges.clone(),
                live: live_surface.clone(),
            }),
        },
        pre,
    )
    .await
    .map_err(ComposeError::ComposeDomains)?;


    // ---- 11. register every service (registration-inventory.md); no `MockDomain`: what nobody claims is `ComposeError::Unclaimed` ----
    let mut builder = mixdog_core_domains::domains::DomainsBuilder::new();
    for service in composed.services.iter().chain(mcp.services.iter()) {
        builder.register(service.clone())?;
    }
    // The workspace (fs, lsp, project*, search, transfer, git/review parts) and the document preview.
    let workspace = mixdog_workspace::service::WorkspaceService::new(mixdog_workspace::service::Deps {
        lanes: mixdog_workspace::lanes::Lanes {
            interactive: b.tokens.interactive_io,
            durability: b.tokens.durability_io,
            maintenance: b.tokens.maintenance_io,
            cpu_bulk: b.tokens.cpu_bulk,
        },
        feeds: b.scoped_feeds.clone(),
        processes: b.process_manager.clone(),
        tracked: Arc::new(mixdog_scm::tracked::GixTrackedFiles::new(b.tokens.maintenance_io)),
        state: b.core_state.clone(),
        recovery_dir: b.data_dir.join(mixdog_workspace::recovery::JOURNALS_DIR),
        user_data_dir: b.user_data_dir.clone(),
        sources: composed.transfer_sources.clone(),
        code_graph: Some(Arc::new(mixdog_tools::code_graph::WorkspaceCodeGraph::new(code_graph.clone(), b.tokens.maintenance_io))), // code-graph-adapter-1: the SAME `Arc<CodeGraphTool>` the pool registers
        turn_review: Some(turn_review.clone() as Arc<dyn mixdog_core_api::turn_review::TurnReviewApi>),
        releases: folder_releases.clone(),
    })
    .map_err(ComposeError::Workspace)?;
    workspace.spawn_idle_sweeper(); // abandoned uploads go at their idle deadline, as Node's per-upload timer
    workspace.set_user_markdown_view({
        let config = config.clone();
        Arc::new(move || config.get(mixdog_protocol::config::keys::DESKTOP_MARKDOWN_DEFAULT_VIEW).and_then(|view| view.as_str().map(str::to_owned)))
    });
    // A paired phone's one-file grants (SPEC.md R44, DS 4.7): held per paired credential, and a conversation that left the
    // catalog ends its grants (Node's `sessionRemoved`).
    let phone_grants = Arc::new(mixdog_workspace::grants::GrantStore::new(
        Arc::new(mixdog_workspace::transfer::SystemClock),
        Arc::new(CatalogSessions { sessions: Arc::new(catalog_index.clone()), media: Arc::new(mixdog_services::media::MediaStore::new(&b.data_dir, b.tokens.durability_io)) }),
    ));
    thread_deletions
        .on_gone({
            let workspace = workspace.clone();
            Arc::new(move |session: &str| workspace.session_removed(session))
        })
        .map_err(|()| ComposeError::AlreadyBound("thread deletions"))?;
    workspace.set_host(b.host.clone());
    workspace.set_phone_grants(phone_grants.clone(), crate::domain_seams::remote::phone_credential(built_remote.registry.clone()));
    // An unpair ends the device's grants, transfers and browser streams at once and, once the relay confirmed it, its notification
    // preferences. The live view is composed below and fills its slot then.
    let live_view_slot: Arc<std::sync::OnceLock<std::sync::Weak<crate::live_view::LiveViewService>>> = Arc::default();
    built_remote
        .events
        .bind(Arc::new(crate::domain_seams::remote::PairedDeviceCleanup {
            grants: phone_grants.clone(),
            registry: built_remote.registry.clone(),
            end_transfers: {
                let workspace = workspace.clone();
                Arc::new(move |owner| workspace.revoke_device(owner))
            },
            end_downloads: {
                let workspace = workspace.clone();
                Arc::new(move || workspace.revoke_all_downloads())
            },
            config: config.clone(),
            live_view: live_view_slot.clone(),
        }))
        .map_err(|_| ComposeError::AlreadyBound("device cleanup"))?;
    builder.register(workspace.clone() as Arc<dyn mixdog_core_api::service::DomainService>)?;
    // A phone's pages: a registered project's entry or its device's granted file (the workspace's catalog and grant
    // store), or a visualize pane's own file (the tabs the desktop set).
    builder.register(Arc::new(
        mixdog_exthost::DocumentService::new(b.ext_host.clone(), b.user_data_dir.to_string_lossy().into_owned())
            .with_relay_scope(Arc::new(crate::domain_seams::relay_files::WorkspaceRelayFiles(workspace.clone())), visualize_panes.clone()),
    ))?;
    builder.register(secret.service.clone())?; // `approval/provideSecret`: the same `SecretSlots` as `SecretFill`
    builder.register(Arc::new(mixdog_tools::orch::status::ToolsService::new(tool_surface.clone())))?; // `tools/*`
    builder.register(Arc::new(mixdog_scm::service::ScmHandle(mixdog_scm::service::ScmService::new(
        scm.clone(),
        b.scoped_feeds.clone(),
        state.publisher.clone(),
        Arc::new(mixdog_core_config::config::seams::ConfigFeatureGate::new(config.clone())),
        turn_review.clone(), // `review/diff/get` of a turn or session: Node's turn-review reads
        Arc::new(crate::compose_domains::HeaderCwds(late_headers.clone())),
    ))))?;
    builder.register(Arc::new(mixdog_core_domains::domains::remote_access::RemoteAccessService::new(
        built_remote.runtime.clone(),
        built_remote.registry.clone(),
        domain_inputs.scopes.scopes("remoteAccess").map_err(ComposeError::ComposeDomains)?,
    )))?;
    builder.register(screen.clone())?;
    builder.register(Arc::new(mixdog_core_domains::notify::timeline::ConnectionTimeline::new(built_remote.registry.clone(), {
        let log = b.log.clone();
        Arc::new(move |line: &str| log.console("info", line))
    })))?;
    builder.register(Arc::new(mixdog_core_domains::notify::service::NotifyService::new(
        notify_engine.clone(),
        audience.clone(),
        b.host.clone(),
        push_sink.clone(),
        domain_inputs.scopes.scopes("notify").map_err(ComposeError::ComposeDomains)?,
    )))?;
    // process/* and terminal/* over the one manager and feeds built with the pool; `ui/newTab/created` and `ui/terminalRun/claimed` reach the one `PendingWaits`.
    builder.register(mixdog_spawn::service::ProcessService::new(b.local_processes.clone(), process_feeds.clone()))?;
    builder.register(terminal.clone())?;
    builder.register(Arc::new(pending_waits.clone()))?;
    // Rooms (spec desktop-services §9, flip-rooms-3/-4/-6/-7/-8): ONE `RoomCalls` over the live rooms is both the `RoomService` runner (`CallsRunner`) and the home delivery's relay
    // (`MemberRelay`). The republish closures of the daemon port read `RoomSummaries`, which is built after the rooms (a cycle through `ThreadListService`): the late cell `LateRoomSummaries`.
    let late_room_summaries = Arc::new(crate::late_session::LateRoomSummaries::default());
    let rooms = Arc::new(mixdog_core_rooms::rooms::records::Rooms::new(mixdog_core_rooms::rooms::store::StateRoomStore::new(b.core_state.clone())));
    // Node's one `lastArchiveStamp`, which the host's archive and the rooms' share (`ArchiveStamps`).
    let archive_stamps: Arc<mixdog_core_session::session::thread_settings::ArchiveStamps> = Arc::default();
    let room_sessions = Arc::new(
        mixdog_core::run_host::directory_sessions::DirectorySessions::new(directory.clone(), threads.clone()).with_archive_stamps(archive_stamps.clone()),
    );
    // Node's supervisor step logs one line per step with `process.stderr.write` (`room-supervisor-completion.mjs` default `log`): the daemon's raw stderr.
    let maintainer = Arc::new(mixdog_core_rooms::rooms::maintainer::RouteMaintainer::new(
        Arc::new(mixdog_core::run_host::summary_routes::SummaryRoutes::new(
            summaries.host(&mixdog_core_api::ids::ThreadId::from("room-supervisor"), &mixdog_store::schema::record::Header::new()),
        )),
        { let log = b.log.clone(); Arc::new(move |chunk: &str| log.raw(chunk)) },
    ));
    // Node's rooms log (`agent-rooms.ts:190`) is `console.warn("[mixdog-rooms] <line>")` in the desktop main process. Rooms live in the core (spec §9), so it is the
    // daemon's `console.warn`, which `installRedirect` (`daemon.mjs:844`) writes as `[<ISO>] [console.warn] [mixdog-rooms] <line>`: `console_warn_sink()` (wp-ai-svc-35), no `[daemon]` tag.
    let room_log: Arc<dyn Fn(&str) + Send + Sync> = {
        let warn = b.log.console_warn_sink();
        Arc::new(move |line| warn(&format!("[mixdog-rooms] {line}")))
    };
    let definition_names = Arc::new(mixdog_core::run_host::member_names::DefinitionNames::new(agents.clone())); // the room labels and the thread list's room rows share it
    let room_approvals = Arc::new(mixdog_core::run_host::room_approvals::SessionRoomApprovals::new(directory.clone(), handoff_hub.clone())); // its room summaries are bound below, once they exist
    let live_rooms = mixdog_core_rooms::rooms::live::LiveRooms::new(
        rooms.clone(),
        mixdog_core_rooms::rooms::live::RoomPorts {
            // `DirectoryRoomDaemon` (flip-rooms-6): the log's rows, the members' turns and snapshots, abort; `republish` / `republish_catalog` are the summaries'.
            daemon: Arc::new(mixdog_core::run_host::room_daemon::DirectoryRoomDaemon::new(
                directory.clone(),
                { let summaries = late_room_summaries.clone(); Arc::new(move || summaries.republish()) },
            )),
            approvals: room_approvals.clone(),
            labels: Arc::new(mixdog_core::run_host::room_labels::DefinitionLabels::new(definition_names.clone())), // flip-rooms-7
            files: Arc::new(mixdog_core::run_host::room_files::SessionFiles::new( // flip-rooms-8
                directory.clone(),
                b.tokens.durability_io,
                b.data_dir.clone(),
                mixdog_services::task_reports::collect::sensitive_scopes(&[home.clone(), mixdog_home.clone(), b.data_dir.clone()]),
                documents.clone(),
                room_log.clone(),
            )),
            sessions: room_sessions.clone(),
            catalog: agents.clone(),
            maintainer: maintainer.clone(),
            preview: Arc::new(|text: &str| mixdog_core_rooms::rooms::preview::plain_preview_text(text)), // flip-rooms-9
            log: room_log.clone(),
            now: now_ms.clone(),
        },
    );
    let room_calls = mixdog_core_rooms::rooms::calls::RoomCalls::new(Arc::new(mixdog_core_rooms::rooms::exchange_run::ExchangeRunner::new(live_rooms.clone())), room_log.clone());
    live_rooms.bind_relays(Arc::new({
        let calls = Arc::downgrade(&room_calls);
        move |room: &str, error: &str| {
            if let Some(calls) = calls.upgrade() {
                calls.fail_relays(room, error)
            }
        }
    }));
    let room_runner = Arc::new(mixdog_core_rooms::rooms::runner::CallsRunner::new(room_calls.clone(), live_rooms.clone()));
    late_room_members.bind(&live_rooms).map_err(|_| ComposeError::AlreadyBound("room members"))?;
    // The thread list with the room rows, and the room summaries over it (wp-session-32).
    let room_rows: Arc<dyn mixdog_core_session::session::thread_list::ListRooms> = Arc::new(mixdog_core::run_host::room_list::RoomListRows::new(rooms.clone(), room_runner.clone(), definition_names.clone()));
    // `BotWork` (also the report host's bot-work registry): its `on_change` republishes the session's row (flip-agent-worlds-7), through a cell bound once the list service exists.
    let bot_summaries = mixdog_core::run_host::bot_work_summaries::BotWorkSummaries::new();
    let bot_work = Arc::new(mixdog_services::task_reports::host::BotWork::new({ let summaries = bot_summaries.clone(); Arc::new(move |session: &str| summaries.changed(session)) }));
    let list_overlay = Arc::new(mixdog_core_session::session::thread_list::LiveListOverlay::new(directory.clone(), bot_work)); // wp-session-37: the overlay reads the directory's handles and `bot_work.by_session()`
    let catalog_handle = Arc::new(catalog_index.clone()); // the handle the idle sweep and the heartbeat's catalog read (Node listSessionCatalog)
    let thread_list = Arc::new(mixdog_core_session::session::thread_list::ThreadListService::new(catalog_handle.clone(), list_overlay.clone(), room_rows, agents.clone()));
    thread_list.fence(store_threads.clone()); // a list is never older than a write whose reply or notification has gone out
    late_list_catalog.bind(thread_list.clone()).map_err(|_| ComposeError::AlreadyBound("session list catalog"))?;
    // A session counts as seen when a published catalog lists it (Node's seenSessions); the downloads of one that leaves the catalog end in the
    // step its `thread/deleted` is published (`ThreadDeletions`).
    thread_list.observe(phone_grants.clone());
    let heartbeat = mixdog_core::run_host::heartbeat_parts::production_heartbeat(mixdog_core::run_host::heartbeat_parts::HeartbeatHolds {
        clock: channel_clock.clone(),
        store: heartbeat_store.clone(),
        activity: user_activity.clone(),
        settings: mixdog_core_config::config::Settings::with_process_env(config.clone(), settings_effects.clone()),
        agents: routine_agents.clone(),
        directory: directory.clone(),
        summaries: summaries.clone(),
        delivery: home_delivery.clone(),
        catalog: Arc::new(mixdog_core_session::session::heartbeat_catalog::StoredSessionCatalog::new(catalog_handle.clone(), list_overlay.clone())),
        held: held_requests.clone(),
        records: routine_records.clone(),
        routines: routines.clone(),
        wake_host: Arc::new(mixdog_core_session::session::heartbeat_host::SessionWakeHost::new(directory.clone(), session_close.clone(), route_context.clone(), home_delivery.clone())),
        marks: heartbeats.clone(),
    });
    bot_summaries.bind(thread_list.clone(), b.sections.clone()).map_err(|_| ComposeError::AlreadyBound("bot work summaries"))?;
    // The index writer's row writes reach the app feed: `thread/started`, `thread/summary/updated`, `thread/deleted` (Node's roster push).
    let room_publication = mixdog_core::run_host::room_publication::wire(thread_list.clone(), b.sections.clone(), thread_deletions.clone(), agents.clone(), &catalog_index, directory.clone(), room_sessions.clone()).map_err(|_| ComposeError::AlreadyBound("thread edges"))?;
    let (room_summaries, room_host) = (room_publication.summaries, room_publication.host);
    late_room_summaries.bind(room_summaries.clone()).map_err(|_| ComposeError::AlreadyBound("room summaries"))?;
    room_approvals.bind_summaries(room_summaries.clone()).map_err(|_| ComposeError::AlreadyBound("room approvals summaries"))?;
    // The rooms' first load (`agent-rooms.ts:353-362` `ready`), which every room call, a member forgotten and a member's relay await first: the rooms
    // are hosted and members whose definition is proven deleted leave (`pruneDeleted`). A failed one is forgotten; the next caller loads again.
    let rooms_ready = mixdog_core_rooms::rooms::ready::RoomsReady::new();
    // The room ports a deleted agent leaves (the agent deletion's below, and the rooms' first load's).
    let home_rooms = Arc::new(mixdog_core_rooms::rooms::sessions::SessionHomePorts::new(mcp.agents.clone(), room_sessions.clone(), rooms.clone(), room_host.clone(), room_runner.clone(), rooms_ready.clone()));
    rooms_ready
        .bind({
            let (live, rooms, homes, log) = (live_rooms.clone(), rooms.clone(), Arc::downgrade(&home_rooms), room_log.clone());
            move || {
                let (live, rooms, homes, log) = (live.clone(), rooms.clone(), homes.clone(), log.clone());
                async move {
                    live.host_loaded(&rooms).await?;
                    let Some(homes) = homes.upgrade() else { return Ok(()) };
                    homes.prune_deleted(&*log).await
                }
            }
        })
        .map_err(ComposeError::AlreadyBound)?;
    // Start-up `recover` (`agent-rooms.ts:465-480`), started and not awaited (`session-host.ts:430-432`): its failure is logged, not the core's start's.
    // After the first load, rooms whose exchange a dead process left running are marked interrupted (flip-rooms-4) and the catalog
    // is republished (`agent-rooms.ts:479`), ahead of the mutations that awaited the same load (`ready::recover`). Those wait for it, so
    // its pass is bounded: one that does not end in time is the recovery's logged failure, and they go on.
    drop(mixdog_core_rooms::rooms::ready::recover(
        rooms.clone(),
        rooms_ready.clone(),
        {
            let (live, rooms, summaries) = (live_rooms.clone(), rooms.clone(), room_summaries.clone());
            move || async move {
                live.recover(&rooms).await?;
                mixdog_rt::time::timeout(ROOM_RECOVERY_REPUBLISH, summaries.republish_now()).await.map_err(|_| {
                    mixdog_core_rooms::rooms::RoomError::Port(format!(
                        "the catalog's republish after the rooms' first load did not end within {} s",
                        ROOM_RECOVERY_REPUBLISH.as_secs()
                    ))
                })
            }
        },
        room_log.clone(),
    ));
    // The core is the attached room host (`registerAgentRoomHost(host.agentRoomHost())`, desktop-service.ts:788).
    let room_host_registration = room_hosts.register(Arc::new(mixdog_core_rooms::rooms::room_relay::MemberRelay::new(rooms.clone(), room_calls.clone(), rooms_ready.clone())));
    builder.register(Arc::new(mixdog_core_rooms::rooms::service::RoomService::new(
        rooms.clone(),
        room_host.clone(),
        room_runner.clone(),
        domain_inputs.scopes.scopes("room").map_err(ComposeError::ComposeDomains)?,
        definition_names.clone(),
        rooms_ready.clone(),
        // A user's message into a room (`room/send`, the composer's `submitToSession` on a room log).
        Arc::new(mixdog_core_rooms::rooms::user_send::UserSend::new(rooms.clone(), live_rooms.clone(), room_calls.clone())),
    )))?;
    // A room member's tool approval (wp-session-36) is wired through the ports above: `SessionRoomApprovals` is `RoomPorts.approvals` (`answer_member_approval`) and publishes the
    // decorated view (`RoomSummaries::publish_room`, `thread/roomView/updated`), `DirectoryRoomDaemon::read_snapshot` carries `member_approval` as the snapshot's `toolApproval`, and
    // `late_room_members` hands a resolved approval back to the rooms. A client answers the member's request as the response to its server request (P §8.3), not through a room method.
    // The workspaces (wp-session-32): the project registry is the concrete `WorkspaceService`; `ProjectConnectors` and the agent connector API share ONE
    // `ConnectorCatalog`; `SessionWorkspaces` is one value for the project service, the thread scm service, `ThreadSettingsParts` and the git tool.
    let project_registry: Arc<dyn mixdog_core_session::project::service::Registry> = workspace.clone();
    let connector_catalog: Arc<dyn mixdog_core_agents::agents::connector_api::ConnectorCatalog> = Arc::new(mixdog_core_agents::agents::connector_api::McpConnectors::new(mcp.mcp_domain.clone(), connector_policy.clone()));
    let project_connectors = mixdog_core_session::project::connectors::ProjectConnectors::new(
        project_registry.clone(),
        connector_catalog.clone(),
        &b.data_dir,
        mixdog_mcp::permissions::PolicyIo { maintenance: b.tokens.maintenance_io, interactive: b.tokens.interactive_io, durability: b.tokens.durability_io },
    );
    let worktree_setup = Arc::new(mixdog_core_session::session::worktree::worktree_setup::WorktreeSetup::new(worktrees.clone(), b.process_manager.clone()));
    // `SessionWorkspaceHost` needs the `HostRuntime`: the live one over the directory, the agent registry, the shells and the stores (flip-ce-misc rows).
    let host_runtime: Arc<dyn mixdog_core_session::session::worktree::worktree_host_impl::HostRuntime> = Arc::new(crate::host_runtime_draft::LiveHostRuntime {
        directory: directory.clone(),
        shells: b.shell_control.clone(),
        registry: agent_registry.clone(),
        callers: mcp.callers.clone(),
        reuses: path.reuses.clone(),
        read_state: read_state.clone(),
        durability: b.tokens.durability_io,
        prompt_reroot: mixdog_core_session::session::worktree::PromptReroot::new(directory.clone(), threads.clone()).with_surface(surface_generation.clone()),
        user_cwd: mixdog_core_session::session::UserCwd::new(b.data_dir.clone(), b.tokens.interactive_io),
        board: job_board.clone(),
        stored: mixdog_core_session::session::worktree::worktree_consumers::StoredConsumers::new(stored_sessions.clone()),
        core_memory: core_memory.clone(),
        prompt_io,
        probes: startup_probes.clone(),
        observed: startup_observed.clone(),
        facts: prompt_facts.clone(),
        instruction_files: Arc::new({ let config = config.clone(); move || prompt_config_slice(&config.full())["instructionFiles"].clone() }),
        config: config.clone(),
    });
    let workspaces = mixdog_core_session::session::worktree::SessionWorkspaces::new(
        worktrees.clone(),
        worktree_sessions.clone(),
        { let ids = live_ids.clone(); Arc::new(move || ids().into_iter().collect()) },
        Arc::new(mixdog_core_config::config::ConfigWorktreeSettings::new(config.clone())),
        Arc::new(mixdog_core_session::session::worktree::worktree_host_impl::SessionWorkspaceHost::new(directory.clone(), threads.clone(), host_runtime, worktree_setup.clone())),
        mixdog_core_session::session::worktree::AdmissionGate::new(),
    );
    late_workspaces.bind(Arc::new(workspaces.clone())).map_err(|_| ComposeError::AlreadyBound("session workspaces"))?;
    let resolver = Arc::new(crate::project_workspaces::SessionProjectWorkspaces::new(
        Arc::new(mixdog_core_session::session::thread_settings::WorkspaceFolders::new(workspace.clone(), b.user_data_dir.clone(), session_lanes())),
        worktrees.clone(),
    ));
    // `project/directory` and `project/touch` take a managed worktree path as Node's `projectScope` does: the one resolver.
    workspace.set_managed_projects(resolver.clone());
    project_workspaces.bind(resolver).map_err(|_| ComposeError::AlreadyBound("project workspaces"))?;
    late_turn_admission.bind(Arc::new(workspaces.clone())).map_err(ComposeError::AlreadyBound)?;
    late_live_workspace.bind(Arc::new(workspaces.clone())).map_err(ComposeError::AlreadyBound)?;

    // ---- the agent tool (flip-agent-worlds chain, landed at 51e73b496): `assemble(AgentParts{..})`, after the session workspaces (`AgentParts.spawn_admission`) ----
    let default_cwd = startup_cwd.to_string_lossy().into_owned();
    let session_completions = Arc::new(mixdog_core_session::session::agent_registry::flow::SessionCompletions::new(directory.clone()));
    let assembled = mixdog_agent::agent_tool::assemble(mixdog_agent::agent_tool::AgentParts {
        board: job_board.clone(),
        clock: clock_agent.clone(),
        registry: agent_registry.clone(),
        sessions: agent_sessions.clone(),
        turn_sessions: session_turns.clone(),
        turns: Arc::new(worker_turns.clone()),
        reviews: Arc::new(mixdog_core_review::turn_review::seams::AgentTurnReviews::new(turn_review.clone())),
        events: Arc::new(mixdog_core::run_host::hooks::HookSubagentEvents::new(hook_bus.clone(), {
            // The session's folder and hook payload fields, as the compaction hooks read them; a session that is not loaded runs hooks in the startup folder with Node's defaults.
            let (late, startup_cwd) = (late.clone(), startup_cwd.clone());
            Arc::new(move |session: &str| match late.live_header(session) {
                Some(header) => (
                    header.get("cwd").and_then(|v| v.as_str()).filter(|c| !c.is_empty()).map_or_else(|| startup_cwd.clone(), std::path::PathBuf::from),
                    mixdog_core::run_host::compose_parts::common_of_header(&header),
                ),
                None => (startup_cwd.clone(), mixdog_mcp::hook_bus::HookCommon { permission_mode: Some("default".to_owned()), ..Default::default() }),
            })
        })),
        inbox: session_completions.clone(),
        owner_notify: session_completions,
        admission: agent_admission.clone(),
        starts: Arc::new(mixdog_core_session::session::agent_registry::flow::AgentTaskStarts::default()),
        workers: Arc::new(mixdog_core_session::session::agent_registry::workers::AgentWorkers::new(directory.clone(), threads.clone(), agent_registry.clone(), shell_jobs.clone(), clock.clone())),
        status_changed: { let activity = activity.clone(); Arc::new(move || activity.everyone()) },
        spawn_world: Arc::new(mixdog_core::run_host::agent_spawn_world::DirectorySpawnWorld {
            config: config.clone(),
            bots: route_bots.clone(),
            definitions: mcp.agents.clone(),
            registry: agent_registry.clone(),
            sessions: agent_sessions.clone(),
            directory: directory.clone(),
            providers: registry.clone(),
            windows: Arc::new(mixdog_core::run_host::agent_world::CatalogWindows(b.catalog.clone())),
            statusline: Arc::new(gateway_routes.clone()),
            runs: unattended.clone(),
        }),
        spawn_admission: Arc::new(workspaces.clone()),
        send_world: agent_send_world.clone(),
        terminal_trace: agent_registry.clone(),
        env: Arc::new(mixdog_core::run_host::agent_inputs::FileEnvironment::new(b.files.clone(), b.tokens.interactive_io, default_cwd.clone())),
        catalog: Some(Arc::new(mixdog_core::run_host::agent_board::ModelListCatalog(model_list.clone()))),
        scopes: directory.clone(),
        errors: Arc::new(mixdog_agent::agent_tool::error_text::PlainErrorText),
        default_cwd,
        mcp_scope_id: None,
    });
    late_agent_port.bind(assembled.port()).map_err(|_| ComposeError::AlreadyBound("agent port"))?;
    let agent_runtime = assembled.runtime.clone();
    // The routine sessions of the channel stack (`LateRoutineSessions`): the spawn flow is the agents the executor runs.
    routine_sessions
        .bind(mixdog_core::run_host::routine_host::CoreRoutineSessions::new(directory.clone(), unattended.clone(), Arc::new(assembled.spawn.clone()), attachment_files.clone(), Arc::new(home_delivery.clone())))
        .map_err(|_| ComposeError::AlreadyBound("routine sessions"))?;
    builder.register(Arc::new(mixdog_core_session::project::service::ProjectService::new(
        project_registry.clone(),
        worktrees.clone(),
        workspaces.clone(),
        worktree_sessions.clone(),
        { let ids = live_ids.clone(); Arc::new(move || ids().into_iter().collect()) },
        project_connectors,
        domain_inputs.scopes.scopes("project").map_err(ComposeError::ComposeDomains)?,
    )))?;
    let thread_scm = Arc::new(mixdog_core_session::session::worktree::worktree_service::ThreadScmService::new(
        workspaces.clone(),
        turn_review.clone(),
        domain_inputs.scopes.scopes("git").map_err(ComposeError::ComposeDomains)?,
    ));
    // The directory's `thread/start` (draft worktree) and `thread/fork` (heir's Project) reach the workspace service and the Projects through this cell.
    let new_place_folders: Arc<dyn mixdog_core_session::session::thread_settings::ProjectFolders> = Arc::new(mixdog_core_session::session::thread_settings::WorkspaceFolders::new(workspace.clone(), b.user_data_dir.clone(), session_lanes()));
    late_new_place.bind(Arc::new(mixdog_core_session::session::worktree::worktree_service::ScmNewThreadPlace::new(thread_scm.clone(), new_place_folders))).map_err(ComposeError::AlreadyBound)?;
    builder.register(thread_scm)?;
    // `thread/list`: the room rows overlay the stored list (wp-session-32).
    // (`thread_list` itself is built above, before the room republish that reads it.)
    builder.register(thread_list.clone())?;
    builder.register(model_list.clone())?; // `model/list` (the same `ModelListService` the web-search rows call)
    // wp-ai-admin `RouteService` (EffortTuning): the route cell, the adapter the cell's writer applies through (the one bound `late_route_session`), the live route writer
    // and the follow-the-thread route. `usage` is `ProviderUsageSources` (`StatuslineUsage`), whose api-key lookups need the api-key store and `ApiUsageService`.
    let usage_sources = mixdog_core_domains::domains::ai_account::usage::sources::ProviderUsageSources::new(
        oauth_usage.clone(),
        registry.clone(),
        account_store.clone(),
        Arc::new(mixdog_ai::service::api_usage::ApiUsageService::new(
            Arc::new(mixdog_ai::service::usage_ports::RoutedUsageHttp::following(http_send.clone())), // bare `fetch` follows redirects
            media_keys.clone(), // the registry's one `ApiKeyStore` (builder_env.keys), never a second one
            process.vault.clone(),
            process.env.clone(),
            credential_io,
            b.data_dir.clone(),
            now_ms.clone(),
        )),
    );
    // The boot's scheduleStatuslineUsageWarmup() (session.mjs:125): it prepares the live Main route's OAuth provider and refreshes its usage reading.
    statusline_warmup
        .bind(
            { let main = main_route.clone(); Arc::new(move || main.route()) },
            Arc::new(mixdog_core_domains::domains::ai_admin::statusline_warmup::ReadinessPrep { keychain: keychain_live.clone(), loaded: loaded_config.clone(), readiness: readiness.clone() }),
            usage_sources.clone(),
            Arc::new(crate::prewarm_world::DaemonWarmupGates { liveness: liveness.clone(), directory: late.clone(), close_requested: close_requested.clone() }),
        )
        .map_err(|()| ComposeError::AlreadyBound("statusline usage warm-up"))?;
    warmup_schedulers.schedule_statusline_usage_warmup();
    let route_writer = Arc::new(mixdog_core_ports::ports::route_write::LiveRouteWriter {
        cell: routes.clone(),
        session: late_route_session.clone(),
        config: config.clone(),
        catalog: b.catalog.clone(),
        readiness: readiness.clone(),
        usage: usage_sources.clone(),
    });
    let route_follow = Arc::new(mixdog_core_ports::ports::route::SessionRoutes::new(threads.clone(), threads.clone(), late_route_session.clone(), routes.clone()));
    let route_service = Arc::new(mixdog_core_domains::domains::ai_admin::route_service::RouteService { config: config.clone(), facts: facts.clone(), writer: route_writer, session: route_follow.clone(), models: model_list.clone(), controls: directory.clone() });
    // The control thread's empty Main route follows the config as Node's `adoptFullConfig` does (`syncEmptyMainRoute`).
    let control_route_sync = route_service.follow_config();
    // The route a `thread/start` thread begins on is the route service's; the pick a turn start applies is the follow's (`SessionRoutes::apply_pending`).
    late_new_route.bind(route_service.clone()).map_err(|_| ComposeError::AlreadyBound("new thread route"))?;
    late_pending_route.bind(route_follow).map_err(|_| ComposeError::AlreadyBound("pending route"))?;
    chat_routes.bind(Arc::new(mixdog_core_domains::domains::ai_admin::chat_routes::ChatRoutes::new(route_service.clone()))).map_err(|_| ComposeError::AlreadyBound("agent chat routes"))?;
    builder.register(Arc::new(mixdog_core_session::session::thread_settings::ThreadSettings::new(
        mixdog_core_session::session::thread_settings::ThreadSettingsParts {
            directory: directory.clone(),
            workspaces: workspaces.clone(),
            effort: route_service.clone(), // `impl EffortTuning for RouteService`; the same Arc as `RouteSetService.routes` and `ThreadRouteService`
            projects: Arc::new(mixdog_core_session::session::thread_settings::WorkspaceFolders::new(workspace.clone(), b.user_data_dir.clone(), session_lanes())),
            agent_only: Arc::new(catalog_index.clone()),
            worktrees: worktree_maintenance.clone(),
            retention: archive_retention.clone(), // the SAME Arc as `PurgeOwners.retention` (wp-session-33/-40)
            app: b.sections.clone(),
            ops: domain_inputs.scopes.scopes("thread").map_err(ComposeError::ComposeDomains)?,
            surface: surface_generation.clone(),
            archive_stamps: archive_stamps.clone(),
        },
    )))?;
    // `thread/setWorkflow`, `thread/setOrchestrationMode`, `thread/setOutputStyle`, `thread/switchContext` (`compose-seams.md` "wu-thread-settings", landing wu-thread-settings-3; flip-brief A16): the context switch
    // closes the thread being left as `deleteSession` does and moves the surface generation with the gauge (`GaugeTarget`, Node's `invalidateContextStatusCache` + `invalidatePreSessionToolSurface`).
    let thread_settings = Arc::new(mixdog_core_config::workflow::thread_settings::ThreadSettings {
        workflow: workflow_config.clone(),
        styles: output_styles.clone(),
        switches: session_switches.clone(),
        context: Arc::new(mixdog_core_session::session::thread_switches::SessionContextSwitch::new(
            directory.clone(),
            session_close.clone(),
            Arc::new(mixdog_core_session::session::thread_switches::GaugeTarget(gauge.clone(), surface_generation.clone())),
        )),
        ops: domain_inputs.scopes.scopes("thread").map_err(ComposeError::ComposeDomains)?,
    });
    // A new task's draft workflow and mode are these methods of the new thread (`configureDraft` → `invokeSession`).
    late_draft_settings.bind(thread_settings.clone()).map_err(|_| ComposeError::AlreadyBound("draft settings"))?;
    builder.register(thread_settings)?;
    // `thread/contextStatus` (`ThreadContextService`) over the same world; `thread/backgroundTerminals/*`, `thread/listShellJobs`, `thread/listStoppableShellJobs`
    // (`ShellJobsService`) over the one `SessionThreads`, the shell control and a git sight on the maintenance lane; both share the one `thread` op scope (in `OP_SCOPES`).
    builder.register(Arc::new(mixdog_core_session::session::thread_context::ThreadContextService::new(Arc::new(
        mixdog_core_session::session::thread_context::LiveContextStatus::new(context_world.clone()),
    ))))?;
    builder.register(Arc::new(mixdog_core_session::session::shell_jobs::ShellJobsService::new(
        b.shell_control.clone(),
        threads.clone(),
        Arc::new(mixdog_core_session::session::workspace_sight::GitSight::new(b.tokens.maintenance_io)),
        domain_inputs.scopes.scopes("thread").map_err(ComposeError::ComposeDomains)?,
    )))?;
    // `thread/turnActions/*` and `thread/resizeImage`: the directory, the agent runtime of `assemble(AgentParts{..})` (wp-agent), the ext-host image codec, the `thread` scope.
    builder.register(Arc::new(mixdog_core_session::session::turn_actions::TurnActionsService::new(
        directory.clone(),
        agent_runtime,
        Arc::new(mixdog_exthost::ExtImageCodec::new(b.ext_host.clone())),
        domain_inputs.scopes.scopes("thread").map_err(ComposeError::ComposeDomains)?,
    )))?;
    // ---- the services whose constructors the tree and the draft both have (registration-inventory.md; flip-brief.md "Unregistered services") ----
    // memory (`memory/recall`, `memory/memoryControl`): the memory stack's service over the stored sessions it recalls from.
    builder.register(Arc::new(memory.service(Arc::new(mixdog_core_ports::ports::memory_source::SessionRecallSource::new(
        Arc::new(LateThreads(late.clone())),
        Arc::new(LateThreads(late.clone())),
        Arc::new(config.clone()),
    )))))?;
    // thread/search: the read side of the session-search database the stack's ingest writer owns.
    builder.register(mixdog_services::memory::thread_search::ThreadSearchService::new(memory.search().db().clone()))?;
    // channel/*: the admin and the call dispatch of the channel worker; `ChannelRuntime` is the lifecycle `activate_channel_bridge`/`reload_config` drive.
    // `degraded` is `isChannelsDegraded()`, a constant `false` in Node (`crash-log.mjs:12`).
    let channel_calls = mixdog_services::channels::CallDispatch::new(
        Arc::new(mixdog_services::channels::bridge::BridgeCalls::new(mixdog_services::channels::ToolDispatch::new(channel_runtime.clone(), channel_work.clone(), Box::new(|| false)))),
        channel_work.clone(),
    );
    channel_calls.hear_bridge(&channel_runtime);
    // `hostState.remoteSession`: the session the bridge is pinned to, published now and at each change of the binding.
    let session_publisher = state.publisher.clone();
    channel_calls.observe_binding(Arc::new(move |remote| mixdog_core_domains::domains::host::publish_remote_session(session_publisher.as_ref(), remote.acquired, remote.pinned_session_id, remote.cwd)));
    // The pin a manual Remote ON saved (`channel-remote-intent.json` in the runtime root, where Node keeps it); `restore_remote_intent` activates it after ready.
    channel_calls
        .load_intent(mixdog_services::channels::intent::IntentFile::new(&b.runtime_root, b.tokens.maintenance_io, b.log.line_log()))
        .await;
    // The restore drops a pin only to a session known to be deleted (`storedSessionPresence`); an unreadable record keeps it.
    let restore_directory = directory.clone();
    channel_calls.bind_session_presence(Arc::new(move |id: String| {
        let directory = restore_directory.clone();
        Box::pin(async move { directory.stored_presence(&mixdog_core_api::ids::ThreadId::from(id.as_str())).await })
    }));
    builder.register(Arc::new(mixdog_services::channels::ChannelService::new(channel_admin.clone(), channel_calls.clone())))?;
    // agent/*, lead, home: definitions with the connector and permission stores the tool gate holds, the Lead's appearance, and the bots' homes.
    // The home threads, one value for the home methods, the lifecycle of the definition calls and Mixy's status: the stored
    // sessions the retire pass reads, and the room ports a deleted agent leaves (`home_rooms`, above).
    let agent_homes = mixdog_core_agents::agents::AgentHomeSessions::new(Arc::new(mixdog_core::run_host::agent_home_deps::SessionHomeDeps::new(
        mcp.agents.clone(),
        room_sessions.clone(),
        directory.clone(),
        stored_sessions.clone(),
        home_rooms,
    )));
    let agent_greetings = mixdog_core_agents::agents::AgentGreetings::new(Arc::new(crate::agent_lifecycle::SessionGreetingDeps::new(config.clone(), mcp.agents.clone(), agent_homes.clone(), directory.clone())));
    // Node ran the agent-home retire and the greeting reconcile whenever `listAgents` was read; the pushed `agents`
    // section calls `listed` after each catalog build, and builds once more now that the hook exists.
    let agent_lifecycle = mixdog_core_agents::agents::AgentLifecycle::new(agent_homes.clone(), agent_greetings);
    let listed_lifecycle = agent_lifecycle.clone();
    assert!(agent_listed.set(Arc::new(move |agents| listed_lifecycle.listed(agents))).is_ok(), "the list hook is bound once");
    agent_list_changed.notify_one();
    builder.register(Arc::new(mixdog_core_agents::agents::AgentService::new(
        mcp.agents.clone(),
        mixdog_core_agents::agents::AgentConnectors::new(mcp.agents.clone(), connector_catalog.clone()),
        mixdog_core_agents::agents::AgentPermissions::new(grants.clone()),
        agent_lifecycle,
    )))?;
    builder.register(Arc::new(mixdog_core_agents::agents::DesktopLeadStatus::new(
        mixdog_core_agents::agents::LeadService::new(
            mcp.agents.clone(),
            mixdog_core_agents::agents::LeadAppearance::new(config.clone()),
            domain_inputs.scopes.scopes("agent").map_err(ComposeError::ComposeDomains)?,
        ),
        mcp.agents.clone(),
        agent_homes.clone(),
    )))?;
    builder.register(Arc::new(mixdog_core_agents::agents::AgentHomeService::new(
        agent_homes,
        mixdog_core_agents::agents::AgentMemoryHost::new(Arc::new(mixdog_core_rooms::rooms::memory_control::RuntimeMemoryControl::new(
            memory.db(),
            memory.data_dir(),
            memory.snapshot_revision(),
            b.tokens.durability_io,
        ))),
        agent_pool,
    )))?;
    // thread/getSessionUsage; route/set and fast/set; thread/continueInModel and thread/quotaResume/*. The op scopes are `account` and `thread`
    // (Node gates the model routes with the provider accounts, the thread routes with the thread ops).
    builder.register(mixdog_core_domains::domains::ai_account::usage::session_usage::SessionUsageService::new(ledger_source.clone(), account_store.clone(), threads.clone(), threads.clone()))?;
    builder.register(Arc::new(mixdog_core_domains::domains::ai_admin::route_set_service::RouteSetService {
        routes: route_service.clone(),
        agents: route_setter.clone(),
        ops: domain_inputs.scopes.scopes("account").map_err(ComposeError::ComposeDomains)?,
    }))?;
    builder.register(Arc::new(mixdog_core_domains::domains::ai_admin::thread_route_service::ThreadRouteService {
        routes: route_service.clone(),
        quota: quota_store.clone(),
        sessions: directory.clone(),
        ops: domain_inputs.scopes.scopes("thread").map_err(ComposeError::ComposeDomains)?,
    }))?;
    // account/* (+ `account/listWebSearchModels`) and usage/*: the provider admin and the sign-in flows over the one ledger source, the custom-provider admin (a transaction per key, over the
    // stores the provider admin holds), the web-search catalog (wp-ai-admin-19) and the dashboards; the usage dashboard also reads the stored sessions' metadata (session-metadata-1: the directory).
    let custom_providers = mixdog_core_domains::domains::ai_account::custom_admin::CustomAdmin::new(
        mixdog_core_domains::domains::ai_account::custom_admin::CustomHost::new(
            config.clone(),
            process.vault.clone(),
            media_keys.clone(),
            account_store.clone(),
            default_builder.clone(),
            process.env.clone(),
            mixdog_core_domains::domains::ai_account::custom_admin::CustomSeams { broker: broker.clone(), rotation: (*rotation).clone(), log: b.log.line_log() },
        ),
        refresh.clone(),
    );
    builder.register(mixdog_core_domains::domains::ai_account::account::AccountService::new(
        provider_admin.clone(),
        mixdog_core_domains::domains::ai_account::flows::OAuthFlows::new(
            std::time::Duration::from_millis(mixdog_core_domains::domains::ai_account::flows::DEFAULT_FLOW_TTL_MS),
            Arc::new(mixdog_core_api::feed_publisher::LoginFeeds::new(b.scoped_feeds.clone())),
        ),
        ledger_source.clone(),
        custom_providers,
        web_search_models.clone(),
        provider_setup.clone(),
        dashboards.clone(),
        usage_sources.clone(),
        domain_inputs.scopes.scopes("account").map_err(ComposeError::ComposeDomains)?,
        state.publisher.clone(), // `providerSetup` and `providerAccounts`
        mixdog_core_domains::domains::ai_account::account::SectionWake {
            config: config.changes(),
            // The credential files Node reads on every call, and the stored-secret marker.
            files: mixdog_core_config::section_watch::Watched {
                roots: vec![b.data_dir.join("provider-accounts")],
                files: [mixdog_ai::accounts::ACCOUNT_PROVIDERS.iter().map(|provider| format!("{provider}.json")).collect::<Vec<_>>(), vec![
                    "provider-accounts.json".to_owned(),
                    "anthropic-oauth-credentials.json".to_owned(),
                    mixdog_core_config::config::secret_changes::SecretChanges::marker_name().to_owned(),
                ]]
                .concat()
                .into_iter()
                .map(|name| (b.data_dir.clone(), std::ffi::OsString::from(name)))
                .collect(),
            },
        },
    )
    .map_err(|error| ComposeError::ComposeDomains(crate::compose_domains::ComposeDomainsError::Watch(mixdog_core_config::config::ConfigError::Io(std::io::Error::other(error)))))?)?;
    usage_push
        .dashboard
        .bind(Arc::new(mixdog_core::run_host::usage_stats_feed::DashboardReading { dashboards: dashboards.clone(), sources: usage_sources.clone(), accounts: account_store.clone() }))
        .map_err(|_| ComposeError::AlreadyBound("usage dashboard source"))?;
    // The ledger opens here, at startup, rather than at its first record or statistics question: opening starts the feeds, which publish both
    // `usage` entries at once, so a client that subscribes later is handed them. An open that fails is logged and tried again at the next ask.
    if let Err(error) = ledger_source.get().await {
        tracing::warn!(%error, "[usage] the ledger could not be opened at startup");
    }
    builder.register(mixdog_core_domains::domains::ai_account::usage::UsageService::new(ledger_source.clone(), directory.clone(), usage_sources.clone(), account_store.clone(), dashboards.clone()))?;
    // modelProxy/run, modelProxy/cancel (and the `modelProxy/run/event` notifications): the PC end of the model proxy (model-proxy-1). They are in the method and notification tables at 51e73b496, so the
    // unclaimed check asks for them. Every input is an instance held above: the registry, the one broker, the one account store and OAuth usage, the config, the registry's builder, key store and env.
    let proxy_runner = Arc::new(mixdog_core_domains::domains::ai_admin::model_proxy::ProxyRunner {
        providers: registry.clone(),
        broker: broker.clone(),
        quota: Arc::new(mixdog_core::run_host::model_proxy_pc::PcQuotaProbe::new(
            Arc::new(mixdog_core::run_host::model_proxy_pc::UsageMeasure(Arc::new(mixdog_core::run_host::quota_usage::UsageReadings { store: account_store.clone(), usage: oauth_usage.clone() }))),
            { let now = now_ms_epoch.clone(); Arc::new(move || now() as i64) },
        )),
        wire: Arc::new(mixdog_core::run_host::model_proxy_pc::PcWireRouter),
        config: Arc::new(mixdog_core::run_host::model_proxy_pc::PcProviderConfig::new(
            { let config = config.clone(); Arc::new(move || config.agent().get("providers").and_then(serde_json::Value::as_object).cloned().unwrap_or_default()) },
            registry.clone(),
            Arc::new(mixdog_core::run_host::model_proxy_pc::RegistryCredentials { builder: default_builder.clone(), keys: media_keys.clone(), env: process.env.clone() }),
        )),
        catalog: b.catalog.clone(),
    });
    let model_proxy = Arc::new(mixdog_core_domains::domains::ai_admin::model_proxy_service::ModelProxyService::new(proxy_runner, b.host.clone(), b.notifier.clone()));
    builder.register(model_proxy.clone())?;
    // browser/stream, browser/webrtcSignal, browser/screenDisplays, browser/streamAck, host/browser/page, host/browser/frame: the phone's live
    // view of Browser Use (SPEC R36) and its JPEG view.
    let live_view = Arc::new(crate::live_view::LiveViewService::new(b.host.clone(), b.notifier.clone(), b.host_media.clone(), built_remote.runtime.clone(), b.tokens.media_thread, Arc::new(crate::live_view::PairedScreenAccess::new(crate::domain_seams::remote::phone_credential(built_remote.registry.clone()), crate::domain_seams::remote::screen_revoked(built_remote.registry.clone()), crate::domain_seams::remote::peer_attached(built_remote.registry.clone())))));
    let _ = live_view_slot.set(Arc::downgrade(&live_view));
    builder.register(live_view.clone())?;
    // host/claim is answered by the server itself (it owns the connection registry, ClientRequest::HostClaim), so no domain service claims it.
    let mut unclaimed = builder.unclaimed();
    unclaimed.retain(|method| *method != "host/claim");
    if !unclaimed.is_empty() {
        return Err(ComposeError::Unclaimed { methods: unclaimed });
    }
    let domains = builder.build();
    // Every late cell, once the last of them (the session workspaces) is bound.
    // The five owners of per-connection state (run-host-36); `compose()` binds them into `ComposedCore::connection_owners()`, which `verify_bound` checks.
    let connection_owners = crate::connection_close::ConnectionOwnersCell::default();
    connection_owners
        .bind(crate::connection_close::ConnectionOwners::new(terminal.clone(), screen.clone(), workspace.clone(), composed.system.clone(), built_remote.registry.clone(), live_view))
        .map_err(|_| ComposeError::AlreadyBound("connection owners"))?;
    crate::compose::verify_bound(&[&*bot_world, &*late_new_place, &*late_draft_settings,&connection_owners, &*late_agent_status, &*late_turn_admission, &*late_live_workspace,&*room_approvals, &*late, &crate::late_session::LateReadinessHook(readiness.clone()), &*late_room_summaries, &*late_computer_hosts, &*late_dispatcher, &*late_catalog, &*late_list_catalog, &*late_skills, &*project_workspaces, &*bot_summaries, &*late_reactions, &*late_agent_port,&*late_cycle_llm, &*route_positions, &*live_route, &*agent_channels, &*chat_routes, &*routine_sessions, &mixdog_core::run_host::late_chats::LateAgentChats(late.clone()), &*late_setup_ui, &*late_workspaces, &*path.turn_settings, &*late_new_route, &*late_pending_route, &*late_route_session, &*extension_host, &crate::late_session::LateCallerSessions(late.clone()), &mixdog_core::run_host::compose_parts::LateHeaders(late.clone()), &mixdog_core::run_host::compose_parts::HookCommonCell(late.clone()), &crate::late_session::LateMediaProbe(provider_layer.clone()), &*setup_warmup, &crate::setup_host::ModelWarmupCell(model_warmup.clone()), &crate::setup_host::StatuslineWarmupCell(statusline_warmup.clone()), &*b.thread_gates, &*agent_evidence, &*session_facts, &*held_home, &*live_route, &*tool_surface])?;
    Ok(Real { defaults_separation, control_route_sync, late_lifecycle, connection_owners, local_dialer: late_dialer.clone(), remote: built_remote, directory, agent_dispatch, agent_host, code_graph_cache, exec: b.exec.clone(), maintenance_io: b.tokens.maintenance_io, domains, config, close_requested, resume_timer, goal_recovery, worktree_stop, maintenance_stop, worktree_task, maintenance_loop: std::sync::Mutex::new(maintenance_loop), ledgers: ledger_source, computer: computer_pool, terminal, room_host: room_host_registration, channels: channel_runtime, channel_calls, channel_config_follow, memory, log: b.log.clone(), publisher: state.publisher.clone(), gateway_routes: gateway_settle, model_proxy, event_pipeline, catalog_index: catalog_handle, heartbeat, heartbeat_run: Arc::default(), sub_agent_retention: Arc::default(), archive_stamps, core_state: b.core_state.clone(), skip_memory, gateway_usage, #[cfg(feature = "replay-controls")] replay_writers: crate::replay_stores_settled::WriteBehind { workers: replay_workers, read_state: read_state.clone() }, #[cfg(test)] turn_review, #[cfg(test)] tool_pool: kept_tool_pool })
}

/// `promptConfigSlice(config)` (`prompt-settings.mjs:36`) over the whole in-memory config: `??` falls through on `null`/absent only.
fn prompt_config_slice(root: &serde_json::Map<String, serde_json::Value>) -> serde_json::Value {
    let agent = root.get("agent").and_then(serde_json::Value::as_object);
    let pick = |key: &str, with_agent: bool| {
        let own = root.get(key).filter(|v| !v.is_null());
        let from_agent = || agent.and_then(|a| a.get(key)).filter(|v| !v.is_null());
        own.or_else(|| if with_agent { from_agent() } else { None }).cloned().unwrap_or(serde_json::Value::Null)
    };
    serde_json::json!({ "outputStyle": pick("outputStyle", false), "profile": pick("profile", true), "instructionFiles": pick("instructionFiles", true) })
}

/// The tracked secret store whose keychain failures raise the `secret-storage-failed` desktop notice (`keychain-cjs.cjs` `_noticeSecretStoreFailure` →
/// `raiseDesktopNotice('secret-storage', 'secret-storage-failed')`), through the `notice` section.
fn tracked_secret_store(
    io: mixdog_rt::DurabilityIo,
    data_dir: &std::path::Path,
    notices: &Arc<mixdog_core_domains::notify::desktop_notice::DesktopNotices>,
) -> (Arc<dyn mixdog_secrets::SecretStore>, Arc<mixdog_secrets::StatusTracker>) {
    mixdog_secrets::default_store_with_status(io, data_dir, notices.secret_storage_failed())
}

/// `builtinSkillNamesFor` (`turn-tool-cards.mjs:39-55`): the built-in skills' names, trimmed and lower-cased, from the skill catalog's current list. The read is sync (a live
/// turn asks while it commits a batch), so it takes the catalog's cached list; a cold or stale list is `None` ("the status could not be read"), as the trait says.
pub struct CatalogBuiltinSkills(pub Arc<mixdog_mcp::skill_catalog::SkillCatalog>);

impl mixdog_core_session::session::BuiltinSkills for CatalogBuiltinSkills {
    fn names(&self) -> Option<std::collections::HashSet<String>> {
        self.0.cached().map(|skills| skills.iter().filter(|skill| skill.source == mixdog_mcp::skills::SkillSource::Builtin).map(|skill| skill.name.trim().to_lowercase()).collect())
    }
}

/// The host's catalog for the grants and downloads a paired phone holds: whether a session is still in it (`SqliteStore::summary`: a
/// deleted session, or one whose log has no readable frame, has no row), the row of one, and the file the media store has for an asset.
struct CatalogSessions {
    sessions: Arc<mixdog_store::sqlite::SqliteStore>,
    media: Arc<mixdog_services::media::MediaStore>,
}

#[async_trait::async_trait]
impl mixdog_workspace::grants::SessionCatalog for CatalogSessions {
    async fn has(&self, session_id: &str) -> mixdog_workspace::error::WsResult<bool> {
        self.sessions
            .summary(session_id)
            .await
            .map(|row| row.is_some())
            .map_err(|error| mixdog_workspace::error::WsError::new(mixdog_workspace::error::Reason::Io, error.to_string()))
    }

    /// Node's `listSessions()` entry of the conversation: its classification, project and folder as its list row states them.
    async fn row(&self, session_id: &str) -> mixdog_workspace::error::WsResult<Option<mixdog_workspace::grants::SessionRow>> {
        let io = |error: String| mixdog_workspace::error::WsError::new(mixdog_workspace::error::Reason::Io, error);
        let Some(summary) = self.sessions.summary(session_id).await.map_err(|error| io(error.to_string()))? else { return Ok(None) };
        // Only the three fields a download needs: the stored row is a JSON object, whose other fields are not this seam's to interpret.
        let row: serde_json::Value = serde_json::from_str(&summary).map_err(|error| io(error.to_string()))?;
        let text = |key: &str| row.get(key).and_then(serde_json::Value::as_str).map(str::to_owned);
        // Node's list row (`_desktopSessionSummary`) states the classification and the project under `desktopSession`.
        let desktop = row.get("desktopSession");
        let in_desktop = |key: &str| desktop.and_then(|d| d.get(key)).and_then(serde_json::Value::as_str).map(str::to_owned);
        Ok(Some(mixdog_workspace::grants::SessionRow {
            project: in_desktop("classification").as_deref() == Some("project"),
            project_path: in_desktop("projectPath"),
            cwd: text("cwd").unwrap_or_default(),
        }))
    }

    /// The media store's file for an asset (`resolveMediaFile`, original rendition): none for an asset it does not know or whose bytes are
    /// gone. A file that is not a regular one is handed over all the same: the download refuses it without opening it.
    async fn media(&self, asset_id: &str) -> mixdog_workspace::error::WsResult<Option<mixdog_workspace::grants::MediaEntry>> {
        let id = asset_id.to_owned();
        let located = self
            .media
            .run(move |store| store.locate_file(&id))
            .await
            .and_then(|found| found)
            .map_err(|error| mixdog_workspace::error::WsError::new(mixdog_workspace::error::Reason::Io, error.to_string()))?;
        Ok(located.and_then(|found| {
            let (mixdog_services::media::store::Located::Readable(entry) | mixdog_services::media::store::Located::Special(entry)) = found;
            let path = entry.get("path")?.as_str()?.to_owned();
            Some(mixdog_workspace::grants::MediaEntry { path, mime: entry.get("mime").and_then(serde_json::Value::as_str).map(str::to_owned) })
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_core_api::mock::MockStatePublisher;
    use mixdog_core_api::state::SectionChange;
    use mixdog_protocol::SectionName;

    /// A keychain failure on the daemon's tracked secret store reaches the `notice` section as the notice Node's holder raises
    /// (`fixtures/desktop-notice/golden.json`, `keychainSteps` "failure": `raiseDesktopNotice('secret-storage', 'secret-storage-failed')`).
    #[test]
    fn a_keychain_failure_on_the_tracked_secret_store_raises_the_desktop_notice() {
        let golden: serde_json::Value = serde_json::from_str(include_str!("../../../fixtures/desktop-notice/golden.json")).unwrap();
        let step = golden["keychainSteps"].as_array().unwrap().iter().find(|step| step["step"] == "failure").unwrap();
        let publisher = Arc::new(MockStatePublisher::default());
        let notices = mixdog_core_domains::notify::desktop_notice::DesktopNotices::new(publisher.clone());
        let dir = tempfile::tempdir().unwrap();
        let (_store, tracker) = tracked_secret_store(mixdog_rt::testing::tokens().durability_io, dir.path(), &notices);
        tracker.note_failure("storage exploded", mixdog_secrets::FailureCode::Other);
        let delivered: Vec<serde_json::Value> = publisher
            .published()
            .into_iter()
            .map(|(section, key, change)| {
                assert_eq!(section, SectionName::Notice);
                let SectionChange::Set(bytes) = change else { panic!("a raise sets the entry") };
                let notice: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(key.as_deref(), notice["key"].as_str());
                notice
            })
            .collect();
        assert_eq!(serde_json::Value::Array(delivered), step["delivered"]);
    }
}
