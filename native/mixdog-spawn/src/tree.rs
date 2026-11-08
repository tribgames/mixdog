//! The one tracker of what a finished command leaves running on POSIX: a port of
//! `createProcessTreeTracker`, `killShellDescendants`, `killProcessTrees` and `watchTermination` of
//! `lib/shell-descendants.mjs` and `mcp/child-tree.mjs`.
//!
//! The algorithm takes its process table, its signals and its clock from the outside, so the
//! production code and the tests run the same lines: [`crate::osproc`] supplies the operating
//! system's, `tests` below supplies scripted ones and replays the scenarios Node's own code was
//! recorded running (`fixtures/shell-tracker-trace`).
//!
//! Processes are followed by identity (pid plus start token of the same table read), never by pid:
//! a recycled pid is a different process, neither keeps a survivor alive nor becomes a target. A
//! table that could not be read is unknown, never an empty one.

use std::collections::HashSet;
use std::collections::HashMap;
use std::io;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

/// `TERMINATION_RECHECK_MS`: how often an observation with no exit event to wake it looks again.
pub(crate) const RECHECK: Duration = Duration::from_millis(5_000);
/// The group gets its SIGTERM and this long to end before the SIGKILL (`delay(200)`).
const GROUP_GRACE: Duration = Duration::from_millis(200);
/// And this long after the SIGKILL (`delay(100)`).
const GROUP_FORCED_WAIT: Duration = Duration::from_millis(100);
/// `killProcessTrees`: targets get their SIGTERM and this long before the SIGKILL (`delay(300)`).
const TARGET_GRACE: Duration = Duration::from_millis(300);
/// `KILL_ROUNDS`: kill-and-observe rounds before a cancel reports what is left.
const KILL_ROUNDS: usize = 3;

/// A process as one table read named it: the pid and the start token that tells it from a later
/// process holding the same pid.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Identity {
    pub(crate) pid: u32,
    pub(crate) token: String,
}

/// One row of the process table.
#[derive(Clone, Debug)]
pub(crate) struct Proc {
    pub(crate) pid: u32,
    pub(crate) ppid: u32,
    pub(crate) pgid: u32,
    pub(crate) token: String,
}

/// A complete read of the process table, in the reader's order.
pub(crate) struct Table {
    procs: Vec<Proc>,
    at: HashMap<u32, usize>,
    children: HashMap<u32, Vec<u32>>,
}

impl Table {
    pub(crate) fn new(procs: Vec<Proc>) -> Self {
        let mut at = HashMap::new();
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        for (index, proc) in procs.iter().enumerate() {
            at.insert(proc.pid, index);
            children.entry(proc.ppid).or_default().push(proc.pid);
        }
        Self { procs, at, children }
    }

    fn token(&self, pid: u32) -> Option<&str> {
        self.at.get(&pid).map(|&index| self.procs[index].token.as_str())
    }

    fn children(&self, pid: u32) -> &[u32] {
        self.children.get(&pid).map_or(&[], Vec::as_slice)
    }
}

/// Where the process table comes from.
pub(crate) trait Reader: Send + Sync {
    /// The whole table. An error means it is unknown: never an empty table, never one with
    /// entries dropped.
    fn table(&self) -> io::Result<Table>;
}

/// What is sent to a process or group. `Probe` is signal 0: it asks whether anything is there.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Signal {
    Probe,
    Term,
    Kill,
}

/// Signals, and the exit events there are.
pub(crate) trait Signals: Send + Sync {
    /// To every member of the group `pgid`. For `Probe`: whether the group has a member we may
    /// not be able to signal (a refusal counts as alive); otherwise whether it was delivered.
    fn group(&self, pgid: u32, signal: Signal) -> bool;
    /// The same for one process.
    fn process(&self, pid: u32, signal: Signal) -> bool;
    /// Completes with `true` when one of `watched` has ended (or is no longer the process that was
    /// seen). `false` at once when exit events cannot be had: the caller looks again later.
    async fn exited(&self, watched: &[Identity]) -> bool;
}

/// Time.
pub(crate) trait Clock: Send + Sync {
    async fn sleep(&self, duration: Duration);
}

