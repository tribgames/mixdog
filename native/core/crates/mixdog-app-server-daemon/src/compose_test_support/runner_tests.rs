//! The runner's own proofs: each drives `run` against a child of this test binary (the test itself, in its child role) with the fault or the shares
//! the case needs, and reads the run's report. None needs PostgreSQL except the cluster killed while starting (`#[ignore]`, `MIXDOG_PG_RUNTIME`).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use super::{Budget, Fault, Report, SINK, Setup, child_side, run, test_path};

/// Shares no case here comes near, except those a case sets to 0.
const AMPLE: Budget = Budget { start: 30, child: 120, ending: 30, clusters: 60, descendants: 30 };

fn this(name: &str) -> String {
    test_path(module_path!(), name)
}

fn current_thread() -> tokio::runtime::Builder {
    tokio::runtime::Builder::new_current_thread()
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

/// A `pg_ctl` stand-in in `dir`: `status` exits `status`; `stop` fails, saying the test's pg_ctl refuses to stop.
#[allow(clippy::disallowed_methods, reason = "test: writes the stand-in")]
fn fake_pg_ctl(dir: &Path, status: u8) -> Option<(PathBuf, PathBuf)> {
    #[cfg(windows)]
    let path = {
        let path = dir.join("pg_ctl.cmd");
        std::fs::write(&path, format!("@echo off\r\nif \"%1\"==\"status\" exit /b {status}\r\necho the test's pg_ctl refuses to stop 1>&2\r\nexit /b 1\r\n")).unwrap();
        path
    };
    #[cfg(unix)]
    let path = {
        use std::os::unix::fs::PermissionsExt as _;
        let path = dir.join("pg_ctl");
        std::fs::write(&path, format!("#!/bin/sh\nif [ \"$1\" = status ]; then exit {status}; fi\necho \"the test's pg_ctl refuses to stop\" >&2\nexit 1\n")).unwrap();
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

/// Item 1: a kill reaches everything the child started in its tree. The child starts a process that reads the word pipe (open until the run ends) and
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
    let report = run(&this(NAME), &Setup { budget: AMPLE, pg_ctl: None, fault: Some(Fault::KillOn(KILL)) });
    let shown = report.to_string();
    clean(&report);
    assert_eq!(report.failures.len(), 1, "{shown}");
    assert!(report.failures[0].contains("was killed at its test's request with its process tree"), "{shown}");
    assert!(report.removed && report.left.is_empty(), "{shown}");
}

/// Item 6: a child that runs over its share and whose tree does not end (its kill does nothing) gets one report with both problems, and its
/// directory is kept.
#[test]
fn an_overrun_whose_tree_does_not_end_is_reported_with_the_overrun() {
    const NAME: &str = "an_overrun_whose_tree_does_not_end_is_reported_with_the_overrun";
    if child_side(current_thread(), |_| async {
        // Reads the word pipe to its end: the child ends when the run closes it.
        tokio::task::spawn_blocking(|| std::io::copy(&mut std::io::stdin(), &mut std::io::sink())).await.unwrap().unwrap();
    }) {
        return;
    }
    let report = run(&this(NAME), &Setup { budget: Budget { child: 0, ending: 0, ..AMPLE }, pg_ctl: None, fault: Some(Fault::TreeKillFails) });
    let shown = report.to_string();
    clean(&report);
    assert!(report.failures.iter().any(|failure| failure.contains("ran over the child step's share (0 s) and was killed")), "{shown}");
    assert!(report.failures.iter().any(|failure| failure.starts_with("the ending step: the child's process tree was not proven empty")), "{shown}");
    assert!(!report.removed, "{shown}");
}

/// Item 4: what the child starts first is inside its job. The child starts a process at once (before anything else it does) and ends; the job
/// counts both, so the child was in the job before it started anything.
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
    let report = run(&this(NAME), &Setup { budget: AMPLE, pg_ctl: None, fault: None });
    let shown = report.to_string();
    clean(&report);
    assert!(report.failures.is_empty() && report.removed, "{shown}");
    assert_eq!(report.job_processes, Some(2), "the child and the process it started first: {shown}");
}

/// Item 3: a cluster that still runs after the child ended and whose stop fails is named, and its directory is kept.
#[test]
fn a_stop_that_fails_keeps_the_directory_and_names_it() {
    const NAME: &str = "a_stop_that_fails_keeps_the_directory_and_names_it";
    if child_side(current_thread(), |dir| async move {
        pgdata_at(&dir, &["data", "pgdata"]);
    }) {
        return;
    }
    let fake = tempfile::tempdir().unwrap();
    let report = run(&this(NAME), &Setup { budget: AMPLE, pg_ctl: fake_pg_ctl(fake.path(), 0), fault: None });
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

/// Item 2: a data directory at any depth is examined even without a `postmaster.pid`, and one whose state cannot be decided is kept.
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
    let report = run(&this(NAME), &Setup { budget: AMPLE, pg_ctl: fake_pg_ctl(fake.path(), 4), fault: None });
    let shown = report.to_string();
    let pgdata = report.dir.join("a").join("b").join("c").join("pgdata");
    let kept = report.dir.exists();
    clean(&report);
    assert!(report.failures.iter().any(|failure| failure.contains(&format!("{} is not proven stopped: its state cannot be decided", pgdata.display()))), "{shown}");
    assert!(kept && !report.removed, "{shown}");
}

/// Item 5: the data directories share the clusters step's one share; when it runs out the rest are named as not examined, with the step, and kept.
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
    // `pg_ctl status` exit 3 (not running) would prove each stopped, had it run.
    let report = run(&this(NAME), &Setup { budget: Budget { clusters: 0, ..AMPLE }, pg_ctl: fake_pg_ctl(fake.path(), 3), fault: None });
    let shown = report.to_string();
    let unexamined = report.failures.iter().filter(|failure| failure.starts_with("the clusters step: ") && failure.ends_with("was not examined: the step's share (0 s) ran out")).count();
    let kept = report.dir.exists();
    clean(&report);
    assert_eq!(unexamined, 2, "{shown}");
    assert!(kept && !report.removed, "{shown}");
}

