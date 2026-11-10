//! The runner's own proofs: each drives `run` (or `run_bounded`) against a child of this test binary (the test itself, in its child role) with the
//! fault or the shares the case needs, and reads the report. None needs PostgreSQL except the cluster left running by a killed child (`#[ignore]`,
//! `MIXDOG_PG_RUNTIME`). They run under nextest only (the runner refuses otherwise: module doc).
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    clippy::zombie_processes,
    reason = "the runner's tests: the processes and files of their own children, which end with the run (module doc)"
)]

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use super::{Budget, Contain, Fault, KILL_GRACE, Report, SINK, SPAWN, Setup, child_side, run, run_bounded, test_path};

/// Shares no case here comes near, except those a case sets.
const AMPLE: Budget = Budget { start: 30, child: 120, ending: 30, clusters: 60, descendants: 30 };

fn this(name: &str) -> String {
    test_path(module_path!(), name)
}

fn current_thread() -> tokio::runtime::Builder {
    tokio::runtime::Builder::new_current_thread()
}

fn setup(budget: Budget, pg_ctl: Option<(PathBuf, PathBuf)>, fault: Option<Fault>) -> Setup {
    Setup { budget, pg_ctl, fault, lost: Duration::ZERO }
}

/// A process the child starts: this test again, as a sink that reads its stdin to the end.
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test: a process the child starts")]
fn sink(test: &str, stdin: Stdio, stdout: Stdio) -> std::process::Child {
    std::process::Command::new(std::env::current_exe().expect("the test binary"))
        .args(["--exact", test, "--include-ignored", "--nocapture"])
        .env(SINK, "1")
        .stdin(stdin)
        .stdout(stdout)
        .spawn()
        .expect("the sink starts")
}

/// A data directory (one holding `PG_VERSION`) at `parts` under `dir`.
#[allow(clippy::disallowed_methods, reason = "test: a data directory's marker")]
fn pgdata_at(dir: &Path, parts: &[&str]) -> PathBuf {
    let pgdata = parts.iter().fold(dir.to_owned(), |path, part| path.join(part));
    std::fs::create_dir_all(&pgdata).unwrap();
    std::fs::write(pgdata.join("PG_VERSION"), "16\n").unwrap();
    pgdata
}

/// What the stand-in's `pg_ctl status` does.
#[derive(Clone, Copy)]
enum Status {
    Exit(u8),
    /// Reads its stdin (held open by the runner) until it is killed.
    Hang,
}

