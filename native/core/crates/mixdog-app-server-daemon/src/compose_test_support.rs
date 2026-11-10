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
//! - The runner runs under nextest only, one test per process (nextest sets `NEXTEST`): on Linux its reaper (`waitid(P_ALL)`, step 5) takes every
//!   child of the process, another test's too. Started otherwise (a plain `cargo test`) it refuses, naming the nextest command.
//!
//! Time: one end for the whole run, fixed when it starts, [`BUDGET`]'s total after it (under the 720 s nextest gives these tests,
//! `.config/nextest.toml`). Each step's deadline is the end of its share or the run's end, whichever comes first, so time lost outside the steps' waits
//! (process creation, discovery) comes off the run, not on top of it. A failure names the step whose time ran out.
//!
//! The steps, in order:
//! 1. start: the child is started and announces [`READY`] before it starts anything; only then is it put in its process tree and told to go
//!    (over its stdin), so nothing it starts is outside the tree. The child waits for the word under the same share and fails without it.
//! 2. child: the child runs to its end, or past its share it is killed with its whole tree.
//! 3. ending: the child has ended, its process tree is established empty (killed, if something outlived a child that ended by itself) and its output is
//!    closed (no process it started still holds it). On Unix the child is reaped only after its group was checked: until then its zombie keeps its pid,
//!    which is the group's id, from being reused, so the kill and the check reach that group and no other. A child that could not be killed is
//!    reported here and not waited for again.
//! 4. clusters, only when step 3 proved the tree ended (otherwise nothing is examined: the failure says "not examined: the tree was not proven
//!    ended", the directory is kept and what is known to be alive is listed). Every data directory under the test's directory (a directory holding
//!    `PG_VERSION`, at any depth; the walk does not descend into a data directory it found, whose contents belong to that cluster) is examined with
//!    `pg_ctl status`, by that directory; a running one is a failure and is stopped (`pg_ctl stop -m fast`); one whose state cannot be decided, whose
//!    stop failed or that the step's time left unexamined is "not proven stopped". An entry the walk cannot read and a link or junction (never followed)
//!    are each listed as unexamined, which keeps the directory, and the walk goes on with their siblings.
//! 5. descendants (Linux), only when the tree was proven ended: every process descended from the test has ended (see below).
//! 6. removal, only when every earlier step proved its part.
//!
//! Helpers: every `pg_ctl` the runner runs (`status`, `stop`) runs in a tree of its own, started inside it with no window (Windows: created suspended,
//! put in its job, then resumed; Unix: a process group of its own, made at the spawn before its program runs, its leader left unreaped until the group
//! was checked), until `KILL_GRACE` before its step's deadline. Its result is used only once that tree is proven ended: a helper that leaves a
//! process running is killed with its tree and its result is not used. One that does not end after its kill is abandoned and named with its pid among
//! what is left. A start helper (`pg_ctl start`, which a test may run, never the runner) runs in its caller's tree instead, because its postmaster
//! legitimately outlives it: on Windows the postmaster stays in that tree's job; on Unix it leaves the group and is accounted for by the cluster step
//! (by its data directory) and, on Linux, step 5, not by any tree.
//!
//! What reaches a cluster: the product starts PostgreSQL by spawning `pg_ctl start` (`mixdog-services/src/memory/pg/cluster.rs`, `spawn_start`) through
//! `tokio::process::Command`, outside the process manager's jobs, and never kills it; the postmaster is started by `pg_ctl`, not by the core. On Windows
//! `pg_ctl` starts it (through `cmd`) in the job of its caller, which allows no breakaway: the child's job holds it, and an empty job means the postmaster
//! has ended. On Unix `pg_ctl` forks, calls `setsid` and execs the postmaster, so it leaves the child's process group and the group kill does not reach it:
//! only the stop by data directory does. On Linux the parent is a child subreaper (`PR_SET_CHILD_SUBREAPER`), so an orphaned postmaster becomes its child
//! and step 5 waits for it: a postmaster still starting when its directory was examined (no `postmaster.pid` yet, `pg_ctl status` 3) keeps step 5 from
//! ending and the directory is kept. On Linux a group member is waited for through a pidfd, on macOS through a kqueue `NOTE_EXIT`. macOS has no
//! subreaper: after an abnormal end a "not running" status is not taken as proof there (the directory is kept).
//!
//! Rulings (what the runner deliberately does not do):
//! - Synchronous filesystem calls (`remove_dir_all`, the discovery walk, the listing of held files) have no deadline of their own. A filesystem that
//!   stalls is bounded by nextest's time limit for the test, which kills the test process: on Windows its jobs are kill-on-close, so what they hold
//!   ends with it; on Unix the child's process group survives it (a limit). Filesystem calls are not wrapped in threads to time them out.
//! - The walk does not descend into a data directory it found.
//! - The Unix-only code (process groups, the unreaped leader, the Linux reaper and pidfd waits, the macOS kqueue waits) cannot run on the PC it was
//!   written on: it is proven by reading and by its first run in `.github/workflows/rust-core-unix.yml`.
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
/// Set in a helper a runner test starts: it starts a sink (running the test named here) holding only its stdin, and exits.
const SPAWN: &str = "MIXDOG_COMPOSED_TEST_SPAWN";
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
    /// Time the run counts as already spent when it starts (a runner test's stand-in for time lost outside the steps' waits): its end comes that
    /// much sooner.
    pub lost: Duration,
}