/// What one observation found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Observation {
    /// These identities are alive.
    Running(Vec<Identity>),
    /// Nothing of the tree is left.
    Gone,
    /// The table could not be read: nothing is known.
    Unknown,
}

/// `createProcessTreeTracker`, POSIX form, for a root whose exit we saw ourselves (it is our own
/// child, reaped by us): the identities it has met, in the order they were met.
struct Tracker {
    root: u32,
    /// The root's start token, taken while it was known ours.
    root_token: Option<String>,
    tracked: Vec<Identity>,
}

impl Tracker {
    fn present(table: &Table, identity: &Identity) -> bool {
        table.token(identity.pid) == Some(identity.token.as_str())
    }

    fn root_alive(&self, table: &Table, root_exited: bool) -> bool {
        if root_exited {
            return false;
        }
        match table.token(self.root) {
            None => false,
            Some(token) => self.root_token.as_deref().is_none_or(|known| known == token),
        }
    }

    /// The root's pid still names our root, or nothing: its child links and its group are ours. A
    /// different process under that pid is a reuse, and none of what hangs off it is ours.
    fn root_is_ours(&self, table: &Table, root_alive: bool) -> bool {
        let held = table.token(self.root);
        root_alive || held.is_none() || (self.root_token.is_some() && self.root_token.as_deref() == held)
    }

    fn track(&mut self, table: &Table, pid: u32) {
        if let Some(token) = table.token(pid) {
            let identity = Identity { pid, token: token.to_owned() };
            if !self.tracked.contains(&identity) {
                self.tracked.push(identity);
            }
        }
    }

    /// Admits what this read shows: descendants of the root (while it is ours) and of every tracked
    /// identity still present, and the members of the root's group (while it is ours).
    fn absorb(&mut self, table: &Table, root_alive: bool) {
        let ours = self.root_is_ours(table, root_alive);
        let mut from: Vec<u32> = Vec::new();
        if ours {
            from.push(self.root);
        }
        from.extend(self.tracked.iter().filter(|identity| Self::present(table, identity)).map(|identity| identity.pid));
        let mut seen: HashSet<u32> = from.iter().copied().collect();
        while let Some(current) = from.pop() {
            for &child in table.children(current) {
                if seen.insert(child) {
                    self.track(table, child);
                    from.push(child);
                }
            }
        }
        if ours {
            for proc in &table.procs {
                if proc.pgid == self.root && proc.pid != self.root {
                    self.track(table, proc.pid);
                }
            }
        }
        if root_alive && self.root_token.is_none() {
            self.root_token = table.token(self.root).map(str::to_owned);
        }
    }

    fn observe(&mut self, table: &Table, root_exited: bool) -> Observation {
        let alive = self.root_alive(table, root_exited);
        self.absorb(table, alive);
        if alive {
            let token = table.token(self.root).map(str::to_owned).unwrap_or_default();
            return Observation::Running(vec![Identity { pid: self.root, token }]);
        }
        let live: Vec<Identity> = self.tracked.iter().filter(|identity| Self::present(table, identity)).cloned().collect();
        if live.is_empty() { Observation::Gone } else { Observation::Running(live) }
    }
}

/// One command's tree, observed, waited for and ended.
pub(crate) struct Tree<R, S, C> {
    reader: R,
    signals: S,
    clock: C,
    root: u32,
    tracker: Mutex<Tracker>,
    /// The root has been reaped: from then on its pid and its group id may belong to someone else.
    reaped: AtomicBool,
    /// The identities the last observation found alive: what a cancel signals.
    live: Mutex<Vec<Identity>>,
}

impl<R: Reader, S: Signals, C: Clock> Tree<R, S, C> {
    /// `root_token`: the root's start token, read while the root was known to be ours.
    pub(crate) fn new(reader: R, signals: S, clock: C, root: u32, root_token: Option<String>) -> Self {
        Self {
            reader,
            signals,
            clock,
            root,
            tracker: Mutex::new(Tracker { root, root_token, tracked: Vec::new() }),
            reaped: AtomicBool::new(false),
            live: Mutex::new(Vec::new()),
        }
    }

    pub(crate) fn root_reaped(&self) {
        self.reaped.store(true, Ordering::Release);
    }

