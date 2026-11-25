//! The daemon: composition root and lifecycle of the `mixdogd` process (SPEC §3.2). Module
//! owners add their own `pub mod` line below.

use std::sync::Arc;

use mixdog_core_api::CoreState;
use mixdog_rt::Backend;
use mixdog_rt::LaneTokens;
use mixdog_rt::TaskClass;
use mixdog_rt::exec::Executors;
use mixdog_rt::exec::RtConfig;

pub mod acp_tools;
pub mod acp_usage;
pub mod acquired;
pub mod agent_lifecycle;
pub mod barrier;
pub mod boot;
pub mod boot_coordinator;
pub mod browser_engine_service;
pub mod catalog;
pub mod catalog_index_section;
pub mod channel_router;
pub mod code_graph_trust;
pub mod compat;
pub mod compose;
pub mod compose_browser_engine;
pub mod compose_computer;
pub mod compose_computer_bridge;
pub mod compose_connections;
pub mod compose_core;
mod compose_desktop_files;
pub mod compose_domains;
pub mod compose_flip;
mod compose_legacy;
pub mod compose_mcp;
mod compose_media_lease;
pub mod compose_screen;
#[cfg(test)]
mod compose_test_support;
pub mod computer_control;
pub mod computer_gate;
pub mod computer_pointer_service;
pub mod computer_scope_report_service;
pub mod connection_close;
pub mod control;
pub mod crash_record;
pub mod daemon_log;
mod desktop_confirmation;
pub mod desktop_defaults;
#[cfg(feature = "test-hooks")]
mod dev_computer;
pub mod discovery;
pub mod domain_seams;
pub mod effort_judge_host;
pub mod embedding_host;
pub mod event_pipeline;
pub mod exec;
pub mod exec_events;
pub mod feature_probes;
pub mod fencing_ownership;
pub mod held_home_draft;
pub mod held_requests;
#[cfg(test)]
mod held_run_scenes;
pub mod hook_rule_setup;
pub mod host_runtime_draft;
pub mod js_runtime;
pub mod late_agent_cells;
pub mod late_lifecycle;
pub mod late_live_route;
pub mod late_route_positions;
pub mod late_seams;
pub mod late_session;
pub mod late_setup_actions;
pub mod late_tool_surface;
pub mod lifecycle;
pub mod live_view;
pub mod live_view_streams;
pub mod mcp_surface;
pub mod media;
pub mod memory_agent_watch;
pub mod memory_callers;
#[cfg(test)]
mod model_proxy_client_tests;
mod office_startup;
pub mod os_probe;
pub mod ownership;
pub mod pair_code;
pub mod prewarm_world;
pub mod project_workspaces;
#[cfg(feature = "replay-controls")]
mod replay_stores_settled;
pub mod restart_sweep;
pub mod server;
pub mod server_ensure;
pub mod serving;
#[cfg(test)]
mod session_host_tests;
pub mod session_retention;
pub mod session_sweep;
pub mod setup_host;
pub mod setup_status;
pub mod shell_name;
pub mod signals;
#[cfg(test)]
mod ssh_origin_tests;
pub mod stale_temps;
pub mod startup;
pub mod statusline_port;
pub mod stop_watch;
pub mod sweep_store;
pub mod system_proxy_claim;
pub mod takeover_port;
pub mod telemetry;
pub mod terminal_folder_release;
pub mod update_installer;
pub mod verdict;
#[cfg(test)]
mod warmup_scheduler_tests;
#[cfg(test)]
mod workers_stop_tests;
pub mod worktree_cache_cleanups;

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

pub fn run(desktop_confirmation_pipe: bool) -> Result<(), ServeError> {
    adopt_login_shell_environment(std::io::IsTerminal::is_terminal(&std::io::stdin()));
    let (executors, tokens) = boot_executors()?;
    startup_end(executors.handle(TaskClass::Work).block_on(serve(&executors, tokens, desktop_confirmation_pipe)))
}