impl Setup {
    /// The composed tests': `pg_ctl` of `MIXDOG_PG_RUNTIME`.
    fn composed() -> Self {
        let pg_ctl = std::env::var_os("MIXDOG_PG_RUNTIME").map(PathBuf::from).map(|runtime| {
            (runtime.join("bin").join(if cfg!(windows) { "pg_ctl.exe" } else { "pg_ctl" }), runtime.join("lib"))
        });
        Self { budget: BUDGET, pg_ctl, fault: None, lost: Duration::ZERO }
    }
}

/// The run's one end, fixed when it starts: a step's deadline is the end of its share or the run's end, whichever comes first.
struct Clock {
    end: Instant,
}

impl Clock {
    fn new(setup: &Setup) -> Self {
        Self { end: Instant::now() + Duration::from_secs(setup.budget.total()).saturating_sub(setup.lost) }
    }

    fn step(&self, share: u64) -> Instant {
        (Instant::now() + Duration::from_secs(share)).min(self.end)
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

/// In a child process (or a process a runner test started), runs its part and returns `true`; in the parent returns `false`.
#[allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    clippy::zombie_processes,
    reason = "test harness: the child's gate on its own stdin, and the processes runner tests start (the helper's sink is its runner's to end)"
)]
fn child_side<F, Fut>(mut runtime: tokio::runtime::Builder, body: F) -> bool
where
    F: FnOnce(PathBuf) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    if std::env::var_os(SINK).is_some() {
        let _ = std::io::copy(&mut std::io::stdin(), &mut std::io::sink());
        return true;
    }
    if let Some(test) = std::env::var_os(SPAWN) {
        // A helper that starts a sink holding only its own stdin (which the helper's runner holds open) and exits without waiting for it.
        std::process::Command::new(std::env::current_exe().expect("the test binary"))
            .arg("--exact")
            .arg(&test)
            .args(["--include-ignored", "--nocapture"])
            .env_remove(SPAWN)
            .env(SINK, "1")
            .stdin(std::process::Stdio::inherit())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("the helper's sink starts");
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
    /// The child has exited (not reaped yet: `watch_exit`).
    Exited(Result<(), String>),
}

#[derive(Default)]
struct Heard {
    ready: bool,
    marker: bool,
    output_closed: bool,
    exited: Option<Result<(), String>>,
}

