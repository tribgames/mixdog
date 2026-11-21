//! `mixdogd serve | ctl | migrate | server-ensure` (SPEC §3.2). Argument parsing only; every
//! subcommand body lives in the daemon, migrate or client crate it names.

#[cfg(feature = "crash-gates")]
mod boot_fault;
mod log_filter;
mod projector;

#[cfg(all(feature = "alloc-profile", windows))]
mod alloc_profile;
#[cfg(all(feature = "alloc-profile", windows))]
#[global_allocator]
static ALLOCATOR: alloc_profile::ProfilingAllocator = alloc_profile::ProfilingAllocator;
// The ordinary build uses the system heap. mimalloc was tried (2026-11-17): with ~150 threads its per-thread segments held
// 650-790 MB private at idle where the system heap held 294 MB for the same core a minute after boot.

use mixdog_cli::exec;

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use mixdog_exthost::ExtDocumentText;
use mixdog_exthost::ExtHostPool;
use mixdog_migrate::run::cli::MigrateArgs;
use mixdog_migrate::session::context_blobs::OfficeExtractor;
use mixdog_rt::Backend;
use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;
use mixdog_rt::TaskClass;

use clap::ArgGroup;
use clap::Args;
use clap::Parser;
use clap::Subcommand;

#[derive(Parser)]
#[command(name = "mixdogd", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the core in this process.
    Serve {
        /// The desktop launcher supplies a private stdin/stdout pair.
        #[arg(long, hide = true)]
        desktop_confirmation_pipe: bool,
    },
    /// Manage the running core over its control listener.
    Ctl(CtlArgs),
    /// Convert a 1.4.5 data directory (one-shot).
    Migrate(MigrateCliArgs),
    /// Install-time entry run on an SSH server.
    ServerEnsure {
        /// The desktop's base64 JSON `RemoteProgramArgs`.
        argument: String,
    },
    /// Headless one-shot: ask once on a pristine root, print the answer.
    Exec(exec::ExecArgs),
    #[command(name = "embedding-host", hide = true)]
    EmbeddingHost {
        #[arg(long)]
        cache_dir: PathBuf,
        #[arg(long)]
        model_id: String,
        #[arg(long)]
        ort_library: PathBuf,
        #[arg(long)]
        dtype: Option<String>,
    },
    /// The process the effort judge's model runs in; started by the core, never by a user.
    #[command(name = "effort-judge-host", hide = true)]
    EffortJudgeHost {
        #[arg(long)]
        dir: PathBuf,
        #[arg(long)]
        ort_library: PathBuf,
        #[arg(long)]
        explicit: bool,
    },
    /// The extension-host worker: the process the core's extension host pool starts; it prints READY on its frame pipe and
    /// serves document calls until the pool says bye. Started by the core, never by a user.
    #[command(name = "ext-worker", hide = true)]
    /// The process Microsoft Office automation runs in; started by the core, never by a user.
    #[command(name = "office-com-host", hide = true, trailing_var_arg = true, allow_hyphen_values = true, disable_help_flag = true)]
    OfficeComHost {
        #[arg(allow_hyphen_values = true, value_name = "ARGS")]
        args: Vec<std::ffi::OsString>,
    },
    ExtWorker,
    /// The program the `mixdog-skill-node` launchers start: runs a skill script.
    #[command(name = "skill-run", hide = true, trailing_var_arg = true, allow_hyphen_values = true, disable_help_flag = true)]
    SkillRun {
        #[arg(allow_hyphen_values = true, value_name = "SCRIPT_AND_ARGS")]
        args: Vec<std::ffi::OsString>,
    },
}

#[derive(Args)]
struct MigrateCliArgs {
    /// Default: `$MIXDOG_DATA_DIR`, else `<$MIXDOG_HOME or ~/.mixdog>/data`.
    #[arg(long)]
    data_dir: Option<PathBuf>,
    /// Default: `$MIXDOG_HOME`, else `~/.mixdog`.
    #[arg(long)]
    home: Option<PathBuf>,
    /// The desktop profile directory (the launcher's `--desktop-profile`).
    #[arg(long)]
    desktop_profile: Option<PathBuf>,
}

#[derive(Args)]
struct CtlArgs {
    /// Print the reply as JSON.
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    action: CtlAction,
}

#[derive(Subcommand)]
enum CtlAction {
    Status,
    /// Hold new work for an update; `--off` releases the hold.
    Hold {
        #[arg(long)]
        off: bool,
    },
    Stop(StopArgs),
    CancelDrain {
        #[arg(long)]
        drain_id: String,
    },
    /// Decide an `undecidable` prior owner.
    Release {
        #[arg(long)]
        pid: u32,
        #[arg(long)]
        confirm_token: String,
    },
    /// Exit a stalled core.
    Terminate {
        #[arg(long)]
        confirm_token: String,
    },
    /// Return when the process with this identity exits (updater, fast deploy).
    WaitExit {
        #[arg(long)]
        pid: u32,
        /// The discovery `core.processStartTime`.
        #[arg(long)]
        start_time: u64,
    },
}

