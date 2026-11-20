//! The format-only engines whose check output names the files they would rewrite: air,
//! clang-format, `dart format`, dprint, StyLua and taplo. Each keeps its output parsing in a pure
//! function and says, from the engine's own exit codes, whether a run completed.

use std::path::Path;
use std::sync::OnceLock;

use async_trait::async_trait;
use mixdog_js::{JsRegex, js_trim};

use super::shared::*;
use crate::tidy::process::ProcessResult;

fn re(cell: &'static OnceLock<JsRegex>, pattern: &str) -> &'static JsRegex {
    cell.get_or_init(|| JsRegex::new_static(pattern, ""))
}

/// Exit 1 is "would reformat" for these engines; a failure has a code of its own.
fn clean_or_unformatted(r: &ProcessResult) -> bool {
    r.code == 0 || r.code == 1
}

/// The findings are the engine's stderr or stdout; its tail is worth showing only without them.
fn quiet_when_found(mut result: RunnerResult) -> RunnerResult {
    if !result.changed_files.is_empty() {
        result.stderr_tail.clear();
    }
    result
}

// ---- air (posit-dev/air): `air format --check` lists "Would reformat: <path>" on stderr; 255 is a failure.

pub fn parse_air_check(stderr: &str, cwd: &Path) -> Findings {
    static R: OnceLock<JsRegex> = OnceLock::new();
    parse_reformat_report(stderr, re(&R, r"^Would reformat:\s*(.+?)\s*$"), cwd, "air", "air")
}

pub struct Air;

#[async_trait]
impl Runner for Air {
    fn id(&self) -> &'static str {
        "air"
    }
    async fn check(&self, req: &RunRequest) -> RunnerResult {
        let read = |r: &ProcessResult, _: &[String]| if clean_or_unformatted(r) { Batch::Done(parse_air_check(&r.stderr, &req.cwd)) } else { Batch::Incomplete(said(r)) };
        quiet_when_found(run_batches(req, "air", &req.files, req.files_per_spawn, &|files| Invocation::over(req, &["format", "--check"], files), &read).await.into_result())
    }
    async fn fix(&self, req: &RunRequest) -> RunnerResult {
        run_writes(req, "air", &["format"], &exited_zero).await.into_result()
    }
}

// ---- clang-format: `--dry-run -Werror` reports each violation on stderr with its position and
// exits 1, the code it also gives a configuration it cannot read.

const VIOLATION: &str = "[-Wclang-format-violations]";

/// The violations of a dry run; `Err` with the first positioned message that is not one, and the
/// file it is positioned in (a configuration error is reported at a position too, in the
/// configuration file).
pub fn parse_clang_format_dry_run(stderr: &str, cwd: &Path) -> Result<Findings, (String, String)> {
    static R: OnceLock<JsRegex> = OnceLock::new();
    let positioned = re(&R, r"^(.*?):(\d+):(\d+):\s*(warning|error):\s*(.*)$");
    let mut found = Findings::default();
    for line in stderr.lines() {
        let Some(m) = positioned.captures(js_trim(line)) else { continue };
        let group = |n: usize| m.get(n).unwrap_or("");
        if !group(5).contains(VIOLATION) {
            return Err((to_rel(cwd, group(1)), js_trim(line).to_owned()));
        }
        let file = to_rel(cwd, group(1));
        found.changed.push(file.clone());
        found.diagnostics.push(diagnostic(DiagnosticInit {
            file: &file,
            line: group(2).parse().unwrap_or(0),
            col: group(3).parse().unwrap_or(0),
            code: "clang-format",
            message: group(5),
            severity: if group(4) == "error" { "error" } else { "warning" },
            fixable: true,
        }));
    }
    found.changed = unique_paths(found.changed);
    Ok(found)
}

pub struct ClangFormat;