impl Heard {
    fn note(&mut self, event: Event) {
        match event {
            Event::Ready => self.ready = true,
            Event::Marker => self.marker = true,
            Event::OutputClosed => self.output_closed = true,
            Event::Exited(exited) => self.exited = Some(exited),
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

/// The message of a runner started outside nextest (module doc).
const ONE_TEST_PER_PROCESS: &str = "the composed-test runner needs a process of its own per test (on Linux its reaper, `waitid(P_ALL)`, takes every \
     child of the process, another test's too): run it under nextest, `cargo nextest run --profile pg --run-ignored only -p mixdog-app-server-daemon` \
     for the composed tests or `cargo nextest run -p mixdog-app-server-daemon compose_test_support::runner_tests` for the runner's own";

/// One run of `test` (the parent's side of the contract, module doc).
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test harness: runs the test's child process and removes the test's own directory")]
pub(crate) fn run(test: &str, setup: &Setup) -> Report {
    assert!(std::env::var_os("NEXTEST").is_some(), "{ONE_TEST_PER_PROCESS}");
    let budget = setup.budget;
    let clock = Clock::new(setup);
    let dir = tempfile::Builder::new().prefix("mixdog-composed-").tempdir().expect("the test's own directory").keep();
    let mut report = Report { test: test.to_owned(), dir: dir.clone(), failures: Vec::new(), left: Vec::new(), removed: false, job_processes: None };
    #[cfg(target_os = "linux")]
    let subreaper = become_subreaper().map_err(|error| report.failures.push(format!("the parent could not become a child subreaper: {error}"))).is_ok();

    // Step 1, start.
    let start_deadline = clock.step(budget.start);
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
        let why = if heard.output_closed { "ended its output before it reached its gate" } else { "did not reach its gate by the start step's deadline" };
        report.failures.push(format!("the start step: the child (pid {pid}) {why} (share {} s); it was killed and never put in its process tree", budget.start));
        let _ = child.kill();
        false
    };
    watch_exit(&child, move |exited| {
        let _ = sender.send(Event::Exited(exited));
    });
    let mut killed = !held;

    // Step 2, child.
    if held {
        let went = stdin.as_mut().map(|stdin| stdin.write_all(&[GO]).and_then(|()| stdin.flush()));
        if let Some(Err(error)) = went {
            report.failures.push(format!("the start step: the word to go could not be written to the child (pid {pid}): {error}"));
        }
        let ended = heard.wait(&events, clock.step(budget.child), |heard| heard.exited.is_some() || heard.marker);
        if !ended || heard.marker {
            let why =
                if heard.marker { "was killed at its test's request".to_owned() } else { format!("ran over the child step's time (share {} s) and was killed", budget.child) };
            report.failures.push(format!("the child step: the child (pid {pid}) {why} with its process tree{}", kill_failure(tree.kill(setup.fault))));
            killed = true;
        }
    }

    // Step 3, ending.
    let ending_deadline = clock.step(budget.ending);
    heard.wait(&events, ending_deadline, |heard| heard.exited.is_some());
    let child_ended = matches!(heard.exited, Some(Ok(())));
    match &heard.exited {
        None => report.failures.push(format!("the ending step: the child (pid {pid}) was still running when the step's time ran out (share {} s)", budget.ending)),
        Some(Err(error)) => report.failures.push(format!("the ending step: the child (pid {pid}) could not be waited for: {error}")),
        Some(Ok(())) => {}
    }
    if !child_ended {
        report.left.push(format!("the child test process, pid {pid}"));
    }
    let mut tree_ended = false;
    if held {
        // A kill this step makes keeps the grace it may need.
        let mut emptied = tree.wait_empty(if killed { ending_deadline } else { ending_deadline.checked_sub(KILL_GRACE).unwrap_or(ending_deadline) }, child_ended);
        if emptied.is_err() && !killed {
            report.failures.push(format!(
                "the ending step: processes the child started were still running after it ended ({}); its process tree was killed{}",
                emptied.as_ref().unwrap_err(),
                kill_failure(tree.kill(setup.fault))
            ));
            killed = true;
            emptied = tree.wait_empty(ending_deadline, child_ended);
        }
        match emptied {
            Ok(()) => tree_ended = child_ended,
            Err(error) => {
                report.failures.push(format!("the ending step: the child's process tree was not proven empty when the step's time ran out (share {} s): {error}", budget.ending));
                report.left.push(tree.describe());
            }
        }
        report.job_processes = tree.processes_ever();
        if !heard.wait(&events, ending_deadline, |heard| heard.output_closed) {
            report.failures.push(format!("the ending step: the child's output was still held open by a process it started when the step's time ran out (share {} s)", budget.ending));
            report.left.push("a process holding the child's output (outside its process tree)".to_owned());
            tree_ended = false;
        }
    }
    // The child is reaped only now that its group was checked: on Unix its zombie kept its pid, the group's id, from being reused until here.
    if child_ended {
        match child.wait() {
            Ok(status) if !status.success() && !killed => report.failures.push(format!("the child step: the child test process failed: {status}")),
            Ok(_) => {}
            Err(error) => report.failures.push(format!("the ending step: the child's status could not be read: {error}")),
        }
    }

    // Step 4, clusters, only once the tree is proven ended: then nothing of the test can still be starting a cluster (on Linux step 5 also waits for
    // an orphaned postmaster). On macOS a "not running" status after an abnormal end is not taken as proof (module doc).
    let proven = if tree_ended {
        let trust_not_running = !(cfg!(target_os = "macos") && killed);
        examine_clusters(&dir, setup, clock.step(budget.clusters), trust_not_running, &mut report)
    } else {
        report.failures.push(format!(
            "the clusters step: the data directories under {} were not examined: the child's process tree was not proven ended (what is known to be alive is \
             under \"left behind\")",
            dir.display()
        ));
        false
    };

    // Step 5, descendants (Linux), only once the tree is proven ended: otherwise it would wait for the child itself.
    #[cfg(target_os = "linux")]
    let proven = {
        let descendants = tree_ended && subreaper && descendants_step(clock.step(budget.descendants), budget.descendants, &mut report);
        proven && descendants
    };

    // Step 6, removal.
    if tree_ended && proven {
        remove(&mut report);
    } else {
        let why = if tree_ended { "a data directory in it is not proven stopped" } else { "the child's process tree was not proven ended" };
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

/// Tells `said` when `child` has exited, leaving it unreaped: its status is read afterwards with `child.wait()`. On Unix the unreaped child keeps its
/// pid (its process group's id) from being reused until then.
#[cfg(unix)]
#[allow(clippy::disallowed_types, reason = "test harness: a process the harness started")]
fn watch_exit(child: &std::process::Child, said: impl FnOnce(Result<(), String>) + Send + 'static) {
    let pid: libc::id_t = child.id();
    std::thread::spawn(move || said(exited_unreaped(pid)));
}

/// Waits for the process `pid` (a child of this one) to have exited, leaving it unreaped (`WNOWAIT`).
#[cfg(unix)]
fn exited_unreaped(pid: libc::id_t) -> Result<(), String> {
    loop {
        // SAFETY: `info` is a local the call fills.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        if unsafe { libc::waitid(libc::P_PID, pid, &mut info, libc::WEXITED | libc::WNOWAIT) } == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EINTR) {
            return Err(format!("waitid: {error}"));
        }
    }
}

/// A process handle the watcher thread owns.
#[cfg(windows)]
struct OwnedHandle(windows_sys::Win32::Foundation::HANDLE);

// SAFETY: a process handle may be waited on and closed from any thread; only the watcher uses this one.
#[cfg(windows)]
unsafe impl Send for OwnedHandle {}

/// Tells `said` when `child` has exited (a duplicate of its handle is waited on); its status is read afterwards with `child.wait()`.
#[cfg(windows)]
#[allow(clippy::disallowed_types, reason = "test harness: a process the harness started")]
fn watch_exit(child: &std::process::Child, said: impl FnOnce(Result<(), String>) + Send + 'static) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, DUPLICATE_SAME_ACCESS, DuplicateHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, INFINITE, WaitForSingleObject};
    let mut own = std::ptr::null_mut();
    // SAFETY: the child's handle is valid while `child` lives; the duplicate is owned by the watcher, which closes it.
    let duplicated = unsafe { DuplicateHandle(GetCurrentProcess(), child.as_raw_handle(), GetCurrentProcess(), &mut own, 0, 0, DUPLICATE_SAME_ACCESS) };
    if duplicated == 0 {
        said(Err(format!("its handle could not be duplicated: {}", std::io::Error::last_os_error())));
        return;
    }
    let own = OwnedHandle(own);
    std::thread::spawn(move || {
        let own = own;
        // SAFETY: the duplicate is valid until it is closed here.
        let waited = unsafe { WaitForSingleObject(own.0, INFINITE) };
        let exited = if waited == WAIT_OBJECT_0 { Ok(()) } else { Err(format!("WaitForSingleObject: {}", std::io::Error::last_os_error())) };
        // SAFETY: closed once, here.
        unsafe { CloseHandle(own.0) };
        said(exited);
    });
}

/// What a helper (`pg_ctl`, `initdb`) gave: its output, or why it cannot be used; and what of it may be left.
pub(crate) struct Helper {
    pub output: Result<std::process::Output, String>,
    pub left: Vec<String>,
}

/// Where a helper runs (module doc).
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Contain {
    /// In a tree of its own, started inside it; its result is used only once that tree is proven ended. Every `pg_ctl` of the runner.
    OwnTree,
    /// In its caller's tree, its output discarded: a `pg_ctl start`, whose postmaster legitimately outlives it.
    CallersTree,
}

#[cfg(windows)]
const ABANDONED: &str = " (abandoned; its job is closed as its run returns, which ends it)";
#[cfg(unix)]
const ABANDONED: &str = " (abandoned)";

/// Runs the helper `command` (`what` names it) until `deadline`: the program itself until `KILL_GRACE` before it, the rest for its kill and the proof
/// that its tree has ended. One that does not end is named with its pid among what is left.
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test harness: runs and waits for a helper process")]
pub(crate) fn run_bounded(mut command: std::process::Command, deadline: Instant, what: &str, contain: Contain) -> Helper {
    let mut left = Vec::new();
    let tree = match contain {
        Contain::OwnTree => match Tree::new() {
            Ok(tree) => Some(tree),
            Err(error) => return Helper { output: Err(format!("{what}: no process tree: {error}; it was not started")), left },
        },
        Contain::CallersTree => None,
    };
    let piped = || if tree.is_some() { std::process::Stdio::piped() } else { std::process::Stdio::null() };
    // An own tree's helper gets a held stdin: one that reads it waits, as one that hangs would.
    command.stdin(piped()).stdout(piped()).stderr(piped());
    let started = match &tree {
        Some(tree) => tree.start(command),
        None => command.spawn().map(|child| (child, None)).map_err(|error| error.to_string()),
    };
    let (mut child, unheld) = match started {
        Ok(started) => started,
        Err(error) => return Helper { output: Err(format!("{what} did not start: {error}")), left },
    };
    let pid = child.id();
    let stdin = child.stdin.take();
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    let (said, exited) = std::sync::mpsc::channel();
    watch_exit(&child, move |result| {
        let _ = said.send(result);
    });
    let mut failures = Vec::new();
    let mut killed = false;
    if let Some(problem) = unheld {
        failures.push(format!("{what} (pid {pid}) could not be put in its process tree ({problem}); it was killed{}", kill_failure(child.kill())));
        killed = true;
    }
    let program_deadline = deadline.checked_sub(KILL_GRACE).unwrap_or(deadline);
    let mut ended = exited.recv_timeout(program_deadline.saturating_duration_since(Instant::now())).ok();
    if ended.is_none() {
        let kill = tree.as_ref().map_or_else(|| child.kill(), |tree| tree.kill(None));
        failures.push(format!("{what} (pid {pid}) did not end by its step's deadline and was killed{}", kill_failure(kill)));
        killed = true;
        ended = exited.recv_timeout(deadline.saturating_duration_since(Instant::now())).ok();
    }
    let exited_ok = matches!(ended, Some(Ok(())));
    match &ended {
        None => {
            failures.push(format!("{what} (pid {pid}) was still running at its step's deadline"));
            left.push(format!("{what}, pid {pid}{ABANDONED}"));
        }
        Some(Err(error)) => {
            failures.push(format!("{what} (pid {pid}) could not be waited for: {error}"));
            left.push(format!("{what}, pid {pid}{ABANDONED}"));
        }
        Some(Ok(())) => {}
    }
    // Its result counts only once its own tree is proven ended (a start helper's postmaster belongs to its caller's tree).
    if let Some(tree) = &tree {
        // What the helper started is given its kill grace to end after it: a process still running then was left by it.
        let mut emptied = tree.wait_empty(if killed { deadline } else { (Instant::now() + KILL_GRACE).min(deadline) }, exited_ok);
        if emptied.is_err() && !killed {
            failures.push(format!(
                "{what} (pid {pid}) left processes running after it ended ({}); its process tree was killed{} and its result is not used",
                emptied.as_ref().unwrap_err(),
                kill_failure(tree.kill(None))
            ));
            emptied = tree.wait_empty(deadline, exited_ok);
        }
        if let Err(error) = emptied {
            failures.push(format!("{what}'s process tree was not proven ended by its step's deadline: {error}"));
            left.push(format!("{what}'s process tree: {}", tree.describe()));
        }
    }
    let status = exited_ok.then(|| child.wait());
    drop(stdin);
    if !failures.is_empty() {
        return Helper { output: Err(failures.join("; ")), left };
    }
    let status = match status {
        Some(Ok(status)) => status,
        Some(Err(error)) => return Helper { output: Err(format!("{what} (pid {pid}): its status could not be read: {error}")), left },
        None => unreachable!("a helper that did not exit is a failure above"),
    };
    let collect = |output: Receiver<Vec<u8>>| output.recv_timeout(deadline.saturating_duration_since(Instant::now()));
    match (collect(stdout), collect(stderr)) {
        (Ok(stdout), Ok(stderr)) => Helper { output: Ok(std::process::Output { status, stdout, stderr }), left },
        _ => {
            left.push(format!("a process holding the output of {what} (outside its process tree)"));
            Helper { output: Err(format!("{what} (pid {pid}): its output was still held open at its step's deadline")), left }
        }
    }
}

/// Reads `output` to its end on a thread of its own.
fn drain(output: Option<impl std::io::Read + Send + 'static>) -> Receiver<Vec<u8>> {
    let (said, read) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut output) = output {
            let _ = output.read_to_end(&mut bytes);
        }
        let _ = said.send(bytes);
    });
    read
}