#[derive(Args)]
#[command(group(ArgGroup::new("mode").required(true).args(["when_idle", "abort", "force"])))]
struct StopArgs {
    #[arg(long)]
    when_idle: bool,
    #[arg(long)]
    abort: bool,
    /// Drain and abort the running work in one request, no token (the desktop's quit).
    #[arg(long)]
    force: bool,
    #[arg(long)]
    reason: String,
    #[arg(long)]
    confirm_token: Option<String>,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.command {
        Command::Serve { desktop_confirmation_pipe } => {
            #[cfg(all(feature = "alloc-profile", windows))]
            alloc_profile::enable_from_env();
            serve(desktop_confirmation_pipe)
        }
        Command::Ctl(args) => ctl(args),
        Command::Migrate(args) => {
            let args = MigrateArgs { data_dir: args.data_dir, home: args.home, desktop_profile: args.desktop_profile };
            migrate(&args)
        }
        Command::ServerEnsure { argument } => {
            // Prints its own result lines; the status is 0 or 3.
            ExitCode::from(mixdog_app_server_daemon::server_ensure::main(&argument) as u8)
        }
        Command::Exec(args) => exec_command(args),
        Command::EffortJudgeHost { dir, ort_library, explicit } => {
            ExitCode::from(mixdog_app_server_daemon::effort_judge_host::run(dir, ort_library, explicit) as u8)
        }
        Command::EmbeddingHost { cache_dir, model_id, ort_library, dtype } => {
            ExitCode::from(mixdog_app_server_daemon::embedding_host::run(cache_dir, model_id, ort_library, dtype) as u8)
        }
        Command::OfficeComHost { args } => ExitCode::from(mixdog_office_com::host::run(&args) as u8),
        Command::ExtWorker => {
            // A pptxgenjs authoring script runs on the script interpreter of the install; without one that route says so.
            if let Ok(js) = mixdog_app_server_daemon::js_runtime::resolve_current() {
                mixdog_office::author::script_runtime::install(mixdog_office::author::script_runtime::ScriptRuntime {
                    program: js.program,
                    package_root: js.package_root,
                    electron: js.electron,
                });
            }
            mixdog_exthost_worker::ext_worker_main()
        }
        Command::SkillRun { args } => {
            // A script that is not shipped runs on the install's script interpreter.
            let runtime = match mixdog_app_server_daemon::js_runtime::resolve_current() {
                Ok(js) => mixdog_skill_scripts::UserScriptRuntime::Interpreter {
                    entry: js.package_root.join("src").join("skill-script-entry.mjs"),
                    program: js.program,
                    electron: js.electron,
                },
                Err(error) => mixdog_skill_scripts::UserScriptRuntime::Unavailable { reason: error.to_string() },
            };
            // The shipped office scripts (source-extract, qc-pages) read Office files through this process's engine.
            if let Ok(engine) = mixdog_exthost_worker::methods::SkillOfficeEngine::new() {
                let _ = mixdog_skill_scripts::source_extract::install_office_engine(Box::new(engine));
            }
            mixdog_skill_scripts::skill_run(args, runtime)
        }
    }
}

