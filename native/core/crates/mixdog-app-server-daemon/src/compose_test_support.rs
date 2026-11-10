//! What the tests that compose the real core share. Composing runs `ensure_runtime` for the bundled PostgreSQL runtime and starts the memory stack on it; with no runtime
//! installed in the data directory that DOWNLOADS it, so these tests never start from an empty one. They are the integration tests of the memory crate's kind
//! (`#[ignore]`, `MIXDOG_PG_RUNTIME` names an unpacked runtime directory, as in `mixdog-services`' `memory/tests/boot.rs`): the runtime is copied once into the layout
//! `ensure_runtime` reads as installed (`<data>/runtime/runtime-<key>`, the `.version-sha256` stamp, `active-version`), so no network is touched.
//!
//! # The runner ([`in_child`])
//!
//! Each such test runs in a child process of its own (this test binary, run for that test alone) over a directory of its own. A composed core's SQLite
//! stores outlive its stop (`state/core.sqlite` and `index/store.sqlite` stay open after `ComposedCore::stop`, after the core and its runtime are dropped),
//! so only the end of the process that held them makes removing the directory possible on Windows.
//!
//! The contract:
//! - Normal end (the child exits by itself, its test passed or failed): the core's own stop has ended its cluster. The parent verifies that every process
//!   the child started has ended and that no cluster runs in any data directory under the test's directory, then removes the directory.
//! - Abnormal end (the child ran over its limit or never reached its gate, a process of it outlived it, a cluster still ran, a stop failed): the parent
//!   ends what it can establish it owns (the child's process tree, a cluster by its data directory) and FAILS the test with one report naming every problem
//!   found and what may be left (pids, process groups, directories). It never removes a directory holding a data directory it could not prove stopped and
//!   never reports success.
//! - Every problem found is in the one report: no step returns early over another; a step that cannot run says why.
//!
//! The steps, in order, with one total budget ([`BUDGET`], under the 720 s nextest gives these tests, `.config/nextest.toml`) divided among them, each
//! failure naming the step whose share ran out:
//! 1. start: the child is started and announces [`READY`] before it starts anything; only then is it put in its process tree and told to go
//!    (over its stdin), so nothing it starts is outside the tree. The child waits for the word under the same share and fails without it.
//! 2. child: the child runs to its end, or past its share it is killed with its whole tree.
//! 3. ending: the child has ended, its process tree is established empty (killed, if something outlived a child that ended by itself) and its output is
//!    closed (no process it started still holds it).
//! 4. clusters: every data directory under the test's directory (a directory holding `PG_VERSION`, at any depth) is examined with `pg_ctl status`, by
//!    that directory; a running one is a failure and is stopped (`pg_ctl stop -m fast`); one whose state cannot be decided, whose stop failed or that the
//!    share left unexamined is "not proven stopped". Every `pg_ctl` runs in a tree of its own under the step's deadline; one that has to be killed and does
//!    not end is named, with its pid, as abandoned.
//! 5. descendants (Linux): every process descended from the test has ended (see below).
//! 6. removal, only when every earlier step proved its part.
//!
//! What reaches a cluster: the product starts PostgreSQL by spawning `pg_ctl start` (`mixdog-services/src/memory/pg/cluster.rs`, `spawn_start`) through
//! `tokio::process::Command`, outside the process manager's jobs, and never kills it; the postmaster is started by `pg_ctl`, not by the core. On Windows
//! `pg_ctl` starts it (through `cmd`) in the job of its caller, which allows no breakaway: the child's job holds it, and an empty job means the postmaster
//! has ended. On Unix `pg_ctl` forks, calls `setsid` and execs the postmaster, so it leaves the child's process group and the group kill does not reach it:
//! only the stop by data directory does. On Linux the parent is a child subreaper (`PR_SET_CHILD_SUBREAPER`), so an orphaned postmaster becomes its child
//! and step 5 waits for it: a postmaster still starting when its directory was examined (no `postmaster.pid` yet, `pg_ctl status` 3) keeps step 5 from
//! ending and the directory is kept. macOS has no subreaper: there the group is checked once, without a wait, and after an abnormal end a "not running"
//! status is not taken as proof (the directory is kept).
//!
//! Limits: the runner cannot end a process that left the child's tree other than a postmaster by its data directory; such a process shows as an open output
//! (if it inherited it) or, on Linux, in step 5, and is reported, not ended.

use std::io::{BufRead as _, Read as _, Write as _};
use std::path::Path;
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use mixdog_services::memory::pg::runtime_install::{Manifest, Platform, install_key, ver_dir};

mod runner_tests;

/// Set only in a composed test's child process: the directory the test works in.
const CHILD_DIR: &str = "MIXDOG_COMPOSED_TEST_DIR";
/// Set in a process a runner test starts from its child: it reads its stdin to the end and exits.
const SINK: &str = "MIXDOG_COMPOSED_TEST_SINK";
/// The line the child writes when it has started nothing yet and waits for the parent's word.
const READY: &str = "mixdog-composed-test: at the gate";
/// The parent's word to go, the one byte it writes to the child's stdin.
const GO: u8 = b'g';
/// What nextest gives a composed test (`slow-timeout` 120 s × 6, `.config/nextest.toml`).
const NEXTEST_LIMIT_SECS: u64 = 720;

