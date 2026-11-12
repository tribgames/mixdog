//! Replay of `native/core/fixtures/memory-core-management` (core-memory-management.test.mjs) through
//! `memory::core::list::{list, format}` (Node's `listManagedMemories` / `formatManagedMemories`) and
//! `memory::core::action::run` (Node's `handleMemoryAction({action:"core", op:"list"})`).
//!
//! Mappings:
//! - The recording's database is the test file's SQLite stand-in; here a private PostgreSQL cluster holds the recorded
//!   `table` as `core_entries` rows. Two stand-in shapes are mapped, not filtered: SQLite answers the boolean column
//!   `injection_enabled` as `1`/`0` where PostgreSQL (and so Node in production and the core) answers `true`/`false`, and
//!   the stand-in's `db.query(sql, args = [])` writes a statement sent without parameters as `params: []`. The core's
//!   booleans are written as 1/0 at `injection_enabled` (structured entries and the JSON text) and its parameterless
//!   statements as `[]`.
//! - Statements are observed under cfg(test) at `memory::core::index::observe` (index sync and the list select);
//!   `indexReads` is the number of `pg_advisory_xact_lock` statements of the step, as the stand-in counted them.
//! - `roundTrip`: the core's formatted text is parsed by the reader of that text, the TUI's `parseMemoryCoreRows`
//!   (`src/tui/app/input-parsers.mjs:50`, unchanged since b6f10295a), run by Node in a child process; the parsed rows,
//!   the recorder's per-entry checks against the core's listed entries and both counts are compared whole.
//! - `handleMemoryAction` answers `{text, isError?, entries, nextOffset, projectScopes}`; the core's `ToolReply` is the
//!   same reply before the dispatch layer adds `content` (and `isError: false`): text, `isError` when set, its fields.
//! - The temp project root is `<root>` in the recording; the replay makes its own folders with the recorded ids and
//!   writes its root as `<root>` (raw, JSON-escaped, forward slashes), as the recorder did.
//! - UUIDs the product generates are labelled `<uuid-N>` by first appearance, as the recorder labels them.

use mixdog_testkit::Exact;

use super::{assert_case_count, golden, string};

const SET: &str = "memory-core-management";

#[test]
fn every_recorded_case_has_a_replay() {
    assert_case_count(&golden(SET), 1);
}

pub(in crate::memory::replays) mod pg {
    use super::*;
    use crate::memory::core::action::{CoreContext, run};
    use crate::memory::core::list::{ListOptions, format, list};
    use crate::memory::replays::pg::memory_db;
    use crate::memory::replays::{case, int, object, same};

    const DEADLINE: std::time::Duration = std::time::Duration::from_secs(60);

    /// `<uuid-N>` labelling, as `core_file` does it.
    pub(in crate::memory::replays) fn label_uuids(value: &mut Exact, seen: &mut Vec<String>) {
        let pattern =
            regex::Regex::new(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").expect("uuid pattern");
        match value {
            Exact::String(text) => {
                *text = pattern
                    .replace_all(text, |m: &regex::Captures<'_>| {
                        let uuid = m[0].to_owned();
                        let at = seen.iter().position(|s| *s == uuid).unwrap_or_else(|| {
                            seen.push(uuid);
                            seen.len() - 1
                        });
                        format!("<uuid-{}>", at + 1)
                    })
                    .into_owned();
            }
            Exact::Array(items) => items.iter_mut().for_each(|item| label_uuids(item, seen)),
            Exact::Object(entries) => entries.iter_mut().for_each(|(_, item)| label_uuids(item, seen)),
            Exact::Map(entries) => entries.iter_mut().for_each(|(key, item)| {
                label_uuids(key, seen);
                label_uuids(item, seen);
            }),
            _ => {}
        }
    }

