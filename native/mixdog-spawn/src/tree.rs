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
//! a recycled pid is a different process, neither keeps a survivor alive nor becomes a target.
//!
//! What a read cannot show is unknown, never absent and never empty:
//! * a pid's row is [`Row::Absent`] (authoritatively not there), [`Row::Readable`] or
//!   [`Row::Unreadable`] (there, or perhaps, but not inspectable); against a followed identity that
//!   is a [`Relation`]: `Same`, `Different` (the pid is someone else now), `Absent` or `Unknown`;
//! * the verified survivors, the unresolved candidates and the completeness of the listing are kept
//!   apart: any verified survivor is `Running`; none verified but a candidate or an incomplete
//!   listing is `Unknown`; `Gone` needs neither. `Unknown` is never a signal target, and signals
//!   carry identities that are revalidated just before they are sent.

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

/// What a read shows of one pid.
#[derive(Clone, Debug)]
pub(crate) enum Row {
    /// Nothing has this pid (or only a process that ended).
    Absent,
    Readable(Proc),
    /// Something has this pid and the kernel will not show it to us (it may have changed credentials).
    Unreadable,
}

/// How a row stands to an identity that was followed. `Unknown` never equals `Same`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Relation {
    Same,
    /// The pid belongs to another process now: the identity ended.
    Different,
    Absent,
    Unknown,
}

impl Row {
    pub(crate) fn relation(&self, identity: &Identity) -> Relation {
        match self {
            Self::Absent => Relation::Absent,
            Self::Unreadable => Relation::Unknown,
            Self::Readable(proc) if proc.token == identity.token => Relation::Same,
            Self::Readable(_) => Relation::Different,
        }
    }
}

/// A read of the process table, in the reader's order.
pub(crate) struct Table {
    procs: Vec<Proc>,
    at: HashMap<u32, usize>,
    children: HashMap<u32, Vec<u32>>,
    /// Pids the listing named whose rows the kernel would not show us: they are there, and nothing
    /// more is known of them. A listing with any is incomplete: they may belong to the tree.
    unreadable: HashSet<u32>,
}

impl Table {
    pub(crate) fn new(procs: Vec<Proc>) -> Self {
        Self::with_unreadable(procs, Vec::new())
    }

    pub(crate) fn with_unreadable(procs: Vec<Proc>, unreadable: Vec<u32>) -> Self {
        let mut at = HashMap::new();
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        for (index, proc) in procs.iter().enumerate() {
            at.insert(proc.pid, index);
            children.entry(proc.ppid).or_default().push(proc.pid);
        }
        Self { procs, at, children, unreadable: unreadable.into_iter().collect() }
    }

    pub(crate) fn row(&self, pid: u32) -> Row {
        match self.at.get(&pid) {
            Some(&index) => Row::Readable(self.procs[index].clone()),
            None if self.unreadable.contains(&pid) => Row::Unreadable,
            None => Row::Absent,
        }
    }

    /// Whether every process the listing named could be read.
    fn complete(&self) -> bool {
        self.unreadable.is_empty()
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
    /// One pid, read now: how a signal's target is revalidated just before it is sent. An error
    /// means it is unknown.
    fn row(&self, pid: u32) -> io::Result<Row>;
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
    /// These verified identities are alive.
    Running(Vec<Identity>),
    /// Nothing of the tree is left, and nothing is unaccounted for.
    Gone,
    /// No survivor is verified, but the table could not be read, or it could not show every process,
    /// or a candidate is unresolved: nothing is known.
    Unknown,
}

/// Whether the root's pid and group still name our root's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Ownership {
    /// Its child links and its group are ours.
    Ours,
    /// A different process holds the pid: none of what hangs off it is ours.
    NotOurs,
    /// The pid is held by something we cannot inspect: no grant.
    Unknown,
}

/// A process that might belong to the tree and has not been shown to: never an owned descendant,
/// never a signal target.
struct Candidate {
    pid: u32,
    /// The token it had when it was met under a parent of unknown identity; `None` for a pid that was
    /// only ever unreadable, which has no token to end with.
    token: Option<String>,
}