/// The runner's one budget, divided among its steps (whole seconds).
#[derive(Clone, Copy, Debug)]
pub(crate) struct Budget {
    pub start: u64,
    pub child: u64,
    pub ending: u64,
    pub clusters: u64,
    pub descendants: u64,
}

impl Budget {
    const fn total(&self) -> u64 {
        self.start + self.child + self.ending + self.clusters + self.descendants
    }
}

/// The composed tests' budget. The cluster share fits a status and a stop (each `pg_ctl stop` waits at most what is left) for several directories.
pub(crate) const BUDGET: Budget = Budget { start: 30, child: 480, ending: 60, clusters: 90, descendants: 30 };
const _: () = assert!(BUDGET.total() < NEXTEST_LIMIT_SECS, "the runner must end before nextest ends it");
/// Of a step's share, what a killed process (a `pg_ctl`) is given to end.
const KILL_GRACE: Duration = Duration::from_secs(5);

/// A fault a runner test injects.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Fault {
    /// Putting the child in its tree fails, and the kill that follows does nothing.
    HoldFails,
    /// Killing the child's tree does nothing.
    TreeKillFails,
    /// The child's tree is killed when the child writes this line (a test's "kill me now").
    KillOn(&'static str),
}

/// How a run is made.
pub(crate) struct Setup {
    pub budget: Budget,
    /// `pg_ctl`, and the library directory it needs on Linux. `None`: no runtime is known, and any data directory is "not proven stopped".
    pub pg_ctl: Option<(PathBuf, PathBuf)>,
    pub fault: Option<Fault>,
}

impl Setup {
    /// The composed tests': `pg_ctl` of `MIXDOG_PG_RUNTIME`.
    fn composed() -> Self {
        let pg_ctl = std::env::var_os("MIXDOG_PG_RUNTIME").map(PathBuf::from).map(|runtime| {
            (runtime.join("bin").join(if cfg!(windows) { "pg_ctl.exe" } else { "pg_ctl" }), runtime.join("lib"))
        });
        Self { budget: BUDGET, pg_ctl, fault: None }
    }
}

/// What a run found.
#[derive(Debug)]
pub(crate) struct Report {
    pub test: String,
    pub dir: PathBuf,
    pub failures: Vec<String>,
    /// What may be left: processes, groups, directories.
    pub left: Vec<String>,
    pub removed: bool,
    /// Windows: how many processes the child's job ever held.
    pub job_processes: Option<u32>,
}

impl std::fmt::Display for Report {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f, "{} (directory {}): {} problem(s)", self.test, self.dir.display(), self.failures.len())?;
        if let Some(processes) = self.job_processes {
            writeln!(f, "the child's job held {processes} process(es) in all")?;
        }
        for failure in &self.failures {
            writeln!(f, "- {failure}")?;
        }
        if self.left.is_empty() {
            writeln!(f, "left behind: nothing")
        } else {
            writeln!(f, "left behind:")?;
            self.left.iter().try_for_each(|left| writeln!(f, "- {left}"))
        }
    }
}

/// The data directory of a composed test working in `dir` (`<dir>/data`), with the runtime of `MIXDOG_PG_RUNTIME` installed in it.
pub fn data_in(dir: &Path) -> PathBuf {
    let data = dir.join("data");
    install(&data);
    data
}

/// Runs a test that composes the real core under the runner's contract (module doc): in the child process `body` runs on a runtime built by `runtime`
/// over the test's own directory; in the parent the run's report fails the test unless it found no problem.
pub fn in_child<F, Fut>(module: &str, name: &str, runtime: tokio::runtime::Builder, body: F)
where
    F: FnOnce(PathBuf) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    if child_side(runtime, body) {
        return;
    }
    let report = run(&test_path(module, name), &Setup::composed());
    assert!(report.failures.is_empty(), "{report}");
}

/// The test's path as libtest names it (`module_path!()` without the crate).
fn test_path(module: &str, name: &str) -> String {
    format!("{}::{name}", module.split_once("::").map_or(module, |(_, path)| path))
}

/// In a child process (or a sink a runner test started), runs its part and returns `true`; in the parent returns `false`.
#[allow(clippy::disallowed_methods, reason = "test harness: the child's gate on its own stdin")]
fn child_side<F, Fut>(mut runtime: tokio::runtime::Builder, body: F) -> bool
where
    F: FnOnce(PathBuf) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    if std::env::var_os(SINK).is_some() {
        let _ = std::io::copy(&mut std::io::stdin(), &mut std::io::sink());
        return true;
    }
    let Some(dir) = std::env::var_os(CHILD_DIR) else { return false };
    gate();
    let runtime = runtime.enable_all().build().expect("the test's runtime");
    runtime.block_on(body(PathBuf::from(dir)));
    true
}

