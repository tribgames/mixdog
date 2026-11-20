//! Formatters run one file at a time: the file's text goes in on stdin and comes back formatted
//! on stdout, and tidy writes it. A file needs reformatting when what comes back differs from it,
//! in check and in fix alike, so a fix writes exactly what a check announced. The engine never
//! sees a path: a name with a leading dash, a glob character or letters outside the console's
//! code page is nothing to it, it cannot follow the file into others, and one file it cannot
//! format fails alone. It runs where every engine runs, in the request's directory, so the
//! arguments a project configured mean the same for every file; what it would have found from
//! the file's place (a name, a configuration) the engine's plan passes as arguments.
//!
//! The text is the file's without its byte order mark, and it comes back with the file's line
//! endings: formatting is about layout, and a formatter that ends every line its own way would
//! otherwise rewrite every line of a checkout that ends them the other way.
//!
//! Stdout must be the formatted text and nothing else: an engine that runs project code which
//! can print there (`mix format`) does not belong here.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use super::shared::*;
use crate::lane::on_lane;
use crate::tidy::process::map_limit;

const BOM: &[u8] = b"\xEF\xBB\xBF";

fn has_crlf(text: &[u8]) -> bool {
    text.windows(2).any(|pair| pair == b"\r\n")
}

/// `formatted` with the line endings of `source`, when the formatter changed them for the whole
/// text: every LF of a CR LF file, or every CR LF of a file that has none. Anything in between
/// (a CR LF the formatter kept inside a string of an LF file) is the formatter's answer as it is.
fn with_line_endings_of(source: &[u8], formatted: String) -> Vec<u8> {
    let all_crlf = || formatted.matches('\n').count() == formatted.matches("\r\n").count();
    if ends_lines_with_crlf(source) && !has_crlf(formatted.as_bytes()) {
        formatted.replace('\n', "\r\n").into_bytes()
    } else if !has_crlf(source) && has_crlf(formatted.as_bytes()) && all_crlf() {
        formatted.replace("\r\n", "\n").into_bytes()
    } else {
        formatted.into_bytes()
    }
}

/// The 1-based line where `formatted` first differs from `source`.
fn first_changed_line(source: &[u8], formatted: &[u8]) -> i64 {
    let same = source.iter().zip(formatted).take_while(|(a, b)| a == b).count();
    source[..same].iter().filter(|b| **b == b'\n').count() as i64 + 1
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn read_source(path: &Path) -> std::io::Result<Vec<u8>> {
    std::fs::read(path)
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn write_source(path: &Path, text: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, text)
}

/// The arguments, after the engine's configured ones, for the file at an index of the request's
/// files. `Err` leaves the file unprocessed for that reason.
pub type Plan<'a> = &'a (dyn Fn(usize) -> Result<Vec<String>, String> + Sync);

/// Whether the engine's configured arguments already give `flag` (`--flag value` or `--flag=value`).
pub fn configured(req: &RunRequest, flag: &str) -> bool {
    req.args.iter().any(|arg| arg.strip_prefix(flag).is_some_and(|rest| rest.is_empty() || rest.starts_with('=')))
}

enum One {
    /// The engine could not run at all.
    Stopped(String),
    /// Not run: an earlier file found that the engine cannot run.
    Skipped,
    /// The engine ran and could not format this file.
    Unprocessed(String),
    /// Formatted: the line where the formatted text first differs from the file, when it does,
    /// and what the engine said.
    Done(Option<i64>, String),
}

async fn one(req: &RunRequest, id: &str, index: usize, write: bool, plan: Plan<'_>) -> One {
    let lane = || One::Stopped(format!("{id} could not run: its lane did not do the file work"));
    let path = req.cwd.join(&req.files[index]);
    let source = match on_lane(req.lane, {
        let path = path.clone();
        move || read_source(&path)
    })
    .await
    {
        Ok(Ok(source)) => source,
        Ok(Err(e)) => return One::Unprocessed(format!("could not be read: {e}")),
        Err(_) => return lane(),
    };
    // The byte order mark is the file's, not the text's: formatters choke on it or drop it.
    let (mark, text) = match source.strip_prefix(BOM) {
        Some(text) => (BOM, text),
        None => (&[][..], &source[..]),
    };
    if text.is_empty() {
        return One::Done(None, String::new());
    }
    // What comes back is read as UTF-8: text in another encoding would not survive the trip.
    if std::str::from_utf8(text).is_err() {
        return One::Unprocessed("is not UTF-8 text".to_owned());
    }
    let for_file = match plan(index) {
        Ok(args) => args,
        Err(why) => return One::Unprocessed(why),
    };
    let args: Vec<String> = req.args.iter().cloned().chain(for_file).collect();
    let r = req.spawn.run(&req.bin, &args, &req.cwd, req.timeout, req.cancel.as_ref(), None, Some(text.to_vec())).await;
    if let Some(why) = stopped(req, id, &r) {
        return One::Stopped(why);
    }
    if r.truncated {
        return One::Unprocessed(format!("{id} printed more than tidy captures"));
    }
    if r.code != 0 {
        return One::Unprocessed(said(&r));
    }
    let formatted = with_line_endings_of(text, r.stdout);
    if formatted == text {
        return One::Done(None, r.stderr);
    }
    let line = first_changed_line(text, &formatted);
    if write {
        let whole = [mark, &formatted[..]].concat();
        match on_lane(req.lane, move || write_source(&path, &whole)).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return One::Unprocessed(format!("could not be written: {e}")),
            Err(_) => return lane(),
        }
    }
    One::Done(Some(line), r.stderr)
}

