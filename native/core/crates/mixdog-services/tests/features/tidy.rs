//! The tidy runners against a scripted engine: the command lines they run and what they make of the answers.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_services::tidy::process::ProcessResult;
use mixdog_services::tidy::runners::{RunRequest, Spawn, runner_for};
use tokio_util::sync::CancellationToken;

type Call = (String, Vec<String>);

struct Script {
    answers: Mutex<Vec<ProcessResult>>,
    calls: Mutex<Vec<Call>>,
}

impl Script {
    fn new(answers: Vec<ProcessResult>) -> Arc<Self> {
        Arc::new(Self { answers: Mutex::new(answers), calls: Mutex::default() })
    }
}

#[async_trait]
impl Spawn for Script {
    async fn run(
        &self,
        bin: &str,
        args: &[String],
        _cwd: &Path,
        _timeout: Duration,
        _cancel: Option<&CancellationToken>,
        _env: Option<&HashMap<String, String>>,
        _input: Option<Vec<u8>>,
    ) -> ProcessResult {
        self.calls.lock().unwrap().push((bin.to_owned(), args.to_vec()));
        let mut answers = self.answers.lock().unwrap();
        if answers.is_empty() { ProcessResult::default() } else { answers.remove(0) }
    }
}

fn ok(stdout: &str) -> ProcessResult {
    ProcessResult { stdout: stdout.to_owned(), ..Default::default() }
}

fn request(script: &Arc<Script>, files: &[&str]) -> RunRequest {
    RunRequest::new(Path::new("/repo"), "gofmt", files.iter().map(|f| (*f).to_owned()).collect(), script.clone(), mixdog_rt::testing::tokens().durability_io)
}

fn names(files: &[&str]) -> Vec<String> {
    files.iter().map(|f| (*f).to_owned()).collect()
}

#[tokio::test]
async fn a_list_formatter_check_lists_then_names_each_unformatted_file_once() {
    let script = Script::new(vec![ok("a.go\n\nb.go\na.go\n")]);
    let result = runner_for("gofmt").unwrap().check(&request(&script, &["a.go", "b.go", "c.go"])).await;
    assert_eq!(*script.calls.lock().unwrap(), vec![("gofmt".to_owned(), names(&["-l", "a.go", "b.go", "c.go"]))]);
    assert_eq!(result.changed_files, names(&["a.go", "b.go"]));
    assert!(result.diagnostics.iter().all(|d| d.fixable && d.severity == "warning" && d.code == "gofmt"));
    assert_eq!(result.diagnostics[0].message, "gofmt would reformat this file");
    assert!(result.error.is_none());
}

#[tokio::test]
async fn a_list_formatter_fix_writes_and_reports_no_diagnostics() {
    let script = Script::new(vec![]);
    let result = runner_for("gofmt").unwrap().fix(&request(&script, &["a.go"])).await;
    assert_eq!(script.calls.lock().unwrap()[0].1, names(&["-w", "a.go"]));
    assert!(result.diagnostics.is_empty() && result.error.is_none());
}

#[tokio::test]
async fn caller_arguments_come_first_and_files_are_split_into_chunks_of_the_request() {
    let script = Script::new(vec![ok("a.go\n"), ok("c.go\n")]);
    let mut req = request(&script, &["a.go", "b.go", "c.go"]);
    req.args = names(&["--flag"]);
    req.files_per_spawn = 2;
    let result = runner_for("gofmt").unwrap().check(&req).await;
    let calls: Vec<Vec<String>> = script.calls.lock().unwrap().iter().map(|c| c.1.clone()).collect();
    assert_eq!(calls, vec![names(&["--flag", "-l", "a.go", "b.go"]), names(&["--flag", "-l", "c.go"])]);
    assert_eq!(result.changed_files, names(&["a.go", "c.go"]));
}

#[tokio::test]
async fn an_engine_that_cannot_start_is_one_actionable_error_not_a_clean_pass() {
    let script = Script::new(vec![ProcessResult { code: -1, error: "program not found".to_owned(), error_code: "NotFound".to_owned(), ..Default::default() }]);
    let result = runner_for("gofmt").unwrap().check(&request(&script, &["a.go"])).await;
    assert_eq!(result.error.as_deref(), Some("gofmt could not run: program not found"));
    assert_eq!(result.files_checked, Some(0));
    assert!(result.diagnostics.is_empty() && result.changed_files.is_empty());
}

#[tokio::test]
async fn an_engine_that_times_out_says_so() {
    let script = Script::new(vec![ProcessResult { code: -1, timed_out: true, error: "timed out".to_owned(), ..Default::default() }]);
    let result = runner_for("gofmt").unwrap().fix(&request(&script, &["a.go"])).await;
    assert_eq!(result.error.as_deref(), Some("gofmt timed out"));
}

#[tokio::test]
async fn a_long_stderr_is_kept_only_as_its_last_600_characters() {
    let script = Script::new(vec![ProcessResult { stderr: format!("{}END", "x".repeat(900)), ..Default::default() }]);
    let result = runner_for("gofmt").unwrap().check(&request(&script, &["a.go"])).await;
    assert!(result.stderr_tail.starts_with('…') && result.stderr_tail.ends_with("END"));
    assert_eq!(result.stderr_tail.chars().count(), 601);
}

#[test]
fn engines_without_a_runner_are_not_run() {
    assert!(runner_for("mix").is_none() && runner_for("").is_none());
    for id in ["biome", "ruff", "shfmt", "prettier", "eslint", "rustfmt", "dotnet-format"] {
        assert_eq!(runner_for(id).unwrap().id(), id);
    }
}