/// The child's gate: it announces itself, then starts nothing until the parent's word (which comes once it is in its tree), under the start share.
#[allow(clippy::disallowed_methods, reason = "test harness: the child's gate on its own stdin")]
fn gate() {
    let mut out = std::io::stdout();
    // On a line of its own: libtest has written `test <name> ... ` without an end of line.
    writeln!(out, "\n{READY}").and_then(|()| out.flush()).expect("the child's stdout");
    let (said, word) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut byte = [0u8];
        let _ = said.send(std::io::stdin().read_exact(&mut byte).map(|()| byte[0]));
    });
    let limit = Duration::from_secs(BUDGET.start);
    match word.recv_timeout(limit) {
        Ok(Ok(GO)) => {}
        other => panic!("the parent's word to go did not come within {limit:?} (the start step): {other:?}"),
    }
}

/// What the parent hears of its child.
enum Event {
    Ready,
    /// The line of `Fault::KillOn`.
    Marker,
    OutputClosed,
    Exited(std::io::Result<std::process::ExitStatus>),
}

#[derive(Default)]
struct Heard {
    ready: bool,
    marker: bool,
    output_closed: bool,
    exited: Option<Result<std::process::ExitStatus, String>>,
}

impl Heard {
    fn note(&mut self, event: Event) {
        match event {
            Event::Ready => self.ready = true,
            Event::Marker => self.marker = true,
            Event::OutputClosed => self.output_closed = true,
            Event::Exited(status) => self.exited = Some(status.map_err(|error| error.to_string())),
        }
    }

    /// Takes events until `until` holds or `deadline` passes; returns whether it holds.
    fn wait(&mut self, events: &Receiver<Event>, deadline: Instant, until: impl Fn(&Self) -> bool) -> bool {
        while !until(self) {
            match events.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(event) => self.note(event),
                Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => return until(self),
            }
        }
        true
    }
}

/// One run of `test` (the parent's side of the contract, module doc).
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test harness: runs the test's child process and removes the test's own directory")]
pub(crate) fn run(test: &str, setup: &Setup) -> Report {
    let budget = setup.budget;
    let dir = tempfile::Builder::new().prefix("mixdog-composed-").tempdir().expect("the test's own directory").keep();
    let mut report = Report { test: test.to_owned(), dir: dir.clone(), failures: Vec::new(), left: Vec::new(), removed: false, job_processes: None };
    #[cfg(target_os = "linux")]
    let subreaper = become_subreaper().map_err(|error| report.failures.push(format!("the parent could not become a child subreaper: {error}"))).is_ok();

    // Step 1, start.
    let start_deadline = Instant::now() + Duration::from_secs(budget.start);
    let tree = match Tree::new() {
        Ok(tree) => tree,
        Err(error) => {
            report.failures.push(format!("the start step: no process tree for the child: {error}; nothing was started"));
            remove(&mut report);
            return report;
        }
    };
    let mut command = std::process::Command::new(std::env::current_exe().expect("the test binary"));
    command
        .args(["--exact", test, "--include-ignored", "--nocapture", "--test-threads=1"])
        .env(CHILD_DIR, &dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped());
    tree.prepare(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            report.failures.push(format!("the start step: the child did not start: {error}; nothing was started"));
            remove(&mut report);
            return report;
        }
    };
    let pid = child.id();
    let (sender, events) = std::sync::mpsc::channel();
    let mut stdin = child.stdin.take();
    relay(child.stdout.take().expect("piped"), sender.clone(), setup.fault);
    let mut heard = Heard::default();
    heard.wait(&events, start_deadline, |heard| heard.ready || heard.output_closed);
    let held = if heard.ready {
        match tree.hold(&child, setup.fault) {
            Ok(()) => true,
            Err(error) => {
                report.failures.push(format!("the start step: the child (pid {pid}) could not be put in its process tree: {error}; it was killed at its gate"));
                if setup.fault != Some(Fault::HoldFails) {
                    let _ = child.kill();
                }
                false
            }
        }
    } else {
        let why = if heard.output_closed { "ended its output before it reached its gate" } else { "did not reach its gate within the start step's share" };
        report.failures.push(format!("the start step: the child (pid {pid}) {why} ({} s); it was killed and never put in its process tree", budget.start));
        let _ = child.kill();
        false
    };
    std::thread::spawn(move || {
        let _ = sender.send(Event::Exited(child.wait()));
    });
    let mut killed = !held;

    // Step 2, child.
    if held {
        let went = stdin.as_mut().map(|stdin| stdin.write_all(&[GO]).and_then(|()| stdin.flush()));
        if let Some(Err(error)) = went {
            report.failures.push(format!("the start step: the word to go could not be written to the child (pid {pid}): {error}"));
        }
        let child_deadline = Instant::now() + Duration::from_secs(budget.child);
        let ended = heard.wait(&events, child_deadline, |heard| heard.exited.is_some() || heard.marker);
        if !ended || heard.marker {
            let why = if heard.marker { "was killed at its test's request".to_owned() } else { format!("ran over the child step's share ({} s) and was killed", budget.child) };
            report.failures.push(format!("the child step: the child (pid {pid}) {why} with its process tree{}", kill_failure(tree.kill(setup.fault))));
            killed = true;
        }
    }

    // Step 3, ending.
    let ending_deadline = Instant::now() + Duration::from_secs(budget.ending);
    let child_ended = heard.wait(&events, ending_deadline, |heard| heard.exited.is_some());
    match &heard.exited {
        Some(Ok(status)) if !status.success() && !killed => report.failures.push(format!("the child step: the child test process failed: {status}")),
        Some(Err(error)) => report.failures.push(format!("the ending step: the child (pid {pid}) could not be waited for: {error}")),
        _ => {}
    }
    if !child_ended {
        report.failures.push(format!("the ending step: the child (pid {pid}) was still running when the step's share ({} s) ran out", budget.ending));
        report.left.push(format!("the child test process, pid {pid}"));
    }
    let mut tree_empty = false;
    if held {
        // A kill this step makes keeps the grace it may need.
        let mut emptied = tree.wait_empty(if killed { ending_deadline } else { ending_deadline.checked_sub(KILL_GRACE).unwrap_or(ending_deadline) });
        if emptied.is_err() && !killed {
            report.failures.push(format!(
                "the ending step: processes the child started were still running after it ended ({}); its process tree was killed{}",
                emptied.as_ref().unwrap_err(),
                kill_failure(tree.kill(setup.fault))
            ));
            killed = true;
            emptied = tree.wait_empty(ending_deadline);
        }
        match emptied {
            Ok(()) => tree_empty = child_ended,
            Err(error) => {
                report.failures.push(format!("the ending step: the child's process tree was not proven empty within the step's share ({} s): {error}", budget.ending));
                report.left.push(tree.describe());
            }
        }
        report.job_processes = tree.processes_ever();
        if !heard.wait(&events, ending_deadline, |heard| heard.output_closed) {
            report.failures.push(format!("the ending step: the child's output was still held open by a process it started when the step's share ({} s) ran out", budget.ending));
            report.left.push("a process holding the child's output (outside its process tree)".to_owned());
            tree_empty = false;
        }
    }

    // Step 4, clusters. A "not running" status proves a stop only when nothing of the test can still be starting a cluster: on Windows once the job is
    // empty, on Linux by step 5, on macOS only after a normal end.
    let trust_not_running = if cfg!(target_os = "linux") { true } else if cfg!(windows) { tree_empty } else { tree_empty && !killed };
    let clusters_deadline = Instant::now() + Duration::from_secs(budget.clusters);
    let proven = examine_clusters(&dir, setup, clusters_deadline, trust_not_running, &mut report);

    // Step 5, descendants.
    #[cfg(target_os = "linux")]
    let proven = {
        let descendants = subreaper && descendants_step(budget, &mut report);
        proven && descendants
    };

    // Step 6, removal.
    if tree_empty && proven {
        remove(&mut report);
    } else {
        let why = if tree_empty { "a data directory in it is not proven stopped" } else { "the child's process tree was not proven ended" };
        report.failures.push(format!("the removal step: the test's directory {} is kept: {why}", dir.display()));
        report.left.push(format!("the test's directory {}", dir.display()));
    }
    // The word pipe closes last: a process the child started that reads it stays until here.
    drop(stdin);
    report
}