/// A `pg_ctl` stand-in in `dir`: `status` does `status`; `stop` fails, saying the test's pg_ctl refuses to stop.
#[allow(clippy::disallowed_methods, reason = "test: writes the stand-in")]
fn fake_pg_ctl(dir: &Path, status: Status) -> Option<(PathBuf, PathBuf)> {
    #[cfg(windows)]
    let path = {
        let body = match status {
            Status::Exit(code) => format!("exit /b {code}"),
            Status::Hang => "set /p line=\r\nexit /b 3".to_owned(),
        };
        let path = dir.join("pg_ctl.cmd");
        std::fs::write(&path, format!("@echo off\r\nif \"%1\"==\"status\" goto status\r\necho the test's pg_ctl refuses to stop 1>&2\r\nexit /b 1\r\n:status\r\n{body}\r\n")).unwrap();
        path
    };
    #[cfg(unix)]
    let path = {
        use std::os::unix::fs::PermissionsExt as _;
        let body = match status {
            Status::Exit(code) => format!("exit {code}"),
            Status::Hang => "read line; exit 3".to_owned(),
        };
        let path = dir.join("pg_ctl");
        std::fs::write(&path, format!("#!/bin/sh\nif [ \"$1\" = status ]; then {body}; fi\necho \"the test's pg_ctl refuses to stop\" >&2\nexit 1\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    };
    Some((path, dir.to_owned()))
}

/// Removes a directory a report kept (a test's own cleanup, after its assertions read it).
#[allow(clippy::disallowed_methods, reason = "test: removes the directory the run kept")]
fn clean(report: &Report) {
    if report.dir.exists() {
        std::fs::remove_dir_all(&report.dir).unwrap();
    }
}

/// Runs `test` on a thread of its own and returns its report, or fails when it has not returned within `limit` (a run without its own deadline).
fn run_within(test: &str, setup: Setup, limit: Duration) -> Report {
    let (said, returned) = std::sync::mpsc::channel();
    let test = test.to_owned();
    std::thread::spawn(move || {
        let _ = said.send(run(&test, &setup));
    });
    returned.recv_timeout(limit).unwrap_or_else(|_| panic!("the run did not return within {limit:?}"))
}

/// A kill reaches everything the child started in its tree. The child starts a process that reads the word pipe (open until the run ends) and
/// holds the child's output; the child is killed while both run. Only a kill of the whole tree (the group on Unix, the job on Windows) ends that
/// process, and only then does the child's output close: the run reports the kill and nothing else, and removes the directory.
#[test]
fn a_killed_child_is_killed_with_everything_it_started() {
    const NAME: &str = "a_killed_child_is_killed_with_everything_it_started";
    const KILL: &str = "kill the child now";
    if child_side(current_thread(), |_| async {
        let _sink = sink(&this(NAME), Stdio::inherit(), Stdio::inherit());
        println!("{KILL}");
        std::future::pending::<()>().await;
    }) {
        return;
    }
    let report = run(&this(NAME), &setup(AMPLE, None, Some(Fault::KillOn(KILL))));
    let shown = report.to_string();
    clean(&report);
    assert_eq!(report.failures.len(), 1, "{shown}");
    assert!(report.failures[0].contains("was killed at its test's request with its process tree"), "{shown}");
    assert!(report.removed && report.left.is_empty(), "{shown}");
}

/// A child that runs over its share and whose tree does not end (its kill does nothing) gets one report with both problems, its directory is kept,
/// and the run returns within its budget.
#[test]
fn an_overrun_whose_tree_does_not_end_is_reported_with_the_overrun() {
    const NAME: &str = "an_overrun_whose_tree_does_not_end_is_reported_with_the_overrun";
    if child_side(current_thread(), |_| async {
        // Reads the word pipe to its end: the child ends when the run closes it.
        tokio::task::spawn_blocking(|| std::io::copy(&mut std::io::stdin(), &mut std::io::sink())).await.unwrap().unwrap();
    }) {
        return;
    }
    let budget = Budget { child: 0, ending: 0, ..AMPLE };
    let started = Instant::now();
    let report = run(&this(NAME), &setup(budget, None, Some(Fault::TreeKillFails)));
    let took = started.elapsed();
    let shown = report.to_string();
    clean(&report);
    assert!(took <= Duration::from_secs(budget.total()), "the run took {took:?}, over its budget of {} s: {shown}", budget.total());
    assert!(report.failures.iter().any(|failure| failure.contains("ran over the child step's time (share 0 s) and was killed")), "{shown}");
    assert!(report.failures.iter().any(|failure| failure.starts_with("the ending step: the child's process tree was not proven empty")), "{shown}");
    assert!(!report.removed, "{shown}");
}

/// What the child starts first is inside its job. The child starts a process at once (before anything else it does) and ends; the job counts both,
/// so the child was in the job before it started anything.
#[cfg(windows)]
#[test]
fn a_process_the_child_starts_first_is_inside_its_job() {
    const NAME: &str = "a_process_the_child_starts_first_is_inside_its_job";
    if child_side(current_thread(), |_| async {
        // Its stdin is the child's: it ends when the child does.
        let _sink = sink(&this(NAME), Stdio::piped(), Stdio::null());
    }) {
        return;
    }
    let report = run(&this(NAME), &setup(AMPLE, None, None));
    let shown = report.to_string();
    clean(&report);
    assert!(report.failures.is_empty() && report.removed, "{shown}");
    assert_eq!(report.job_processes, Some(2), "the child and the process it started first: {shown}");
}

/// A helper whose own process ends but which leaves a process running (here one holding only the helper's stdin, not its output) is not believed:
/// its tree is killed, its result is not used, and the tree is proven ended.
#[test]
fn a_helper_that_leaves_a_process_running_is_not_believed() {
    const NAME: &str = "a_helper_that_leaves_a_process_running_is_not_believed";
    if child_side(current_thread(), |_| async {}) {
        return;
    }
    let mut helper = std::process::Command::new(std::env::current_exe().expect("the test binary"));
    helper.args(["--exact", &this(NAME), "--include-ignored", "--nocapture"]).env(SPAWN, this(NAME));
    let done = run_bounded(helper, Instant::now() + Duration::from_secs(60), "the test's helper", Contain::OwnTree);
    let error = done.output.expect_err("a helper that left a process running is not used");
    assert!(error.contains("left processes running after it ended"), "{error}");
    assert!(done.left.is_empty(), "its tree was killed and proven ended: {:?}", done.left);
}

/// A tree that is not proven ended keeps every data directory unexamined: the child (its kill does nothing) still runs when its time is up, and
/// although a cluster would show as running in its data directory, none is examined; the directory is kept.
#[test]
fn a_tree_not_proven_ended_is_not_examined_and_its_directory_is_kept() {
    const NAME: &str = "a_tree_not_proven_ended_is_not_examined_and_its_directory_is_kept";
    if child_side(current_thread(), |dir| async move {
        pgdata_at(&dir, &["data", "pgdata"]);
        tokio::task::spawn_blocking(|| std::io::copy(&mut std::io::stdin(), &mut std::io::sink())).await.unwrap().unwrap();
    }) {
        return;
    }
    let fake = tempfile::tempdir().unwrap();
    let report = run(&this(NAME), &setup(Budget { child: 0, ending: 0, ..AMPLE }, fake_pg_ctl(fake.path(), Status::Exit(0)), Some(Fault::TreeKillFails)));
    let shown = report.to_string();
    let kept = report.dir.exists();
    clean(&report);
    assert!(report.failures.iter().any(|failure| failure.contains("were not examined: the child's process tree was not proven ended")), "{shown}");
    assert!(!report.failures.iter().any(|failure| failure.contains("a cluster was still running")), "nothing was examined: {shown}");
    assert!(kept && !report.removed, "{shown}");
}

/// A cluster that still runs after the child ended and whose stop fails is named, and its directory is kept.
#[test]
fn a_stop_that_fails_keeps_the_directory_and_names_it() {
    const NAME: &str = "a_stop_that_fails_keeps_the_directory_and_names_it";
    if child_side(current_thread(), |dir| async move {
        pgdata_at(&dir, &["data", "pgdata"]);
    }) {
        return;
    }
    let fake = tempfile::tempdir().unwrap();
    let report = run(&this(NAME), &setup(AMPLE, fake_pg_ctl(fake.path(), Status::Exit(0)), None));
    let shown = report.to_string();
    let pgdata = report.dir.join("data").join("pgdata");
    let kept = report.dir.exists();
    clean(&report);
    assert!(report.failures.iter().any(|failure| failure.contains(&format!("a cluster was still running in {}", pgdata.display()))), "{shown}");
    assert!(
        report.failures.iter().any(|failure| failure.contains(&format!("{} is not proven stopped: pg_ctl stop failed", pgdata.display())) && failure.contains("the test's pg_ctl refuses to stop")),
        "{shown}"
    );
    assert!(kept && !report.removed, "{shown}");
    assert!(report.left.iter().any(|left| left.contains(&pgdata.display().to_string())), "{shown}");
}

/// A data directory at any depth is examined even without a `postmaster.pid`, and one whose state cannot be decided is kept.
#[test]
fn every_data_directory_is_examined_and_an_undecided_one_is_kept() {
    const NAME: &str = "every_data_directory_is_examined_and_an_undecided_one_is_kept";
    if child_side(current_thread(), |dir| async move {
        pgdata_at(&dir, &["a", "b", "c", "pgdata"]);
    }) {
        return;
    }
    let fake = tempfile::tempdir().unwrap();
    // `pg_ctl status` exit 4: the data directory is not accessible, so its state cannot be decided.
    let report = run(&this(NAME), &setup(AMPLE, fake_pg_ctl(fake.path(), Status::Exit(4)), None));
    let shown = report.to_string();
    let pgdata = report.dir.join("a").join("b").join("c").join("pgdata");
    let kept = report.dir.exists();
    clean(&report);
    assert!(report.failures.iter().any(|failure| failure.contains(&format!("{} is not proven stopped: its state cannot be decided", pgdata.display()))), "{shown}");
    assert!(kept && !report.removed, "{shown}");
}

/// A link (a junction on Windows) is listed as unexamined, never followed, and the walk goes on: the data directory beside it is still examined.
#[test]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test: makes a link in the child's directory")]
fn a_link_is_listed_unexamined_and_the_walk_goes_on() {
    const NAME: &str = "a_link_is_listed_unexamined_and_the_walk_goes_on";
    if child_side(current_thread(), |dir| async move {
        std::fs::create_dir_all(dir.join("a")).unwrap();
        // A link back to the test's own directory: followed, it would be a cycle.
        #[cfg(unix)]
        std::os::unix::fs::symlink(&dir, dir.join("a").join("link")).unwrap();
        #[cfg(windows)]
        {
            let mut mklink = std::process::Command::new("cmd");
            mklink.args(["/c", "mklink", "/J"]).arg(dir.join("a").join("link")).arg(&dir);
            let made = run_bounded(mklink, Instant::now() + Duration::from_secs(60), "mklink", Contain::OwnTree);
            assert!(made.output.as_ref().is_ok_and(|output| output.status.success()), "mklink: {:?}", made.output);
        }
        pgdata_at(&dir, &["b", "pgdata"]);
    }) {
        return;
    }
    let fake = tempfile::tempdir().unwrap();
    let report = run(&this(NAME), &setup(AMPLE, fake_pg_ctl(fake.path(), Status::Exit(4)), None));
    let shown = report.to_string();
    let link = report.dir.join("a").join("link");
    let pgdata = report.dir.join("b").join("pgdata");
    let kept = report.dir.exists();
    clean(&report);
    assert!(report.failures.iter().any(|failure| failure.contains(&format!("not examined: {} is a link or junction (not followed)", link.display()))), "{shown}");
    assert!(report.failures.iter().any(|failure| failure.contains(&format!("{} is not proven stopped: its state cannot be decided", pgdata.display()))), "{shown}");
    assert!(kept && !report.removed, "{shown}");
}

/// The data directories share the clusters step's one share. Two are found; the first one's status hangs and is killed when the share runs out, so
/// the second is named as not examined, with the step, and kept. Per-directory shares would examine (and kill) both.
#[test]
fn the_clusters_step_shares_one_budget_and_names_the_step() {
    const NAME: &str = "the_clusters_step_shares_one_budget_and_names_the_step";
    if child_side(current_thread(), |dir| async move {
        pgdata_at(&dir, &["data", "pgdata"]);
        pgdata_at(&dir, &["scenario-0", "data", "pgdata"]);
    }) {
        return;
    }
    let fake = tempfile::tempdir().unwrap();
    // A share of two seconds more than a helper's kill grace: the first status runs for those two seconds.
    let clusters = KILL_GRACE.as_secs() + 2;
    let report = run(&this(NAME), &setup(Budget { clusters, ..AMPLE }, fake_pg_ctl(fake.path(), Status::Hang), None));
    let shown = report.to_string();
    let killed = report.failures.iter().filter(|failure| failure.contains("pg_ctl status") && failure.contains("did not end by its step's deadline and was killed")).count();
    let unexamined =
        report.failures.iter().filter(|failure| failure.starts_with("the clusters step: ") && failure.ends_with(&format!("was not examined: the step's time ran out (share {clusters} s, or the run's end)"))).count();
    let kept = report.dir.exists();
    clean(&report);
    assert_eq!((killed, unexamined), (1, 1), "{shown}");
    assert!(kept && !report.removed, "{shown}");
}

/// The run has one end, fixed when it starts: a step whose share reaches past it gets only what remains. The run starts with all but 20 s of its
/// budget counted as spent; the clusters step's share is 600 s and its status hangs, yet the run returns by its end.
#[test]
fn a_step_gets_no_more_than_what_remains_of_the_run() {
    const NAME: &str = "a_step_gets_no_more_than_what_remains_of_the_run";
    if child_side(current_thread(), |dir| async move {
        pgdata_at(&dir, &["data", "pgdata"]);
    }) {
        return;
    }
    let fake = tempfile::tempdir().unwrap();
    let budget = Budget { clusters: 600, ..AMPLE };
    let remains = Duration::from_secs(20);
    let lost = Duration::from_secs(budget.total()) - remains;
    let started = Instant::now();
    let report = run_within(&this(NAME), Setup { budget, pg_ctl: fake_pg_ctl(fake.path(), Status::Hang), fault: None, lost }, Duration::from_secs(60));
    let took = started.elapsed();
    let shown = report.to_string();
    clean(&report);
    assert!(took <= remains + Duration::from_secs(1), "the run took {took:?}, past what remained of it ({remains:?}): {shown}");
    assert!(report.failures.iter().any(|failure| failure.contains("pg_ctl status") && failure.contains("did not end by its step's deadline and was killed")), "{shown}");
}

/// A child that cannot be put in its tree, and whose kill does nothing, is reported by the ending step and not waited for again: the run returns at
/// once, naming the child's pid as left (it ends when the run closes its word pipe) and examining nothing.
#[test]
fn a_child_that_cannot_be_held_is_waited_for_under_a_deadline() {
    const NAME: &str = "a_child_that_cannot_be_held_is_waited_for_under_a_deadline";
    // The child stays at its gate (the body never runs) until the word pipe closes or the gate's own limit (30 s) passes.
    if child_side(current_thread(), |_| async {}) {
        return;
    }
    // The run's own deadline is the ending step's share (0 s); this one only turns a run without it into a failure instead of a 30 s wait.
    let report = run_within(&this(NAME), setup(Budget { ending: 0, ..AMPLE }, None, Some(Fault::HoldFails)), Duration::from_secs(10));
    let shown = report.to_string();
    clean(&report);
    assert!(report.failures.iter().any(|failure| failure.contains("could not be put in its process tree")), "{shown}");
    assert!(report.failures.iter().any(|failure| failure.contains("was still running when the step's time ran out (share 0 s)")), "{shown}");
    assert!(report.failures.iter().any(|failure| failure.contains("were not examined")), "{shown}");
    assert!(report.left.iter().any(|left| left.starts_with("the child test process, pid ")), "{shown}");
}

/// With a real cluster: the child starts one (`pg_ctl start -w`, in the child's tree, so it is running when the kill comes) and is killed. On
/// Windows the postmaster is in the child's job and dies with it, so the cluster is found stopped; on Unix it left the group and still runs, so the
/// cluster step finds it running and stops it by its data directory. Either way it is ended before the directory is removed.
#[test]
#[ignore = "integration: starts a real PostgreSQL cluster from the bundled runtime (MIXDOG_PG_RUNTIME); no network"]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test: runs the runtime's initdb and pg_ctl in the child")]
fn a_cluster_left_running_by_a_killed_child_is_ended_before_its_directory_is_removed() {
    const NAME: &str = "a_cluster_left_running_by_a_killed_child_is_ended_before_its_directory_is_removed";
    const KILL: &str = "the cluster runs";
    if child_side(current_thread(), |dir| async move {
        let runtime = PathBuf::from(std::env::var_os("MIXDOG_PG_RUNTIME").expect("MIXDOG_PG_RUNTIME"));
        let bin = |name: &str| runtime.join("bin").join(if cfg!(windows) { format!("{name}.exe") } else { name.to_owned() });
        let lib = runtime.join("lib");
        let pgdata = dir.join("deep").join("data").join("pgdata");
        let deadline = Instant::now() + Duration::from_secs(120);
        let mut initdb = std::process::Command::new(bin("initdb"));
        initdb.args(["-U", "postgres", "-A", "trust", "-N", "-D"]).arg(&pgdata);
        if cfg!(target_os = "linux") {
            initdb.env("LD_LIBRARY_PATH", &lib);
        }
        let made = run_bounded(initdb, deadline, "initdb", Contain::OwnTree);
        assert!(made.output.as_ref().is_ok_and(|output| output.status.success()), "initdb: {:?}", made.output);
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let mut start = std::process::Command::new(bin("pg_ctl"));
        start.args(["start", "-w", "-D"]).arg(&pgdata).arg("-l").arg(dir.join("deep").join("pg.log")).arg("-o").arg(format!("-p {port} -h 127.0.0.1"));
        if cfg!(target_os = "linux") {
            start.env("LD_LIBRARY_PATH", &lib);
        }
        let started = run_bounded(start, deadline, "pg_ctl start", Contain::CallersTree);
        assert!(started.output.as_ref().is_ok_and(|output| output.status.success()), "pg_ctl start: {:?}", started.output);
        println!("{KILL}");
        std::future::pending::<()>().await;
    }) {
        return;
    }
    let report = run(&this(NAME), &Setup { budget: AMPLE, fault: Some(Fault::KillOn(KILL)), ..Setup::composed() });
    let shown = report.to_string();
    clean(&report);
    assert!(report.failures[0].contains("was killed at its test's request with its process tree"), "{shown}");
    if cfg!(windows) {
        assert_eq!(report.failures.len(), 1, "the postmaster died with the job: {shown}");
    } else {
        assert_eq!(report.failures.len(), 2, "{shown}");
        assert!(report.failures[1].contains("a cluster was still running in") && report.failures[1].contains("it is stopped by its data directory"), "{shown}");
    }
    assert!(report.removed && report.left.is_empty(), "{shown}");
}

/// Every test that runs under the runner is run by the `pg` profile and gets the composed tests' time: each `in_child(module_path!(), "<name>"` call
/// in the crate's sources (its module: the file's path and the inline modules around the call) and each `#[ignore]`d test of this module must be
/// matched by the profile's filter and by the override that gives 720 s (`.config/nextest.toml`). A renamed module would otherwise stop running.
#[test]
#[allow(clippy::disallowed_methods, reason = "test: reads the crate's sources and the nextest configuration")]
fn every_composed_test_is_run_by_the_pg_profile_with_its_time() {
    let crate_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut tests = Vec::new();
    composed_tests(&crate_dir.join("src"), &crate_dir.join("src"), &mut tests);
    let own = std::fs::read_to_string(crate_dir.join("src").join("compose_test_support").join("runner_tests.rs")).unwrap();
    tests.extend(ignored_tests(&own).into_iter().map(|name| this(&name)));
    assert!(!tests.is_empty(), "no composed test was found");
    let nextest = std::fs::read_to_string(crate_dir.join("../../.config/nextest.toml")).unwrap();
    let profile = predicates(positive(filter_after(&nextest, "[profile.pg]")));
    let time = predicates(positive(filter_before(&nextest, "slow-timeout = { period = \"120s\", terminate-after = 6 }")));
    let unmatched = |predicates: &[String]| tests.iter().filter(|test| !predicates.iter().any(|predicate| matches(predicate, test))).cloned().collect::<Vec<_>>();
    assert_eq!(unmatched(&profile), Vec::<String>::new(), "composed tests the `pg` profile's filter does not run (found: {tests:?})");
    assert_eq!(unmatched(&time), Vec::<String>::new(), "composed tests without the 720 s override (found: {tests:?})");
}

#[test]
fn the_scan_reads_a_call_however_it_is_spaced_and_refuses_a_use_it_cannot_read() {
    let read = |source: &str| std::panic::catch_unwind(|| runner_calls(source, "source")).ok().map(|calls| calls.into_iter().map(|(_, name)| name).collect::<Vec<_>>());
    assert_eq!(read("x::in_child(module_path!(), \"a\", runtime, body);"), Some(vec!["a".to_owned()]));
    assert_eq!(read("in_child (\n    module_path!() ,\n    \"b\",\n);"), Some(vec!["b".to_owned()]));
    assert_eq!(read("/// see `in_child`\npub fn in_child<F>() {}\nfn not_in_child_at_all() {}"), Some(Vec::new()));
    assert_eq!(read("use crate::compose_test_support::in_child as run;"), None);
    assert_eq!(read("in_child(module, name, runtime, body);"), None);
}

#[test]
fn a_filter_that_takes_tests_out_again_is_refused() {
    assert!(std::panic::catch_unwind(|| positive("package(a) & (test(/^b::(c|d)::/) | test(=e))")).is_ok());
    for filter in ["test(/^a::/) & not test(=a::b)", "test(/^a::/) - test(=a::b)", "test(/^a::/) & !test(=a::b)"] {
        assert!(std::panic::catch_unwind(|| positive(filter)).is_err(), "{filter}");
    }
}

const RUNNER: &str = "in_child";

/// Every use of the runner in `source`: where it is and the test's name. A use that is not a call with `module_path!()` and a literal name (an import, an
/// alias, a name made at run time) is one this scan cannot follow, and fails it.
fn runner_calls(source: &str, shown: &str) -> Vec<(usize, String)> {
    let is_ident = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_';
    let bytes = source.as_bytes();
    let mut calls = Vec::new();
    for (at, _) in source.match_indices(RUNNER) {
        let end = at + RUNNER.len();
        if (at > 0 && is_ident(bytes[at - 1])) || bytes.get(end).is_some_and(|byte| is_ident(*byte)) {
            continue;
        }
        let line = &source[source[..at].rfind('\n').map_or(0, |start| start + 1)..at];
        // A comment that names the runner, and the runner's own definition.
        if line.trim_start().starts_with("//") || line.trim_end().ends_with("fn") {
            continue;
        }
        let name = ["(", "module_path!()", ","]
            .iter()
            .try_fold(source[end..].trim_start(), |rest, token| rest.strip_prefix(*token).map(str::trim_start))
            .and_then(|rest| rest.strip_prefix('"'))
            .and_then(|rest| rest.split_once('"'))
            .map(|(name, _)| name)
            .unwrap_or_else(|| panic!("{shown}: line {}: a use of the runner this scan cannot read (not `in_child(module_path!(), \"<name>\"`)", source[..at].matches('\n').count() + 1));
        calls.push((at, name.to_owned()));
    }
    calls
}

/// `filter`, refused unless it is `test(…)` and `package(…)` predicates joined by `&`, `|` and parentheses: a `not`, `!` or `-` takes a test out again
/// without [`predicates`] seeing it.
fn positive(filter: &str) -> &str {
    let mut skeleton = String::new();
    let mut rest = filter;
    while let Some((at, open)) = ["test(", "package("].iter().filter_map(|open| rest.find(open).map(|at| (at, open.len()))).min() {
        skeleton.push_str(&rest[..at]);
        let body = &rest[at + open..];
        let mut depth = 1;
        let end = body
            .char_indices()
            .find(|(_, c)| {
                depth += match c {
                    '(' => 1,
                    ')' => -1,
                    _ => 0,
                };
                depth == 0
            })
            .map(|(end, _)| end)
            .expect("a closed predicate");
        rest = &body[end + 1..];
    }
    skeleton.push_str(rest);
    assert!(skeleton.chars().all(|c| c.is_whitespace() || "&|()".contains(c)), "a filter with an operator this scan does not read ({skeleton:?}): {filter}");
    filter
}

#[allow(clippy::disallowed_methods, reason = "test: reads the crate's sources")]
fn composed_tests(src: &Path, dir: &Path, found: &mut Vec<String>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            composed_tests(src, &path, found);
            continue;
        }
        if path.extension().is_none_or(|extension| extension != "rs") {
            continue;
        }
        // This file names the call in its own text, and calls `run` itself (its `#[ignore]`d tests are added by name).
        if path.ends_with(Path::new("compose_test_support").join("runner_tests.rs")) {
            continue;
        }
        let source = std::fs::read_to_string(&path).unwrap();
        let mut module: Vec<String> = path.strip_prefix(src).unwrap().with_extension("").components().map(|part| part.as_os_str().to_string_lossy().into_owned()).collect();
        if module.last().is_some_and(|last| ["mod", "lib", "main"].contains(&last.as_str())) {
            module.pop();
        }
        for (at, name) in runner_calls(&source, &path.display().to_string()) {
            let mut parts = module.clone();
            parts.extend(modules_around(&source, at));
            parts.push(name);
            found.push(parts.join("::"));
        }
    }
}

/// The inline modules (`mod name {`) open at `at`, outermost first.
fn modules_around(source: &str, at: usize) -> Vec<String> {
    let is_ident = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_';
    let bytes = source.as_bytes();
    let (mut open, mut depth, mut pending) = (Vec::<(String, usize)>::new(), 0usize, None::<(String, usize)>);
    for i in 0..at {
        if bytes[i..].starts_with(b"mod ") && (i == 0 || !is_ident(bytes[i - 1])) {
            let start = i + 4;
            let end = start + bytes[start..].iter().take_while(|byte| is_ident(**byte)).count();
            let brace = end + bytes[end..].iter().take_while(|byte| **byte == b' ').count();
            if end > start && bytes.get(brace) == Some(&b'{') {
                pending = Some((source[start..end].to_owned(), brace));
            }
        }
        match bytes[i] {
            b'{' => {
                depth += 1;
                if let Some((name, _)) = pending.take_if(|(_, brace)| *brace == i) {
                    open.push((name, depth));
                }
            }
            b'}' => {
                if open.last().is_some_and(|(_, opened)| *opened == depth) {
                    open.pop();
                }
                depth = depth.saturating_sub(1);
            }
            _ => {}
        }
    }
    open.into_iter().map(|(name, _)| name).collect()
}

/// The names of the `#[ignore]`d tests in `source`.
fn ignored_tests(source: &str) -> Vec<String> {
    source
        .match_indices("\n#[ignore")
        .filter_map(|(at, _)| source[at..].split_once("\nfn ").and_then(|(_, rest)| rest.split_once('(')).map(|(name, _)| name.to_owned()))
        .collect()
}

/// The filter (`'''…'''`) that follows `marker`.
fn filter_after<'a>(toml: &'a str, marker: &str) -> &'a str {
    let rest = &toml[toml.find(marker).unwrap_or_else(|| panic!("{marker} in nextest.toml"))..];
    let start = rest.find("'''").expect("a filter") + 3;
    &rest[start..start + rest[start..].find("'''").expect("its end")]
}