#[async_trait]
impl Runner for ClangFormat {
    fn id(&self) -> &'static str {
        "clang-format"
    }
    async fn check(&self, req: &RunRequest) -> RunnerResult {
        let read = |r: &ProcessResult, files: &[String]| match parse_clang_format_dry_run(&r.stderr, &req.cwd) {
            // Exit 1 with no violation to show for it is clang-format refusing something.
            Ok(found) if r.code == 0 || (r.code == 1 && !found.changed.is_empty()) => Batch::Done(found),
            Ok(_) => Batch::Incomplete(said(r)),
            Err((file, message)) if files.iter().any(|given| to_rel(&req.cwd, given) == file) => Batch::Incomplete(message),
            // An error positioned in a file it was not given is in what it read on its own: its configuration.
            Err((_, message)) => Batch::Refused(message),
        };
        quiet_when_found(run_batches(req, "clang-format", &req.files, req.files_per_spawn, &|files| Invocation::over(req, &["--dry-run", "-Werror"], files), &read).await.into_result())
    }
    async fn fix(&self, req: &RunRequest) -> RunnerResult {
        run_writes(req, "clang-format", &["-i"], &exited_zero).await.into_result()
    }
}

// ---- dprint: `check` prints a diff block per file and exits 20 when any file is unformatted;
// `fmt` writes. It formats only the files its configured plugins match, and exits 14 when that is
// none of those it was given.

pub fn parse_dprint_check(output: &str, cwd: &Path) -> Findings {
    static R: OnceLock<JsRegex> = OnceLock::new();
    parse_reformat_report(output, re(&R, r"^(?:from\s+(.+?):|---\s*(.+?)\s*---)$"), cwd, "dprint", "dprint")
}

fn dprint_listed(r: &ProcessResult) -> bool {
    r.code == 0 || r.code == 14
}

pub struct Dprint;

#[async_trait]
impl Runner for Dprint {
    fn id(&self) -> &'static str {
        "dprint"
    }
    async fn check(&self, req: &RunRequest) -> RunnerResult {
        let (selected, ignored) = match selected_files(req, "dprint", &["output-file-paths"], dprint_listed).await {
            Ok(split) => split,
            Err(why) => return engine_stopped(why),
        };
        let read = |r: &ProcessResult, _: &[String]| if r.code == 0 || r.code == 20 { Batch::Done(parse_dprint_check(&format!("{}\n{}", r.stdout, r.stderr), &req.cwd)) } else { Batch::Incomplete(said(r)) };
        let pass = run_batches(req, "dprint", &selected, req.files_per_spawn, &|files| Invocation::over(req, &["check"], files), &read).await;
        RunnerResult { ignored, ..quiet_when_found(pass.into_result()) }
    }
    async fn fix(&self, req: &RunRequest) -> RunnerResult {
        run_writes(req, "dprint", &["fmt"], &exited_zero).await.into_result()
    }
}

// ---- StyLua: `--check` prints a diff per unformatted file; the bare command formats in place; 2
// is a failure. Handed a path, StyLua formats it even when `.styluaignore` lists it, unless told
// to respect its ignores, and it does not say which files it then skipped.

const STYLUA_LINE_ENDINGS: LineEndingFlags = LineEndingFlags { lf: &["--line-endings", "Unix"], crlf: &["--line-endings", "Windows"] };

pub fn parse_stylua_check(output: &str, cwd: &Path) -> Findings {
    static R: OnceLock<JsRegex> = OnceLock::new();
    parse_reformat_report(output, re(&R, r"^Diff in (.+?):?\s*$"), cwd, "stylua", "stylua")
}

pub struct Stylua;

#[async_trait]
impl Runner for Stylua {
    fn id(&self) -> &'static str {
        "stylua"
    }
    async fn check(&self, req: &RunRequest) -> RunnerResult {
        let read = |r: &ProcessResult, _: &[String]| if clean_or_unformatted(r) { Batch::Done(parse_stylua_check(&format!("{}\n{}", r.stdout, r.stderr), &req.cwd)) } else { Batch::Incomplete(said(r)) };
        let call = |line_ending: &[&str], files: &[String]| Invocation::over(req, &[&["--check", "--respect-ignores"][..], line_ending].concat(), files);
        quiet_when_found(run_by_line_ending(req, "stylua", Command::Reads, &STYLUA_LINE_ENDINGS, &call, &read).await.into_result())
    }
    async fn fix(&self, req: &RunRequest) -> RunnerResult {
        let call = |line_ending: &[&str], files: &[String]| Invocation::over(req, &[&["--respect-ignores"][..], line_ending].concat(), files);
        run_by_line_ending(req, "stylua", Command::Writes, &STYLUA_LINE_ENDINGS, &call, &|r, _| wrote(&exited_zero, r)).await.into_result()
    }
}

