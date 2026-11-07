//! `plugins.git`: the `git` that `PluginAdmin` clones and updates plugins with.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use mixdog_js::js_trim;
use mixdog_mcp::plugin_admin::GitRunner;
use mixdog_services::tidy::process::Processes;
use mixdog_services::tidy::process::RunOptions;
use tokio::runtime::Handle;

/// `runGit(args)` of `plugin-admin.mjs`: `spawnSync('git', args, { timeout })` whose non-zero
/// status throws the trimmed stderr, else the trimmed stdout, else `git <args> failed`.
///
/// `GitRunner::run` is called from a maintenance-lane job (a thread that is not a runtime
/// worker), so the child runs under the one process manager and the job waits for it on `runtime`.
pub struct ProcessGit {
    processes: Processes,
    runtime: Handle,
    /// The folder `git` starts in (Node: the process's own working directory).
    cwd: PathBuf,
}

impl ProcessGit {
    /// `runtime` is the handle of the runtime that drives `processes`.
    pub fn new(processes: Processes, runtime: Handle, cwd: PathBuf) -> Arc<Self> {
        Arc::new(Self { processes, runtime, cwd })
    }
}

impl GitRunner for ProcessGit {
    fn run(&self, args: &[String], timeout: Duration) -> Result<String, String> {
        let mut options = RunOptions::new(&self.cwd);
        options.timeout = timeout;
        let result = self.runtime.block_on(self.processes.run("git", args, options));
        if result.code != 0 {
            let detail = [js_trim(&result.stderr), js_trim(&result.stdout)].into_iter().find(|text| !text.is_empty());
            return Err(detail.map_or_else(|| format!("git {} failed", args.join(" ")), str::to_owned));
        }
        Ok(js_trim(&result.stdout).to_owned())
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "the test lays out its fixture files with blocking calls on the test thread")]
mod tests {
    use super::*;
    use crate::domain_seams::golden;
    use crate::domain_seams::portable;
    use serde_json::Value;
    use serde_json::json;

    async fn on_thread<R: Send + 'static>(job: impl FnOnce() -> R + Send + 'static) -> R {
        let (tx, rx) = tokio::sync::oneshot::channel();
        std::thread::spawn(move || drop(tx.send(job())));
        rx.await.unwrap()
    }

    /// Node's `runGit` over the recorded scenario: one repository made, cloned from nothing, read and
    /// committed in, each step's trimmed stdout or its failure text.
    #[tokio::test(flavor = "multi_thread")]
    async fn each_git_step_answers_what_nodes_run_git_answers() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().to_path_buf();
        let tokens = mixdog_rt::testing::tokens();
        let manager = Arc::new(mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default()));
        let runner = ProcessGit::new(Processes::new(manager, tokens.durability_io), Handle::current(), base.clone());
        for step in golden()["git"].as_array().unwrap() {
            if let Some(files) = step["before"].as_object() {
                for (rel, text) in files {
                    let path = base.join(rel);
                    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                    std::fs::write(path, text.as_str().unwrap()).unwrap();
                }
            }
            let root = base.to_string_lossy().into_owned();
            let args: Vec<String> = step["args"].as_array().unwrap().iter().map(|arg| arg.as_str().unwrap().replace("<root>", &root)).collect();
            let runner = runner.clone();
            let outcome = on_thread(move || runner.run(&args, Duration::from_secs(60))).await;
            let shown: Value = match outcome {
                Ok(out) => json!({ "ok": out }),
                Err(error) => json!({ "error": error }),
            };
            let expected = if step["ok"].is_null() { json!({ "error": step["error"] }) } else { json!({ "ok": step["ok"] }) };
            assert_eq!(portable(&shown, &base), expected, "{}", step["args"]);
        }
    }
}