/// Runs the migration on this thread, outside every async context: the runtime only carries the
/// extension host, whose office extractor signs a recovered turn's context as Node does, and the
/// migration drives it with the runtime's handle. The host stops when the migration returns.
fn migrate(args: &MigrateArgs) -> ExitCode {
    let roots = match mixdog_migrate::run::cli::roots(args) {
        Ok(roots) => roots,
        Err(status) => return ExitCode::from(status),
    };
    // The daemon's own guard of the data dir: no core serves it while this migrates.
    let ownership = match mixdog_app_server_daemon::ownership::acquire(&roots.data) {
        Ok(ownership) => Arc::new(ownership),
        Err(err) => {
            eprintln!("mixdogd migrate: {err}");
            return ExitCode::FAILURE;
        }
    };
    let (executors, tokens) = match mixdog_app_server_daemon::boot_executors() {
        Ok(booted) => booted,
        Err(err) => {
            eprintln!("mixdogd migrate: starting the executors: {err}");
            return ExitCode::FAILURE;
        }
    };
    let runtime = executors.handle(TaskClass::Work);
    let cutover = runtime.block_on(async {
        let ownership = ownership.clone();
        tokens
            .durability_io
            .submit(&CancellationToken::new(), move |lane| mixdog_app_server_daemon::startup::require_migration_barrier(lane, ownership))
            .map_err(|error| error.to_string())?
            .await
            .map_err(|error| error.to_string())?
    });
    if let Err(error) = cutover {
        eprintln!("mixdogd migrate: {error}");
        return ExitCode::FAILURE;
    }
    let js = match mixdog_app_server_daemon::js_runtime::resolve_current() {
        Ok(js) => js,
        Err(err) => {
            eprintln!("mixdogd migrate: resolving the JS runtime: {err}");
            return ExitCode::FAILURE;
        }
    };
    let pool = {
        let _context = runtime.enter();
        ExtHostPool::new(mixdog_app_server_daemon::compose::ext_host_config(&js, &roots.data, &tokens))
    };
    let pool = match pool {
        Ok(pool) => Arc::new(pool),
        Err(err) => {
            eprintln!("mixdogd migrate: starting the extension host: {err}");
            return ExitCode::FAILURE;
        }
    };
    // Node's first read of a config that does not parse keeps it aside and restores the newest backup, as the daemon's boot does before its migration.
    if let Err(err) = mixdog_app_server_daemon::boot::recover_malformed_config(&roots.data, &tokens, &runtime) {
        eprintln!("mixdogd migrate: {err}");
        runtime.block_on(pool.close());
        return ExitCode::FAILURE;
    }
    let office = OfficeExtractor { docs: Arc::new(ExtDocumentText::new(pool.clone())), runtime: runtime.clone() };
    let status = mixdog_migrate::run::cli::main(roots, Arc::new(projector::StoreProjector), office);
    runtime.block_on(pool.close());
    ExitCode::from(status)
}

/// The usage on stdout: Node's `help` kind (`printHelp`, exit 0).
fn exec_help() -> ExitCode {
    use std::io::Write;
    let _ = std::io::stdout().lock().write_all(exec::HELP_TEXT.as_bytes());
    ExitCode::SUCCESS
}

/// Refuses what Node refuses before anything starts, then runs the exec on its own core (`runHeadlessExec`).
fn exec_command(args: exec::ExecArgs) -> ExitCode {
    let refusal = match args.into_invocation(std::env::var("MIXDOG_USAGE_LOG").ok()) {
        Ok(exec::Invocation::Help) => return exec_help(),
        Ok(exec::Invocation::React) => {
            eprint!("{}", exec::REACT_REMOVED);
            return ExitCode::FAILURE;
        }
        Ok(exec::Invocation::Run(options)) => return ExitCode::from(u8::try_from(exec::run_command(options)).unwrap_or(1)),
        Ok(exec::Invocation::Plain) => "--plain starts Node's readline REPL, which mixdogd exec does not have".to_owned(),
        Err(refusal) => refusal,
    };
    eprintln!("mixdog: {refusal}");
    ExitCode::FAILURE
}