/// Step 4: every data directory under `dir` (one holding `PG_VERSION`, at any depth), examined by that directory until `deadline`. Returns whether
/// every one is proven stopped and nothing went unexamined; each one that is not is a failure and is named among what is left.
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test harness: runs pg_ctl on the test's own data directories")]
fn examine_clusters(dir: &Path, setup: &Setup, deadline: Instant, trust_not_running: bool, report: &mut Report) -> bool {
    let mut pgdatas = Vec::new();
    let mut unexamined = Vec::new();
    find_pgdata(dir, &mut pgdatas, &mut unexamined);
    let mut proven = unexamined.is_empty();
    for entry in unexamined {
        report.failures.push(format!("the clusters step: not examined: {entry}"));
        report.left.push(format!("not examined: {entry}"));
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
        let pg = |args: &[&str]| {
            let mut command = std::process::Command::new(pg_ctl);
            command.args(args).arg("-D").arg(&pgdata);
            #[cfg(target_os = "linux")]
            command.env("LD_LIBRARY_PATH", _lib);
            #[cfg(target_os = "macos")]
            command.env("DYLD_LIBRARY_PATH", _lib);
            run_bounded(command, deadline, &format!("pg_ctl {} -D {shown}", args[0]), Contain::OwnTree)
        };
        // A helper starts only with more than its kill grace left: what it may need to be killed and seen ended.
        let time_left = || deadline.saturating_duration_since(Instant::now()) > KILL_GRACE;
        if !time_left() {
            report.failures.push(format!("the clusters step: {shown} was not examined: the step's time ran out (share {share} s, or the run's end)"));
            report.left.push(format!("data directory {shown}, not proven stopped"));
            proven = false;
            continue;
        }
        let status = pg(&["status"]);
        report.left.extend(status.left);
        let stopped = match status.output {
            Ok(output) if output.status.code() == Some(3) && trust_not_running => Ok(()),
            Ok(output) if output.status.code() == Some(3) => {
                Err("pg_ctl status says no server runs, which does not prove it after this end (a postmaster may still be starting)".to_owned())
            }
            Ok(output) if output.status.success() => {
                report.failures.push(format!("the clusters step: a cluster was still running in {shown} after the child ended; it is stopped by its data directory"));
                if time_left() {
                    let seconds = deadline.saturating_duration_since(Instant::now()).saturating_sub(KILL_GRACE).as_secs().max(1).to_string();
                    let stop = pg(&["stop", "-m", "fast", "-w", "-t", &seconds]);
                    report.left.extend(stop.left);
                    match stop.output {
                        Ok(stopped) if stopped.status.success() => Ok(()),
                        Ok(stopped) => Err(format!("pg_ctl stop failed: {} {}", stopped.status, String::from_utf8_lossy(&stopped.stderr).trim())),
                        Err(failure) => Err(failure),
                    }
                } else {
                    Err(format!("its stop could not run: the step's time ran out (share {share} s, or the run's end)"))
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

/// The data directories under `dir`: every directory holding `PG_VERSION`, at any depth, not descending into one it found. An entry that cannot be
/// read and a link or junction (never followed) go to `unexamined`, and the walk goes on with their siblings.
#[allow(clippy::disallowed_methods, reason = "test harness: searches the test's own directory")]
fn find_pgdata(dir: &Path, found: &mut Vec<PathBuf>, unexamined: &mut Vec<String>) {
    if dir.join("PG_VERSION").is_file() {
        found.push(dir.to_owned());
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => {
            unexamined.push(format!("{} could not be read: {error}", dir.display()));
            return;
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                unexamined.push(format!("an entry of {} could not be read: {error}", dir.display()));
                continue;
            }
        };
        let path = entry.path();
        match entry.file_type() {
            Err(error) => unexamined.push(format!("{}: its type could not be read: {error}", path.display())),
            Ok(kind) if kind.is_symlink() => unexamined.push(format!("{} is a link or junction (not followed)", path.display())),
            Ok(kind) if kind.is_dir() => find_pgdata(&path, found, unexamined),
            Ok(_) => {}
        }
    }
}

/// The files under `dir` that cannot be removed now (a process still holds them). Links are removed, never followed.
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test harness: lists the test's own files that cannot be removed")]
fn held_files(dir: &Path) -> Vec<String> {
    let mut held = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return held };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().is_ok_and(|kind| kind.is_dir() && !kind.is_symlink()) {
            held.extend(held_files(&path));
        } else if std::fs::remove_file(&path).or_else(|_| std::fs::remove_dir(&path)).is_err() {
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

    /// Starts a helper inside the job: created suspended, put in the job, then resumed, so nothing it runs is outside it. `Some(problem)`: started
    /// but not held or not resumed (the caller kills it).
    #[allow(clippy::disallowed_types, reason = "test harness: a helper process the harness starts")]
    fn start(&self, mut command: std::process::Command) -> Result<(std::process::Child, Option<String>), String> {
        use std::os::windows::process::CommandExt as _;
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_SUSPENDED);
        let child = command.spawn().map_err(|error| error.to_string())?;
        let problem = match self.hold(&child, None) {
            Err(error) => Some(format!("its job: {error}")),
            Ok(()) => resume(child.id()).err().map(|error| format!("its resume: {error}")),
        };
        Ok((child, problem))
    }

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
        format!("the processes of the job, pids {:?} (the job is closed as its run returns, which ends them)", self.pids())
    }

    /// Waits until `deadline` for the job to hold no process. Every message of the job's port (a process ended, the last one ended) wakes the check of
    /// its count, so a message from an earlier moment is not taken for the state now. (A job is its own identity: nothing is left unreaped for it.)
    fn wait_empty(&self, deadline: Instant, _leader_exited: bool) -> Result<(), String> {
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

/// Resumes the one thread of the suspended process `pid`.
#[cfg(windows)]
fn resume(pid: u32) -> std::io::Result<()> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next};
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};
    // SAFETY: a snapshot of the system's threads, closed below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    let mut entry = THREADENTRY32 { dwSize: std::mem::size_of::<THREADENTRY32>() as u32, ..Default::default() };
    let mut resumed = Err(std::io::Error::other(format!("no thread of process {pid} was found")));
    // SAFETY: the snapshot is valid and `entry` is a local with its size set.
    let mut more = unsafe { Thread32First(snapshot, &mut entry) } != 0;
    while more {
        if entry.th32OwnerProcessID == pid {
            // SAFETY: a plain open; the handle is checked and closed below.
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            resumed = if thread.is_null() {
                Err(std::io::Error::last_os_error())
            } else {
                // SAFETY: the thread handle is valid and closed once, here.
                let count = unsafe { ResumeThread(thread) };
                let result = if count == u32::MAX { Err(std::io::Error::last_os_error()) } else { Ok(()) };
                unsafe { CloseHandle(thread) };
                result
            };
            break;
        }
        // SAFETY: as for `Thread32First`.
        more = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
    }
    // SAFETY: closed once, here.
    unsafe { CloseHandle(snapshot) };
    resumed
}

/// A process and what it starts, as a process group of its own (made at the spawn, before the program runs), whose leader the run leaves unreaped
/// until the group has been checked. What leaves the group (a postmaster started through `pg_ctl`, which calls `setsid`) is outside it: module doc.
#[cfg(unix)]
struct Tree {
    group: std::sync::OnceLock<libc::pid_t>,
}

#[cfg(unix)]
impl Tree {
    fn new() -> std::io::Result<Self> {
        Ok(Self { group: std::sync::OnceLock::new() })
    }

    #[allow(clippy::disallowed_types, reason = "test harness: the command of a process the harness starts")]
    fn prepare(&self, command: &mut std::process::Command) {
        std::os::unix::process::CommandExt::process_group(command, 0);
    }

    /// Starts a helper in a group of its own, made before its program runs. `Some(problem)`: started but not recorded (the caller kills it).
    #[allow(clippy::disallowed_types, reason = "test harness: a helper process the harness starts")]
    fn start(&self, mut command: std::process::Command) -> Result<(std::process::Child, Option<String>), String> {
        self.prepare(&mut command);
        let child = command.spawn().map_err(|error| error.to_string())?;
        let problem = self.hold(&child, None).err().map(|error| error.to_string());
        Ok((child, problem))
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

    fn group(&self) -> Result<libc::pid_t, String> {
        self.group.get().copied().ok_or_else(|| "no process group was recorded".to_owned())
    }

    fn kill(&self, fault: Option<Fault>) -> std::io::Result<()> {
        if fault == Some(Fault::TreeKillFails) {
            return Ok(());
        }
        let group = self.group().map_err(std::io::Error::other)?;
        // SAFETY: killpg has no memory preconditions; the group is the one the child leads, its id held by the unreaped leader.
        if unsafe { libc::killpg(group, libc::SIGKILL) } == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
    }

    fn processes_ever(&self) -> Option<u32> {
        None
    }

    fn describe(&self) -> String {
        format!("process group {}", self.group.get().map_or_else(|| "?".to_owned(), ToString::to_string))
    }

    /// Waits until `deadline` for the group to have no live member: each one listed is waited for by its own exit (an event), then the group is listed
    /// again, until a listing has no live member. `leader_exited`: the leader is a zombie the run has not reaped (macOS lists it).
    fn wait_empty(&self, deadline: Instant, leader_exited: bool) -> Result<(), String> {
        let group = self.group()?;
        loop {
            let members = live_members(group, leader_exited)?;
            let mut waited = false;
            for &member in &members {
                match exits_by(member, group, deadline)? {
                    Exit::Already => {}
                    Exit::Now => waited = true,
                    Exit::Running => return Err(format!("process group {group} still had members, pids {members:?}")),
                }
            }
            if !waited {
                return Ok(());
            }
        }
    }
}

/// How a group member's wait ended.
#[cfg(unix)]
enum Exit {
    /// It had ended (or is no longer the member listed) when the wait began.
    Already,
    /// It ended during the wait.
    Now,
    /// It still ran at the deadline.
    Running,
}

/// Linux: the group's members that have not exited (zombies are not live), read from `/proc`.
#[cfg(target_os = "linux")]
#[allow(clippy::disallowed_methods, reason = "test harness: reads /proc")]
fn live_members(group: libc::pid_t, _leader_exited: bool) -> Result<Vec<libc::pid_t>, String> {
    let entries = std::fs::read_dir("/proc").map_err(|error| format!("/proc could not be listed: {error}"))?;
    let mut members = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("/proc could not be listed: {error}"))?;
        let Some(pid) = entry.file_name().to_str().and_then(|name| name.parse::<libc::pid_t>().ok()) else { continue };
        // A process that ended meanwhile has no stat to read: it is not a member.
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else { continue };
        // `pid (comm) state ppid pgrp ...`: the command may hold spaces and parentheses, so the fields are read after its last `)`.
        let mut fields = stat.rsplit_once(')').map_or("", |(_, rest)| rest).split_whitespace();
        let state = fields.next();
        let pgrp = fields.nth(1).and_then(|field| field.parse::<libc::pid_t>().ok());
        if pgrp == Some(group) && !matches!(state, Some("Z" | "X")) {
            members.push(pid);
        }
    }
    Ok(members)
}

