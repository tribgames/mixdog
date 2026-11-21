use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;

use serde_json::Value;
use serde_json::json;
use tokio::sync::Notify;
use tokio::sync::Semaphore;

use super::*;

/// What Node's own tracker did with the same scripted tables, signals and timers
/// (a capture of Node commit b6f10295a, kept here as `tests/fixtures/shell-tracker-trace.json`;
/// the recorder and its manifest are not part of this repository).
fn scenarios(kind: &str) -> Vec<Value> {
    let golden: Value = serde_json::from_str(include_str!("../../tests/fixtures/shell-tracker-trace.json")).unwrap();
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
    Ok(Table::with_unreadable(procs.collect(), Vec::new()))
}

/// Answers every table read from the script, the last answer again once it runs out (as Node's script did).
///
/// Node's tracker has no single-pid read, so the recording has none. Rust's identity reads (`group_is_ours`, `is_same`)
/// are answered from the same recording but on a script of their own: the n-th read of a pid shows that pid in the
/// recording's n-th readable table, whatever the table reads have reached. They are Rust's own events, kept in
/// `identity_reads` apart from the Node trace's `log`; the complete interleaved sequence of them with the signals is
/// asserted by `the_safety_reads_are_made_where_the_contract_says`.
struct ScriptedReader {
    tables: Vec<Value>,
    reads: AtomicUsize,
    rows: Mutex<HashMap<u32, usize>>,
    identity_reads: Log,
    log: Log,
}

impl ScriptedReader {
    fn new(tables: &Value, log: &Log) -> Self {
        Self {
            tables: tables.as_array().unwrap().clone(),
            reads: AtomicUsize::new(0),
            rows: Mutex::new(HashMap::new()),
            identity_reads: Log::default(),
            log: log.clone(),
        }
    }
}

impl Reader for ScriptedReader {
    fn table(&self) -> io::Result<Table> {
        push(&self.log, json!({"op": "read"}));
        let at = self.reads.fetch_add(1, Ordering::SeqCst).min(self.tables.len() - 1);
        table_of(&self.tables[at])
    }