/// `createProcessTreeTracker`, POSIX form, for a root whose exit we saw ourselves (it is our own
/// child, reaped by us): the identities it has verified, in the order they were met, and the
/// candidates still unresolved.
struct Tracker {
    root: u32,
    /// The root's start token, taken while it was known ours.
    root_token: Option<String>,
    tracked: Vec<Identity>,
    candidates: Vec<Candidate>,
}

impl Tracker {
    /// An unreaped child keeps its pid, so then it is ours whatever the table shows. Once reaped the
    /// pid may be anyone's: the same token or a confirmed absence keep it ours, another token does
    /// not, and a row we cannot read grants nothing.
    fn ownership(&self, root: &Row, reaped: bool) -> Ownership {
        if !reaped {
            return Ownership::Ours;
        }
        match root {
            Row::Absent => Ownership::Ours,
            Row::Unreadable => Ownership::Unknown,
            Row::Readable(proc) if self.root_token.as_deref() == Some(proc.token.as_str()) => Ownership::Ours,
            Row::Readable(_) => Ownership::NotOurs,
        }
    }

    fn track(&mut self, table: &Table, pid: u32) {
        if let Some(token) = table.token(pid) {
            let identity = Identity { pid, token: token.to_owned() };
            if !self.tracked.contains(&identity) {
                self.tracked.push(identity);
            }
        }
    }

    fn is_tracked(&self, pid: u32, token: &str) -> bool {
        self.tracked.iter().any(|identity| identity.pid == pid && identity.token == token)
    }

    fn suspect(&mut self, pid: u32, token: Option<&str>) {
        if !self.candidates.iter().any(|c| c.pid == pid && c.token.as_deref() == token) {
            self.candidates.push(Candidate { pid, token: token.map(str::to_owned) });
        }
    }

    /// Admits what this read shows. Only verified ownership seeds adoption: the root's descendants
    /// and group members (while the root is ours) and the descendants of every tracked identity that
    /// is verifiably the same process. What hangs off a pid we cannot inspect is a candidate, and so
    /// is a pid that was only ever unreadable.
    fn absorb(&mut self, table: &Table, ownership: Ownership) {
        let ours = ownership == Ownership::Ours;
        let mut from: Vec<u32> = Vec::new();
        if ours {
            from.push(self.root);
        }
        from.extend(
            self.tracked.iter().filter(|identity| table.row(identity.pid).relation(identity) == Relation::Same).map(|i| i.pid),
        );
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
        let mut unknown_parents: Vec<u32> = self
            .tracked
            .iter()
            .filter(|identity| table.row(identity.pid).relation(identity) == Relation::Unknown)
            .map(|identity| identity.pid)
            .collect();
        if ownership == Ownership::Unknown {
            unknown_parents.push(self.root);
        }
        for &parent in &unknown_parents {
            for &child in table.children(parent) {
                if let Some(token) = table.token(child).filter(|token| !self.is_tracked(child, token)) {
                    self.suspect(child, Some(token));
                }
            }
        }
        let bare: Vec<u32> = table.unreadable.iter().copied().filter(|&pid| pid != self.root && !unknown_parents.contains(&pid)).collect();
        for pid in bare {
            self.suspect(pid, None);
        }
        // A candidate ends only on evidence: promoted by the walk above, or its own identity ended. A pid
        // that was only ever unreadable has no identity to end, and its coverage gap stays open until a
        // readable process shows nothing ties it to the tree.
        let tracked = &self.tracked;
        self.candidates.retain(|candidate| match table.row(candidate.pid) {
            Row::Unreadable => true,
            Row::Absent => candidate.token.is_none(),
            Row::Readable(proc) => {
                let promoted = tracked.iter().any(|identity| identity.pid == proc.pid && identity.token == proc.token);
                !promoted && candidate.token.as_deref() == Some(proc.token.as_str())
            }
        });
    }

    /// The root while it has not been reaped, if the table shows it as the process it was.
    fn live_root(&mut self, root: &Row, reaped: bool) -> Option<Identity> {
        let Row::Readable(proc) = root else {
            return None;
        };
        if reaped {
            return None;
        }
        let known = self.root_token.get_or_insert_with(|| proc.token.clone());
        (*known == proc.token).then(|| Identity { pid: self.root, token: proc.token.clone() })
    }