/// Linux: waits until `deadline` for `pid` to exit, through a pidfd.
#[cfg(target_os = "linux")]
fn exits_by(pid: libc::pid_t, group: libc::pid_t, deadline: Instant) -> Result<Exit, String> {
    // SAFETY: a syscall with integer arguments; the descriptor it returns is closed below.
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    if fd < 0 {
        let error = std::io::Error::last_os_error();
        return if error.raw_os_error() == Some(libc::ESRCH) { Ok(Exit::Already) } else { Err(format!("pidfd_open({pid}): {error}")) };
    }
    let fd = libc::c_int::try_from(fd).expect("a descriptor");
    // The pid may have been reused between the listing and the open: a process now outside the group is not the member that was listed.
    // SAFETY: no memory arguments.
    let exit = if unsafe { libc::getpgid(pid) } == group {
        let mut poll = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
        loop {
            let left = libc::c_int::try_from(deadline.saturating_duration_since(Instant::now()).as_millis()).unwrap_or(libc::c_int::MAX);
            // SAFETY: one pollfd, a local.
            match unsafe { libc::poll(&mut poll, 1, left) } {
                0 => break Ok(Exit::Running),
                ready if ready > 0 => break Ok(Exit::Now),
                _ => {
                    let error = std::io::Error::last_os_error();
                    if error.raw_os_error() != Some(libc::EINTR) {
                        break Err(format!("poll on the pidfd of {pid}: {error}"));
                    }
                }
            }
        }
    } else {
        Ok(Exit::Already)
    };
    // SAFETY: closed once, here.
    unsafe { libc::close(fd) };
    exit
}