// ---- dart format: `--output=none` names each file it would rewrite as "Changed <path>" and
// exits 0; 65 is a file it could not parse. Nothing in its configuration excludes a file.

pub fn parse_dart_check(stdout: &str, cwd: &Path) -> Findings {
    static R: OnceLock<JsRegex> = OnceLock::new();
    parse_reformat_report(stdout, re(&R, r"^Changed (.+)$"), cwd, "dart", "dart")
}

pub struct Dart;

#[async_trait]
impl Runner for Dart {
    fn id(&self) -> &'static str {
        "dart"
    }
    async fn check(&self, req: &RunRequest) -> RunnerResult {
        let read = |r: &ProcessResult, _: &[String]| if r.code == 0 { Batch::Done(parse_dart_check(&r.stdout, &req.cwd)) } else { Batch::Incomplete(said(r)) };
        run_batches(req, "dart", &req.files, req.files_per_spawn, &|files| Invocation::over(req, &["--output=none"], files), &read).await.into_result()
    }
    async fn fix(&self, req: &RunRequest) -> RunnerResult {
        run_writes(req, "dart", &[], &exited_zero).await.into_result()
    }
}

// ---- taplo: `fmt --check` logs each file it would rewrite and exits 1, the code it also gives a
// file that is not TOML; `fmt` writes. It takes its files by path because only then does it leave
// out the ones its configuration excludes; it does so without a word, so they count as checked.
// Its arguments are glob patterns. A configuration it cannot read it replaces with its defaults
// after a warning.

const TAPLO_LINE_ENDINGS: LineEndingFlags = LineEndingFlags { lf: &["-o", "crlf=false"], crlf: &["-o", "crlf=true"] };