    fn row(&self, pid: u32) -> io::Result<Row> {
        push(&self.identity_reads, json!({"op": "row", "pid": pid}));
        let readable: Vec<Table> = self.tables.iter().filter_map(|rows| table_of(rows).ok()).collect();
        let mut asked = self.rows.lock().unwrap();
        let nth = asked.entry(pid).or_insert(0);
        let at = (*nth).min(readable.len() - 1);
        *nth += 1;
        Ok(readable[at].row(pid))
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
        Self { group_probes: vec![true], pid_probes: vec![true], asked: [AtomicUsize::new(0), AtomicUsize::new(0)], exits: false, log: log.clone() }
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

    fn kill_identified(&self, target: &Identity) -> bool {
        push(&self.log, json!({"op": "kill_identified", "id": target.pid}));
        false
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

#[tokio::test]
async fn shutdown_neither_signals_a_reused_group_nor_forgets_an_escaped_descendant() {
    let log = Log::default();
    let tables = json!([
        [
            {"pid": ROOT, "ppid": 1, "pgid": ROOT, "token": "leader"},
            {"pid": 5200, "ppid": ROOT, "pgid": 5200, "token": "descendant"}
        ],
        [
            {"pid": 5200, "ppid": 1, "pgid": 5200, "token": "descendant"},
            {"pid": 5300, "ppid": 1, "pgid": ROOT, "token": "unverified"}
        ],
        [
            {"pid": 5200, "ppid": 1, "pgid": 5200, "token": "descendant"}
        ]
    ]);
    let tree = Tree::new(
        ScriptedReader::new(&tables, &log),
        ScriptedSignals::new(&log).probes(&json!([true, false]), &json!([true])),
        ScriptedClock::new(&log),
        ROOT,
        Some("leader".to_owned()),
    );
    tree.shutdown_private_group();
    tree.root_reaped();
    tree.shutdown_descendants().await;
    assert!(!tree.shutdown_idle(), "an empty group does not retire a known live escapee");
    assert!(tree.shutdown_survivor_confirmed());
    let log = log.lock().unwrap();
    let sent: Vec<_> = log.iter().filter(|event| event["op"] == "kill" && event["signal"] != json!(0)).collect();
    assert_eq!(sent, vec![&json!({"op": "kill", "target": "group", "id": ROOT, "signal": "SIGKILL"})]);
    let identified: Vec<_> = log.iter().filter(|event| event["op"] == "kill_identified").collect();
    assert_eq!(identified, vec![&json!({"op": "kill_identified", "id": 5200})]);
}

#[test]
fn shutdown_signals_the_pinned_private_group_without_a_process_table() {
    let log = Log::default();
    let tree = Tree::new(ScriptedReader::new(&json!([{"error": "unreadable"}]), &log), ScriptedSignals::new(&log), ScriptedClock::new(&log), ROOT, None);
    tree.shutdown_private_group();
    assert_eq!(*log.lock().unwrap(), vec![json!({"op": "read"}), json!({"op": "kill", "target": "group", "id": ROOT, "signal": "SIGKILL"})]);
    assert!(!tree.shutdown_survivor_confirmed(), "unknown is not a confirmed survivor");
}

#[test]
fn a_zombie_only_group_does_not_pin_the_shutdown_record() {
    let log = Log::default();
    let tree = Tree::new(ScriptedReader::new(&json!([[]]), &log), ScriptedSignals::new(&log), ScriptedClock::new(&log), ROOT, None);
    tree.root_reaped();
    assert!(tree.shutdown_idle());
}

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
        // Node's whole trace: its table reads, signals and timers, each in its recorded place.
        let events = Value::Array(log.lock().unwrap().clone());
        assert_eq!(events, scenario["events"], "{}", scenario["name"]);
        assert_eq!(terminated, scenario["result"]["terminated"], "{}", scenario["name"]);
    }
}

#[tokio::test]
async fn the_passive_wait_looks_at_every_recheck_and_only_an_empty_look_ends_it() {
    for scenario in scenarios("wait") {
        let (tree, clock, log) = probed(&scenario, ScriptedSignals::new);
        let task = tokio::spawn({
            let tree = tree.clone();
            async move { tree.wait_gone(&CancellationToken::new()).await }
        });
        let recheck = scenario["result"]["recheckMs"].as_u64().unwrap();
        let mut sleeps = 0;
        let waited = run_gated(task, &clock, &log, |so_far| {
            assert_eq!(so_far.last().unwrap()["ms"], recheck);
            sleeps += 1;
        })
        .await;
        assert_eq!(waited, Waited::Gone, "{}", scenario["name"]);
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
    assert_eq!(tree.wait_gone(&CancellationToken::new()).await, Waited::Gone);
    assert!(log.lock().unwrap().iter().all(|event| event["op"] == "read"), "no sleep was needed");
}

/// `waitForShellDescendants` with a `signal` (`shell-descendants.mjs`): an abort already raised answers `false`
/// before the tree is looked at; one raised while the wait sleeps ends it at once with `false`, even though the
/// next look would have found the tree gone, and nothing is read or signalled after it.
#[tokio::test]
async fn an_abort_ends_the_wait_unconfirmed_and_looks_at_nothing_more() {
    let scenario = scenarios("wait").remove(0);
    let (tree, clock, log) = probed(&scenario, ScriptedSignals::new);
    let raised = CancellationToken::new();
    raised.cancel();
    assert_eq!(tree.wait_gone(&raised).await, Waited::Aborted);
    assert!(log.lock().unwrap().is_empty(), "an abort already raised reads and sleeps nothing");

    let abort = CancellationToken::new();
    let task = tokio::spawn({
        let (tree, abort) = (tree.clone(), abort.clone());
        async move { tree.wait_gone(&abort).await }
    });
    clock.entered.notified().await;
    let parked = log.lock().unwrap().clone();
    assert_eq!(parked.last().unwrap()["op"], "sleep", "the wait is parked in a recheck");
    abort.cancel();
    assert_eq!(task.await.unwrap(), Waited::Aborted);
    assert_eq!(*log.lock().unwrap(), parked, "nothing is read or signalled once aborted");
}

/// The group id is the root's pid, free for reuse once the root is reaped: then the table decides.
#[tokio::test]
async fn a_group_is_signalled_only_while_its_id_is_still_ours() {
    let signalled = |reaped: bool, tables: Value| {
        let log = Log::default();
        let tree = Tree::new(ScriptedReader::new(&tables, &log), ScriptedSignals::new(&log), ScriptedClock::new(&log), ROOT, Some("rt".to_owned()));
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
    /// Where every read is recorded, in order with the signals, when a test asserts the whole sequence.
    log: Option<Log>,
}

impl Split {
    fn new(tables: Vec<Listing>) -> Self {
        Self { tables: Mutex::new(tables.into()), rows: Mutex::new(HashMap::new()), log: None }
    }

    fn logged(mut self, log: &Log) -> Self {
        self.log = Some(log.clone());
        self
    }

    fn rows(self, pid: u32, rows: Vec<Row>) -> Self {
        self.rows.lock().unwrap().insert(pid, rows.into());
        self
    }
}

impl Reader for Split {
    fn table(&self) -> io::Result<Table> {
        if let Some(log) = &self.log {
            push(log, json!({"op": "read"}));
        }
        let mut tables = self.tables.lock().unwrap();
        let (procs, unreadable) = if tables.len() > 1 { tables.pop_front().unwrap() } else { tables[0].clone() };
        Ok(Table::with_unreadable(procs, unreadable))
    }

    fn row(&self, pid: u32) -> io::Result<Row> {
        if let Some(log) = &self.log {
            push(log, json!({"op": "row", "pid": pid}));
        }
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

/// The Rust safety contract of a cancel, which Node's `killShellDescendants` does not have: the complete sequence of
/// table reads, single-pid identity reads, signals and waits for a reaped root whose group and one survivor are
/// still ours. Beyond Node's trace it reads the root's row after the group grace (before the group SIGKILL) and the
/// survivor's row before the SIGTERM and again after the grace, before the SIGKILL (decisions.md D-SV2).
#[tokio::test]
async fn the_safety_reads_are_made_where_the_contract_says() {
    let survivor = proc(7000, 1, ROOT, "s1");
    let listing = || (vec![survivor.clone()], vec![]);
    let log = Log::default();
    let clock = ScriptedClock::new(&log);
    let reader = Split::new(vec![listing(), listing(), (vec![], vec![])]).rows(7000, vec![Row::Readable(survivor.clone())]).logged(&log);
    let tree = Arc::new(Tree::new(reader, ScriptedSignals::new(&log), clock.clone(), ROOT, None));
    tree.root_reaped();
    assert_eq!(tree.observe(), Observation::Running(vec![Identity { pid: 7000, token: "s1".to_owned() }]));
    log.lock().unwrap().clear();
    let task = tokio::spawn({
        let tree = tree.clone();
        async move { tree.cancel().await }
    });
    assert!(run_gated(task, &clock, &log, |_| {}).await);
    let group = |signal: Value| json!({"op": "kill", "target": "group", "id": ROOT, "signal": signal});
    let row = |pid: u32| json!({"op": "row", "pid": pid});
    let sleep = |ms: u64| json!({"op": "sleep", "ms": ms});
    let expected = [
        json!({"op": "read"}),
        group(json!("SIGTERM")),
        sleep(200),
        row(ROOT),
        group(json!(0)),
        group(json!("SIGKILL")),
        sleep(100),
        row(7000),
        kill_of(7000, json!("SIGTERM")),
        sleep(300),
        kill_of(7000, json!(0)),
        row(7000),
        kill_of(7000, json!("SIGKILL")),
        json!({"op": "read"}),
    ];
    assert_eq!(*log.lock().unwrap(), expected);
}

/// An unreaped root is owned by its lifecycle, not by its row: a child that has not been waited for holds its pid, so
/// even a row the kernel will not show grants the group. The same row after the reap grants nothing.
#[tokio::test]
async fn an_unreaped_root_is_owned_by_its_lifecycle_whatever_its_row_reads() {
    let member = proc(7001, ROOT, ROOT, "m");
    let observed = |reaped: bool| {
        let log = Log::default();
        let reader = Split::new(vec![(vec![member.clone()], vec![ROOT])]);
        let tree = Tree::new(reader, ScriptedSignals::new(&log), ScriptedClock::new(&log), ROOT, Some("rt".to_owned()));
        if reaped {
            tree.root_reaped();
        }
        let seen = tree.observe();
        tree.signal_group(Signal::Kill);
        let events = log.lock().unwrap().clone();
        (seen, events)
    };
    let kill = json!({"op": "kill", "target": "group", "id": ROOT, "signal": "SIGKILL"});
    let (seen, events) = observed(false);
    assert_eq!(seen, Observation::Running(vec![Identity { pid: 7001, token: "m".to_owned() }]), "its group member is adopted");
    assert_eq!(events, [kill], "the group is signalled without reading the root's row");
    let (seen, events) = observed(true);
    assert_eq!(seen, Observation::Unknown, "after the reap an unreadable root adopts nothing");
    assert_eq!(events, Vec::<Value>::new(), "and the group is not signalled");
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
    let reader = Split::new(vec![(vec![survivor.clone()], vec![]), (vec![survivor], vec![]), (vec![], vec![7000])]).rows(7000, vec![Row::Unreadable]);
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