/// macOS: the group's members (`proc_listpgrppids`, which lists zombies too: the exited leader is left out).
#[cfg(target_os = "macos")]
fn live_members(group: libc::pid_t, leader_exited: bool) -> Result<Vec<libc::pid_t>, String> {
    let mut pids: Vec<libc::pid_t> = vec![0; 4096];
    let bytes = libc::c_int::try_from(std::mem::size_of_val(pids.as_slice())).expect("a small buffer");
    // SAFETY: the buffer is a local of `bytes` bytes.
    let count = unsafe { libc::proc_listpgrppids(group, pids.as_mut_ptr().cast(), bytes) };
    if count < 0 {
        return Err(format!("proc_listpgrppids({group}): {}", std::io::Error::last_os_error()));
    }
    pids.truncate(usize::try_from(count).unwrap_or(0).min(4096));
    pids.retain(|&pid| pid > 0 && !(leader_exited && pid == group));
    Ok(pids)
}

/// macOS: waits until `deadline` for `pid` to exit, through a kqueue `NOTE_EXIT`; one that has already exited cannot be watched (`ESRCH`).
#[cfg(target_os = "macos")]
fn exits_by(pid: libc::pid_t, _group: libc::pid_t, deadline: Instant) -> Result<Exit, String> {
    // SAFETY: a plain constructor; the descriptor is closed below.
    let queue = unsafe { libc::kqueue() };
    if queue < 0 {
        return Err(format!("kqueue: {}", std::io::Error::last_os_error()));
    }
    let change = libc::kevent {
        ident: usize::try_from(pid).expect("a pid"),
        filter: libc::EVFILT_PROC,
        flags: libc::EV_ADD | libc::EV_ONESHOT,
        fflags: libc::NOTE_EXIT,
        data: 0,
        udata: std::ptr::null_mut(),
    };
    // SAFETY: one change, a local; no event slots.
    let exit = if unsafe { libc::kevent(queue, &change, 1, std::ptr::null_mut(), 0, std::ptr::null()) } < 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) { Ok(Exit::Already) } else { Err(format!("kevent on pid {pid}: {error}")) }
    } else {
        // SAFETY: an all-zero kevent is a valid value to be filled.
        let mut event: libc::kevent = unsafe { std::mem::zeroed() };
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let timeout = libc::timespec { tv_sec: libc::time_t::try_from(left.as_secs()).unwrap_or(libc::time_t::MAX), tv_nsec: libc::c_long::from(left.subsec_nanos()) };
            // SAFETY: no changes; one event slot and the timeout, locals.
            match unsafe { libc::kevent(queue, std::ptr::null(), 0, &mut event, 1, &timeout) } {
                0 => break Ok(Exit::Running),
                ready if ready > 0 => break Ok(Exit::Now),
                _ => {
                    let error = std::io::Error::last_os_error();
                    if error.raw_os_error() != Some(libc::EINTR) {
                        break Err(format!("kevent wait on pid {pid}: {error}"));
                    }
                }
            }
        }
    };
    // SAFETY: closed once, here.
    unsafe { libc::close(queue) };
    exit
}