    fn observe(&mut self, table: &Table, reaped: bool) -> Observation {
        let root = table.row(self.root);
        let ownership = self.ownership(&root, reaped);
        self.absorb(table, ownership);
        if let Some(root) = self.live_root(&root, reaped) {
            return Observation::Running(vec![root]);
        }
        let live: Vec<Identity> =
            self.tracked.iter().filter(|identity| table.row(identity.pid).relation(identity) == Relation::Same).cloned().collect();
        if !live.is_empty() {
            Observation::Running(live)
        } else if !self.candidates.is_empty() || !table.complete() {
            Observation::Unknown
        } else {
            Observation::Gone
        }
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
    /// The verified identities the last observation found alive: what a cancel signals, each revalidated
    /// first. Empty after any look that was not a verified `Running`.
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
            tracker: Mutex::new(Tracker { root, root_token, tracked: Vec::new(), candidates: Vec::new() }),
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
        let observation = match self.reader.table() {
            Ok(table) => self.tracker().observe(&table, self.reaped.load(Ordering::Acquire)),
            Err(_) => Observation::Unknown,
        };
        *self.live.lock().unwrap_or_else(|e| e.into_inner()) = match &observation {
            Observation::Running(live) => live.clone(),
            _ => Vec::new(),
        };
        observation
    }

    /// Whether the root's pid and group id still name our root's, read now.
    fn group_is_ours(&self) -> bool {
        if !self.reaped.load(Ordering::Acquire) {
            return true;
        }
        matches!(self.reader.row(self.root), Ok(root) if self.tracker().ownership(&root, true) == Ownership::Ours)
    }