    /// The recorder's `<root>` forms: JSON-escaped first (it contains the raw form's characters), then raw, then slashes.
    fn scrub(value: &mut Exact, root: &str) {
        let forms = [root.replace('\\', "\\\\"), root.to_owned(), root.replace('\\', "/")];
        match value {
            Exact::String(text) => {
                for form in &forms {
                    *text = text.replace(form.as_str(), "<root>");
                }
            }
            Exact::Array(items) => items.iter_mut().for_each(|item| scrub(item, root)),
            Exact::Object(entries) => entries.iter_mut().for_each(|(_, item)| scrub(item, root)),
            _ => {}
        }
    }

    /// The replay's own root in place of `<root>` in recorded arguments.
    fn unscrub(value: &serde_json::Value, root: &str) -> serde_json::Value {
        match value {
            serde_json::Value::String(text) => serde_json::Value::String(text.replace("<root>", root)),
            serde_json::Value::Array(items) => items.iter().map(|item| unscrub(item, root)).collect(),
            serde_json::Value::Object(entries) => {
                entries.iter().map(|(key, item)| (key.clone(), unscrub(item, root))).collect()
            }
            other => other.clone(),
        }
    }

    /// The stand-in's integer booleans at `injection_enabled` (see the header).
    pub(in crate::memory::replays) fn stand_in(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::Object(entries) => {
                for (key, item) in entries.iter_mut() {
                    if key == "injection_enabled" {
                        if let serde_json::Value::Bool(flag) = item {
                            *item = serde_json::Value::from(i64::from(*flag));
                        }
                    } else {
                        stand_in(item);
                    }
                }
            }
            serde_json::Value::Array(items) => items.iter_mut().for_each(stand_in),
            _ => {}
        }
    }

    pub(in crate::memory::replays) fn plain(json: &str) -> Exact {
        let mut value: serde_json::Value = serde_json::from_str(json).expect("reply field JSON");
        stand_in(&mut value);
        Exact::plain(&value)
    }

    /// The statements of the step and its `pg_advisory_xact_lock` count.
    pub(in crate::memory::replays) fn statements() -> (Exact, i64) {
        let log = crate::memory::core::index::STATEMENTS
            .with(|log| log.borrow_mut().replace(Vec::new()))
            .unwrap_or_default();
        let reads = log.iter().filter(|(sql, ..)| sql.contains("pg_advisory_xact_lock")).count() as i64;
        let list = log
            .into_iter()
            .map(|(sql, params, _)| {
                object(vec![
                    ("sql", string(sql)),
                    ("params", Exact::plain(&serde_json::Value::Array(params.unwrap_or_default()))),
                ])
            })
            .collect();
        (Exact::Array(list), reads)
    }

    pub(in crate::memory::replays) fn page_value(page: &crate::memory::core::list::Page) -> Exact {
        let mut entries = serde_json::to_value(&page.entries).expect("entries JSON");
        stand_in(&mut entries);
        let mut fields = vec![
            ("entries", Exact::plain(&entries)),
            ("nextOffset", page.next_offset.map_or(Exact::Null, int)),
        ];
        if let Some(scopes) = &page.project_scopes {
            fields.push(("projectScopes", Exact::plain(&serde_json::to_value(scopes).expect("scopes JSON"))));
        }
        object(fields)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn standing_memory_lists_curated_records_by_scope_page_and_activity() {
        let g = golden(SET);
        let name = "standing memory lists curated records by scope, page and activity (test line 11; the steps after the first eight are further shapes)";
        let c = case(&g, 0, name);
        let now = g.get("clock").get("dateNowMs").as_f64() as i64;
        let pg = memory_db().await;
        for row in g.get("table").as_array() {
            let text = |key: &str| match row.get(key) {
                Exact::String(s) => Some(s.clone()),
                Exact::Null => None,
                other => panic!("table {key}: {other:?}"),
            };
            let id = row.get("id").as_f64() as i64;
            pg.db
                .execute(
                    "INSERT INTO core_entries (id, element, summary, category, project_id, status, created_at, updated_at)
                     VALUES ($1, $2, $3, 'rule', $4, $5, $6, $6)",
                    &[&id, &text("element"), &text("summary"), &text("project_id"), &text("status"), &now],
                )
                .await
                .unwrap_or_else(|e| panic!("insert core row {id}: {}", e.message()));
        }
        let dir = tempfile::tempdir().expect("project root");
        let root = dir.path().to_string_lossy().into_owned();
        for folder in g.get("projectFolders").as_array() {
            let marker = dir.path().join(folder.get("folder").as_str()).join(".mixdog");
            std::fs::create_dir_all(&marker).expect("project folder");
            std::fs::write(marker.join("project.id"), folder.get("projectId").as_str()).expect("project.id");
        }
        let data_dir = tempfile::tempdir().expect("data dir");
        let revision = std::sync::atomic::AtomicU64::new(0);
        let ctx = CoreContext {
            db: &pg.db,
            data_dir: data_dir.path(),
            session_cwd: None,
            snapshot_revision: &revision,
            lane: mixdog_rt::testing::tokens().durability_io,
        };
        let mut actual = Vec::new();
        for step in c.get("steps").as_array() {
            let label = step.get("label").as_str();
            let args = unscrub(&step.get("args").to_plain().expect("args JSON"), &root);
            crate::memory::core::index::STATEMENTS.with(|log| *log.borrow_mut() = Some(Vec::new()));
            let mut fields = vec![("label", string(label)), ("args", step.get("args").clone())];
            if args.get("action").is_some() {
                let reply = tokio::time::timeout(DEADLINE, run(&ctx, &args))
                    .await
                    .unwrap_or_else(|_| panic!("{name}: {label}: did not settle within {DEADLINE:?}"));
                let mut result = vec![("text", string(reply.text.replace("\"injection_enabled\":true", "\"injection_enabled\":1")))];
                if reply.is_error {
                    result.push(("isError", Exact::Bool(true)));
                }
                for (key, json) in &reply.fields {
                    result.push((key, plain(json)));
                }
                fields.push(("result", object(result)));
            } else {
                assert!(args["options"].get("agent_id").is_none(), "{name}: {label}: the recording passes no agent_id");
                let options = ListOptions {
                    scope: args["scope"].as_str(),
                    agent_id: None,
                    args: &args["options"],
                    project_scopes: None,
                };
                let outcome = tokio::time::timeout(DEADLINE, list(&pg.db, options))
                    .await
                    .unwrap_or_else(|_| panic!("{name}: {label}: did not settle within {DEADLINE:?}"));
                match outcome {
                    Ok(page) => {
                        let text = format(&page);
                        fields.push(("result", page_value(&page)));
                        fields.push(("formatted", string(text.clone())));
                        fields.push(("roundTrip", round_trip(&format!("{name}: {label}"), &text, &page)));
                    }
                    Err(error) => fields.push((
                        "error",
                        Exact::Error {
                            name: "Error".into(),
                            message: error.message().to_owned(),
                            code: None,
                            cause: None,
                            props: Vec::new(),
                        },
                    )),
                }
            }
            let (statements, reads) = statements();
            fields.push(("indexReads", int(reads)));
            fields.push(("statements", statements));
            let mut value = object(fields);
            scrub(&mut value, &root);
            actual.push(value);
        }
        crate::memory::core::index::STATEMENTS.with(|log| *log.borrow_mut() = None);
        let mut actual = Exact::Array(actual);
        label_uuids(&mut actual, &mut Vec::new());
        same(name, c.get("steps"), &actual);
    }

    /// The TUI parser's process until it has answered: dropped before that, it kills the tree and waits for the reaping.
    struct KillOnDrop {
        pid: u32,
        waited: std::sync::mpsc::Receiver<std::io::Result<std::process::Output>>,
        answered: std::cell::Cell<bool>,
        /// The command that ends the process tree of a pid.
        kill: fn(u32) -> std::process::Command,
        /// How long the kill command may run.
        kill_deadline: std::time::Duration,
        /// How long the guard waits for the waiting thread to report the parser reaped once its tree is killed.
        reap_deadline: std::time::Duration,
    }

    /// A thread that waits for `child` and sends how it ended.
    fn reap(mut child: std::process::Child) -> std::sync::mpsc::Receiver<std::io::Result<std::process::ExitStatus>> {
        let (done, finished) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = done.send(child.wait());
        });
        finished
    }

    fn kill_tree_command(pid: u32) -> std::process::Command {
        let mut kill = if cfg!(windows) {
            let mut kill = std::process::Command::new("taskkill");
            kill.args(["/PID", &pid.to_string(), "/T", "/F"]);
            kill
        } else {
            let mut kill = std::process::Command::new("kill");
            kill.args(["-KILL", &pid.to_string()]);
            kill
        };
        #[cfg(windows)]
        std::os::windows::process::CommandExt::creation_flags(&mut kill, 0x0800_0000);
        kill
    }

    impl KillOnDrop {
        fn new(pid: u32, waited: std::sync::mpsc::Receiver<std::io::Result<std::process::Output>>) -> Self {
            Self {
                pid,
                waited,
                answered: std::cell::Cell::new(false),
                kill: kill_tree_command,
                kill_deadline: std::time::Duration::from_secs(10),
                reap_deadline: std::time::Duration::from_secs(10),
            }
        }

        /// Runs the kill command and waits for it for at most `kill_deadline`. What is waited on is a real OS process (`taskkill` / `kill`,
        /// `Child::wait` below), so the deadline is real time, not the virtual clock. When it is overrun the stuck command is killed
        /// by a second command and the guard waits for both to end; the error names each one that did not.
        fn kill_tree(&self) -> Result<(), String> {
            let quiet = |command: &mut std::process::Command| {
                command.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn()
            };
            let kill = quiet(&mut (self.kill)(self.pid))
                .map_err(|e| format!("the command that ends the TUI parser's process tree (pid {}) did not start: {e}", self.pid))?;
            let kill_pid = kill.id();
            let finished = reap(kill);
            if finished.recv_timeout(self.kill_deadline).is_ok() {
                return Ok(());
            }
            let fallback = match quiet(&mut kill_tree_command(kill_pid)) {
                Err(e) => format!("the fallback command (on pid {kill_pid}) did not start: {e}"),
                Ok(fallback) => match reap(fallback).recv_timeout(self.kill_deadline) {
                    Ok(_) => "the fallback command ended".to_owned(),
                    Err(_) => format!("the fallback command (on pid {kill_pid}) did not finish within {:?}", self.kill_deadline),
                },
            };
            let stuck = if finished.recv_timeout(self.kill_deadline).is_ok() {
                "the stuck command was ended".to_owned()
            } else {
                format!("the stuck command (pid {kill_pid}) is still running")
            };
            Err(format!(
                "the command that ends the TUI parser's process tree (pid {}) did not finish within {:?}; {fallback}; {stuck}",
                self.pid, self.kill_deadline
            ))
        }

        /// Ends the parser's tree and returns once the parser is reaped and the kill commands have ended; the error names what did not.
        fn finish(&self) -> Result<(), String> {
            let killed = self.kill_tree();
            let reaped = match self.waited.recv_timeout(self.reap_deadline) {
                Ok(_) => Ok(()),
                Err(_) => Err(format!("the TUI parser (pid {}) was not reaped within {:?}", self.pid, self.reap_deadline)),
            };
            match (killed, reaped) {
                (Ok(()), Ok(())) => Ok(()),
                (Err(a), Ok(())) | (Ok(()), Err(a)) => Err(a),
                (Err(a), Err(b)) => Err(format!("{a}; {b}")),
            }
        }
    }

    impl Drop for KillOnDrop {
        fn drop(&mut self) {
            if self.answered.get() {
                return;
            }
            if let Err(message) = self.finish() {
                // A second panic while unwinding would abort the test binary.
                if std::thread::panicking() {
                    eprintln!("{message}");
                } else {
                    panic!("{message}");
                }
            }
        }
    }

    /// `parseMemoryCoreRows(formatted)` of the shipped TUI (`src/tui/app/input-parsers.mjs:50`, the reader of this text),
    /// run by Node over the core's formatted text and encoded with the recordings' encoder.
    /// The child is killed (with its tree) and reaped on every exit path: a write failure, the deadline, or a failure.
    pub(in crate::memory::replays) fn parse_rows(what: &str, formatted: &str) -> Exact {
        use std::io::Write;
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..").canonicalize().expect("repository root");
        let url = |relative: &str| {
            let path = repo.join(relative).to_string_lossy().replace('\\', "/");
            // `canonicalize` answers a verbatim path (`\\?\C:\…`) on Windows.
            format!("file:///{}", path.trim_start_matches("//?/").trim_start_matches('/'))
        };
        let script = format!(
            "import {{ parseMemoryCoreRows }} from '{}'; import {{ exact }} from '{}';\n\
             let text = ''; process.stdin.setEncoding('utf8'); for await (const chunk of process.stdin) text += chunk;\n\
             process.stdout.write(JSON.stringify(exact(parseMemoryCoreRows(text))));",
            url("src/tui/app/input-parsers.mjs"),
            url("benchmarks/rust-core/recorders/lib/exact.mjs"),
        );
        let mut command = std::process::Command::new("node");
        command
            .args(["--input-type=module", "-e", &script])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000); // CREATE_NO_WINDOW
        let mut child = command.spawn().unwrap_or_else(|e| panic!("{what}: node runs the TUI parser: {e}"));
        let pid = child.id();
        let mut stdin = child.stdin.take().expect("stdin");
        let (done, waited) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = done.send(child.wait_with_output());
        });
        // From here every way out of this function but the parser's own answer (a panic included, here or in the waiting thread)
        // ends the parser's process tree and waits for the waiting thread to reap it.
        let parser = KillOnDrop::new(pid, waited);
        if let Err(e) = stdin.write_all(formatted.as_bytes()) {
            panic!("{what}: writing the formatted text to the TUI parser failed: {e}");
        }
        drop(stdin);
        let output = match parser.waited.recv_timeout(std::time::Duration::from_secs(60)) {
            Ok(Ok(output)) => {
                parser.answered.set(true);
                output
            }
            Ok(Err(e)) => panic!("{what}: the TUI parser's output could not be read: {e}"),
            Err(_) => panic!("{what}: the TUI parser did not answer within 60 s"),
        };
        assert!(output.status.success(), "{what}: the TUI parser failed: {}", String::from_utf8_lossy(&output.stderr));
        let value: serde_json::Value = serde_json::from_slice(&output.stdout).expect("the parser's JSON");
        Exact::decode(&value).expect("the parser's encoded rows")
    }

    /// A panic while the parser runs ends its process tree and waits until it is reaped.
    #[test]
    fn a_panic_while_the_parser_runs_kills_and_reaps_it() {
        let mut command = std::process::Command::new("node");
        command.args(["-e", "setInterval(() => {}, 1000)"]).stdin(std::process::Stdio::null());
        #[cfg(windows)]
        std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000); // CREATE_NO_WINDOW
        let child = command.spawn().expect("node runs");
        let pid = child.id();
        let reaped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (done, waited) = std::sync::mpsc::channel();
        let flag = reaped.clone();
        std::thread::spawn(move || {
            let output = child.wait_with_output();
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
            let _ = done.send(output);
        });
        let unwound = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _parser = KillOnDrop::new(pid, waited);
            panic!("the parser's output could not be read");
        }));
        assert!(unwound.is_err());
        assert!(reaped.load(std::sync::atomic::Ordering::SeqCst), "the guard returned before the parser (pid {pid}) was reaped");
    }

    /// A kill command that does not finish does not hold the guard: the wait for it ends at its deadline with a message naming it.
    #[test]
    fn a_kill_command_that_does_not_finish_is_given_up_on_at_its_deadline() {
        fn slow_kill(_pid: u32) -> std::process::Command {
            // Ends by itself after 5 s, so no process outlives the test for long.
            let mut command = std::process::Command::new("node");
            command.args(["-e", "setTimeout(() => {}, 5000)"]);
            #[cfg(windows)]
            std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000); // CREATE_NO_WINDOW
            command
        }
        let (_done, waited) = std::sync::mpsc::channel();
        let mut guard = KillOnDrop::new(0, waited);
        guard.kill = slow_kill;
        guard.kill_deadline = std::time::Duration::from_millis(300);
        let message = guard.kill_tree().expect_err("the kill command runs for 5 s, past the 300 ms deadline");
        assert!(message.contains("did not finish within"), "{message}");
        assert!(message.contains("the fallback command ended") && message.contains("the stuck command was ended"), "{message}");
        guard.answered.set(true);
    }

    /// A parser the waiting thread never reports reaped fails the guard with a message naming it, instead of returning as if it had ended.
    #[test]
    fn a_parser_that_is_not_reaped_fails_the_guard_naming_it() {
        fn quick_kill(_pid: u32) -> std::process::Command {
            let mut command = std::process::Command::new("node");
            command.args(["-e", ""]);
            #[cfg(windows)]
            std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000); // CREATE_NO_WINDOW
            command
        }
        let (_done, waited) = std::sync::mpsc::channel();
        let mut guard = KillOnDrop::new(7, waited);
        guard.kill = quick_kill;
        guard.reap_deadline = std::time::Duration::from_millis(300);
        let message = guard.finish().expect_err("nothing ever reports the parser reaped");
        assert!(message.contains("the TUI parser (pid 7) was not reaped within"), "{message}");
        guard.answered.set(true);
    }

    /// The recorder's `roundTrip(formatted, entries)` over the core's formatted text and the core's listed entries.
    pub(in crate::memory::replays) fn round_trip(what: &str, formatted: &str, page: &crate::memory::core::list::Page) -> Exact {
        let parsed = parse_rows(what, formatted);
        let rows = parsed.as_array();
        let per_entry = page
            .entries
            .iter()
            .enumerate()
            .map(|(i, entry)| {
                let row = rows.get(i);
                let field = |key: &str| row.and_then(|r| r.try_get(key)).cloned().unwrap_or(Exact::Undefined);
                let id = entry.id.map_or(Exact::Null, |id| int(id as i64));
                let project = entry.project_id.clone().map_or(Exact::Null, string);
                let summary = string(entry.summary.clone());
                // `String(entry.index_revision)`: a listed entry always carries the key, `null` when it has no revision.
                let revision = string(entry.index_revision.clone().unwrap_or_else(|| "null".to_owned()));
                object(vec![
                    ("id", Exact::Bool(field("_id") == id)),
                    ("projectId", Exact::Bool(field("_projectId") == project)),
                    ("summary", Exact::Bool(field("_summary") == summary)),
                    ("indexRevision", Exact::Bool(field("_indexRevision") == revision)),
                    (
                        "listed",
                        object(vec![
                            ("id", id),
                            ("project_id", project),
                            ("summary", summary),
                            ("index_revision", entry.index_revision.clone().map_or(Exact::Null, string)),
                        ]),
                    ),
                ])
            })
            .collect();
        let count = object(vec![("parsed", int(rows.len() as i64)), ("listed", int(page.entries.len() as i64))]);
        object(vec![("parsed", parsed.clone()), ("perEntry", Exact::Array(per_entry)), ("rowCount", count)])
    }
}
