//! The daemon: composition root and lifecycle of the `mixdogd` process (SPEC §3.2). Module
//! owners add their own `pub mod` line below.

use std::sync::Arc;

use mixdog_core_api::CoreState;
use mixdog_rt::Backend;
use mixdog_rt::LaneTokens;
use mixdog_rt::TaskClass;
use mixdog_rt::exec::Executors;
use mixdog_rt::exec::RtConfig;

pub mod acquired;
pub mod agent_lifecycle;
pub mod barrier;
pub mod boot_coordinator;
pub mod boot;
pub mod catalog;
pub mod channel_router;
pub mod compat;
pub mod compose;
#[cfg(test)]
mod compose_test_support;
pub mod compose_core;
#[cfg(all(test, windows))]
mod lead_request_tests;
pub mod compose_mcp;
pub mod connection_close;
pub mod effort_judge_host;
pub mod fencing_ownership;
pub mod code_graph_trust;
pub mod compose_flip;
#[cfg(feature = "replay-controls")]
mod replay_stores_settled;
pub mod feature_probes;
pub mod held_home_draft;
pub mod host_runtime_draft;
pub mod late_lifecycle;
pub mod memory_agent_watch;
pub mod prewarm_world;
pub mod setup_host;
#[cfg(test)]
mod warmup_schedulers_replay;
pub mod compose_domains;
pub mod late_live_route;
pub mod late_route_positions;
pub mod late_agent_cells;
pub mod late_session;
pub mod late_seams;
pub mod late_tool_surface;
pub mod os_probe;
pub mod control;
pub mod crash_record;
pub mod stale_temps;
pub mod daemon_log;
pub mod desktop_defaults;
pub mod discovery;
pub mod domain_seams;
pub mod js_runtime;
pub mod event_pipeline;
pub mod held_requests;
#[cfg(test)]
mod held_runs_tests;
#[cfg(test)]
mod workers_stop_tests;
#[cfg(test)]
mod session_host_replay_tests;
pub mod memory_callers;
pub mod hook_rule_setup;
pub mod setup_status;
pub mod lifecycle;
pub mod mcp_surface;
pub mod live_view;
pub mod live_view_streams;
pub mod media;
pub mod exec;
pub mod exec_events;
pub mod ownership;
mod office_startup;
pub mod pair_code;
pub mod project_workspaces;
pub mod server;
pub mod serving;
pub mod server_ensure;
pub mod session_retention;
pub mod session_sweep;
pub mod shell_name;
pub mod signals;
pub mod system_proxy_claim;
pub mod terminal_folder_release;
pub mod startup;
pub mod stop_watch;
pub mod sweep_store;
pub mod update_installer;
pub mod verdict;