fn kill_failure(killed: std::io::Result<()>) -> String {
    killed.err().map_or_else(String::new, |error| format!(" (the kill failed: {error})"))
}

#[allow(clippy::disallowed_methods, reason = "test harness: removes the test's own directory")]
fn remove(report: &mut Report) {
    match std::fs::remove_dir_all(&report.dir) {
        Ok(()) => report.removed = true,
        Err(error) => {
            report.failures.push(format!("the removal step: {} was not removed: {error}; still held: {:?}", report.dir.display(), held_files(&report.dir)));
            report.left.push(format!("the test's directory {}", report.dir.display()));
        }
    }
}

/// Copies the child's output to the parent's, line by line, and tells the parent what it heard.
#[allow(clippy::disallowed_types, reason = "test harness: the output of a process the harness started")]
fn relay(output: std::process::ChildStdout, events: Sender<Event>, fault: Option<Fault>) {
    std::thread::spawn(move || {
        let mut output = std::io::BufReader::new(output);
        let mut line = Vec::new();
        loop {
            line.clear();
            match output.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let text = String::from_utf8_lossy(&line);
            let text = text.trim_end();
            if text == READY {
                let _ = events.send(Event::Ready);
                continue;
            }
            if matches!(fault, Some(Fault::KillOn(marker)) if text == marker) {
                let _ = events.send(Event::Marker);
            }
            let mut out = std::io::stdout();
            let _ = out.write_all(&line).and_then(|()| out.flush());
        }
        let _ = events.send(Event::OutputClosed);
    });
}