/// How the process records a start that ended before the core served: a lost claim yields (exit 0, recorded as the claim lost); a stop
/// request is Node's `shutdown(<signal>)` from its signal handler, a stop with exit 0, not a fatal boot error; anything else is the error.
fn startup_end(served: Result<(), ServeError>) -> Result<(), ServeError> {
    match served {
        Err(ServeError::Startup(startup::StartupError::Ownership(ownership::AcquireError::AlreadyOwned))) => {
            crash_record::yield_ownership(discovery::running_core_pid());
            Ok(())
        }
        Err(ServeError::StoppedDuringStartup(signal)) => {
            tracing::info!(signal, "stopped during startup");
            crash_record::settle_exit(signal, 0);
            Ok(())
        }
        served => served,
    }
}

/// A start by a launcher (the desktop, a login item, a service) lacks what the user's shell profile exports; a start from a terminal has it already. The shell is read only
/// where the profile can be missing (macOS and Linux) and the process was not started from a terminal.
fn reads_login_shell(platform: &str, started_from_terminal: bool) -> bool {
    platform != "win32" && !started_from_terminal
}

/// The login-shell environment (`login-shell-environment.ts`): what the shell overrides is set in this process before any executor or thread exists, so the core, every
/// terminal and every tool call inherit it. A failed read is reported once at error level and the start goes on with the inherited environment.
fn adopt_login_shell_environment(started_from_terminal: bool) {
    use mixdog_core_domains::domains::desktop_residual::host_platform;
    use mixdog_core_domains::domains::desktop_residual_b as residual;
    let platform = host_platform();
    if !reads_login_shell(platform, started_from_terminal) {
        return;
    }
    let began = std::time::Instant::now();
    let inherited: std::collections::BTreeMap<String, String> = std::env::vars().collect();
    let adoption = residual::adopt_login_shell_environment(platform, &inherited, residual::LOGIN_SHELL_READ_BUDGET);
    for (name, value) in &adoption.set {
        // SAFETY: the process is still single-threaded: no executor or thread that reads the environment exists yet.
        unsafe { std::env::set_var(name, value) };
    }
    if adoption.adopted {
        tracing::info!(
            elapsed_ms = began.elapsed().as_millis() as u64,
            changed = adoption.changed_count,
            homebrew_path_added = ?adoption.homebrew_path_added,
            "login-shell environment adopted"
        );
    }
    for failure in &adoption.failures {
        tracing::error!(shell = %failure.shell, reason = %failure.reason, "the login-shell environment could not be read");
    }
}

