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

use std::collections::HashMap;
use std::collections::HashSet;
use std::io;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::contain::Waited;

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
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
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
    pub(crate) fn with_unreadable(procs: Vec<Proc>, unreadable: Vec<u32>) -> Self {
        let mut at = HashMap::new();
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        for (index, proc) in procs.iter().enumerate() {
            at.insert(proc.pid, index);
            children.entry(proc.ppid).or_default().push(proc.pid);
        }
        Self { procs, at, children, unreadable: unreadable.into_iter().collect() }
    }

    /// The table of `pids`, each read with `row`: a pid the kernel will not show us is listed as unreadable and the
    /// read goes on.
    pub(crate) fn scan(pids: impl IntoIterator<Item = u32>, row: impl Fn(u32) -> io::Result<Row>) -> io::Result<Self> {
        let mut procs = Vec::new();
        let mut unreadable = Vec::new();
        for pid in pids {
            match row(pid)? {
                Row::Readable(proc) => procs.push(proc),
                Row::Absent => {}
                Row::Unreadable => unreadable.push(pid),
            }
        }
        Ok(Self::with_unreadable(procs, unreadable))
    }

    /// The readable processes, in the reader's order.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub(crate) fn procs(&self) -> &[Proc] {
        &self.procs
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
    /// SIGKILL to `target` only while it is still that process, the one way shutdown signals an individual: `false`
    /// when nothing was sent.
    fn kill_identified(&self, _target: &Identity) -> bool {
        false
    }
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
    shutdown_tracked: HashSet<Identity>,
    candidates: Vec<Candidate>,
}

impl Tracker {
    fn absorb_shutdown(&mut self, table: &Table, pinned: bool, reader: &impl Reader) {
        let mut seeds = Vec::new();
        if pinned {
            seeds.push(self.root);
            seeds.extend(table.procs.iter().filter(|proc| proc.pgid == self.root).map(|proc| proc.pid));
        }
        seeds
            .extend(self.shutdown_tracked.iter().filter_map(|identity| (table.row(identity.pid).relation(identity) == Relation::Same).then_some(identity.pid)));
        let mut seen = HashSet::new();
        while let Some(pid) = seeds.pop() {
            if !seen.insert(pid) {
                continue;
            }
            if pinned && pid == self.root {
                seeds.extend(table.children(pid));
                continue;
            }
            let Some(token) = table.token(pid) else { continue };
            let identity = Identity { pid, token: token.to_owned() };
            // The table is not atomic. Before trusting a parent link, make
            // sure the parent still has the identity in the captured table.
            if !table.children(pid).is_empty() && matches!(reader.row(pid), Ok(row) if row.relation(&identity) == Relation::Same) {
                seeds.extend(table.children(pid));
            }
            self.shutdown_tracked.insert(identity);
        }
    }

    fn shutdown_members(&self) -> impl Iterator<Item = &Identity> {
        self.tracked.iter().chain(self.shutdown_tracked.iter())
    }

    fn shutdown_candidates_gone(&self, row: impl Fn(u32) -> Row) -> bool {
        self.candidates.iter().all(|candidate| match row(candidate.pid) {
            Row::Absent => candidate.token.is_some(),
            Row::Readable(proc) => candidate.token.as_deref() != Some(proc.token.as_str()),
            Row::Unreadable => false,
        })
    }