/// Runs `command` in a tree of its own until `deadline`, its output collected. Past the deadline its tree is killed and the process given
/// `KILL_GRACE`; one that does not end then is abandoned, named with its pid. `what` names the run.
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test harness: waits for a process the harness started")]
fn run_bounded(mut command: std::process::Command, deadline: Instant, what: &str) -> Result<std::process::Output, String> {
    let tree = Tree::new().map_err(|error| format!("{what}: no process tree: {error}"))?;
    // A held stdin: a run that reads it waits, as one that hangs would.
    command.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    tree.prepare(&mut command);
    let mut child = command.spawn().map_err(|error| format!("{what} did not start: {error}"))?;
    let pid = child.id();
    if let Err(error) = tree.hold(&child, None) {
        let _ = child.kill();
        return Err(format!("{what} (pid {pid}) could not be put in a process tree ({error}); it was killed and abandoned"));
    }
    let stdin = child.stdin.take();
    let (done, ended) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = done.send(child.wait_with_output());
    });
    let output = match ended.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        Ok(output) => output,
        Err(_) => {
            let killed = kill_failure(tree.kill(None));
            return match ended.recv_timeout(KILL_GRACE) {
                Ok(_) => Err(format!("{what} (pid {pid}) did not end by its step's deadline and was killed{killed}")),
                Err(_) => Err(format!(
                    "{what} (pid {pid}) did not end by its step's deadline, was killed{killed} and was still running {KILL_GRACE:?} later: abandoned{}",
                    if cfg!(windows) { " (its job is closed as this run returns, which ends it)" } else { "" }
                )),
            };
        }
    };
    drop(stdin);
    output.map_err(|error| format!("{what} (pid {pid}) could not be waited for: {error}"))
}

/// Step 4: every data directory under `dir` (one holding `PG_VERSION`, at any depth), examined by that directory until `deadline`. Returns whether
/// every one is proven stopped; each one that is not is a failure and is named among what is left.
#[allow(clippy::disallowed_types, reason = "test harness: runs pg_ctl on the test's own data directories")]
fn examine_clusters(dir: &Path, setup: &Setup, deadline: Instant, trust_not_running: bool, report: &mut Report) -> bool {
    let mut pgdatas = Vec::new();
    let mut proven = true;
    if let Err(error) = find_pgdata(dir, &mut pgdatas) {
        report.failures.push(format!("the clusters step: {} could not be searched for data directories: {error}", dir.display()));
        proven = false;
    }
    let share = setup.budget.clusters;
    for pgdata in pgdatas {
        let shown = pgdata.display();
        let Some((pg_ctl, _lib)) = &setup.pg_ctl else {
            report.failures.push(format!("the clusters step: {shown} cannot be examined: no PostgreSQL runtime is known (MIXDOG_PG_RUNTIME)"));
            report.left.push(format!("data directory {shown}, not proven stopped"));
            proven = false;
            continue;
        };
        let pg = |args: &[&str], deadline: Instant| {
            let mut command = std::process::Command::new(pg_ctl);
            command.args(args).arg("-D").arg(&pgdata);
            #[cfg(target_os = "linux")]
            command.env("LD_LIBRARY_PATH", _lib);
            #[cfg(target_os = "macos")]
            command.env("DYLD_LIBRARY_PATH", _lib);
            run_bounded(command, deadline, &format!("pg_ctl {} -D {shown}", args[0]))
        };
        // A run gets what is left of the share less the grace its kill may need.
        let run_deadline = || deadline.checked_sub(KILL_GRACE).filter(|at| *at > Instant::now());
        let Some(status_deadline) = run_deadline() else {
            report.failures.push(format!("the clusters step: {shown} was not examined: the step's share ({share} s) ran out"));
            report.left.push(format!("data directory {shown}, not proven stopped"));
            proven = false;
            continue;
        };
        let stopped = match pg(&["status"], status_deadline) {
            Ok(output) if output.status.code() == Some(3) && trust_not_running => Ok(()),
            Ok(output) if output.status.code() == Some(3) => {
                Err("pg_ctl status says no server runs, which does not prove it after this end (a postmaster may still be starting)".to_owned())
            }
            Ok(output) if output.status.success() => {
                report.failures.push(format!("the clusters step: a cluster was still running in {shown} after the child ended; it is stopped by its data directory"));
                match run_deadline() {
                    None => Err(format!("its stop could not run: the step's share ({share} s) ran out")),
                    Some(stop_deadline) => {
                        let seconds = stop_deadline.saturating_duration_since(Instant::now()).as_secs().max(1).to_string();
                        match pg(&["stop", "-m", "fast", "-w", "-t", &seconds], stop_deadline) {
                            Ok(stopped) if stopped.status.success() => Ok(()),
                            Ok(stopped) => Err(format!("pg_ctl stop failed: {} {}", stopped.status, String::from_utf8_lossy(&stopped.stderr).trim())),
                            Err(failure) => Err(failure),
                        }
                    }
                }
            }
            Ok(output) => Err(format!("its state cannot be decided: pg_ctl status: {} {}", output.status, String::from_utf8_lossy(&output.stderr).trim())),
            Err(failure) => Err(failure),
        };
        if let Err(why) = stopped {
            report.failures.push(format!("the clusters step: {shown} is not proven stopped: {why}"));
            report.left.push(format!("data directory {shown}, not proven stopped"));
            proven = false;
        }
    }
    proven
}

/// The data directories under `dir`: every directory holding `PG_VERSION`, at any depth (links are not followed).
#[allow(clippy::disallowed_methods, reason = "test harness: searches the test's own directory")]
fn find_pgdata(dir: &Path, found: &mut Vec<PathBuf>) -> std::io::Result<()> {
    if dir.join("PG_VERSION").is_file() {
        found.push(dir.to_owned());
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            find_pgdata(&entry.path(), found)?;
        }
    }
    Ok(())
}

