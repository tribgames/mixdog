//! The daemon: composition root and lifecycle of the `mixdogd` process (SPEC §3.2). Module
//! owners add their own `pub mod` line below.

use mixdog_core_api::CoreState;
use mixdog_protocol::DrainReason;

pub mod barrier;
pub mod catalog;
pub mod compat;
pub mod compose;
pub mod compose_domains;
pub mod control;
pub mod discovery;
pub mod js_runtime;
pub mod event_pipeline;
pub mod held_requests;
pub mod lifecycle;
pub mod exec;
pub mod ownership;
pub mod pair_code;
pub mod server;
pub mod server_ensure;
pub mod session_sweep;
pub mod shell_name;
pub mod signals;
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
    let config = compose::ComposeConfig {
        user_data_dir: data_dir.join("userdata"),
        data_dir,
        js_runtime,
        ort_library,
        // The server that attaches here takes this router with it (`Running::build`).
        host: mixdog_app_server::Outgoing::new(),
    };
    let core = compose::compose(&tokens, config).await?;
    tracing::info!(mocked = core.mocked_domains().len(), "core composed against mocks");
    let signal = signals::stop_requested().await.map_err(ServeError::Signal)?;
    tracing::info!(signal = signal.name(), "stopping");
    signals::start_budget(signals::SHUTDOWN_BUDGET, std::sync::Arc::new(lifecycle::ProcessExiter)).map_err(ServeError::Signal)?;
    core.set_state(CoreState::Draining {
        reason: DrainReason::Quit,
    });
    core.stop().await;
    core.set_state(CoreState::Stopped);
    Ok(())
}