    /// While the root is unreaped, the lifecycle evidence is the ownership proof and its row is not
    /// consulted: a child that has not been waited for keeps its pid (a zombie holds it), so the pid
    /// cannot have been reused and cannot name anyone but our root, whether its row reads, is absent
    /// or is unreadable. Once reaped the pid may be anyone's and only the row decides: the same
    /// token or a confirmed absence keep it ours, another token does not, and a row we cannot read
    /// grants nothing. `group_is_ours` and `signal_group` rest on the same proof.
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
        self.adopt_verified(table, ownership == Ownership::Ours);
        self.suspect_uninspectable(table, ownership);
        self.settle_candidates(table);
    }

    fn adopt_verified(&mut self, table: &Table, ours: bool) {
        let mut from: Vec<u32> = Vec::new();
        if ours {
            from.push(self.root);
        }
        from.extend(self.tracked.iter().filter(|identity| table.row(identity.pid).relation(identity) == Relation::Same).map(|i| i.pid));
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
    }

    fn suspect_uninspectable(&mut self, table: &Table, ownership: Ownership) {
        let mut unknown_parents: Vec<u32> =
            self.tracked.iter().filter(|identity| table.row(identity.pid).relation(identity) == Relation::Unknown).map(|identity| identity.pid).collect();
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
    }

    fn settle_candidates(&mut self, table: &Table) {
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
        let live: Vec<Identity> = self.tracked.iter().filter(|identity| table.row(identity.pid).relation(identity) == Relation::Same).cloned().collect();
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
            tracker: Mutex::new(Tracker { root, root_token, tracked: Vec::new(), shutdown_tracked: HashSet::new(), candidates: Vec::new() }),
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

    /// Whether the root's pid and group id still name our root's, read now. An unreaped root is owned
    /// by its lifecycle ([`Tracker::ownership`]), so then nothing is read.
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

    /// Keeps what the group holds for [`Self::shutdown_descendants`], which may come once the group id is anyone's. The
    /// root was started with `setsid` and cannot be reaped meanwhile (the caller is its reaper, or holds the reap lock):
    /// another session cannot join this group, and the unreaped PID cannot be reused. Neither guarantee depends on a
    /// process-table read.
    pub(crate) fn keep_private_group(&self) {
        if let Ok(table) = self.reader.table() {
            self.tracker().absorb_shutdown(&table, true, &self.reader);
        }
    }

    /// [`Self::keep_private_group`], then the group's SIGKILL.
    pub(crate) fn shutdown_private_group(&self) {
        self.keep_private_group();
        self.signals.group(self.root, Signal::Kill);
    }

    /// A numeric group probe also finds zombies. An authoritative live table
    /// can show that a record no longer needs to be retained for that group.
    pub(crate) fn group_has_live_members(&self) -> bool {
        self.group_may_be_occupied()
            && match self.reader.table() {
                Ok(table) => !table.complete() || table.procs.iter().any(|proc| proc.pgid == self.root),
                Err(_) => true,
            }
    }

    pub(crate) fn shutdown_survivor_confirmed(&self) -> bool {
        self.tracker().shutdown_tracked.iter().any(|identity| self.is_same(identity))
    }

    pub(crate) fn shutdown_idle(&self) -> bool {
        if !self.reaped.load(Ordering::Acquire) || self.group_has_live_members() {
            return false;
        }
        let tracker = self.tracker();
        let gone = tracker
            .shutdown_members()
            .all(|identity| matches!(self.reader.row(identity.pid), Ok(row) if matches!(row.relation(identity), Relation::Absent | Relation::Different)));
        gone && tracker.shutdown_candidates_gone(|pid| self.reader.row(pid).unwrap_or(Row::Unreadable))
    }

    pub(crate) async fn shutdown_descendants(&self) {
        if self.shutdown_idle() {
            return;
        }
        for _ in 0..KILL_ROUNDS {
            let Ok(table) = self.reader.table() else {
                return;
            };
            let targets = {
                let mut tracker = self.tracker();
                tracker.absorb_shutdown(&table, false, &self.reader);
                tracker.shutdown_tracked.iter().filter(|identity| table.row(identity.pid).relation(identity) == Relation::Same).cloned().collect::<Vec<_>>()
            };
            if !targets.iter().fold(false, |sent, target| self.signals.kill_identified(target) || sent) {
                return;
            }
            self.clock.sleep(GROUP_FORCED_WAIT).await;
        }
    }

    /// A tree kill of the group while the command still runs, or while the group is still ours. The
    /// root's pid and group id are free for reuse once the root is reaped, so then the table decides
    /// whether they still name our group; a table that cannot be read signals nothing. While the
    /// root is unreaped its lifecycle is the proof of ownership ([`Tracker::ownership`]) and its row
    /// is not read.
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

    /// `waitForShellDescendants`: completes [`Waited::Gone`] when the tree is gone, or
    /// [`Waited::Aborted`] when `abort` is raised first, which is Node's `false`: an `abort` already
    /// raised answers before anything is read, and one raised during the wait ends it without
    /// another look, whatever that look would have found.
    pub(crate) async fn wait_gone(&self, abort: &CancellationToken) -> Waited {
        if abort.is_cancelled() {
            return Waited::Aborted;
        }
        tokio::select! {
            biased;
            () = abort.cancelled() => Waited::Aborted,
            () = self.until_gone() => Waited::Gone,
        }
    }

    async fn until_gone(&self) {
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
mod tests;