    /// Whether `identity` is still the process that was seen, read now.
    fn is_same(&self, identity: &Identity) -> bool {
        matches!(self.reader.row(identity.pid), Ok(row) if row.relation(identity) == Relation::Same)
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
        if self.tracker().ownership(&table.row(self.root), true) == Ownership::Ours {
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

    /// `killProcessTrees` on POSIX: SIGTERM to each, a grace, then SIGKILL to those still alive. A
    /// pid is only a name, so each identity is read again before each signal and a target that is no
    /// longer verifiably the process that was seen (reused, gone, or unreadable) is left alone; the
    /// existence probe that Node escalates on says something is there, not that it is this process.
    async fn kill_trees(&self, targets: &[Identity]) {
        let sent: Vec<&Identity> = targets
            .iter()
            .filter(|identity| self.is_same(identity))
            .inspect(|identity| {
                self.signals.process(identity.pid, Signal::Term);
            })
            .collect();
        if sent.is_empty() {
            return;
        }
        self.clock.sleep(TARGET_GRACE).await;
        for identity in sent {
            if self.signals.process(identity.pid, Signal::Probe) && self.is_same(identity) {
                self.signals.process(identity.pid, Signal::Kill);
            }
        }
    }

    /// `killShellDescendants`: ends the group while it is still ours, then the verified identities
    /// that are still the processes that were seen, then looks again; what the kill missed is killed in
    /// the next of up to [`KILL_ROUNDS`] rounds. `true` only when a look finds nothing left: a look that
    /// cannot tell, or survivors after the last round, are an unconfirmed termination.
    pub(crate) async fn cancel(&self) -> bool {
        let Ok(table) = self.reader.table() else {
            return false;
        };
        let targets = self.live.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if self.tracker().ownership(&table.row(self.root), self.reaped.load(Ordering::Acquire)) == Ownership::Ours {
            self.signals.group(self.root, Signal::Term);
            self.clock.sleep(GROUP_GRACE).await;
            // Ownership is read again after the grace: the id may have been freed and taken meanwhile.
            if self.group_is_ours() && self.signals.group(self.root, Signal::Probe) {
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
            self.kill_trees(live).await;
            observed = self.observe();
        }
        observed == Observation::Gone
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
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

        /// A single-pid read shows the table as last served and does not advance the script: Node's tracker has no
        /// such read, so the recording's tables stay in step with the reads it made.
        fn row(&self, pid: u32) -> io::Result<Row> {
            push(&self.log, json!({"op": "row"}));
            let at = self.reads.load(Ordering::SeqCst).saturating_sub(1).min(self.tables.len() - 1);
            table_of(&self.tables[at]).map(|table| table.row(pid))
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
            // Node's events are the reads and signals; the single-pid revalidations are Rust's own and are no event of its.
            let events: Vec<Value> = log.lock().unwrap().iter().filter(|e| e["op"] != "row").cloned().collect();
            assert_eq!(Value::Array(events), scenario["events"], "{}", scenario["name"]);
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

    fn proc(pid: u32, ppid: u32, pgid: u32, token: &str) -> Proc {
        Proc { pid, ppid, pgid, token: token.to_owned() }
    }

    /// One read of the table: the rows it could read and the pids it could not.
    type Listing = (Vec<Proc>, Vec<u32>);

    /// A reader whose full reads and single-pid reads are scripted apart (each script repeats its last answer; a pid with
    /// no script is absent).
    struct Split {
        tables: Mutex<VecDeque<Listing>>,
        rows: Mutex<HashMap<u32, VecDeque<Row>>>,
    }

    impl Split {
        fn new(tables: Vec<Listing>) -> Self {
            Self { tables: Mutex::new(tables.into()), rows: Mutex::new(HashMap::new()) }
        }

        fn rows(self, pid: u32, rows: Vec<Row>) -> Self {
            self.rows.lock().unwrap().insert(pid, rows.into());
            self
        }
    }

    impl Reader for Split {
        fn table(&self) -> io::Result<Table> {
            let mut tables = self.tables.lock().unwrap();
            let (procs, unreadable) = if tables.len() > 1 { tables.pop_front().unwrap() } else { tables[0].clone() };
            Ok(Table::with_unreadable(procs, unreadable))
        }

        fn row(&self, pid: u32) -> io::Result<Row> {
            let mut rows = self.rows.lock().unwrap();
            let Some(script) = rows.get_mut(&pid) else {
                return Ok(Row::Absent);
            };
            Ok(if script.len() > 1 { script.pop_front().unwrap() } else { script[0].clone() })
        }
    }

    /// Runs a cancel over `reader` after an observation that found the survivor `s1` at 7000; returns what it reported and
    /// the signals it sent to processes (not the group).
    async fn cancelled(reader: Split, pid_probes: &[bool]) -> (bool, Vec<Value>) {
        let log = Log::default();
        let clock = ScriptedClock::new(&log);
        let mut signals = ScriptedSignals::new(&log);
        signals.pid_probes = pid_probes.to_vec();
        let tree = Arc::new(Tree::new(reader, signals, clock.clone(), ROOT, None));
        tree.root_reaped();
        assert_eq!(tree.observe(), Observation::Running(vec![Identity { pid: 7000, token: "s1".to_owned() }]));
        log.lock().unwrap().clear();
        let task = tokio::spawn({
            let tree = tree.clone();
            async move { tree.cancel().await }
        });
        let terminated = run_gated(task, &clock, &log, |_| {}).await;
        let sent = log.lock().unwrap().iter().filter(|e| e["target"] == "pid").cloned().collect();
        (terminated, sent)
    }

    fn kill_of(pid: u32, signal: Value) -> Value {
        json!({"op": "kill", "target": "pid", "id": pid, "signal": signal})
    }

    /// A survivor whose row the kernel will not show (it changed credentials) is there, not gone, and not verified: the
    /// look that cannot read it is `Unknown`, and the look after it ended is `Gone`.
    #[tokio::test]
    async fn a_tracked_survivor_the_table_cannot_read_is_unknown_then_gone() {
        let survivor = proc(7000, 1, ROOT, "s1");
        let reads = Split::new(vec![(vec![survivor], vec![]), (vec![], vec![7000]), (vec![], vec![])]);
        let log = Log::default();
        let tree = Tree::new(reads, ScriptedSignals::new(&log), ScriptedClock::new(&log), ROOT, None);
        tree.root_reaped();
        assert_eq!(tree.observe(), Observation::Running(vec![Identity { pid: 7000, token: "s1".to_owned() }]));
        assert_eq!(tree.observe(), Observation::Unknown, "there, and not verified");
        assert_eq!(tree.observe(), Observation::Gone, "its identity ended and nothing else is unaccounted for");
        assert!(tree.live.lock().unwrap().is_empty(), "no stale target is left to be signalled");
    }

    /// A pid whose process cannot be read is never a signal target: whatever holds it now is not shown to be the
    /// survivor that was seen there.
    #[tokio::test]
    async fn a_pid_taken_over_by_an_unreadable_process_is_never_signalled() {
        let survivor = proc(7000, 1, ROOT, "s1");
        let reader = Split::new(vec![(vec![survivor.clone()], vec![]), (vec![survivor], vec![]), (vec![], vec![7000])])
            .rows(7000, vec![Row::Unreadable]);
        let (terminated, sent) = cancelled(reader, &[true]).await;
        assert_eq!(sent, Vec::<Value>::new());
        assert!(!terminated, "an unreadable process is not a confirmed termination");
    }

    /// The existence probe says something is at the pid after the grace; the identity read decides whether it is the
    /// survivor, and only the same process is killed.
    #[tokio::test]
    async fn the_kill_is_revalidated_after_the_grace() {
        let survivor = proc(7000, 1, ROOT, "s1");
        let listing = || (vec![survivor.clone()], vec![]);
        let term = kill_of(7000, json!("SIGTERM"));
        let probe = kill_of(7000, json!(0));
        let kill = kill_of(7000, json!("SIGKILL"));
        let taken = (vec![proc(7000, 1, 1, "someone-else")], vec![]);
        for (after_grace, then) in [(Row::Readable(proc(7000, 1, 1, "someone-else")), taken), (Row::Unreadable, (vec![], vec![7000]))] {
            let same = Row::Readable(survivor.clone());
            let reader = Split::new(vec![listing(), listing(), then]).rows(7000, vec![same, after_grace]);
            let (_, sent) = cancelled(reader, &[true]).await;
            assert_eq!(sent, [term.clone(), probe.clone()], "no SIGKILL for a pid that is not verifiably the survivor");
        }
        let same = Row::Readable(survivor.clone());
        let (_, sent) = cancelled(Split::new(vec![listing(), listing(), (vec![], vec![])]).rows(7000, vec![same]), &[true]).await;
        assert_eq!(sent, [term, probe, kill], "the same process is killed");
    }

    /// A root pid that cannot be read grants no ownership of its group or its links, and what hangs off it is a
    /// candidate, not a descendant.
    #[tokio::test]
    async fn an_unreadable_root_grants_no_ownership() {
        let member = proc(7001, ROOT, ROOT, "m");
        let log = Log::default();
        let reader = Split::new(vec![(vec![member], vec![ROOT])]);
        let tree = Tree::new(reader, ScriptedSignals::new(&log), ScriptedClock::new(&log), ROOT, Some("rt".to_owned()));
        tree.root_reaped();
        assert_eq!(tree.observe(), Observation::Unknown, "its child is not adopted, and nothing is known");
        tree.signal_group(Signal::Kill);
        assert_eq!(*log.lock().unwrap(), Vec::<Value>::new(), "the group is not signalled");
    }

    /// The first look finds a pid it cannot read and nothing else: that is not an empty tree, and the gap does not
    /// close because the pid is gone from the next listing.
    #[tokio::test]
    async fn a_first_look_that_cannot_read_a_pid_is_not_gone() {
        let log = Log::default();
        let tree = Tree::new(Split::new(vec![(vec![], vec![9000]), (vec![], vec![])]), ScriptedSignals::new(&log), ScriptedClock::new(&log), ROOT, None);
        tree.root_reaped();
        assert_eq!(tree.observe(), Observation::Unknown);
        assert_eq!(tree.observe(), Observation::Unknown, "what it was is still not known");
        let control = Tree::new(Split::new(vec![(vec![], vec![])]), ScriptedSignals::new(&log), ScriptedClock::new(&log), ROOT, None);
        control.root_reaped();
        assert_eq!(control.observe(), Observation::Gone, "a complete listing with nothing in it is gone");
    }

    #[tokio::test]
    async fn the_retention_probe_asks_the_group_and_nothing_else() {
        let log = Log::default();
        let tree = Tree::new(ScriptedReader::new(&json!([[]]), &log), ScriptedSignals::new(&log), ScriptedClock::new(&log), ROOT, None);
        assert!(tree.group_may_be_occupied());
        assert_eq!(*log.lock().unwrap(), [json!({"op": "kill", "target": "group", "id": ROOT, "signal": 0})]);
    }
}