fn ctl(args: CtlArgs) -> ExitCode {
    if let CtlAction::WaitExit { pid, start_time } = args.action {
        return match mixdog_app_server_daemon::control::wait_exit::wait_exit(pid, start_time) {
            Ok(()) => ExitCode::SUCCESS,
            Err(err) => {
                eprintln!("mixdogd: waiting for process {pid}: {err}");
                ExitCode::FAILURE
            }
        };
    }
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(err) => {
            eprintln!("mixdogd: starting the async runtime: {err}");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(ctl_request(args.action)) {
        Ok(status) => {
            if args.json {
                println!("{}", serde_json::to_string(&status).expect("status serializes"));
            } else {
                println!(
                    "{} {} (instance {}, {} clients, {} running{}{})",
                    serde_json::to_value(status.state).expect("state serializes"),
                    status.version,
                    status.instance_id,
                    status.clients,
                    status.running.len(),
                    if status.hold { ", hold" } else { "" },
                    status.drain.as_ref().map_or(String::new(), |d| format!(", draining {}", d.drain_id)),
                );
            }
            ExitCode::SUCCESS
        }
        Err(err) => {
            // A refusal carries its machine-readable code; scripts read it from stderr.
            eprintln!("{}", err.cli_line());
            ExitCode::FAILURE
        }
    }
}

async fn ctl_request(action: CtlAction) -> Result<mixdog_app_server_client::ctl::CoreStatus, mixdog_app_server_client::ctl::CtlError> {
    use mixdog_app_server_client::ctl::CtlClient;
    use mixdog_app_server_client::ctl::StopMode;

    // A process table that cannot answer proves nothing: the call goes to the listener.
    let client =
        CtlClient::local(|core| mixdog_app_server_daemon::discovery::names_running_core(core.pid, &core.core.process_start_time).unwrap_or(true)).await?;
    match action {
        CtlAction::Status => client.status().await,
        CtlAction::Hold { off } => client.hold(!off).await,
        CtlAction::Stop(stop) => {
            let mode = if stop.force {
                StopMode::Force
            } else if stop.abort {
                StopMode::AbortConfirmed
            } else {
                StopMode::WhenIdle
            };
            let reason = serde_json::from_value(serde_json::Value::String(stop.reason.clone())).map_err(|_| {
                mixdog_app_server_client::ctl::CtlError::BadReply(format!(
                    "unknown stop reason `{}` (update, quit, restart, fastDeploy, sshReplace, userStop)",
                    stop.reason
                ))
            })?;
            client.stop(mode, reason, stop.confirm_token.as_deref()).await
        }
        CtlAction::CancelDrain { drain_id } => client.cancel_drain(&drain_id).await,
        CtlAction::Release { pid, confirm_token } => client.release(pid, &confirm_token).await,
        CtlAction::Terminate { confirm_token } => client.terminate(&confirm_token).await,
        CtlAction::WaitExit { .. } => unreachable!("handled without a control connection"),
    }
}

/// Task Manager groups its Processes rows by AppUserModelID, not by the parent/child chain: a core with no identity of
/// its own is listed beside the app that started it instead of inside it. The core claims the desktop app's id (the
/// `appId` of electron-builder.yml, which the app passes to `app.setAppUserModelId`), as the native helpers do
/// (`mixdog-spawn`, `mixdog-graph`). It changes the grouping in the taskbar and Task Manager only; a call that fails
/// leaves the core listed on its own.
#[cfg(windows)]
fn adopt_desktop_app_identity() {
    let app_id: Vec<u16> = "io.mixdog.desktop\0".encode_utf16().collect();
    // SAFETY: `app_id` is a NUL-terminated UTF-16 string that outlives the call; the call only records it for this process.
    #[allow(unsafe_code, reason = "one Win32 call that records this process's AppUserModelID")]
    let _ = unsafe { windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(app_id.as_ptr()) };
}

#[cfg(not(windows))]
fn adopt_desktop_app_identity() {}

/// A core started as an ordinary child (the desktop app's start, `detached: false`) is given a hidden console of its
/// own, and that console's window belongs to the core. Task Manager lists a process that owns a top-level window on a
/// row of its own, so the core showed inside the app's group for a moment and then left it; the helpers that stay in
/// a group (no window of their own) do not. The core needs no console: its stderr is the capture file it was handed,
/// and until this start it ran detached, with none. A failing call leaves the console where it is.
#[cfg(windows)]
fn leave_console() {
    // SAFETY: detaches this process from its console; no handle or pointer is passed.
    #[allow(unsafe_code, reason = "one Win32 call that detaches this process from its console")]
    let _ = unsafe { windows_sys::Win32::System::Console::FreeConsole() };
}

#[cfg(not(windows))]
fn leave_console() {}

fn serve(desktop_confirmation_pipe: bool) -> ExitCode {
    adopt_desktop_app_identity();
    leave_console();
    {
        use tracing_subscriber::layer::SubscriberExt;
        use tracing_subscriber::util::SubscriberInitExt;
        tracing_subscriber::registry()
            .with(tracing_subscriber::EnvFilter::from_default_env())
            .with(log_filter::RefusedWrites)
            .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
            .init();
    }
    #[cfg(feature = "crash-gates")]
    boot_fault::wait_for_launcher();
    // Node installs its recorder at module load: a start that fails on its way up (no JS runtime, no executors) is recorded too.
    mixdog_app_server_daemon::crash_record::install_for_process();
    let start = || -> Result<(), String> {
        #[cfg(feature = "crash-gates")]
        if let Some(ended) = boot_fault::run() {
            return ended;
        }
        mixdog_app_server_daemon::run(desktop_confirmation_pipe).map_err(|error| error.to_string())
    };
    ExitCode::from(mixdog_app_server_daemon::crash_record::serve_recorded(start) as u8)
}

#[cfg(test)]
mod tests {
    use clap::CommandFactory;

    use super::*;

    #[test]
    fn grammar_is_consistent() {
        Cli::command().debug_assert();
    }

    #[test]
    fn stop_force_is_a_mode_of_its_own() {
        assert!(Cli::try_parse_from(["mixdogd", "ctl", "stop", "--force", "--reason", "userStop"]).is_ok());
        assert!(Cli::try_parse_from(["mixdogd", "ctl", "stop", "--force", "--abort", "--reason", "userStop"]).is_err());
    }

    #[test]
    fn stop_needs_a_mode() {
        assert!(Cli::try_parse_from(["mixdogd", "ctl", "stop", "--reason", "quit"]).is_err());
        assert!(Cli::try_parse_from(["mixdogd", "ctl", "stop", "--when-idle", "--reason", "quit"]).is_ok());
        assert!(Cli::try_parse_from(["mixdogd", "ctl", "stop", "--when-idle", "--abort", "--reason", "quit"]).is_err());
    }
}