    fn tracker(&self) -> std::sync::MutexGuard<'_, Tracker> {
        self.tracker.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// One look at the tree.
    pub(crate) fn observe(&self) -> Observation {
        let Ok(table) = self.reader.table() else {
            return Observation::Unknown;
        };
        let observation = self.tracker().observe(&table, self.reaped.load(Ordering::Acquire));
        *self.live.lock().unwrap_or_else(|e| e.into_inner()) = match &observation {
            Observation::Running(live) => live.clone(),
            _ => Vec::new(),
        };
        observation
    }

    /// Whether anything of the group might still be there, for deciding how long to keep a record:
    /// it signals nothing and proves nothing about ownership.
    pub(crate) fn group_may_be_occupied(&self) -> bool {
        self.signals.group(self.root, Signal::Probe)
    }

    /// A tree kill of the group while the command still runs, or while the group is still ours. The
    /// root's pid and group id are free for reuse once the root is reaped, so then the table decides
    /// whether they still name our group; a table that cannot be read signals nothing.
    pub(crate) fn signal_group(&self, signal: Signal) {
        if !self.reaped.load(Ordering::Acquire) {
            self.signals.group(self.root, signal);
            return;
        }
        let Ok(table) = self.reader.table() else {
            return;
        };
        if self.tracker().root_is_ours(&table, false) {
            self.signals.group(self.root, signal);
        }
    }

    /// Completes when the tree is gone. An exit event wakes it where there is one; otherwise, and
    /// whenever the table cannot be read, it looks again every [`RECHECK`]. Unknown is never gone.
    pub(crate) async fn wait_gone(&self) {
        loop {
            match self.observe() {
                Observation::Gone => return,
                Observation::Running(live) => {
                    if !self.signals.exited(&live).await {
                        self.clock.sleep(RECHECK).await;
                    }
                }
                Observation::Unknown => self.clock.sleep(RECHECK).await,
            }
        }
    }

    /// `killProcessTrees` on POSIX: SIGTERM to each, a grace, then SIGKILL to those still alive.
    async fn kill_trees(&self, pids: &[u32]) {
        if pids.is_empty() {
            return;
        }
        for &pid in pids {
            self.signals.process(pid, Signal::Term);
        }
        self.clock.sleep(TARGET_GRACE).await;
        for &pid in pids {
            if self.signals.process(pid, Signal::Probe) {
                self.signals.process(pid, Signal::Kill);
            }
        }
    }