/// The files a check would rewrite; `Err` with the first error that is not about formatting.
pub fn parse_taplo_check(stderr: &str, cwd: &Path) -> Result<Findings, String> {
    static R: OnceLock<JsRegex> = OnceLock::new();
    let unformatted = re(&R, r#"^ERROR .*the file is not properly formatted path="(.+)"$"#);
    let text = strip_ansi(stderr);
    let mut changed = Vec::new();
    for line in text.lines().map(js_trim) {
        if let Some(m) = unformatted.captures(line) {
            changed.push(to_rel(cwd, m.get(1).unwrap_or("")));
        } else if (line.starts_with("ERROR") || line.starts_with("error")) && !line.contains("some files were not properly formatted") {
            return Err(line.to_owned());
        }
    }
    let changed = unique_paths(changed);
    Ok(Findings { diagnostics: reformat_diagnostics(&changed, "taplo", "taplo"), changed, ..Default::default() })
}

/// What taplo said apart from its progress log, which names every file of the run.
fn taplo_said(r: &ProcessResult) -> String {
    let errors: Vec<&str> = r.stderr.lines().filter(|line| !js_trim(line).starts_with("INFO ")).collect();
    said(&ProcessResult { code: r.code, stderr: errors.join("\n"), ..Default::default() })
}

fn taplo_refused_configuration(r: &ProcessResult) -> Option<String> {
    strip_ansi(&r.stderr).lines().map(js_trim).find(|line| line.contains("invalid configuration file")).map(str::to_owned)
}

/// A path as a glob pattern that matches only it.
fn glob_literal(file: &str) -> String {
    let mut pattern = String::with_capacity(file.len());
    for c in file.chars() {
        if matches!(c, '[' | ']' | '*' | '?') {
            pattern.extend(['[', c, ']']);
        } else {
            pattern.push(c);
        }
    }
    pattern
}

async fn taplo(req: &RunRequest, command: Command, mode: &[&str], read: &(dyn Fn(&ProcessResult, &[String]) -> Batch + Sync)) -> RunnerResult {
    let call = |line_ending: &[&str], files: &[String]| Invocation::over(req, &[mode, line_ending].concat(), &files.iter().map(|f| glob_literal(f)).collect::<Vec<_>>());
    let pass = run_by_line_ending(req, "taplo", command, &TAPLO_LINE_ENDINGS, &call, read).await;
    // Its stderr is its log; what that says about the files is in the findings.
    RunnerResult { stderr_tail: String::new(), ..pass.into_result() }
}

pub struct Taplo;

#[async_trait]
impl Runner for Taplo {
    fn id(&self) -> &'static str {
        "taplo"
    }
    async fn check(&self, req: &RunRequest) -> RunnerResult {
        let read = |r: &ProcessResult, _: &[String]| match (taplo_refused_configuration(r), parse_taplo_check(&r.stderr, &req.cwd)) {
            (Some(why), _) => Batch::Refused(why),
            // Exit 1 with no file to show for it is taplo failing at something else.
            (None, Ok(found)) if r.code == 0 || !found.changed.is_empty() => Batch::Done(found),
            _ => Batch::Incomplete(taplo_said(r)),
        };
        taplo(req, Command::Reads, &["fmt", "--check"], &read).await
    }
    async fn fix(&self, req: &RunRequest) -> RunnerResult {
        let read = |r: &ProcessResult, _: &[String]| match taplo_refused_configuration(r) {
            Some(why) => Batch::Refused(why),
            None if r.code == 0 => Batch::Done(Findings::default()),
            None => Batch::Incomplete(taplo_said(r)),
        };
        taplo(req, Command::Writes, &["fmt"], &read).await
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;

    use tokio_util::sync::CancellationToken;

    use super::*;

    const CWD: &str = "/r";

    fn cwd() -> &'static Path {
        Path::new(CWD)
    }

    struct Fake(Box<dyn Fn(&[String]) -> ProcessResult + Send + Sync>);

    #[async_trait]
    impl Spawn for Fake {
        async fn run(&self, _: &str, args: &[String], _: &Path, _: std::time::Duration, _: Option<&CancellationToken>, _: Option<&HashMap<String, String>>, _: Option<Vec<u8>>) -> ProcessResult {
            (self.0)(args)
        }
    }

    fn request(files: &[&str], reply: impl Fn(&[String]) -> ProcessResult + Send + Sync + 'static) -> RunRequest {
        RunRequest::new(cwd(), "engine", files.iter().map(|f| (*f).to_owned()).collect(), Arc::new(Fake(Box::new(reply))), mixdog_rt::testing::tokens().durability_io)
    }

    /// A request over files that exist, each one line that ends with LF, for the engines that
    /// are told how a file ends its lines: tidy reads that from the file.
    fn on_disk(files: &[&str], reply: impl Fn(&[String]) -> ProcessResult + Send + Sync + 'static) -> (tempfile::TempDir, RunRequest) {
        let dir = tempfile::tempdir().unwrap();
        for file in files {
            let path = dir.path().join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "x\n").unwrap();
        }
        let req = RunRequest::new(dir.path(), "engine", files.iter().map(|f| (*f).to_owned()).collect(), Arc::new(Fake(Box::new(reply))), mixdog_rt::testing::tokens().durability_io);
        (dir, req)
    }

    fn names(unprocessed: &[(String, String)]) -> Vec<&str> {
        unprocessed.iter().map(|(file, _)| file.as_str()).collect()
    }

    #[test]
    fn reformat_reports_name_files_per_engine() {
        assert_eq!(parse_air_check("\u{1b}[4mWould reformat: a.R\u{1b}[0m\nnoise", cwd()).changed, ["a.R"]);
        assert_eq!(parse_stylua_check("Diff in src/a.lua:\n-x\n+y", cwd()).changed, ["src/a.lua"]);
        assert_eq!(parse_dprint_check("from a.json:\n--- b.md ---", cwd()).changed, ["a.json", "b.md"]);
    }

    #[test]
    fn clang_format_violations_carry_positions_and_any_other_positioned_message_is_a_refusal() {
        let found = parse_clang_format_dry_run("src/a.c:3:5: error: code should be clang-formatted [-Wclang-format-violations]\nint main(){}\n    ^\nsrc/a.c:9:1: warning: code should be clang-formatted [-Wclang-format-violations]", cwd()).unwrap();
        assert_eq!(found.changed, ["src/a.c"]);
        assert_eq!((found.diagnostics[0].line, found.diagnostics[0].col, found.diagnostics[0].severity.as_str(), found.diagnostics[1].severity.as_str()), (3, 5, "error", "warning"));
        assert_eq!(parse_clang_format_dry_run("/r/.clang-format:2:1: error: unknown key 'Foo'\nError reading /r/.clang-format: Invalid argument", cwd()).unwrap_err(), (".clang-format".to_owned(), "/r/.clang-format:2:1: error: unknown key 'Foo'".to_owned()));
    }

    #[tokio::test]
    async fn a_file_an_engine_fails_on_is_unprocessed_and_the_findings_of_the_others_are_kept() {
        // StyLua prints the diffs it has, names the file it could not parse on stderr, and exits 2.
        let stylua = |args: &[String]| {
            let diff: String = args.iter().filter(|a| a.starts_with("messy")).map(|a| format!("Diff in {a}:\n-x\n+y\n")).collect();
            match args.iter().find(|a| a.starts_with("bad")) {
                Some(bad) => ProcessResult { code: 2, stdout: diff, stderr: format!("error: could not format file {bad}: error parsing"), ..Default::default() },
                None => ProcessResult { code: i32::from(!diff.is_empty()), stdout: diff, ..Default::default() },
            }
        };
        let out = Stylua.check(&on_disk(&["messy1.lua", "bad1.lua", "ok.lua", "messy2.lua", "bad2.lua"], stylua).1).await;
        assert_eq!((out.files_checked, out.changed_files.clone(), out.error.clone()), (Some(3), vec!["messy1.lua".to_owned(), "messy2.lua".to_owned()], None));
        assert_eq!(names(&out.unprocessed), ["bad1.lua", "bad2.lua"]);
        assert!(out.unprocessed[0].1.contains("could not format file bad1.lua"));
    }

    #[tokio::test]
    async fn an_engine_that_fails_alike_on_separate_files_is_a_failed_engine_not_a_list_of_bad_files() {
        let air = |_: &[String]| ProcessResult { code: 255, stderr: "ERROR Failed to load configuration air.toml".into(), ..Default::default() };
        let out = Air.check(&request(&["a.R", "b.R", "c.R", "d.R"], air)).await;
        assert!(out.error.as_deref().is_some_and(|e| e.contains("failed the same way on separate groups of files") && e.contains("air.toml")), "{:?}", out.error);
        assert_eq!((out.files_checked, out.unprocessed.len()), (Some(0), 0));
        let fixed = Air.fix(&request(&["a.R"], air)).await;
        assert_eq!(names(&fixed.unprocessed), ["a.R"], "one file alone cannot tell a bad file from a bad engine: the file is what is known to have failed");
    }

    #[tokio::test]
    async fn dprint_checks_only_the_files_its_plugins_match_and_reports_the_rest_as_ignored() {
        let dprint = |args: &[String]| {
            let matched: Vec<&String> = args.iter().filter(|a| a.ends_with(".json")).collect();
            if args[0] == "output-file-paths" {
                return if matched.is_empty() { ProcessResult { code: 14, stderr: "No files found to format with the specified plugins".into(), ..Default::default() } } else { ProcessResult { stdout: matched.iter().map(|f| format!("/r/{f}\n")).collect(), ..Default::default() } };
            }
            assert!(args.iter().all(|a| !a.ends_with(".md")), "an unmatched file is not passed to check: {args:?}");
            ProcessResult { code: 20, stdout: "from /r/a.json:\n1|-x\n".into(), stderr: "Found 1 not formatted file.".into(), ..Default::default() }
        };
        let out = Dprint.check(&request(&["a.json", "notes.md"], dprint)).await;
        assert_eq!((out.files_checked, out.changed_files.clone(), out.ignored.clone(), out.error.clone()), (Some(1), vec!["a.json".to_owned()], vec!["notes.md".to_owned()], None));
        let none = Dprint.check(&request(&["notes.md"], dprint)).await;
        assert_eq!((none.files_checked, none.ignored.clone(), none.error.clone()), (Some(0), vec!["notes.md".to_owned()], None));
    }

    #[tokio::test]
    async fn clang_format_that_refuses_its_configuration_is_not_a_clean_run() {
        let refused = |_: &[String]| ProcessResult { code: 1, stderr: "/r/.clang-format:2:1: error: unknown key 'Foo'\nError reading /r/.clang-format: Invalid argument".into(), ..Default::default() };
        // One file is enough to know: the error is positioned in a file clang-format was not given.
        let out = ClangFormat.check(&request(&["a.c"], refused)).await;
        assert_eq!((out.error.as_deref(), out.unprocessed.len()), (Some("clang-format could not run: /r/.clang-format:2:1: error: unknown key 'Foo'"), 0));
        let in_source = |_: &[String]| ProcessResult { code: 1, stderr: "/r/a.c:1:1: error: Invalid argument".into(), ..Default::default() };
        assert_eq!(names(&ClangFormat.check(&request(&["a.c"], in_source)).await.unprocessed), ["a.c"]);
        let missing = |_: &[String]| ProcessResult { code: 1, stderr: "a.c: no such file or directory".into(), ..Default::default() };
        assert_eq!(names(&ClangFormat.check(&request(&["a.c"], missing)).await.unprocessed), ["a.c"]);
    }

    #[test]
    fn dart_and_taplo_reports_name_the_files_to_rewrite_and_taplo_errors_are_not_findings() {
        assert_eq!(parse_dart_check("Changed lib/a.dart\nChanged ./-b.dart\nFormatted 3 files (2 changed) in 0.01 seconds.", cwd()).changed, ["lib/a.dart", "-b.dart"]);
        let log = " INFO taplo:format_files:collect_files: found files total=2 excluded=0 files=[\"/r/sub/a.toml\", \"/r/b.toml\"] cwd=\"/r\"\nERROR taplo:format_files: the file is not properly formatted path=\"/r/sub/a.toml\"\nERROR operation failed error=some files were not properly formatted";
        assert_eq!(parse_taplo_check(log, cwd()).unwrap().changed, ["sub/a.toml"]);
        assert_eq!(parse_taplo_check("error: invalid TOML\n  ┌─ /r/bad.toml:1:5", cwd()).unwrap_err(), "error: invalid TOML");
        assert_eq!(glob_literal("app/[id]/x*.toml"), "app/[[]id[]]/x[*].toml");
    }

    #[tokio::test]
    async fn dart_names_the_file_it_cannot_parse_and_keeps_the_findings_of_the_others() {
        let dart = |args: &[String]| {
            assert_eq!(args[0], "--output=none");
            let changed: String = args.iter().filter(|a| a.starts_with("messy")).map(|a| format!("Changed {a}\n")).collect();
            let code = if args.iter().any(|a| a.starts_with("bad")) { 65 } else { 0 };
            ProcessResult { code, stdout: changed, stderr: if code == 0 { String::new() } else { "Could not format because the source could not be parsed:".into() }, ..Default::default() }
        };
        let out = Dart.check(&request(&["messy.dart", "bad.dart", "ok.dart"], dart)).await;
        assert_eq!((out.files_checked, out.changed_files.clone(), names(&out.unprocessed), out.error.clone()), (Some(2), vec!["messy.dart".to_owned()], vec!["bad.dart"], None));
    }

    #[tokio::test]
    async fn taplo_is_told_how_each_file_ends_its_lines_and_gets_its_paths_as_literal_patterns() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("unix.toml"), "a=1\n").unwrap();
        std::fs::write(dir.path().join("win[1].toml"), "a=1\r\n").unwrap();
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (seen, root) = (calls.clone(), dir.path().to_string_lossy().replace('\\', "/"));
        let spawn = Fake(Box::new(move |args: &[String]| {
            seen.lock().unwrap().push(args.join(" "));
            let named = args.iter().filter(|a| a.ends_with(".toml")).map(|a| a.replace("[[]", "[").replace("[]]", "]"));
            ProcessResult { code: 1, stderr: named.map(|file| format!("ERROR taplo:format_files: the file is not properly formatted path=\"{root}/{file}\"\n")).collect(), ..Default::default() }
        }));
        let req = RunRequest::new(dir.path(), "taplo", vec!["unix.toml".to_owned(), "gone.toml".to_owned(), "win[1].toml".to_owned()], Arc::new(spawn), mixdog_rt::testing::tokens().durability_io);
        let out = Taplo.check(&req).await;
        assert_eq!(*calls.lock().unwrap(), ["fmt --check -o crlf=false unix.toml", "fmt --check -o crlf=true win[[]1[]].toml"]);
        assert_eq!((out.files_checked, out.changed_files, out.error), (Some(2), vec!["unix.toml".to_owned(), "win[1].toml".to_owned()], None));
        // taplo skips a path that is not there without a word; tidy, which could not read it, says so.
        assert_eq!(names(&out.unprocessed), ["gone.toml"]);
        assert!(out.unprocessed[0].1.starts_with("could not be read: "), "{:?}", out.unprocessed);
    }

    #[tokio::test]
    async fn a_writing_command_that_fails_is_not_run_again_over_the_files_it_may_have_written() {
        let calls = Arc::new(std::sync::Mutex::new(0));
        let seen = calls.clone();
        let (_dir, req) = on_disk(&["a.lua", "b.lua", "c.lua"], move |_| {
            *seen.lock().unwrap() += 1;
            ProcessResult { code: 2, stderr: "error: could not format file c.lua".into(), ..Default::default() }
        });
        let out = Stylua.fix(&req).await;
        assert_eq!((*calls.lock().unwrap(), out.files_checked, out.error.clone()), (1, Some(0), None));
        assert_eq!(names(&out.unprocessed), ["a.lua", "b.lua", "c.lua"]);
        assert!(out.unprocessed[0].1.contains("failed over the 3 files it was given") && out.unprocessed[0].1.contains("could not format file c.lua"), "{:?}", out.unprocessed);
        // What a writing command printed is not its result: a cut log does not undo a completed write.
        let (_dir, req) = on_disk(&["a.lua", "b.lua"], |_| ProcessResult { truncated: true, ..Default::default() });
        let out = Stylua.fix(&req).await;
        assert_eq!((out.files_checked, out.unprocessed.len(), out.error), (Some(2), 0, None));
    }

    #[tokio::test]
    async fn taplo_with_a_configuration_it_cannot_read_is_a_failed_engine_and_a_file_that_is_not_toml_is_unprocessed() {
        let refused = |_: &[String]| ProcessResult { stderr: " INFO taplo:format_files:load_config: found configuration file path=\"/r/.taplo.toml\"\n WARN taplo:format_files:load_config: invalid configuration file error=TOML parse error at line 1, column 13".into(), ..Default::default() };
        let out = Taplo.fix(&on_disk(&["a.toml"], refused).1).await;
        assert_eq!((out.files_checked, out.error.as_deref()), (Some(0), Some("taplo could not run: WARN taplo:format_files:load_config: invalid configuration file error=TOML parse error at line 1, column 13")));
        let broken = |args: &[String]| if args.iter().any(|a| a == "bad.toml") { ProcessResult { code: 1, stderr: " INFO taplo:format_files:collect_files: found files total=1\nerror: invalid TOML\n  ┌─ /r/bad.toml:1:5".into(), ..Default::default() } } else { ProcessResult::default() };
        let out = Taplo.check(&on_disk(&["ok.toml", "bad.toml"], broken).1).await;
        assert_eq!((out.files_checked, out.unprocessed.clone(), out.error.clone(), out.stderr_tail.as_str()), (Some(1), vec![("bad.toml".to_owned(), "exit 1: error: invalid TOML\n  ┌─ /r/bad.toml:1:5".to_owned())], None, ""));
    }

    #[tokio::test]
    async fn a_path_that_begins_with_a_dash_is_passed_as_a_path() {
        let (_dir, req) = on_disk(&["-x.lua", "dir/-y.lua"], |args| {
            assert_eq!(args, ["--respect-ignores", "--line-endings", "Unix", "./-x.lua", "dir/-y.lua"]);
            ProcessResult::default()
        });
        let out = Stylua.fix(&req).await;
        assert_eq!((out.files_checked, out.error), (Some(2), None));
    }
}