/// The filter of the override block that holds `marker`.
fn filter_before<'a>(toml: &'a str, marker: &str) -> &'a str {
    let at = toml.find(marker).unwrap_or_else(|| panic!("{marker} in nextest.toml"));
    let start = toml[..at].rfind("filter = '''").expect("the override's filter") + "filter = '''".len();
    &toml[start..start + toml[start..].find("'''").expect("its end")]
}

/// The arguments of every `test(…)` predicate in `filter`.
fn predicates(filter: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut rest = filter;
    while let Some(at) = rest.find("test(") {
        rest = &rest[at + "test(".len()..];
        let mut depth = 1;
        let end = rest
            .char_indices()
            .find(|(_, c)| {
                depth += match c {
                    '(' => 1,
                    ')' => -1,
                    _ => 0,
                };
                depth == 0
            })
            .map(|(end, _)| end)
            .expect("a closed predicate");
        found.push(rest[..end].to_owned());
        rest = &rest[end..];
    }
    found
}

/// Whether the predicate `=name` or `/^regex/` (literal text and `(a|b)` groups only) matches `test`.
fn matches(predicate: &str, test: &str) -> bool {
    if let Some(exact) = predicate.strip_prefix('=') {
        return exact == test;
    }
    let regex = predicate.strip_prefix("/^").and_then(|rest| rest.strip_suffix('/')).unwrap_or_else(|| panic!("unsupported predicate {predicate}"));
    prefixes(regex).iter().any(|prefix| test.starts_with(prefix.as_str()))
}

fn prefixes(regex: &str) -> Vec<String> {
    match regex.split_once('(') {
        Some((head, rest)) => {
            let (group, tail) = rest.split_once(')').unwrap_or_else(|| panic!("unsupported regex {regex}"));
            group.split('|').flat_map(|choice| prefixes(&format!("{head}{choice}{tail}"))).collect()
        }
        None => {
            assert!(!regex.contains(['.', '*', '+', '?', '[', '{', '$', '\\', '|', ')']), "unsupported regex {regex}");
            vec![regex.to_owned()]
        }
    }
}