/// The files under `dir` that cannot be removed now (a process still holds them).
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test harness: lists the test's own files that cannot be removed")]
fn held_files(dir: &Path) -> Vec<String> {
    let mut held = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return held };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            held.extend(held_files(&path));
        } else if std::fs::remove_file(&path).is_err() {
            held.push(path.display().to_string());
        }
    }
    held
}

/// A process and everything it starts, as one unit to kill and to see end: a job object of the test (nested above the jobs the process makes for its
/// own children, and allowing no breakaway). Closing it kills whatever is left.
#[cfg(windows)]
struct Tree {
    job: windows_sys::Win32::Foundation::HANDLE,
    /// The completion port the job reports to: its "last process ended" message is what `wait_empty` waits for.
    port: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl Tree {
    fn new() -> std::io::Result<Self> {
        use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
        use windows_sys::Win32::System::IO::CreateIoCompletionPort;
        use windows_sys::Win32::System::JobObjects::*;
        // SAFETY: plain constructors; each handle is checked and owned by the `Tree` (closed in `drop`).
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let port = unsafe { CreateIoCompletionPort(INVALID_HANDLE_VALUE, std::ptr::null_mut(), 0, 1) };
        if port.is_null() {
            let error = std::io::Error::last_os_error();
            unsafe { windows_sys::Win32::Foundation::CloseHandle(job) };
            return Err(error);
        }
        let tree = Self { job, port };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let association = JOBOBJECT_ASSOCIATE_COMPLETION_PORT { CompletionKey: std::ptr::null_mut(), CompletionPort: port };
        // SAFETY: the job handle is valid and each structure is passed with its own size.
        let set = unsafe {
            SetInformationJobObject(job, JobObjectExtendedLimitInformation, std::ptr::addr_of!(limits).cast(), std::mem::size_of_val(&limits) as u32) != 0
                && SetInformationJobObject(job, JobObjectAssociateCompletionPortInformation, std::ptr::addr_of!(association).cast(), std::mem::size_of_val(&association) as u32) != 0
        };
        if set { Ok(tree) } else { Err(std::io::Error::last_os_error()) }
    }

    #[allow(clippy::disallowed_types, reason = "test harness: the command of a process the harness starts")]
    fn prepare(&self, _: &mut std::process::Command) {}

    /// Puts `child` in the job: everything it starts from then on is in it too.
    #[allow(clippy::disallowed_types, reason = "test harness: a process the harness started")]
    fn hold(&self, child: &std::process::Child, fault: Option<Fault>) -> std::io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        if fault == Some(Fault::HoldFails) {
            return Err(std::io::Error::other("the test's fault"));
        }
        // SAFETY: both handles are valid; the child's is open while `child` lives.
        let held = unsafe { windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(self.job, child.as_raw_handle()) };
        if held != 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
    }

    fn kill(&self, fault: Option<Fault>) -> std::io::Result<()> {
        if fault == Some(Fault::TreeKillFails) {
            return Ok(());
        }
        // SAFETY: the job handle is valid.
        let killed = unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job, 1) };
        if killed != 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
    }

    fn accounting(&self) -> Option<windows_sys::Win32::System::JobObjects::JOBOBJECT_BASIC_ACCOUNTING_INFORMATION> {
        use windows_sys::Win32::System::JobObjects::*;
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        // SAFETY: the job handle is valid and the structure is passed with its own size.
        let got = unsafe { QueryInformationJobObject(self.job, JobObjectBasicAccountingInformation, std::ptr::addr_of_mut!(info).cast(), std::mem::size_of_val(&info) as u32, std::ptr::null_mut()) };
        (got != 0).then_some(info)
    }

    fn processes_ever(&self) -> Option<u32> {
        self.accounting().map(|info| info.TotalProcesses)
    }

    /// The pids in the job now (at most 64).
    fn pids(&self) -> Vec<usize> {
        #[repr(C)]
        struct List {
            assigned: u32,
            listed: u32,
            pids: [usize; 64],
        }
        let mut list = List { assigned: 0, listed: 0, pids: [0; 64] };
        // SAFETY: the job handle is valid and the buffer is passed with its own size (the documented layout with room for 64 ids).
        let got = unsafe {
            windows_sys::Win32::System::JobObjects::QueryInformationJobObject(
                self.job,
                windows_sys::Win32::System::JobObjects::JobObjectBasicProcessIdList,
                std::ptr::addr_of_mut!(list).cast(),
                std::mem::size_of_val(&list) as u32,
                std::ptr::null_mut(),
            )
        };
        if got == 0 { Vec::new() } else { list.pids[..(list.listed as usize).min(64)].to_vec() }
    }

    fn describe(&self) -> String {
        format!("the processes of the child's job, pids {:?} (the job is closed as this run returns, which ends them)", self.pids())
    }

    /// Waits until `deadline` for the job to hold no process. Every message of the job's port (a process ended, the last one ended) wakes the check of
    /// its count, so a message from an earlier moment is not taken for the state now.
    fn wait_empty(&self, deadline: Instant) -> Result<(), String> {
        use windows_sys::Win32::System::IO::{GetQueuedCompletionStatus, OVERLAPPED};
        loop {
            if self.accounting().is_some_and(|info| info.ActiveProcesses == 0) {
                return Ok(());
            }
            let left = u32::try_from(deadline.saturating_duration_since(Instant::now()).as_millis()).unwrap_or(u32::MAX);
            let (mut message, mut key, mut overlapped) = (0u32, 0usize, std::ptr::null_mut::<OVERLAPPED>());
            // SAFETY: the port handle is valid and every out pointer points at a local.
            let got = unsafe { GetQueuedCompletionStatus(self.port, &mut message, &mut key, &mut overlapped, left) };
            if got == 0 && overlapped.is_null() {
                return Err(format!("its job still held pids {:?}", self.pids()));
            }
        }
    }
}

