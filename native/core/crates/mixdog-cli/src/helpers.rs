//! The helper processes a core starts as its own executable run with a subcommand (`current_exe`): the extension-host
//! worker, the code graph helper, the search helper, the effort judge's and the embedding model's hosts, Office automation, an ACP agent's tool
//! server and a skill script. Started by a core, never by a user. `mixdogd` serves every one of them; the terminal program hands a
//! line that names one (`mixdog_launch::command::HELPER_SUBCOMMANDS`) to the `mixdogd` beside it.

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::ExitCode;

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
    /// The code graph helper the core's `GraphHost` starts: it owns the graph cache under `cache_dir` and answers the core's
    /// frames on its standard pipes, writing nothing else there, until the core drains it or closes its input.
    #[command(name = "graph-worker", hide = true)]
    GraphWorker {
        #[arg(long)]
        cache_dir: PathBuf,
    },
    /// The search helper the core's `SearchHost` starts: it runs the core's walks and text searches and streams their
    /// results as frames on its standard pipes, writing nothing else there, until the core closes its input.
    #[command(name = "search-worker", hide = true)]
    SearchWorker,
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

/// The page extraction the web tools hand to the worker (`mixdog_tools::web`): the worker crate does not hold the extractor.
fn web_methods(registry: &mut mixdog_exthost_worker::Registry) {
    registry.register_blocking(mixdog_tools::web::EXTRACT_METHOD, |ctx| {
        mixdog_tools::web::extract_answer(&ctx.params)
            .map(mixdog_exthost_worker::Outcome::value)
            .map_err(|message| mixdog_exthost_worker::CodedError::new("invalid_params", message))
    });
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
        Helper::GraphWorker { cache_dir } => ExitCode::from(mixdog_tools::code_graph::engine::serve_worker(cache_dir) as u8),
        Helper::SearchWorker => ExitCode::from(mixdog_search_host::worker::serve_stdio() as u8),
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
            mixdog_exthost_worker::main_entry::ext_worker_main_with(&[web_methods])
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

#[cfg(test)]
mod tests {
    use clap::Subcommand;

    #[test]
    fn the_terminal_program_hands_on_exactly_the_helper_subcommands() {
        let helpers = <super::Helper as Subcommand>::augment_subcommands(clap::Command::new("mixdogd"));
        let mut served: Vec<&str> = helpers.get_subcommands().map(clap::Command::get_name).collect();
        let mut handed = mixdog_launch::command::HELPER_SUBCOMMANDS.to_vec();
        served.sort_unstable();
        handed.sort_unstable();
        assert_eq!(served, handed);
    }

    #[test]
    fn the_worker_serves_the_web_tools_page_extraction() {
        let methods = mixdog_exthost_worker::main_entry::native_methods_with(&[super::web_methods]);
        assert!(methods.iter().any(|method| method == mixdog_tools::web::EXTRACT_METHOD), "{methods:?}");
    }
}
