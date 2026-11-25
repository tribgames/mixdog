//! The helper processes a core starts as its own executable run with a subcommand (`current_exe`): the extension-host
//! worker, the effort judge's and the embedding model's hosts, Office automation, an ACP agent's tool server and a skill
//! script. Started by a core, never by a user. Both programs a core runs in serve every one of them: `mixdogd`, and
//! `mixdog`, whose `exec` composes its core in its own process.

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::ExitCode;

use clap::Parser;
use clap::Subcommand;

#[derive(Subcommand, Debug)]
pub enum Helper {
    /// The process the embedding model runs in.
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
    /// The process the effort judge's model runs in.
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
    /// serves document calls until the pool says bye.
    #[command(name = "ext-worker", hide = true)]
    ExtWorker,
    /// The process Microsoft Office automation runs in.
    #[command(name = "office-com-host", hide = true, trailing_var_arg = true, allow_hyphen_values = true, disable_help_flag = true)]
    OfficeComHost {
        #[arg(allow_hyphen_values = true, value_name = "ARGS")]
        args: Vec<OsString>,
    },
    /// The stdio end of a session's tool server for an ACP agent; started by that agent.
    #[command(name = "acp-mcp-bridge", hide = true)]
    AcpMcpBridge,
    /// The program the `mixdog-skill-node` launchers start: runs a skill script.
    #[command(name = "skill-run", hide = true, trailing_var_arg = true, allow_hyphen_values = true, disable_help_flag = true)]
    SkillRun {
        #[arg(allow_hyphen_values = true, value_name = "SCRIPT_AND_ARGS")]
        args: Vec<OsString>,
    },
}

/// A command line that is one helper's.
#[derive(Parser)]
#[command(no_binary_name = true)]
struct HelperLine {
    #[command(subcommand)]
    helper: Helper,
}

/// The helper `args` (the words after the program's name) ask for: `None` unless the first word names one. A helper line that
/// does not parse ends the process with clap's error, as it does in `mixdogd`.
pub fn requested(args: &[OsString]) -> Option<Helper> {
    let first = args.first()?.to_str()?;
    <Helper as Subcommand>::has_subcommand(first).then(|| HelperLine::parse_from(args).helper)
}

/// Runs `helper` in this process; the process's exit status.
pub fn run(helper: Helper) -> ExitCode {
    match helper {
        Helper::EffortJudgeHost { dir, ort_library, explicit } => {
            ExitCode::from(mixdog_app_server_daemon::effort_judge_host::run(dir, ort_library, explicit) as u8)
        }
        Helper::EmbeddingHost { cache_dir, model_id, ort_library, dtype } => {
            ExitCode::from(mixdog_app_server_daemon::embedding_host::run(cache_dir, model_id, ort_library, dtype) as u8)
        }
        Helper::OfficeComHost { args } => ExitCode::from(mixdog_office_com::host::run(&args) as u8),
        Helper::AcpMcpBridge => ExitCode::from(mixdog_app_server_daemon::acp_tools::run_bridge() as u8),
        Helper::ExtWorker => {
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
        Helper::SkillRun { args } => {
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