#[cfg(windows)]
impl Drop for Tree {
    fn drop(&mut self) {
        // SAFETY: both handles are owned by the `Tree` and closed once; closing the job kills what is left in it.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job);
            windows_sys::Win32::Foundation::CloseHandle(self.port);
        }
    }
}

/// A process and what it starts, as a process group of its own (made at the spawn, before the program runs). What leaves the group (a postmaster
/// started through `pg_ctl`, which calls `setsid`) is outside it: see the module doc.
#[cfg(unix)]
struct Tree {
    group: std::sync::OnceLock<libc::pid_t>,
    /// Linux: the watcher's answer, once it is started.
    #[cfg(target_os = "linux")]
    watch: std::sync::Mutex<Option<Receiver<Result<(), String>>>>,
}

#[cfg(unix)]
impl Tree {
    fn new() -> std::io::Result<Self> {
        Ok(Self {
            group: std::sync::OnceLock::new(),
            #[cfg(target_os = "linux")]
            watch: std::sync::Mutex::new(None),
        })
    }

    #[allow(clippy::disallowed_types, reason = "test harness: the command of a process the harness starts")]
    fn prepare(&self, command: &mut std::process::Command) {
        std::os::unix::process::CommandExt::process_group(command, 0);
    }

    #[allow(clippy::disallowed_types, reason = "test harness: a process the harness started")]
    fn hold(&self, child: &std::process::Child, fault: Option<Fault>) -> std::io::Result<()> {
        if fault == Some(Fault::HoldFails) {
            return Err(std::io::Error::other("the test's fault"));
        }
        let group = libc::pid_t::try_from(child.id()).map_err(std::io::Error::other)?;
        let _ = self.group.set(group);
        Ok(())
    }

    fn kill(&self, fault: Option<Fault>) -> std::io::Result<()> {
        if fault == Some(Fault::TreeKillFails) {
            return Ok(());
        }
        let group = *self.group.get().expect("a held process");
        // SAFETY: killpg has no memory preconditions; the group is the one the child leads.
        if unsafe { libc::killpg(group, libc::SIGKILL) } == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
    }

    /// Whether the group has a member now (zombies included).
    fn has_members(group: libc::pid_t) -> bool {
        // SAFETY: as in `kill`; signal 0 only checks.
        unsafe { libc::killpg(group, 0) == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) }
    }

    fn processes_ever(&self) -> Option<u32> {
        None
    }

    fn describe(&self) -> String {
        format!("process group {}", self.group.get().map_or_else(|| "?".to_owned(), ToString::to_string))
    }

    /// Linux: waits until `deadline` for the group to have no member. Its members that outlive their parents become this process's children (it is a
    /// subreaper), so reaping the group's children until there is none, then finding the group empty, establishes it.
    #[cfg(target_os = "linux")]
    fn wait_empty(&self, deadline: Instant) -> Result<(), String> {
        let group = *self.group.get().expect("a held process");
        let mut watch = self.watch.lock().expect("the watch");
        let answer = watch.take().unwrap_or_else(|| {
            let (said, answer) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let reaped = reap(libc::P_PGID, libc::id_t::try_from(group).expect("a pid"));
                let _ = said.send(reaped.and_then(|()| {
                    if Self::has_members(group) { Err(format!("process group {group} still has members that are not this process's children")) } else { Ok(()) }
                }));
            });
            answer
        });
        match answer.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Ok(())) => {
                *watch = Some(done());
                Ok(())
            }
            Ok(Err(error)) => Err(error),
            Err(_) => {
                *watch = Some(answer);
                Err(format!("process group {group} still had members"))
            }
        }
    }

    /// Other Unix (no subreaper): the group is checked once, without a wait (module doc).
    #[cfg(not(target_os = "linux"))]
    fn wait_empty(&self, _: Instant) -> Result<(), String> {
        let group = *self.group.get().expect("a held process");
        if Self::has_members(group) { Err(format!("process group {group} still has members (this OS gives no way to wait for them)")) } else { Ok(()) }
    }
}

/// An answer that is already "empty", for a watch that has given it.
#[cfg(target_os = "linux")]
fn done() -> Receiver<Result<(), String>> {
    let (said, answer) = std::sync::mpsc::channel();
    let _ = said.send(Ok(()));
    answer
}

/// Linux: reaps this process's children selected by `which`/`id` until it has none.
#[cfg(target_os = "linux")]
fn reap(which: libc::idtype_t, id: libc::id_t) -> Result<(), String> {
    loop {
        // SAFETY: `info` is a local the call fills.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        if unsafe { libc::waitid(which, id, &mut info, libc::WEXITED) } == 0 {
            continue;
        }
        let error = std::io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::ECHILD) => return Ok(()),
            Some(libc::EINTR) => {}
            _ => return Err(format!("waitid: {error}")),
        }
    }
}