/// Item 7: a child that cannot be put in its tree, and whose kill does nothing, is waited for under the ending step's share: the run returns at
/// once, naming the child's pid as left (it ends when the run closes its word pipe).
#[test]
fn a_child_that_cannot_be_held_is_waited_for_under_a_deadline() {
    const NAME: &str = "a_child_that_cannot_be_held_is_waited_for_under_a_deadline";
    // The child stays at its gate (the body never runs) until the word pipe closes or the gate's own limit (30 s) passes.
    if child_side(current_thread(), |_| async {}) {
        return;
    }
    let (said, returned) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = said.send(run(&this(NAME), &Setup { budget: Budget { ending: 0, ..AMPLE }, pg_ctl: None, fault: Some(Fault::HoldFails) }));
    });
    // The run's own deadline is the ending step's share (0 s); this one only turns a run without it into a failure instead of a 30 s wait.
    let report = returned.recv_timeout(Duration::from_secs(10)).expect("the run returns under the ending step's share");
    let shown = report.to_string();
    clean(&report);
    assert!(report.failures.iter().any(|failure| failure.contains("could not be put in its process tree")), "{shown}");
    assert!(report.failures.iter().any(|failure| failure.contains("was still running when the step's share (0 s) ran out")), "{shown}");
    assert!(report.left.iter().any(|left| left.starts_with("the child test process, pid ")), "{shown}");
}

/// Item 2 with a real cluster: the child is killed right after it spawned `pg_ctl start` (the postmaster may not have written `postmaster.pid`).
/// The kill and the empty tree come before the data directory (two levels down) is examined, so it is found stopped and the directory removed.
#[test]
#[ignore = "integration: starts a real PostgreSQL cluster from the bundled runtime (MIXDOG_PG_RUNTIME); no network"]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test: runs the runtime's initdb and pg_ctl in the child")]
fn a_cluster_killed_while_starting_is_ended_before_its_directory_is_examined() {
    const NAME: &str = "a_cluster_killed_while_starting_is_ended_before_its_directory_is_examined";
    const KILL: &str = "pg_ctl start was spawned";
    if child_side(current_thread(), |dir| async move {
        let runtime = PathBuf::from(std::env::var_os("MIXDOG_PG_RUNTIME").expect("MIXDOG_PG_RUNTIME"));
        let bin = |name: &str| runtime.join("bin").join(if cfg!(windows) { format!("{name}.exe") } else { name.to_owned() });
        let lib = runtime.join("lib");
        let pgdata = dir.join("deep").join("data").join("pgdata");
        let mut initdb = std::process::Command::new(bin("initdb"));
        initdb.args(["-U", "postgres", "-A", "trust", "-N", "-D"]).arg(&pgdata).stdout(Stdio::null());
        if cfg!(target_os = "linux") {
            initdb.env("LD_LIBRARY_PATH", &lib);
        }
        assert!(initdb.status().unwrap().success(), "initdb");
        let mut start = std::process::Command::new(bin("pg_ctl"));
        start.args(["start", "-D"]).arg(&pgdata).arg("-l").arg(dir.join("deep").join("pg.log")).args(["-o", "-c listen_addresses="]).stdout(Stdio::null());
        if cfg!(target_os = "linux") {
            start.env("LD_LIBRARY_PATH", &lib);
        }
        let _start = start.spawn().unwrap();
        println!("{KILL}");
        std::future::pending::<()>().await;
    }) {
        return;
    }
    let report = run(&this(NAME), &Setup { budget: AMPLE, fault: Some(Fault::KillOn(KILL)), ..Setup::composed() });
    let shown = report.to_string();
    clean(&report);
    assert_eq!(report.failures.len(), 1, "{shown}");
    assert!(report.failures[0].contains("was killed at its test's request with its process tree"), "{shown}");
    assert!(report.removed && report.left.is_empty(), "{shown}");
}