/// Composes the core and serves until the process is told to stop.
///
/// The core is the real composition (see [`compose`]); the transport and the server attach here.
async fn serve(executors: &Arc<Executors>, tokens: LaneTokens, desktop_confirmation_pipe: bool) -> Result<(), ServeError> {
    let booted_at = daemon_log::boot_clock();
    // Every install ships the manifest: a missing or broken one is a startup error.
    let js_runtime = js_runtime::resolve_current_on(tokens.interactive_io).await?;
    let runtime_resolved = std::time::Instant::now();
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
    let runtime_root = discovery::runtime_root();
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
    let boot_begun = std::time::Instant::now();
    let boot::Begun { started, booting, watch, behind } = begun;
    // Until the core serves, a start that fails gives back what the boot published and started (`boot::abandon`).
    let published = booting.discovery.clone();
    let catalog_http = match catalog::production_http() {
        Ok(http) => http,
        Err(error) => {
            drop(booting);
            boot::abandon(&tokens, Some(published), behind).await;
            return Err(compose::ComposeError::Catalog(error).into());
        }
    };
    let ownership: std::sync::Arc<dyn mixdog_core_api::domain::ownership::Ownership> = started.ownership().clone();
    let stop = mixdog_rt::CancellationToken::new();
    let log = daemon_log::DaemonLog::new(data_dir.join("daemon.log"), tokens.maintenance_io, stop.clone());
    log.boot_mark_at("runtime-resolved", runtime_resolved);
    log.boot_mark_at("data-lock-and-migration-front", boot_begun);
    log.attach_memory_log(daemon_log::DaemonLog::new(data_dir.join("memory-runtime-proxy.log"), tokens.maintenance_io, stop.clone()));
    daemon_log::attach_topic_logs(&log, &data_dir, tokens.maintenance_io, &stop);
    // The memory worker starts during composition and mirrors its stderr into its proxy log from its first line, ready or not.
    mixdog_rt::node_log::install(log.memory_sink());
    let ready_log = log.clone();
    let sweep_dir = data_dir.clone();
    let config = compose::ComposeConfig {
        rebuild: booting.discovery.rebuild_progress(),
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
        catalog_http,
        agent_presets: acp_tools::builtin_presets(),
        acp_data_dir: None,
        #[cfg(test)]
        pg_install: None,
    };
    // A stop that arrives while the core composes (the stop watcher is the one installed at boot) cancels the composition's slow waits, and the composition then fails
    // through its own cleanup: what it had acquired (PostgreSQL) is given back before the error returns. The composition is never dropped half done.
    let interrupt = tokio_util::sync::CancellationToken::new();
    let sessions_bound = tokio_util::sync::CancellationToken::new();
    let cutover = behind.as_ref().map(|back| compose::Cutover { legacy_homes: back.legacy_homes.clone(), sessions_bound: sessions_bound.clone() });
    let composed = watch.drive(compose::compose_for_cutover(&tokens, config, interrupt.clone(), cutover), || interrupt.cancel()).await;
    let core = match composed {
        Ok(core) => std::sync::Arc::new(core),
        Err(error) => {
            let error = match watch.requested() {
                Some(signal) => {
                    tracing::warn!(%error, "the composition ended by the stop request");
                    ServeError::StoppedDuringStartup(signal.name())
                }
                None => error.into(),
            };
            drop(booting);
            boot::abandon(&tokens, Some(published), behind).await;
            return Err(error);
        }
    };
    tracing::info!("core composed");
    ready_log.boot_mark("core-composed");
    // The sessions of the earlier version still to convert are listed before the first client can read the list, by the rows that version kept; an open of one waits for
    // its conversion, which the open asks for ahead of the rest.
    let mut behind = behind;
    match behind.as_mut() {
        Some(behind) => {
            behind.list(&core.catalog_index()).await;
            if let Err(error) = core.set_arriving(behind.arriving()) {
                tracing::error!(error, "the sessions still to convert could not be bound to the directory");
            }
        }
        // The migration is complete: a row still listing a session to convert lists none. The rows to withdraw are read
        // once every session owed its index rows is projected: with none owed that is now, before the first client reads
        // the list; while the index is recovering it is behind the serving core, so the start does not wait for it (a
        // listing waits for the same sessions). A read that fails withdraws nothing, and the next start tries again.
        None => {
            // What the completed migration set aside, for a client to tell the person once (it keys that by the migration's identity).
            boot::publish_migration_settled(core.state_publisher().as_ref(), &sweep_dir);
            let index = core.catalog_index();
            let withdraw = {
                let (index, dir) = (index.clone(), sweep_dir.to_path_buf());
                async move {
                    if let Err(error) = boot::withdraw_pending(&index, &dir).await {
                        tracing::warn!(%error, "the rows of sessions the migration set aside could not be withdrawn");
                    }
                }
            };
            if index.owes_projection() {
                drop(mixdog_rt::spawn("migration-pending-withdraw", mixdog_rt::TaskClass::Work, withdraw));
            } else {
                withdraw.await;
            }
        }
    }
    sessions_bound.cancel();
    ready_log.boot_mark("sessions-bound");
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
            boot::abandon(&tokens, Some(published), behind).await;
            return Err(error);
        }
    };
    core.start_archive_projection();
    if desktop_confirmation_pipe {
        desktop_confirmation::start(core.clone(), executors.handle(TaskClass::Work));
    }
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
    start_after_ready_tasks(&core, &started, &stop, &sweep_dir, behind, &ready_log);
    // The report-only stall monitor (LR §5.4): the runtime probe and the lanes' wedge watch. It lives as long as the process serves.
    let _stall_monitor = serving.watch_stalls(executors.clone(), core.stall_description());
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

