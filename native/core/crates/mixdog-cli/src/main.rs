//! `mixdogd serve | ctl | migrate | server-ensure` (SPEC §3.2). Argument parsing only; every
//! subcommand body lives in the daemon, migrate or client crate it names.

mod exec;
mod projector;

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use mixdog_migrate::run::cli::MigrateArgs;

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
}

#[derive(Args)]
struct MigrateCliArgs {
    /// Default: `$MIXDOG_DATA_DIR`, else `~/.mixdog/data`.
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

/// Exit status of a subcommand whose implementing crate has not landed.
const EXIT_NOT_WIRED: u8 = 70;

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
            // Blocking by design: the migration runs on this thread before any runtime starts.
            ExitCode::from(mixdog_migrate::run::cli::main(&args, Arc::new(projector::StoreProjector)))
        }
        Command::ServerEnsure { argument } => {
            // Prints its own result lines; the status is 0 or 3.
            ExitCode::from(mixdog_app_server_daemon::server_ensure::main(&argument) as u8)
        }
        Command::Exec(args) => exec_command(args),
    }
}

/// Refuses what Node refuses before anything starts. The run itself needs the composition root's
/// `exec::seams::CoreLauncher` and `exec::boundary::HostCredentials`.
fn exec_command(args: exec::ExecArgs) -> ExitCode {
    let options = args.into_options(std::env::var("MIXDOG_USAGE_LOG").ok()).and_then(|options| {
        exec::route::validate_explicit_route(options.provider.as_deref(), options.model.as_deref(), options.effort.as_deref())
    });
    match options {
        Ok(()) => not_wired("exec"),
        Err(refusal) => {
            eprintln!("mixdog: {refusal}");
            ExitCode::FAILURE
        }
    }
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
            match err.code() {
                Some(code) => eprintln!("mixdogd: refused: {code}: {err}"),
                None => eprintln!("mixdogd: {err}"),
            }
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

fn serve() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(err) => {
            eprintln!("mixdogd: starting the async runtime: {err}");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(mixdog_app_server_daemon::serve()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("mixdogd: {err}");
            ExitCode::FAILURE
        }
    }
}

fn not_wired(name: &str) -> ExitCode {
    eprintln!("mixdogd: `{name}` is not wired to its crate yet");
    ExitCode::from(EXIT_NOT_WIRED)
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
