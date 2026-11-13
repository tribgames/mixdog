//! `mixdogd serve | ctl | migrate | server-ensure` (SPEC §3.2). Argument parsing only; every
//! subcommand body lives in the daemon, migrate or client crate it names.

#[cfg(feature = "crash-gates")]
mod boot_fault;
mod projector;

use mixdog_cli::exec;

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use mixdog_exthost::DEFAULT_PENDING_CAP;
use mixdog_exthost::ExtDocumentText;
use mixdog_exthost::ExtHostConfig;
use mixdog_exthost::ExtHostPool;
use mixdog_exthost::RenderBrowserConfig;
use mixdog_exthost::worker_count;
use mixdog_migrate::run::cli::MigrateArgs;
use mixdog_migrate::session::context_blobs::OfficeExtractor;
use mixdog_rt::Backend;
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
    Serve,
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
#[command(group(ArgGroup::new("mode").required(true).args(["when_idle", "abort"])))]
struct StopArgs {
    #[arg(long)]
    when_idle: bool,
    #[arg(long)]
    abort: bool,
    #[arg(long)]
    reason: String,
    #[arg(long)]
    confirm_token: Option<String>,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.command {
        Command::Serve => serve(),
        Command::Ctl(args) => ctl(args),
        Command::Migrate(args) => {
            let args = MigrateArgs {
                data_dir: args.data_dir,
                home: args.home,
                desktop_profile: args.desktop_profile,
            };
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
    let js = match mixdog_app_server_daemon::js_runtime::resolve_current() {
        Ok(js) => js,
        Err(err) => {
            eprintln!("mixdogd migrate: resolving the JS runtime: {err}");
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
    let pool = {
        let _context = runtime.enter();
        ExtHostPool::new(ExtHostConfig {
            program: js.program,
            args: vec![js.package_root.join("src").join("ext-host").join("worker.mjs").into_os_string()],
            electron: js.electron,
            workers: worker_count(None, std::thread::available_parallelism().map_or(1, |n| n.get())),
            pending_cap: DEFAULT_PENDING_CAP,
            spawn_io: tokens.spawn_io,
            render_browser: RenderBrowserConfig {
                command: None,
                profile_root: roots.data.join("render-browser"),
                no_sandbox: false,
            },
        })
    };
    let pool = match pool {
        Ok(pool) => Arc::new(pool),
        Err(err) => {
            eprintln!("mixdogd migrate: starting the extension host: {err}");
            return ExitCode::FAILURE;
        }
    };
    let office = OfficeExtractor { docs: Arc::new(ExtDocumentText::new(pool.clone())), runtime: runtime.clone() };
    let status = mixdog_migrate::run::cli::main(roots, Arc::new(projector::StoreProjector), office);
    runtime.block_on(pool.close());
    ExitCode::from(status)
}

/// Writes the exec's answer and errors to this process's stdout and stderr.
struct StdSink;

impl exec::Sink for StdSink {
    fn out(&self, text: &str) {
        use std::io::Write;
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(text.as_bytes());
        let _ = out.flush();
    }
    fn err(&self, text: &str) {
        use std::io::Write;
        let _ = std::io::stderr().lock().write_all(text.as_bytes());
    }
}

/// Refuses what Node refuses before anything starts, then runs the exec on its own core (`runHeadlessExec`).
fn exec_command(args: exec::ExecArgs) -> ExitCode {
    let options = args.into_options(std::env::var("MIXDOG_USAGE_LOG").ok()).and_then(|options| {
        exec::route::validate_explicit_route(options.provider.as_deref(), options.model.as_deref(), options.effort.as_deref()).map(|()| options)
    });
    let options = match options {
        Ok(options) => options,
        Err(refusal) => {
            eprintln!("mixdog: {refusal}");
            return ExitCode::FAILURE;
        }
    };
    let js = match mixdog_app_server_daemon::js_runtime::resolve_current() {
        Ok(js) => js,
        Err(err) => {
            eprintln!("mixdog: resolving the JS runtime: {err}");
            return ExitCode::FAILURE;
        }
    };
    // The host's own data folder (`resolvePluginData()`), where its credentials live; the run never writes to it.
    let Some(host_data_dir) = mixdog_store::paths::Paths::from_process(&js.package_root).map(|paths| paths.data_dir) else {
        eprintln!("mixdog: no data directory (set MIXDOG_DATA_DIR or HOME)");
        return ExitCode::FAILURE;
    };
    let (executors, tokens) = match mixdog_app_server_daemon::boot_executors() {
        Ok(booted) => booted,
        Err(err) => {
            eprintln!("mixdog: starting the executors: {err}");
            return ExitCode::FAILURE;
        }
    };
    let provider = exec::route::clean(options.provider.as_deref()).to_owned();
    let credentials = executors.handle(TaskClass::Work).block_on(exec::launcher::ResolvedCredentials::read(&tokens, &provider, &host_data_dir));
    // The exec's own thread: one, so the boundary's environment is applied while no other thread reads it.
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(err) => {
            eprintln!("mixdog: starting the async runtime: {err}");
            return ExitCode::FAILURE;
        }
    };
    let ort_library = match mixdog_app_server_daemon::js_runtime::resolve_ort_library_current() {
        Ok(Some(library)) => mixdog_services::effort_judge::model::OrtRuntime::Library(library),
        Ok(None) => mixdog_services::effort_judge::model::OrtRuntime::NoBinding,
        Err(err) => {
            eprintln!("mixdog: resolving the ONNX Runtime: {err}");
            return ExitCode::FAILURE;
        }
    };
    let launcher = exec::launcher::InProcessLauncher::new(executors, tokens, js, ort_library);
    let host = exec::run::Host {
        launcher: &launcher,
        credentials: &credentials,
        host_env: std::env::vars().collect(),
        host_data_dir,
        temp_dir: std::env::temp_dir(),
        sink: Arc::new(StdSink),
        now: exec::lifecycle::system_clock(),
    };
    // `installProcessSignalCleanup`: an interrupt ends the run with 130 after the shutdown.
    let signal: exec::run::Signal = Box::pin(async {
        match tokio::signal::ctrl_c().await {
            Ok(()) => 130,
            Err(_) => std::future::pending().await,
        }
    });
    let code = runtime.block_on(exec::run::run_exec(options, host, signal));
    ExitCode::from(u8::try_from(code).unwrap_or(1))
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
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
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
                    status
                        .drain
                        .as_ref()
                        .map_or(String::new(), |d| format!(", draining {}", d.drain_id)),
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

async fn ctl_request(
    action: CtlAction,
) -> Result<mixdog_app_server_client::ctl::CoreStatus, mixdog_app_server_client::ctl::CtlError> {
    use mixdog_app_server_client::ctl::CtlClient;
    use mixdog_app_server_client::ctl::StopMode;

    let client = CtlClient::local().await?;
    match action {
        CtlAction::Status => client.status().await,
        CtlAction::Hold { off } => client.hold(!off).await,
        CtlAction::Stop(stop) => {
            let mode = if stop.abort {
                StopMode::AbortConfirmed
            } else {
                StopMode::WhenIdle
            };
            let reason = serde_json::from_value(serde_json::Value::String(stop.reason.clone()))
                .map_err(|_| {
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
    let app_id: Vec<u16> = "io.mixdog.desktop ".encode_utf16().collect();
    // SAFETY: `app_id` is a NUL-terminated UTF-16 string that outlives the call; the call only records it for this process.
    #[allow(unsafe_code, reason = "one Win32 call that records this process's AppUserModelID")]
    let _ = unsafe { windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(app_id.as_ptr()) };
}

#[cfg(not(windows))]
fn adopt_desktop_app_identity() {}

fn serve() -> ExitCode {
    adopt_desktop_app_identity();
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();
    #[cfg(feature = "crash-gates")]
    boot_fault::wait_for_launcher();
    // Node installs its recorder at module load: a start that fails on its way up (no JS runtime, no executors) is recorded too.
    mixdog_app_server_daemon::crash_record::install_for_process();
    let start = || -> Result<(), String> {
        #[cfg(feature = "crash-gates")]
        if let Some(ended) = boot_fault::run() {
            return ended;
        }
        mixdog_app_server_daemon::run().map_err(|error| error.to_string())
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
    fn stop_needs_a_mode() {
        assert!(Cli::try_parse_from(["mixdogd", "ctl", "stop", "--reason", "quit"]).is_err());
        assert!(
            Cli::try_parse_from(["mixdogd", "ctl", "stop", "--when-idle", "--reason", "quit"])
                .is_ok()
        );
        assert!(
            Cli::try_parse_from([
                "mixdogd",
                "ctl",
                "stop",
                "--when-idle",
                "--abort",
                "--reason",
                "quit"
            ])
            .is_err()
        );
    }
}