    /// `killShellDescendants`: ends the group if it is still ours, then the observed identities that
    /// are still the processes that were seen, then looks again; what the kill missed is killed in
    /// the next of up to [`KILL_ROUNDS`] rounds. `true` when a look finds nothing left.
    pub(crate) async fn cancel(&self) -> bool {
        let Ok(table) = self.reader.table() else {
            return false;
        };
        let (ours, targets) = {
            let live = self.live.lock().unwrap_or_else(|e| e.into_inner());
            let targets: Vec<u32> =
                live.iter().filter(|identity| Tracker::present(&table, identity)).map(|identity| identity.pid).collect();
            (self.tracker().root_is_ours(&table, false), targets)
        };
        if ours {
            self.signals.group(self.root, Signal::Term);
            self.clock.sleep(GROUP_GRACE).await;
            if self.signals.group(self.root, Signal::Probe) {
                self.signals.group(self.root, Signal::Kill);
                self.clock.sleep(GROUP_FORCED_WAIT).await;
            }
        }
        self.kill_trees(&targets).await;
        let mut observed = self.observe();
        for _ in 1..KILL_ROUNDS {
            let Observation::Running(live) = &observed else {
                break;
            };
            let pids: Vec<u32> = live.iter().map(|identity| identity.pid).collect();
            self.kill_trees(&pids).await;
            observed = self.observe();
        }
        observed == Observation::Gone
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::AtomicUsize;

    use serde_json::Value;
    use serde_json::json;
    use tokio::sync::Notify;
    use tokio::sync::Semaphore;

    use super::*;

    /// What Node's own tracker did with the same scripted tables, signals and timers
    /// (`record-shell-tracker-trace.mjs`, recorded from Node b6f10295a; see its MANIFEST.json).
    fn scenarios(kind: &str) -> Vec<Value> {
        let golden: Value = serde_json::from_str(include_str!("../../core/fixtures/shell-tracker-trace/golden.json")).unwrap();
        let all = golden["scenarios"].as_array().unwrap().iter();
        all.filter(|scenario| scenario["kind"] == kind).cloned().collect()
    }

    type Log = Arc<Mutex<Vec<Value>>>;

    fn push(log: &Log, event: Value) {
        log.lock().unwrap().push(event);
    }

    fn logged(log: &Log) -> usize {
        log.lock().unwrap().len()
    }

    fn table_of(rows: &Value) -> io::Result<Table> {
        if let Some(message) = rows.get("error") {
            return Err(io::Error::other(message.as_str().unwrap().to_owned()));
        }
        let procs = rows.as_array().unwrap().iter().map(|row| Proc {
            pid: row["pid"].as_u64().unwrap() as u32,
            ppid: row["ppid"].as_u64().unwrap() as u32,
            pgid: row["pgid"].as_u64().unwrap() as u32,
            token: row["token"].as_str().unwrap().to_owned(),
        });
        Ok(Table::new(procs.collect()))
    }

    /// Answers every read from the script, the last answer again once it runs out (as Node's script did).
    struct ScriptedReader {
        tables: Vec<Value>,
        reads: AtomicUsize,
        log: Log,
    }

    impl ScriptedReader {
        fn new(tables: &Value, log: &Log) -> Self {
            Self { tables: tables.as_array().unwrap().clone(), reads: AtomicUsize::new(0), log: log.clone() }
        }
    }

    impl Reader for ScriptedReader {
        fn table(&self) -> io::Result<Table> {
            push(&self.log, json!({"op": "read"}));
            let at = self.reads.fetch_add(1, Ordering::SeqCst).min(self.tables.len() - 1);
            table_of(&self.tables[at])
        }
    }

    struct ScriptedSignals {
        group_probes: Vec<bool>,
        pid_probes: Vec<bool>,
        asked: [AtomicUsize; 2],
        /// Whether exits are announced (they are never, unless a test asks).
        exits: bool,
        log: Log,
    }

    impl ScriptedSignals {
        fn new(log: &Log) -> Self {
            Self {
                group_probes: vec![true],
                pid_probes: vec![true],
                asked: [AtomicUsize::new(0), AtomicUsize::new(0)],
                exits: false,
                log: log.clone(),
            }
        }

        fn probes(mut self, group: &Value, pid: &Value) -> Self {
            let answers = |value: &Value| value.as_array().unwrap().iter().map(|a| a.as_bool().unwrap()).collect();
            self.group_probes = answers(group);
            self.pid_probes = answers(pid);
            self
        }

        fn send(&self, target: &str, id: u32, signal: Signal, answers: &[bool], asked: &AtomicUsize) -> bool {
            let name = match signal {
                Signal::Probe => json!(0),
                Signal::Term => json!("SIGTERM"),
                Signal::Kill => json!("SIGKILL"),
            };
            push(&self.log, json!({"op": "kill", "target": target, "id": id, "signal": name}));
            signal != Signal::Probe || answers[asked.fetch_add(1, Ordering::SeqCst).min(answers.len() - 1)]
        }
    }

    impl Signals for ScriptedSignals {
        fn group(&self, pgid: u32, signal: Signal) -> bool {
            self.send("group", pgid, signal, &self.group_probes, &self.asked[0])
        }

        fn process(&self, pid: u32, signal: Signal) -> bool {
            self.send("pid", pid, signal, &self.pid_probes, &self.asked[1])
        }

        async fn exited(&self, _watched: &[Identity]) -> bool {
            self.exits
        }
    }

    /// Every sleep parks until the test lets it end, so a test sees exactly what happens before a deadline.
    #[derive(Clone)]
    struct ScriptedClock {
        entered: Arc<Notify>,
        gate: Arc<Semaphore>,
        log: Log,
    }

    impl ScriptedClock {
        fn new(log: &Log) -> Self {
            Self { entered: Arc::new(Notify::new()), gate: Arc::new(Semaphore::new(0)), log: log.clone() }
        }
    }

    impl Clock for ScriptedClock {
        async fn sleep(&self, duration: Duration) {
            push(&self.log, json!({"op": "sleep", "ms": duration.as_millis() as u64}));
            self.entered.notify_one();
            self.gate.acquire().await.unwrap().forget();
        }
    }

    type Scripted = Tree<ScriptedReader, ScriptedSignals, ScriptedClock>;

    const ROOT: u32 = 5100;

    /// The tree of a scenario after the post-exit look that found its survivors (the first table), with the
    /// log emptied there: what follows is what `killShellDescendants` / `waitForShellDescendants` did.
    fn probed(scenario: &Value, signals: impl FnOnce(&Log) -> ScriptedSignals) -> (Arc<Scripted>, ScriptedClock, Log) {
        let log = Log::default();
        let clock = ScriptedClock::new(&log);
        let tree = Arc::new(Tree::new(ScriptedReader::new(&scenario["tables"], &log), signals(&log), clock.clone(), ROOT, None));
        tree.root_reaped();
        assert!(matches!(tree.observe(), Observation::Running(_)), "{}: the survivors are found", scenario["name"]);
        log.lock().unwrap().clear();
        (tree, clock, log)
    }

    /// Lets the spawned `task` run to its end, letting each sleep it parks in end only after checking that nothing was
    /// read or sent while it was parked; `on_sleep` sees each one (the log so far).
    async fn run_gated<T>(task: tokio::task::JoinHandle<T>, clock: &ScriptedClock, log: &Log, mut on_sleep: impl FnMut(&[Value])) -> T {
        let mut task = task;
        loop {
            tokio::select! {
                done = &mut task => return done.unwrap(),
                () = clock.entered.notified() => {
                    let before = logged(log);
                    tokio::task::yield_now().await;
                    assert_eq!(logged(log), before, "nothing is read or signalled while a wait runs");
                    on_sleep(&log.lock().unwrap());
                    clock.gate.add_permits(1);
                }
            }
        }
    }

    #[tokio::test]
    async fn observations_match_nodes_tracker_for_the_same_tables() {
        for scenario in scenarios("observe") {
            let log = Log::default();
            let root_token = scenario.get("capture").map(|rows| {
                let mut rows = rows.as_array().unwrap().iter();
                rows.find(|row| row["pid"] == ROOT).unwrap()["token"].as_str().unwrap().to_owned()
            });
            let tree = Tree::new(ScriptedReader::new(&scenario["tables"], &log), ScriptedSignals::new(&log), ScriptedClock::new(&log), ROOT, root_token);
            tree.root_reaped();
            let steps: Vec<Value> = (0..scenario["tables"].as_array().unwrap().len())
                .map(|_| match tree.observe() {
                    Observation::Running(live) => {
                        json!({"state": "running", "live": live.iter().map(|i| json!({"pid": i.pid, "token": i.token})).collect::<Vec<_>>()})
                    }
                    Observation::Gone => json!({"state": "gone", "live": []}),
                    Observation::Unknown => json!({"state": "unknown", "live": []}),
                })
                .collect();
            assert_eq!(Value::Array(steps), scenario["result"]["steps"], "{}", scenario["name"]);
        }
    }

    #[tokio::test]
    async fn a_cancel_sends_what_nodes_kill_sent_in_its_order() {
        for scenario in scenarios("cancel") {
            let (tree, clock, log) = probed(&scenario, |log| ScriptedSignals::new(log).probes(&scenario["groupProbes"], &scenario["pidProbes"]));
            let task = tokio::spawn({
                let tree = tree.clone();
                async move { tree.cancel().await }
            });
            // The deadlines: right after a SIGTERM only the wait that follows it is open; the SIGKILL comes after it.
            let terminated = run_gated(task, &clock, &log, |so_far| {
                let sleep_at = so_far.len() - 1;
                assert_eq!(so_far[sleep_at]["op"], "sleep");
                if so_far[sleep_at]["ms"] == 200 || so_far[sleep_at]["ms"] == 300 {
                    let sigkills = so_far[..sleep_at].iter().filter(|e| e["signal"] == "SIGKILL").count();
                    let sigterms = so_far[..sleep_at].iter().filter(|e| e["signal"] == "SIGTERM").count();
                    assert!(sigterms > sigkills, "{}: a grace opens with the SIGTERM it waits out", scenario["name"]);
                }
            })
            .await;
            assert_eq!(Value::Array(log.lock().unwrap().clone()), scenario["events"], "{}", scenario["name"]);
            assert_eq!(terminated, scenario["result"]["terminated"], "{}", scenario["name"]);
        }
    }

    #[tokio::test]
    async fn the_passive_wait_looks_at_every_recheck_and_only_an_empty_look_ends_it() {
        for scenario in scenarios("wait") {
            let (tree, clock, log) = probed(&scenario, ScriptedSignals::new);
            let task = tokio::spawn({
                let tree = tree.clone();
                async move { tree.wait_gone().await }
            });
            let recheck = scenario["result"]["recheckMs"].as_u64().unwrap();
            let mut sleeps = 0;
            run_gated(task, &clock, &log, |so_far| {
                assert_eq!(so_far.last().unwrap()["ms"], recheck);
                sleeps += 1;
            })
            .await;
            let reads = log.lock().unwrap().iter().filter(|e| e["op"] == "read").count() as u64;
            assert_eq!(reads, scenario["result"]["reads"].as_u64().unwrap(), "{}", scenario["name"]);
            assert_eq!(sleeps + 1, reads, "one recheck between looks");
        }
    }

    /// Where the system announces an exit, the wait looks again at once instead of after a recheck. Rust is only faster
    /// than Node here and every state is the same (decisions.md U-SV1).
    #[tokio::test]
    async fn an_announced_exit_wakes_the_wait_without_a_recheck() {
        // The recorded wait's readable tables only: an unreadable one is rechecked by time whatever announces exits.
        let mut scenario = scenarios("wait").remove(0);
        let readable: Vec<Value> = scenario["tables"].as_array().unwrap().iter().filter(|t| t.is_array()).cloned().collect();
        scenario["tables"] = Value::Array(readable);
        let (tree, _clock, log) = probed(&scenario, |log| ScriptedSignals { exits: true, ..ScriptedSignals::new(log) });
        tree.wait_gone().await;
        assert!(log.lock().unwrap().iter().all(|event| event["op"] == "read"), "no sleep was needed");
    }

    /// The group id is the root's pid, free for reuse once the root is reaped: then the table decides.
    #[tokio::test]
    async fn a_group_is_signalled_only_while_its_id_is_still_ours() {
        let signalled = |reaped: bool, tables: Value| {
            let log = Log::default();
            let tree = Tree::new(
                ScriptedReader::new(&tables, &log),
                ScriptedSignals::new(&log),
                ScriptedClock::new(&log),
                ROOT,
                Some("rt".to_owned()),
            );
            if reaped {
                tree.root_reaped();
            }
            tree.signal_group(Signal::Kill);
            let events = log.lock().unwrap().clone();
            events
        };
        let row = |token: &str| json!({"pid": ROOT, "ppid": 1, "pgid": ROOT, "token": token});
        let kill = json!({"op": "kill", "target": "group", "id": ROOT, "signal": "SIGKILL"});
        assert_eq!(signalled(false, json!([[row("anything")]])), [kill.clone()], "the root runs: the group is ours, nothing is read");
        assert_eq!(signalled(true, json!([[]])), [json!({"op": "read"}), kill.clone()], "the id is free: nobody else holds it");
        assert_eq!(signalled(true, json!([[row("rt")]])), [json!({"op": "read"}), kill], "the same process still holds it");
        assert_eq!(signalled(true, json!([[row("someone-else")]])), [json!({"op": "read"})], "another process holds the id");
        assert_eq!(signalled(true, json!([{"error": "denied"}])), [json!({"op": "read"})], "unknown ownership signals nothing");
    }

    #[tokio::test]
    async fn the_retention_probe_asks_the_group_and_nothing_else() {
        let log = Log::default();
        let tree = Tree::new(ScriptedReader::new(&json!([[]]), &log), ScriptedSignals::new(&log), ScriptedClock::new(&log), ROOT, None);
        assert!(tree.group_may_be_occupied());
        assert_eq!(*log.lock().unwrap(), [json!({"op": "kill", "target": "group", "id": ROOT, "signal": 0})]);
    }
}