#[cfg(target_os = "linux")]
fn become_subreaper() -> std::io::Result<()> {
    // SAFETY: prctl with integer arguments only.
    if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
}

/// Step 5 (Linux): whether every process descended from the test has ended by `deadline` (every orphan among them is this process's child, so reaping
/// until there is none establishes it); if not, a failure.
#[cfg(target_os = "linux")]
fn descendants_step(deadline: Instant, share: u64, report: &mut Report) -> bool {
    let (said, answer) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = said.send(reap_all());
    });
    let reaped = answer.recv_timeout(deadline.saturating_duration_since(Instant::now())).unwrap_or_else(|_| Err("a process descended from the test was still running".to_owned()));
    match reaped {
        Ok(()) => true,
        Err(error) => {
            report.failures.push(format!("the descendants step: {error} when the step's time ran out (share {share} s, or the run's end); every data directory is kept"));
            report.left.push("a process descended from the test (a postmaster still starting is one)".to_owned());
            false
        }
    }
}

/// Linux: reaps this process's children until it has none.
#[cfg(target_os = "linux")]
fn reap_all() -> Result<(), String> {
    loop {
        // SAFETY: `info` is a local the call fills.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        if unsafe { libc::waitid(libc::P_ALL, 0, &mut info, libc::WEXITED) } == 0 {
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