#[derive(Debug, thiserror::Error)]
pub enum ServeError {
    #[error("composing the core: {0}")]
    Compose(#[from] compose::ComposeError),
    #[error("resolving the JS runtime: {0}")]
    JsRuntime(#[from] js_runtime::JsRuntimeError),
    #[error("no data directory (set MIXDOG_DATA_DIR or HOME)")]
    NoDataDir,
    #[error("serving: {0}")]
    Serving(#[from] serving::ServingError),
    #[error("startup: {0}")]
    Startup(#[from] startup::StartupError),
    /// A stop request arrived before the core served: the start is abandoned (a blocked verdict wait was woken; a running migration finished first).
    #[error("stopped by {0} during startup")]
    StoppedDuringStartup(&'static str),
    #[error("creating the startup interrupt: {0}")]
    Interrupt(#[source] std::io::Error),
    #[error("the runtime root: {0}")]
    RuntimeRoot(#[source] std::io::Error),
    #[error("the lifecycle refused: {0}")]
    Lifecycle(#[from] lifecycle::CommandError),
    #[error("waiting for the stop signal: {0}")]
    Signal(#[source] std::io::Error),
    #[error("{0}")]
    Executors(#[from] mixdog_rt::exec::BootError),
}

/// Starts the process's executors (RT-C, RT-W and the lanes) and installs them as the one backend, once. Every production entry point that submits lane jobs or spawns
/// through `mixdog_rt` calls this before it does; the `Arc` is what the stall monitor reads and must outlive them.
pub fn boot_executors() -> Result<(Arc<Executors>, LaneTokens), ServeError> {
    Ok(mixdog_rt::exec::boot(RtConfig::detect())?)
}

/// `mixdogd serve`: boots the executors and serves until the process is told to stop.
///
/// The process has no runtime of its own: the calling thread blocks inside RT-W's context, so the composition's tasks and every ambient `Handle::current()` land on the
/// executors, and the connection tasks the transport spawns with `TaskClass::Control` run on RT-C. Blocking work goes to the lanes, never to either runtime.
pub fn run() -> Result<(), ServeError> {
    let (executors, tokens) = boot_executors()?;
    executors.handle(TaskClass::Work).block_on(serve(&executors, tokens))
}

/// Composes the core and serves until the process is told to stop.
///
/// The core is the real composition (see [`compose`]); the transport and the server attach here.
async fn serve(executors: &Arc<Executors>, tokens: LaneTokens) -> Result<(), ServeError> {
    let booted_at = std::time::Instant::now();
    // Every install ships the manifest: a missing or broken one is a startup error.
    let js_runtime = js_runtime::resolve_current_on(tokens.interactive_io).await?;
    // The install names its ONNX Runtime library in the same manifest; one that names none has no models.
    let ort_library = match js_runtime::resolve_ort_library_current_on(tokens.interactive_io).await? {
        Some(library) => mixdog_services::effort_judge::model::OrtRuntime::Library(library),
        None => mixdog_services::effort_judge::model::OrtRuntime::NoBinding,
    };
    // Node's `resolvePluginData()`, the dir `mixdogd migrate` converts.
    let data_dir = mixdog_store::paths::Paths::from_process(&js_runtime.package_root).ok_or(ServeError::NoDataDir)?.data_dir;
    let outgoing = mixdog_app_server::Outgoing::new();
    // LR §3 steps 1 to 5 (`boot`): the data-directory lock `L` (every log writer revalidates it), the control listener, the prior-owner verdict, barrier `B` and the
    // migration, all before the core is composed. The release decision of a blocked verdict is bound on `Booting::release`. The idle sweep and the event pipeline
    // take the `Started` as their proof (`event_pipeline::run`, `session_sweep::run`); both start below, and so does Mixy's heartbeat.
    let runtime_root = discovery::runtime_root().map_err(ServeError::RuntimeRoot)?;
    let begun = boot::boot(
        &tokens,
        &data_dir,
        compose::ext_host_config(&js_runtime, &data_dir, &tokens),
        serving::StartIn {
            runtime_root: runtime_root.clone(),
            exiter: std::sync::Arc::new(lifecycle::ProcessExiter),
            update_text: control::UPDATE_TEXT.to_owned(),
        },
    )
    .await?;
    let boot::Begun { started, booting, watch } = begun;
    let ownership: std::sync::Arc<dyn mixdog_core_api::domain::ownership::Ownership> = started.ownership().clone();
    // The daemon's run token and the one daemon log (`<data>/daemon.log`). Compose and every writer share the log; the one stop procedure
    // (`ComposedCore::run_stop_steps`) flushes it after the last step (Node: daemon.mjs:411, `await flushDaemonLogs()` before the exit) and
    // then cancels the token. A forced exit that skips the stop steps is covered by the release procedure's own `flush_log` step (run-host-25).
    // Until the ready boundary (below) a log line and a Node stderr line go bare to the process's stderr, which is where Node's go.
    let stop = mixdog_rt::CancellationToken::new();
    let log = daemon_log::DaemonLog::new(data_dir.join("daemon.log"), tokens.maintenance_io, stop.clone());
    log.attach_memory_log(daemon_log::DaemonLog::new(data_dir.join("memory-runtime-proxy.log"), tokens.maintenance_io, stop.clone()));
    // The memory worker starts during composition and mirrors its stderr into its proxy log from its first line, ready or not.
    mixdog_rt::node_log::install(log.memory_sink());
    let ready_log = log.clone();
    let sweep_dir = data_dir.clone();
    let config = compose::ComposeConfig {
        user_data_dir: data_dir.join("userdata"),
        runtime_root,
        data_dir,
        js_runtime,
        ort_library,
        // The server that attaches here takes this router with it (`Running::build`).
        outgoing: outgoing.clone(),
        ownership,
        log,
        stop: stop.clone(),
        catalog_http: catalog::production_http().map_err(compose::ComposeError::Catalog)?,
        #[cfg(test)]
        pg_install: None,
    };
    // A stop that arrives while the core composes (the stop watcher is the one installed at boot) cancels the composition's slow waits, and the composition then fails
    // through its own cleanup: what it had acquired (PostgreSQL) is given back before the error returns. The composition is never dropped half done.
    let interrupt = tokio_util::sync::CancellationToken::new();
    let composed = watch.drive(compose::compose_interruptible(&tokens, config, interrupt.clone()), || interrupt.cancel()).await;
    let core = match composed {
        Ok(core) => std::sync::Arc::new(core),
        Err(error) => {
            return Err(match watch.requested() {
                Some(signal) => {
                    tracing::warn!(%error, "the composition ended by the stop request");
                    ServeError::StoppedDuringStartup(signal.name())
                }
                None => error.into(),
            });
        }
    };
    tracing::info!("core composed");
    // From here the core's own stop procedure gives everything back: a failure before the core serves runs it with Node's boot-error reason (`daemon.mjs:1347`).
    let served = async {
        let serving = serving::attach(booting, core.clone(), outgoing).await?;
        serving.lifecycle.set_serving()?;
        Ok::<_, ServeError>(serving)
    }
    .await;
    let serving = match served {
        Ok(serving) => serving,
        Err(error) => {
            core.stop("fatal boot error").await;
            return Err(error);
        }
    };
    // Node's ready boundary (`announceDaemonReady`, daemon.mjs:836-845): `enableFileLogging()` then `installRedirect()`. From here the file has
    // the log, and a line Node writes to its stderr lands where its redirect put it (`mixdog_rt::node_log`): the memory worker's in its own
    // proxy log, every other in `daemon.log`, each as a `[<ISO>] ` row.
    ready_log.enable_file_logging();
    // `MIXDOG_DAEMON_ALLOW_STDERR=1` skips only `installRedirect` (daemon-log.mjs:162): the daemon's lines stay bare, the memory mirror keeps its sink (installed above).
    if std::env::var("MIXDOG_DAEMON_ALLOW_STDERR").as_deref() != Ok("1") {
        mixdog_rt::node_log::install(ready_log.node_sink());
    }
    // `announceDaemonReady` (daemon.mjs:856-857), the first two rows the file gets: the ready line (Node's `port` is the front door the clients discover; here the RPC listener) and the
    // boot-phase mark, whose `totalMs` is one decimal and prints as a JS number does.
    let ready_ms = booted_at.elapsed().as_secs_f64() * 1000.0;
    for line in daemon_log::ready_lines(serving.discovery.rpc_port().unwrap_or(0), std::process::id(), ready_ms) {
        ready_log.log(&line);
    }
    // The tasks Node starts after ready (the webhook queue with the channels, the idle sweep and the retention with the session runtime's first interval, the heartbeat's first tick): their
    // lines land after the redirect, stamped, as Node's do.
    // The webhook event queue ticks from here: it takes the proof that startup finished.
    mixdog_rt::spawn("event-pipeline", mixdog_rt::TaskClass::Work, core.event_pipeline().clone().run(started.clone(), stop.clone()));
    // Node's idle cleanup starts with the session runtime (`runtime-bootstrap.mjs:97`): first cycle one interval after the start, then every interval; it ends with the run token.
    mixdog_rt::spawn("idle-sweep", mixdog_rt::TaskClass::Work, session_sweep::run(started.clone(), core.sweep_store(&sweep_dir, stop.clone()), session_sweep::CLEANUP_INTERVAL, stop.clone()));
    // The sub-agent retention is part of that same cycle in Node (`_retainSubAgents`): same start, same first delay, ended by the stop procedure before the directory shuts down.
    core.start_sub_agent_retention();
    // Mixy's heartbeat (`daemon.mjs:1212`): its first check comes one `FIRST_TICK` later.
    core.start_heartbeat();
    // `startPostgresInBackground` (daemon.mjs:1274), after ready: the memory database starts here only where a cluster already exists.
    core.open_memory_in_background();
    // A pinned channel session outlives the core that pinned it (daemon.mjs:1284-1293): restored after ready, off the boot path.
    core.restore_remote_intent();
    // The report-only stall monitor (LR §5.4): the runtime probe and the lanes' wedge watch. It lives as long as the process serves.
    let _stall_monitor = serving.watch_stalls(executors.clone());
    // A stop that arrived on the way is handed over now: the watcher has been live since boot.
    let signal = watch.wait().await.map_err(ServeError::Signal)?;
    signals::stop_for(&serving.lifecycle, signal);
    tracing::info!(signal = signal.name(), "stop handed to the lifecycle");
    // The release thread runs the final barriers, closes the connections and the extension host,
    // writes `last-exit.json`, withdraws discovery, runs the stop steps and ends the process.
    let mut state = serving.lifecycle.state();
    let _ = state.wait_for(|state| matches!(state, CoreState::Stopped)).await;
    Ok(())
}
