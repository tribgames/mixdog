//! The daemon: composition root and lifecycle of the `mixdogd` process (SPEC §3.2). Module
//! owners add their own `pub mod` line below.

use mixdog_core_api::CoreState;

pub mod acquired;
pub mod agent_lifecycle;
pub mod barrier;
pub mod boot;
pub mod catalog;
pub mod channel_router;
pub mod compat;
pub mod compose;
#[cfg(test)]
mod compose_test_support;
pub mod compose_core;
pub mod compose_mcp;
pub mod connection_close;
pub mod fencing_ownership;
pub mod code_graph_trust;
pub mod compose_flip;
pub mod feature_probes;
pub mod held_home_draft;
pub mod host_runtime_draft;
pub mod late_lifecycle;
pub mod memory_agent_watch;
pub mod prewarm_world;
pub mod setup_host;
pub mod compose_domains;
pub mod late_live_route;
pub mod late_route_positions;
pub mod late_agent_cells;
pub mod late_session;
pub mod late_seams;
pub mod late_tool_surface;
pub mod os_probe;
pub mod control;
pub mod daemon_log;
pub mod discovery;
pub mod domain_seams;
pub mod js_runtime;
pub mod event_pipeline;
pub mod held_requests;
pub mod memory_callers;
pub mod hook_rule_setup;
pub mod setup_status;
pub mod lifecycle;
pub mod mcp_surface;
pub mod media;
pub mod exec;
pub mod exec_events;
pub mod ownership;
pub mod pair_code;
pub mod project_workspaces;
pub mod server;
pub mod serving;
pub mod server_ensure;
pub mod session_sweep;
pub mod shell_name;
pub mod signals;
pub mod system_proxy_claim;
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
}

/// Composes the core and serves until the process is told to stop.
///
/// The core is the real composition (see [`compose`]); the transport and the server attach here.
pub async fn serve() -> Result<(), ServeError> {
    // The inline test backend runs lane jobs on the calling thread; WP-RT's executors replace it.
    let tokens = mixdog_rt::testing::tokens();
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
            runtime_root,
            exiter: std::sync::Arc::new(lifecycle::ProcessExiter),
            update_text: control::UPDATE_TEXT.to_owned(),
        },
    )
    .await?;
    let boot::Begun { started, booting, watch } = begun;
    let ownership: std::sync::Arc<dyn mixdog_core_api::domain::ownership::Ownership> = started.ownership().clone();
    // The daemon's run token and the one daemon log (`<data>/daemon.log`), enabled where the daemon starts, as Node enables its log at
    // startup. Compose and every writer share the log; the one stop procedure (`ComposedCore::run_stop_steps`) flushes it after the
    // last step (Node: daemon.mjs:411, `await flushDaemonLogs()` before the exit) and then cancels the token. A forced exit that skips the
    // stop steps is covered by the release procedure's own `flush_log` step (run-host-25).
    let stop = mixdog_rt::CancellationToken::new();
    let log = daemon_log::DaemonLog::new(data_dir.join("daemon.log"), tokens.maintenance_io, stop.clone());
    log.enable_file_logging();
    let sweep_dir = data_dir.clone();
    let config = compose::ComposeConfig {
        user_data_dir: data_dir.join("userdata"),
        data_dir,
        js_runtime,
        ort_library,
        // The server that attaches here takes this router with it (`Running::build`).
        outgoing: outgoing.clone(),
        ownership,
        log,
        stop: stop.clone(),
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
        // The webhook event queue ticks from here (Node starts it with the channels): it takes the proof that startup finished.
        mixdog_rt::spawn("event-pipeline", mixdog_rt::TaskClass::Work, core.event_pipeline().clone().run(started.clone(), stop.clone()));
        // Node's idle cleanup starts with the session runtime (`runtime-bootstrap.mjs:97`): first cycle one interval after the start, then every interval; it ends with the run token.
        mixdog_rt::spawn("idle-sweep", mixdog_rt::TaskClass::Work, session_sweep::run(started.clone(), core.sweep_store(&sweep_dir, stop.clone()), session_sweep::CLEANUP_INTERVAL, stop.clone()));
        // Mixy's heartbeat (`daemon.mjs:1212`): after the session service and the routine host exist, before the recoveries.
        core.start_heartbeat();
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