/// Runs `id` over each of `req.files` through stdin; `write` puts the formatted text back.
pub async fn format_each(req: &RunRequest, id: &str, write: bool, plan: Plan<'_>) -> RunnerResult {
    let halted = AtomicBool::new(false);
    // One short-lived process per file: as many at once as the machine has threads.
    let at_once = std::thread::available_parallelism().map_or(1, usize::from);
    let outcomes = map_limit((0..req.files.len()).collect(), at_once, |index| {
        let halted = &halted;
        async move {
            if halted.load(Ordering::Relaxed) {
                return One::Skipped;
            }
            let outcome = one(req, id, index, write, plan).await;
            if matches!(outcome, One::Stopped(_)) {
                halted.store(true, Ordering::Relaxed);
            }
            outcome
        }
    })
    .await;
    let mut result = RunnerResult::default();
    let mut checked = 0;
    for (file, outcome) in req.files.iter().zip(outcomes) {
        match outcome {
            One::Stopped(why) => result.error = result.error.or(Some(why)),
            One::Skipped => {}
            One::Unprocessed(reason) => result.unprocessed.push((file.clone(), reason)),
            One::Done(changed_at, stderr) => {
                checked += 1;
                // A fix reports nothing as still to do: it has written the file.
                if let Some(line) = changed_at.filter(|_| !write) {
                    result.changed_files.push(file.clone());
                    result.diagnostics.push(diagnostic(DiagnosticInit {
                        file,
                        line,
                        code: id,
                        message: &format!("{id} would reformat this file (its first change is on this line)"),
                        severity: "warning",
                        fixable: true,
                        ..Default::default()
                    }));
                }
                // An engine repeats a configuration warning for every file.
                if result.stderr_tail.is_empty() {
                    result.stderr_tail = tail600(&stderr);
                }
            }
        }
    }
    result.files_checked = Some(checked);
    result
}

#[cfg(test)]
pub(super) mod tests {
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;
    use tokio_util::sync::CancellationToken;

    use super::*;
    use crate::tidy::process::ProcessResult;

    /// A spawn: its arguments, where it ran, and the text it was given.
    pub type Spawned = (Vec<String>, PathBuf, String);

    /// Answers each spawn from its arguments and stdin, and records it.
    pub struct Fake(pub Mutex<Vec<Spawned>>, Box<dyn Fn(&[String], &str) -> ProcessResult + Send + Sync>);

    #[async_trait]
    impl Spawn for Fake {
        async fn run(
            &self,
            _: &str,
            args: &[String],
            cwd: &Path,
            _: std::time::Duration,
            _: Option<&CancellationToken>,
            _: Option<&HashMap<String, String>>,
            input: Option<Vec<u8>>,
        ) -> ProcessResult {
            let source = String::from_utf8(input.unwrap_or_default()).unwrap();
            self.0.lock().unwrap().push((args.to_vec(), cwd.to_owned(), source.clone()));
            (self.1)(args, &source)
        }
    }

