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
mod tests {
    use super::*;

    fn git(dir: &std::path::Path) -> Arc<ProcessGit> {
        let tokens = mixdog_rt::testing::tokens();
        let manager = Arc::new(mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default()));
        ProcessGit::new(Processes::new(manager, tokens.durability_io), Handle::current(), dir.to_path_buf())
    }

    async fn on_thread<R: Send + 'static>(job: impl FnOnce() -> R + Send + 'static) -> R {
        let (tx, rx) = tokio::sync::oneshot::channel();
        std::thread::spawn(move || drop(tx.send(job())));
        rx.await.unwrap()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_clone_returns_the_trimmed_stdout_and_a_failure_the_trimmed_stderr() {
        let dir = tempfile::tempdir().unwrap();
        let runner = git(dir.path());
        let source = dir.path().join("source");
        let args = vec!["init".to_owned(), source.to_string_lossy().into_owned()];
        let out = on_thread({
            let runner = runner.clone();
            move || runner.run(&args, Duration::from_secs(60))
        })
        .await
        .unwrap();
        assert!(out.starts_with("Initialized empty Git repository"), "{out}");
        let missing = vec!["clone".to_owned(), dir.path().join("none").to_string_lossy().into_owned(), dir.path().join("x").to_string_lossy().into_owned()];
        let err = on_thread(move || runner.run(&missing, Duration::from_secs(60))).await.unwrap_err();
        assert!(err.starts_with("fatal:") && err == err.trim(), "{err}");
    }
}
