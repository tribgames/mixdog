//! The daemon: composition root and lifecycle of the `mixdogd` process (SPEC §3.2). Module
//! owners add their own `pub mod` line below.

use mixdog_core_api::CoreState;

pub mod barrier;
pub mod catalog;
pub mod compat;
pub mod compose;
pub mod compose_core;
pub mod compose_mcp;
pub mod connection_close;
pub mod compose_domains;
pub mod late_live_route;
pub mod late_session;
pub mod late_seams;
pub mod late_tool_surface;
pub mod control;
pub mod daemon_log;
pub mod discovery;
pub mod domain_seams;
pub mod js_runtime;
pub mod event_pipeline;
pub mod held_requests;
pub mod hook_rule_setup;
pub mod lifecycle;
pub mod mcp_surface;
pub mod media;
pub mod exec;
pub mod ownership;
pub mod pair_code;
pub mod server;
pub mod serving;
pub mod server_ensure;
pub mod session_sweep;
pub mod shell_name;
pub mod signals;
pub mod system_proxy_claim;
pub mod startup;
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
    #[error("the runtime root: {0}")]
    RuntimeRoot(#[source] std::io::Error),
    #[error("the lifecycle refused: {0}")]
    Lifecycle(#[from] lifecycle::CommandError),
    #[error("waiting for the stop signal: {0}")]
    Signal(#[source] std::io::Error),
}

/// Composes the core and serves until the process is told to stop.
///
/// The core, domains and executors are mocks (see [`compose`]); the transport and the server
/// attach here when their crates land.
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
    // STARTUP SLOT (wp-install `startup.rs`): the startup exclusion, the verdict gate, barrier B
    // and the migration run here, before compose, and bind `Serving::release` with the verdict
    // gate's decision. Until it lands the idle sweep and the event pipeline are not started: they
    // belong after it, and nothing in this function starts them.
    let outgoing = mixdog_app_server::Outgoing::new();
    // The daemon's run token and the one daemon log (`<data>/daemon.log`), enabled where the daemon starts, as Node enables its log at
    // startup. Compose and every writer share the log; the one stop procedure (`ComposedCore::run_stop_steps`) flushes it after the
    // last step (Node: daemon.mjs:411, `await flushDaemonLogs()` before the exit) and then cancels the token. A forced exit that skips the
    // stop steps is covered by the release procedure's own `flush_log` step (run-host-25).
    let stop = mixdog_rt::CancellationToken::new();
    let log = daemon_log::DaemonLog::new(data_dir.join("daemon.log"), tokens.maintenance_io, stop.clone());
    log.enable_file_logging();
    let config = compose::ComposeConfig {
        user_data_dir: data_dir.join("userdata"),
        data_dir,
        js_runtime,
        ort_library,
        // The server that attaches here takes this router with it (`Running::build`).
        host: outgoing.clone(),
        log,
        stop,
    };
    let core = std::sync::Arc::new(compose::compose(&tokens, config).await?);
    tracing::info!(mocked = core.mocked_domains().len(), "core composed against mocks");
    let runtime_root = discovery::runtime_root().map_err(ServeError::RuntimeRoot)?;
    let serving = serving::start(
        &tokens,
        core,
        outgoing,
        serving::StartIn {
            runtime_root,
            exiter: std::sync::Arc::new(lifecycle::ProcessExiter),
            update_text: control::UPDATE_TEXT.to_owned(),
        },
    )
    .await?;
    serving.lifecycle.set_serving()?;
    let signal = signals::stop_on_signal(&serving.lifecycle).await.map_err(ServeError::Signal)?;
    tracing::info!(signal = signal.name(), "stop handed to the lifecycle");
    // The release thread runs the final barriers, closes the connections and the extension host,
    // writes `last-exit.json`, withdraws discovery, runs the stop steps and ends the process.
    let mut state = serving.lifecycle.state();
    let _ = state.wait_for(|state| matches!(state, CoreState::Stopped)).await;
    Ok(())
}