#[cfg(target_os = "linux")]
fn become_subreaper() -> std::io::Result<()> {
    // SAFETY: prctl with integer arguments only.
    if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
}

/// Step 5 (Linux): whether every process descended from the test has ended within its share; if not, a failure.
#[cfg(target_os = "linux")]
fn descendants_step(budget: Budget, report: &mut Report) -> bool {
    match descendants_ended(Instant::now() + Duration::from_secs(budget.descendants)) {
        Ok(()) => true,
        Err(error) => {
            report.failures.push(format!("the descendants step: {error} within the step's share ({} s); every data directory is kept", budget.descendants));
            report.left.push("a process descended from the test (a postmaster still starting is one)".to_owned());
            false
        }
    }
}

/// Waits until `deadline` for every process descended from this one to have ended (every orphan among them is this process's child).
#[cfg(target_os = "linux")]
fn descendants_ended(deadline: Instant) -> Result<(), String> {
    let (said, answer) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = said.send(reap(libc::P_ALL, 0));
    });
    match answer.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        Ok(reaped) => reaped,
        Err(_) => Err("a process descended from the test was still running".to_owned()),
    }
}

#[allow(clippy::disallowed_methods, reason = "test fixture: copies an unpacked runtime into the layout `ensure_runtime` reads")]
pub fn install(data: &Path) {
    let source = std::path::PathBuf::from(std::env::var_os("MIXDOG_PG_RUNTIME").expect("MIXDOG_PG_RUNTIME names a bundled postgres runtime dir"));
    let manifest = Manifest::bundled().expect("the bundled manifest");
    let (asset, _) = manifest.select(&Platform::current()).expect("the manifest has a runtime for this platform");
    let key = install_key(&manifest.version(), &asset.sha256);
    let base = data.join("runtime");
    let target = ver_dir(&base, &key);
    copy_tree(&source, &target);
    std::fs::write(target.join(".version-sha256"), &asset.sha256).expect("the stamp");
    std::fs::write(base.join("active-version"), &key).expect("the active version");
}

#[allow(clippy::disallowed_methods, reason = "test fixture")]
fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).expect("the target directory");
    for entry in std::fs::read_dir(from).expect("the runtime directory") {
        let entry = entry.expect("a runtime entry");
        let target = to.join(entry.file_name());
        if entry.file_type().expect("an entry type").is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).expect("a runtime file");
        }
    }
}

/// What a user's settings hold once a provider is signed in and a model is chosen: the provider in `mixdog-config.json`, its listed model in the catalog cache the core cold-starts
/// from (`catalogs/snapshot.json`), and the preset `default` names. The provider needs no key (`auth: none`) and its address is never called by a test that starts no turn.
#[allow(clippy::disallowed_methods, reason = "test fixture: the settings files a user's setup would have written")]
pub fn seed_default_model(data: &Path) {
    const PROVIDER: &str = "custom-test";
    const MODEL: &str = "test-model";
    let config = serde_json::json!({ "agent": {
        "providers": { PROVIDER: {
            "type": "custom", "schemaVersion": 2, "name": "test", "protocol": "openai-chat",
            "baseURL": "http://127.0.0.1:9", "auth": "none", "enabled": true,
            "modelOverrides": { MODEL: { "manual": true } },
        } },
        "default": "main",
        "presets": [{ "id": "main", "name": "main", "provider": PROVIDER, "model": MODEL }],
    } });
    std::fs::write(data.join("mixdog-config.json"), config.to_string()).expect("the settings file");
    let snapshot = serde_json::json!({ "generation": 1, "models": { PROVIDER: [{
        "id": MODEL, "provider": PROVIDER, "displayName": null, "rates": {}, "vision": "unknown",
        "functionCalling": "unknown", "reasoning": "unknown", "fastMode": "unknown",
        "reasoningEfforts": [], "source": "native", "manual": true,
    }] } });
    std::fs::create_dir_all(data.join("catalogs")).expect("the catalog directory");
    std::fs::write(data.join("catalogs").join("snapshot.json"), snapshot.to_string()).expect("the catalog cache");
}

/// The catalog's HTTP port in every real-core test: a client that cannot connect, so the boot warm-up (200 ms after
/// the composition starts) never reaches a network.
pub fn offline_http() -> std::sync::Arc<dyn mixdog_ai::transport::http::HttpSend> {
    std::sync::Arc::new(OfflineHttp)
}

struct OfflineHttp;

#[async_trait::async_trait]
impl mixdog_ai::transport::http::HttpSend for OfflineHttp {
    async fn send(
        &self,
        _: mixdog_core_api::domain::provider::WireRequest,
        _: mixdog_ai::transport::Exchange,
    ) -> Result<mixdog_ai::transport::http::HttpResponse, mixdog_core_api::domain::provider::ProviderError> {
        Err(mixdog_core_api::domain::provider::ProviderError::new(
            mixdog_core_api::domain::provider::ErrorKind::Transient,
            mixdog_core_api::domain::provider::DeliveryState::NotSent,
        ))
    }
}