/// The tasks Node starts after ready, each behind the core that serves: the event pipeline, the idle sweep and sub-agent retention, Mixy's heartbeat,
/// telemetry, the memory database, the restored channel pin, and the conversion of the earlier version's sessions.
fn start_after_ready_tasks(
    core: &Arc<compose::ComposedCore>,
    started: &startup::Started,
    stop: &mixdog_rt::CancellationToken,
    sweep_dir: &std::path::Path,
    behind: Option<boot::Behind>,
    ready_log: &daemon_log::DaemonLog,
) {
    // The tasks Node starts after ready (the webhook queue with the channels, the idle sweep and the retention with the session runtime's first interval, the heartbeat's first tick): their
    // lines land after the redirect, stamped, as Node's do.
    // The webhook event queue ticks from here: it takes the proof that startup finished.
    mixdog_rt::spawn("event-pipeline", mixdog_rt::TaskClass::Work, core.event_pipeline().clone().run(started.clone(), stop.clone()));
    // Node's idle cleanup starts with the session runtime (`runtime-bootstrap.mjs:97`): first cycle one interval after the start, then every interval; it ends with the run token.
    mixdog_rt::spawn(
        "idle-sweep",
        mixdog_rt::TaskClass::Work,
        session_sweep::run(started.clone(), core.sweep_store(sweep_dir, stop.clone()), session_sweep::CLEANUP_INTERVAL, stop.clone()),
    );
    // The sub-agent retention is part of that same cycle in Node (`_retainSubAgents`): same start, same first delay, ended by the stop procedure before the directory shuts down.
    // While the earlier version's sessions convert it would judge a tree by the members converted so far (an old parent before its recently used child): it starts when
    // the conversion has run to its completion marker, and a conversion that ends early leaves it to the start that resumes it.
    if behind.is_none() {
        core.start_sub_agent_retention();
    }
    // Mixy's heartbeat (`daemon.mjs:1212`): its first check comes one `FIRST_TICK` later.
    core.start_heartbeat();
    // The boot line, then the 30 s memory and work line, the lag probe and the lag sampler.
    core.start_telemetry();
    // `startPostgresInBackground` (daemon.mjs:1274), after ready: the memory database starts here only where a cluster already exists.
    core.open_memory_in_background();
    // A pinned channel session outlives the core that pinned it (daemon.mjs:1284-1293): restored after ready, off the boot path.
    core.restore_remote_intent();
    // The sessions of the earlier version convert from here, behind the serving core: each is listed once it is verified, and a conversion the stop cuts is resumed by the next start.
    if let Some(behind) = behind
        && let Err(error) = behind.run(
            core.catalog_index(),
            core.session_directory(),
            core.state_publisher().clone(),
            stop.clone(),
            {
                let log = ready_log.clone();
                move |line| log.log(line)
            },
            {
                let core = core.clone();
                move || core.start_sub_agent_retention()
            },
        )
    {
        tracing::error!(%error, "the thread that converts the earlier version's sessions could not start; the next start tries again");
    }
}

#[cfg(test)]
mod startup_end_tests {
    use super::*;

    /// A stop request that ends the start before the core serves is a stop, not a fatal boot error: the process exits 0.
    #[test]
    fn a_stop_during_startup_exits_as_a_stop() {
        assert_eq!(crash_record::serve_recorded(|| startup_end(Err(ServeError::StoppedDuringStartup("SIGTERM")))), 0);
    }
}

#[cfg(test)]
mod login_shell_tests {
    use super::reads_login_shell;

    #[test]
    fn only_a_launcher_start_on_macos_or_linux_reads_the_login_shell() {
        assert!(reads_login_shell("darwin", false));
        assert!(reads_login_shell("linux", false));
        assert!(!reads_login_shell("darwin", true));
        assert!(!reads_login_shell("linux", true));
        assert!(!reads_login_shell("win32", false));
    }
}