    /// A tree of `files` (path, text) and an engine that answers through `reply`, asked about `sources`.
    pub fn project(
        files: &[(&str, &str)],
        sources: &[&str],
        reply: impl Fn(&[String], &str) -> ProcessResult + Send + Sync + 'static,
    ) -> (tempfile::TempDir, Arc<Fake>, RunRequest) {
        let dir = tempfile::tempdir().unwrap();
        for (path, text) in files {
            let full = dir.path().join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, text).unwrap();
        }
        let spawn = Arc::new(Fake(Mutex::default(), Box::new(reply)));
        let req =
            RunRequest::new(dir.path(), "engine", sources.iter().map(|f| (*f).to_owned()).collect(), spawn.clone(), mixdog_rt::testing::tokens().durability_io);
        (dir, spawn, req)
    }

    /// An engine that finds every file formatted: it prints back what it read.
    pub fn clean(_: &[String], source: &str) -> ProcessResult {
        ProcessResult { stdout: source.to_owned(), ..Default::default() }
    }

    fn no_args(_: usize) -> Result<Vec<String>, String> {
        Ok(vec!["-".to_owned()])
    }

    #[test]
    fn the_first_line_ending_decides_the_style_and_the_first_difference_gives_the_line() {
        assert!(
            ends_lines_with_crlf(b"a\r\nb\n") && !ends_lines_with_crlf(b"a\nb\r\n") && !ends_lines_with_crlf(b"no newline") && !ends_lines_with_crlf(b"\n")
        );
        assert_eq!((first_changed_line(b"a\nb\nc", b"a\nb\nd"), first_changed_line(b"x", b"y"), first_changed_line(b"a\n", b"a\n\n")), (3, 1, 2));
    }

    #[tokio::test]
    async fn a_formatter_that_ends_lines_with_lf_does_not_rewrite_the_line_endings_of_a_crlf_file() {
        // The engine answers LF whatever it reads, as zig fmt and mix format do.
        let reply = |_: &[String], source: &str| ProcessResult { stdout: source.replace("\r\n", "\n").replace("x=1", "x = 1"), ..Default::default() };
        let (dir, _spawn, req) =
            project(&[("tidy.zig", "a\r\nb\r\n"), ("messy.zig", "a\r\nx=1\r\n"), ("unix.zig", "x=1\n")], &["tidy.zig", "messy.zig", "unix.zig"], reply);
        let checked = format_each(&req, "fmt", false, &no_args).await;
        assert_eq!(
            (checked.changed_files.clone(), checked.diagnostics.iter().map(|d| d.line).collect::<Vec<_>>()),
            (vec!["messy.zig".to_owned(), "unix.zig".to_owned()], vec![2, 1])
        );
        format_each(&req, "fmt", true, &no_args).await;
        let text = |name: &str| std::fs::read_to_string(dir.path().join(name)).unwrap();
        assert_eq!((text("tidy.zig"), text("messy.zig"), text("unix.zig")), ("a\r\nb\r\n".to_owned(), "a\r\nx = 1\r\n".to_owned(), "x = 1\n".to_owned()));
    }

    #[tokio::test]
    async fn a_formatter_that_ends_lines_with_crlf_does_not_rewrite_an_lf_file_and_a_kept_crlf_is_not_touched() {
        // The engine ends every line with CR LF, as rustfmt does under `newline_style = "Windows"`,
        // except for the text it is told to keep as it is.
        let reply = |_: &[String], source: &str| ProcessResult {
            stdout: if source.contains("keep") { source.replace("x=1", "x = 1") } else { source.replace('\n', "\r\n") },
            ..Default::default()
        };
        let (dir, _spawn, req) = project(&[("unix.rs", "a\nb\n"), ("mixed.rs", "a\n\"keep\r\n\"\nx=1\n")], &["unix.rs", "mixed.rs"], reply);
        let checked = format_each(&req, "fmt", false, &no_args).await;
        assert_eq!((checked.files_checked, checked.changed_files), (Some(2), vec!["mixed.rs".to_owned()]));
        format_each(&req, "fmt", true, &no_args).await;
        let text = |name: &str| std::fs::read_to_string(dir.path().join(name)).unwrap();
        assert_eq!((text("unix.rs"), text("mixed.rs")), ("a\nb\n".to_owned(), "a\n\"keep\r\n\"\nx = 1\n".to_owned()));
    }

    #[tokio::test]
    async fn text_that_is_not_utf8_is_left_alone_and_the_engine_runs_in_the_requests_directory() {
        let (dir, spawn, req) = project(&[("deep/a.ex", "a")], &["deep/a.ex", "latin.ex"], clean);
        std::fs::write(dir.path().join("latin.ex"), b"caf\xE9\n").unwrap();
        let out = format_each(&req, "fmt", true, &no_args).await;
        assert_eq!((out.files_checked, out.unprocessed.clone()), (Some(1), vec![("latin.ex".to_owned(), "is not UTF-8 text".to_owned())]));
        assert_eq!(std::fs::read(dir.path().join("latin.ex")).unwrap(), b"caf\xE9\n");
        assert_eq!(spawn.0.lock().unwrap().iter().map(|c| c.1.clone()).collect::<Vec<_>>(), [dir.path().to_owned()]);
    }

    #[test]
    fn a_configured_flag_is_seen_in_either_spelling() {
        let (_dir, _spawn, mut req) = project(&[], &[], clean);
        req.args = vec!["--edition=2021".to_owned(), "--config-path".to_owned(), "x".to_owned(), "--emitter".to_owned()];
        assert!(configured(&req, "--edition") && configured(&req, "--config-path") && !configured(&req, "--emit") && !configured(&req, "--check"));
    }

    #[tokio::test]
    async fn a_file_the_engine_cannot_format_is_unprocessed_and_the_others_keep_their_findings() {
        let reply = |_: &[String], source: &str| match source {
            "broken" => ProcessResult { code: 1, stderr: "error: this file contains an unclosed delimiter\n --> <stdin>:1:11".into(), ..Default::default() },
            "fn a() {}\nfn  messy(){}\n" => ProcessResult { stdout: "fn a() {}\nfn messy() {}\n".into(), ..Default::default() },
            fine => ProcessResult { stdout: fine.to_owned(), ..Default::default() },
        };
        let (dir, spawn, req) = project(
            &[("src/a.rs", "fn a() {}\nfn  messy(){}\n"), ("src/b.rs", "broken"), ("c.rs", "fine"), ("empty.rs", "")],
            &["src/a.rs", "src/b.rs", "c.rs", "gone.rs", "empty.rs"],
            reply,
        );
        let out = format_each(&req, "fmt", false, &no_args).await;
        assert_eq!((out.files_checked, out.changed_files.clone(), out.error.clone()), (Some(3), vec!["src/a.rs".to_owned()], None));
        assert_eq!(out.diagnostics.iter().map(|d| (d.file.as_str(), d.line, d.fixable, d.code.as_str())).collect::<Vec<_>>(), [("src/a.rs", 2, true, "fmt")]);
        assert_eq!(out.unprocessed.iter().map(|(f, _)| f.as_str()).collect::<Vec<_>>(), ["src/b.rs", "gone.rs"]);
        assert!(out.unprocessed[0].1.contains("unclosed delimiter") && out.unprocessed[1].1.contains("could not be read"));
        let calls = spawn.0.lock().unwrap();
        assert_eq!(calls.len(), 3, "an empty file has nothing to format");
        assert_eq!(std::fs::read_to_string(dir.path().join("src/a.rs")).unwrap(), "fn a() {}\nfn  messy(){}\n", "a check writes nothing");
    }

    #[tokio::test]
    async fn fix_writes_what_the_engine_printed_to_the_files_it_formatted_and_keeps_the_byte_order_mark() {
        let reply = |_: &[String], source: &str| match source {
            "broken" => ProcessResult { code: 1, stderr: "error: expected item".into(), ..Default::default() },
            "tidy\n" => ProcessResult { stdout: "tidy\n".into(), ..Default::default() },
            other => ProcessResult { stdout: format!("formatted {other}"), ..Default::default() },
        };
        let tree = [("clean.rs", "tidy\n"), ("a.rs", "messy"), ("b.rs", "broken"), ("marked.rs", "\u{feff}messy")];
        let (dir, spawn, req) = project(&tree, &["clean.rs", "a.rs", "b.rs", "marked.rs"], reply);
        let out = format_each(&req, "fmt", true, &no_args).await;
        assert_eq!((out.files_checked, out.unprocessed.len(), out.error.clone(), out.diagnostics.len()), (Some(3), 1, None, 0));
        let text = |name: &str| std::fs::read_to_string(dir.path().join(name)).unwrap();
        assert_eq!(
            (text("a.rs"), text("b.rs"), text("clean.rs"), text("marked.rs")),
            ("formatted messy".to_owned(), "broken".to_owned(), "tidy\n".to_owned(), "\u{feff}formatted messy".to_owned())
        );
        assert!(spawn.0.lock().unwrap().iter().all(|c| !c.2.starts_with('\u{feff}')), "the engine is given the text without the mark");
    }

    #[tokio::test]
    async fn an_engine_that_cannot_run_or_is_cancelled_is_a_failure_not_a_clean_run() {
        let (_dir, _spawn, req) = project(&[("a.rs", "a"), ("b.rs", "b")], &["a.rs", "b.rs"], |_, _| ProcessResult {
            code: -1,
            error: "fmt: program not found".into(),
            ..Default::default()
        });
        let missing = format_each(&req, "fmt", false, &no_args).await;
        assert_eq!((missing.files_checked, missing.error.as_deref()), (Some(0), Some("fmt could not run: fmt: program not found")));
        let (_dir, _spawn, mut req) = project(&[("a.rs", "a")], &["a.rs"], |_, _| ProcessResult { code: -1, ..Default::default() });
        let cancel = CancellationToken::new();
        cancel.cancel();
        req.cancel = Some(cancel);
        let cancelled = format_each(&req, "fmt", true, &no_args).await;
        assert_eq!((cancelled.files_checked, cancelled.error.as_deref()), (Some(0), Some("fmt was cancelled")));
    }
}
