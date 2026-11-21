use super::*;

const FOREVER: Duration = Duration::from_secs(3_600);

/// Run a late check to its verdict, one check per `poll`: the verdict and
/// how many checks it took.
fn late(mut check: LateCheck, poll: Duration, mut active: impl FnMut() -> Option<u32>, mut kill: impl FnMut() -> bool) -> (Tree, u32) {
    let mut checks = 0;
    loop {
        checks += 1;
        if let Some(tree) = check.step(active(), &mut kill) {
            return (tree, checks);
        }
        thread::sleep(poll);
    }
}

#[test]
fn late_verification_gives_up_after_repeated_failed_queries() {
    let verdict = late(LateCheck::new(FOREVER, 3), Duration::ZERO, || None, || true);
    assert_eq!(verdict, (Tree::Unverified, 3));
}

#[test]
fn late_verification_gives_up_after_repeated_refused_kills() {
    let mut kills = 0;
    let (tree, _) = late(
        LateCheck::new(FOREVER, 3),
        Duration::ZERO,
        || Some(1),
        || {
            kills += 1;
            false
        },
    );
    assert_eq!(tree, Tree::Unverified);
    assert_eq!(kills, 3);
}

#[test]
fn late_verification_gives_up_at_its_deadline_on_a_job_that_never_empties() {
    let started = std::time::Instant::now();
    let (tree, _) = late(LateCheck::new(Duration::from_millis(50), u32::MAX), Duration::from_millis(1), || Some(1), || true);
    assert_eq!(tree, Tree::Unverified);
    assert!(started.elapsed() >= Duration::from_millis(50));
}

#[test]
fn late_verification_reports_a_job_that_empties() {
    let mut members = 3;
    let (tree, _) = late(
        LateCheck::new(FOREVER, 2),
        Duration::ZERO,
        || {
            members -= 1;
            Some(members)
        },
        || true,
    );
    assert_eq!(tree, Tree::Empty);
}

/// Hold points (main.rs `pause`). A test holds the thread that next
/// reaches a point for one command: it learns when that thread got there,
/// acts, then lets it go on — one interleaving of two actors, driven
/// deterministically.
#[cfg(windows)]
pub(crate) mod gates {
    use std::sync::Mutex;
    use std::sync::mpsc::{Receiver, Sender, channel};

    struct Gate {
        id: u64,
        point: &'static str,
        arrived: Sender<()>,
        release: Receiver<()>,
    }

    static GATES: Mutex<Vec<Gate>> = Mutex::new(Vec::new());

    pub(crate) struct Held {
        arrived: Receiver<()>,
        release: Sender<()>,
    }

    impl Held {
        /// Block until the held thread reached its point.
        pub(crate) fn reached(&self) {
            self.arrived.recv().expect("the thread reached its point");
        }

        /// Let it go on. Dropping a Held lets it go on too.
        pub(crate) fn release(self) {
            let _ = self.release.send(());
        }
    }

    pub(crate) fn hold(id: u64, point: &'static str) -> Held {
        let (arrived, arrived_rx) = channel();
        let (release_tx, release) = channel();
        GATES.lock().unwrap().push(Gate { id, point, arrived, release });
        Held { arrived: arrived_rx, release: release_tx }
    }

    pub(crate) fn pause(id: u64, point: &'static str) {
        let gate = {
            let mut gates = GATES.lock().unwrap_or_else(|e| e.into_inner());
            let at = gates.iter().position(|gate| gate.id == id && gate.point == point);
            at.map(|at| gates.remove(at))
        };
        if let Some(gate) = gate {
            let _ = gate.arrived.send(());
            let _ = gate.release.recv();
        }
    }
}

/// A contained command whose root already exited on its own, leaving
/// `member` running in its job: the moment settle_tree takes over.
#[cfg(windows)]
mod contained {
    use super::*;

    /// Killed (and reaped) when dropped: a process this test started.
    struct Member(winspawn::WinProcess);

    impl Drop for Member {
        fn drop(&mut self) {
            let _ = self.0.terminate(1);
            let _ = self.0.wait();
        }
    }

    fn exited_root_with_member(id: u64) -> (Arc<Manager>, Arc<ManagedProcess>, Member) {
        exited_root_with(id, "60")
    }

    /// `pings`: the member's lifetime in seconds, roughly.
    fn exited_root_with(id: u64, pings: &str) -> (Arc<Manager>, Arc<ManagedProcess>, Member) {
        let request: SpawnRequest = serde_json::from_value(json!({
            "id": id,
            "program": "ping",
            "contain": true,
            "ownerSessionId": "sess_kept",
        }))
        .unwrap();
        let control = ProcessControl::create(true).unwrap();
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        let program = format!("{root}\\System32\\PING.EXE");
        let member = winspawn::spawn(
            control.handle,
            &winspawn::Spawn {
                program: &program,
                command_line: &format!("{program} -n {pings} 127.0.0.1"),
                cwd: None,
                env: None,
                stdio: winspawn::Stdio::Handles { stdin: None, stdout: None, stderr: None },
            },
        )
        .unwrap();
        let managed = Arc::new(ManagedProcess {
            request_id: id,
            pid: member.id(),
            control,
            state: Mutex::new(initial_task_state(&request, Some(format!("job_{id}")), 0, true)),
            done: AtomicBool::new(false),
            retained: AtomicBool::new(false),
            stdin: Mutex::new(None),
        });
        let manager = Arc::new(Manager::new());
        // As run_spawn: reserved, then registered.
        assert!(manager.reserve(id));
        assert!(!manager.register(id, &managed));
        (manager, managed, Member(member))
    }

    fn tree(managed: &ManagedProcess) -> Tree {
        managed.lock_state().tree
    }

    /// Whether the tree becomes `want` within 10 s.
    fn becomes(managed: &ManagedProcess, want: Tree) -> bool {
        (0..1_000).any(|_| {
            let reached = tree(managed) == want;
            if !reached {
                thread::sleep(Duration::from_millis(10));
            }
            reached
        })
    }

    /// The command's completion reported, as finalize_process does.
    fn report(manager: &Manager, managed: &ManagedProcess) {
        let mut state = managed.lock_state();
        state.reported = true;
        deregister_held(manager, managed, &state);
    }

    /// Its root exited on its own and settlement kept its survivors in
    /// the job (as settle_tree decides), watched with a short deadline.
    fn preserved(manager: &Arc<Manager>, managed: &Arc<ManagedProcess>, deadline: Duration) -> thread::JoinHandle<()> {
        let mut state = managed.lock_state();
        assert!(managed.control.keep_survivors());
        managed.done.store(true, Ordering::Release);
        state.tree = Tree::Preserved;
        watch_kept(Arc::clone(managed), Arc::clone(manager), Duration::from_millis(5), deadline)
    }

    fn settle_on_thread(manager: &Arc<Manager>, managed: &Arc<ManagedProcess>) -> thread::JoinHandle<()> {
        let (manager, managed) = (Arc::clone(manager), Arc::clone(managed));
        thread::spawn(move || settle_tree(&managed, &manager, true))
    }

    /// Still running a while later.
    fn alive(member: &mut Member) -> bool {
        thread::sleep(Duration::from_millis(300));
        member.0.try_wait().unwrap().is_none()
    }

    /// The survivors were let go: no kill on close, breakaway allowed
    /// again, and the server refuses to kill them.
    fn let_go(managed: &ManagedProcess) -> bool {
        managed.control.limit_flags() == JOB_OBJECT_LIMIT_BREAKAWAY_OK && !managed.control.terminate()
    }

    // The job counts a process out as it exits; its handle is signalled a
    // moment later.
    fn exits(member: &mut Member) -> bool {
        (0..100).any(|_| {
            thread::sleep(Duration::from_millis(10));
            member.0.try_wait().unwrap().is_some()
        })
    }

    /// Whether the registry lets request `id` go within 10 s.
    fn deregistered(manager: &Manager, id: u64) -> bool {
        (0..1_000).any(|_| {
            let gone = manager.entry(id).is_none();
            if !gone {
                thread::sleep(Duration::from_millis(10));
            }
            gone
        })
    }

    #[test]
    fn a_cancel_that_lands_after_a_natural_exit_kills_and_verifies_the_job() {
        let (manager, managed, mut member) = exited_root_with_member(41);
        // The root exited on its own, so its tree is Open while it
        // settles: this cancel is not refused.
        cancel_request(&manager, 41);
        assert_eq!(tree(&managed), Tree::Killing);
        settle_tree(&managed, &manager, true);
        assert_eq!(tree(&managed), Tree::Empty);
        assert!(exits(&mut member), "the survivor died with the job");
    }

    #[test]
    fn a_cancel_after_the_command_was_reported_kills_its_kept_survivors_through_the_job() {
        let (manager, managed, mut member) = exited_root_with_member(42);
        settle_tree(&managed, &manager, true);
        assert_eq!(tree(&managed), Tree::Preserved);
        report(&manager, &managed);
        assert!(manager.entry(42).is_some(), "still registered: kept");
        cancel_request(&manager, 42);
        assert!(becomes(&managed, Tree::Empty), "verified empty: {:?}", tree(&managed));
        assert!(exits(&mut member), "the survivor died with the job");
        assert!(deregistered(&manager, 42), "the job handle is let go");
    }

    #[test]
    fn a_task_cancel_after_the_command_was_reported_reaches_its_kept_survivors() {
        let (manager, managed, mut member) = exited_root_with_member(44);
        settle_tree(&managed, &manager, true);
        report(&manager, &managed);
        cancel_task_request(&manager, 99, "job_44");
        assert!(becomes(&managed, Tree::Empty), "verified empty: {:?}", tree(&managed));
        assert!(exits(&mut member));
    }

    #[test]
    fn a_session_close_leaves_the_survivors_of_a_finished_command_running() {
        let (manager, managed, mut member) = exited_root_with_member(45);
        settle_tree(&managed, &manager, true);
        report(&manager, &managed);
        cancel_owner_request(&manager, 1, "sess_kept");
        assert!(alive(&mut member), "the survivor runs on");
        assert_eq!(tree(&managed), Tree::Preserved);
    }

    #[test]
    fn kept_survivors_that_exit_on_their_own_are_reported_empty() {
        // About a second: past the settle window, well inside the watch.
        let (manager, managed, mut member) = exited_root_with(46, "2");
        settle_tree(&managed, &manager, true);
        assert_eq!(tree(&managed), Tree::Preserved);
        report(&manager, &managed);
        assert!(becomes(&managed, Tree::Empty), "{:?}", tree(&managed));
        assert!(exits(&mut member));
        assert!(deregistered(&manager, 46));
    }

    #[test]
    fn kept_survivors_are_let_go_at_the_watch_deadline() {
        let (manager, managed, mut member) = exited_root_with_member(47);
        report(&manager, &managed);
        let watcher = preserved(&manager, &managed, Duration::from_millis(50));
        watcher.join().unwrap();
        assert_eq!(tree(&managed), Tree::Released);
        assert!(manager.entry(47).is_none());
        assert_eq!(Arc::strong_count(&managed), 1, "the job handle is let go");
        assert!(let_go(&managed));
        cancel_request(&manager, 47);
        assert!(alive(&mut member), "the survivor runs on");
    }

    #[test]
    fn a_late_verification_that_cannot_kill_gives_up_and_lets_the_job_go() {
        let (manager, managed, mut member) = exited_root_with_member(43);
        report(&manager, &managed);
        // From now on the job kill is refused, so the member never leaves.
        managed.preserve_descendants().unwrap();
        managed.lock_state().tree = Tree::Killing;
        watch_late(Arc::clone(&managed), Arc::clone(&manager), Duration::from_millis(5), FOREVER, 3).join().unwrap();
        assert_eq!(tree(&managed), Tree::Unverified);
        assert!(manager.entry(43).is_none());
        assert_eq!(Arc::strong_count(&managed), 1, "the watcher let the job go");
        assert!(member.0.try_wait().unwrap().is_none(), "never claimed gone");
    }

    // ---- Each pair of actors that can race, in both orders. Every
    // ---- interleaving is held at a `pause` point, so it is exact.

    // settle vs shutdown: the reap lands while the job still settles.
    #[test]
    fn shutdown_while_the_tree_settles_kills_it_and_settlement_verifies_the_kill() {
        let (manager, managed, mut member) = exited_root_with_member(50);
        let held = gates::hold(50, "settle:check");
        let settling = settle_on_thread(&manager, &managed);
        held.reached();
        reap_on_shutdown(&manager);
        assert_eq!(tree(&managed), Tree::Killing, "killed by the reap");
        held.release();
        settling.join().unwrap();
        assert_eq!(tree(&managed), Tree::Empty, "never preserved after it");
        assert!(exits(&mut member));
    }

    // settle vs shutdown: settlement kept the survivors, then the reap.
    #[test]
    fn shutdown_after_settlement_kept_the_survivors_lets_them_go_never_kills_them() {
        let (manager, managed, mut member) = exited_root_with_member(51);
        let held = gates::hold(51, "settle:decided");
        let settling = settle_on_thread(&manager, &managed);
        held.reached();
        assert_eq!(tree(&managed), Tree::Preserved);
        reap_on_shutdown(&manager);
        assert_eq!(tree(&managed), Tree::Released);
        assert!(alive(&mut member), "the survivor outlives the server");
        assert!(let_go(&managed));
        held.release();
        settling.join().unwrap();
        assert!(alive(&mut member));
    }

    // watcher release vs shutdown: the watcher let the survivors go at
    // its deadline, then the reap (it used to see RELEASED and kill).
    #[test]
    fn shutdown_after_the_watcher_released_the_survivors_never_kills_them() {
        let (manager, managed, mut member) = exited_root_with_member(52);
        let held = gates::hold(52, "watch_kept:decided");
        let watcher = preserved(&manager, &managed, Duration::from_millis(50));
        held.reached();
        assert_eq!(tree(&managed), Tree::Released);
        reap_on_shutdown(&manager);
        assert!(alive(&mut member), "the survivor outlives the server");
        assert!(let_go(&managed));
        held.release();
        watcher.join().unwrap();
        assert!(alive(&mut member));
    }

    // watcher release vs shutdown: the reap lands first; past its
    // deadline the watcher finds the survivors no longer kept.
    #[test]
    fn shutdown_before_the_watcher_decides_lets_the_survivors_go_and_the_watcher_stands_down() {
        let (manager, managed, mut member) = exited_root_with_member(53);
        let held = gates::hold(53, "watch_kept:check");
        let watcher = preserved(&manager, &managed, Duration::ZERO);
        held.reached();
        reap_on_shutdown(&manager);
        assert_eq!(tree(&managed), Tree::Released);
        held.release();
        watcher.join().unwrap();
        assert_eq!(tree(&managed), Tree::Released);
        assert!(alive(&mut member), "the survivor outlives the server");
        assert!(let_go(&managed));
    }

    // watcher release vs cancel: released first, then the cancel.
    #[test]
    fn a_cancel_after_the_watcher_released_the_survivors_is_refused() {
        let (manager, managed, mut member) = exited_root_with_member(54);
        let held = gates::hold(54, "watch_kept:decided");
        let watcher = preserved(&manager, &managed, Duration::from_millis(50));
        held.reached();
        cancel_request(&manager, 54);
        cancel_task_request(&manager, 1, "job_54");
        assert_eq!(tree(&managed), Tree::Released);
        assert!(alive(&mut member), "let go: no longer the server's to kill");
        held.release();
        watcher.join().unwrap();
    }

    // watcher release vs cancel: the cancel lands first; past its
    // deadline the watcher finds the survivors being killed and stands
    // down instead of letting them go.
    #[test]
    fn a_cancel_before_the_watcher_decides_kills_through_the_job_and_the_watcher_stands_down() {
        let (manager, managed, mut member) = exited_root_with_member(55);
        let held = gates::hold(55, "watch_kept:check");
        let watcher = preserved(&manager, &managed, Duration::ZERO);
        held.reached();
        cancel_request(&manager, 55);
        assert_eq!(tree(&managed), Tree::Killing);
        held.release();
        watcher.join().unwrap();
        assert!(becomes(&managed, Tree::Empty), "{:?}", tree(&managed));
        assert!(exits(&mut member));
    }

    // retained publication vs shutdown: a retained command's settlement
    // kept its survivors, then the reap (retained commands used to be
    // left out of its walk, their survivors stuck in the job).
    #[test]
    fn shutdown_after_a_retained_command_kept_its_survivors_lets_them_go() {
        let (manager, managed, mut member) = exited_root_with_member(56);
        managed.retained.store(true, Ordering::Release);
        let held = gates::hold(56, "settle:decided");
        let settling = settle_on_thread(&manager, &managed);
        held.reached();
        assert_eq!(tree(&managed), Tree::Preserved);
        reap_on_shutdown(&manager);
        assert_eq!(tree(&managed), Tree::Released);
        assert!(alive(&mut member), "the survivor outlives the server");
        assert!(let_go(&managed));
        held.release();
        settling.join().unwrap();
    }

    // retained publication vs shutdown: the reap lands while a retained
    // command's tree still settles: killed, never preserved after it.
    #[test]
    fn shutdown_while_a_retained_command_settles_kills_it() {
        let (manager, managed, mut member) = exited_root_with_member(57);
        managed.retained.store(true, Ordering::Release);
        let held = gates::hold(57, "settle:check");
        let settling = settle_on_thread(&manager, &managed);
        held.reached();
        reap_on_shutdown(&manager);
        assert_eq!(tree(&managed), Tree::Killing);
        held.release();
        settling.join().unwrap();
        assert_eq!(tree(&managed), Tree::Empty);
        assert!(exits(&mut member));
    }

    // cancel vs settle: the cancel lands at the settlement's decision.
    #[test]
    fn a_cancel_while_the_tree_settles_kills_it_and_settlement_verifies_the_kill() {
        let (manager, managed, mut member) = exited_root_with_member(58);
        let held = gates::hold(58, "settle:check");
        let settling = settle_on_thread(&manager, &managed);
        held.reached();
        cancel_request(&manager, 58);
        assert_eq!(tree(&managed), Tree::Killing);
        held.release();
        settling.join().unwrap();
        assert_eq!(tree(&managed), Tree::Empty);
        assert!(exits(&mut member));
    }

    // cancel vs settle: settlement kept the survivors, then the cancel.
    #[test]
    fn a_cancel_after_settlement_kept_the_survivors_kills_them_through_the_job() {
        let (manager, managed, mut member) = exited_root_with_member(59);
        let held = gates::hold(59, "settle:decided");
        let settling = settle_on_thread(&manager, &managed);
        held.reached();
        assert_eq!(tree(&managed), Tree::Preserved);
        cancel_request(&manager, 59);
        assert_eq!(tree(&managed), Tree::Killing);
        held.release();
        settling.join().unwrap();
        assert!(becomes(&managed, Tree::Empty), "{:?}", tree(&managed));
        assert!(exits(&mut member));
    }

    // A spawn reusing the id of a command still registered (here keeping
    // survivors after it was reported) is refused before anything is
    // spawned, and the command keeps its place.
    #[test]
    fn a_spawn_reusing_a_registered_request_id_is_refused_and_spawns_nothing() {
        let (manager, managed, mut member) = exited_root_with_member(61);
        settle_tree(&managed, &manager, true);
        report(&manager, &managed);
        assert_eq!(tree(&managed), Tree::Preserved);
        let marker = std::env::temp_dir().join(format!("mixdog-spawn-dup-{}", std::process::id()));
        let _ = std::fs::remove_file(&marker);
        let request: SpawnRequest = serde_json::from_value(json!({
            "id": 61,
            "program": "cmd.exe",
            "args": ["/d", "/c", format!("type nul > {}", marker.display())],
        }))
        .unwrap();
        run_spawn(request, Arc::clone(&manager));
        assert!(!marker.exists(), "nothing was spawned");
        let _ = std::fs::remove_file(&marker);
        let entry = manager.entry(61).expect("the command keeps its place");
        assert!(Arc::ptr_eq(&entry, &managed));
        drop(entry);
        // A targeted cancel still reaches exactly it.
        cancel_request(&manager, 61);
        assert!(becomes(&managed, Tree::Empty), "{:?}", tree(&managed));
        assert!(exits(&mut member));
        assert!(deregistered(&manager, 61));
        assert!(!manager.reserve(61), "never reused, even once let go");
    }

    /// A spawn of `cmd.exe /c type nul > marker` under request `id`.
    fn marker_spawn(id: u64, marker: &std::path::Path) -> SpawnRequest {
        serde_json::from_value(json!({
            "id": id,
            "program": "cmd.exe",
            "args": ["/d", "/c", format!("type nul > {}", marker.display())],
        }))
        .unwrap()
    }

    // An id whose command finished and was let go by the registry is
    // still refused: its last events may still be on their way.
    #[test]
    fn a_request_id_freed_by_deregistration_is_still_refused() {
        let manager = Arc::new(Manager::new());
        let dir = std::env::temp_dir();
        let first = dir.join(format!("mixdog-spawn-id62a-{}", std::process::id()));
        let second = dir.join(format!("mixdog-spawn-id62b-{}", std::process::id()));
        run_spawn(marker_spawn(62, &first), Arc::clone(&manager));
        assert!(first.exists(), "the first spawn ran");
        assert!(manager.entry(62).is_none(), "and was let go");
        run_spawn(marker_spawn(62, &second), Arc::clone(&manager));
        let reused = second.exists();
        let _ = std::fs::remove_file(&first);
        let _ = std::fs::remove_file(&second);
        assert!(!reused, "the reused id is refused: nothing spawned");
    }

    /// A stdout that is not being read: every write blocks until opened.
    #[derive(Clone)]
    struct UnreadStdout {
        open: Arc<(Mutex<bool>, std::sync::Condvar)>,
        lines: Arc<Mutex<String>>,
    }

    impl Write for UnreadStdout {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let (open, opened) = &*self.open;
            let mut is_open = open.lock().unwrap();
            while !*is_open {
                is_open = opened.wait(is_open).unwrap();
            }
            self.lines.lock().unwrap().push_str(&String::from_utf8_lossy(buf));
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn finishes(thread: &thread::JoinHandle<()>, within: Duration) -> bool {
        let started = std::time::Instant::now();
        while !thread.is_finished() {
            if started.elapsed() >= within {
                return false;
            }
            thread::sleep(Duration::from_millis(5));
        }
        true
    }

    // The client stops reading stdout. A watcher that lets survivors go
    // and the shutdown reap both decide at once, their events queued in
    // order, and no state lock is held on the writer's account.
    #[test]
    fn while_stdout_is_not_read_transitions_and_shutdown_decide_promptly() {
        let stdout = UnreadStdout { open: Arc::new((Mutex::new(false), std::sync::Condvar::new())), lines: Arc::new(Mutex::new(String::new())) };
        output::replace_writer(stdout.clone());
        emit(&json!({ "id": 64, "event": "probe" })); // the writer is stuck on this
        let (manager_a, a, mut member_a) = exited_root_with_member(64);
        let (manager_b, b, mut member_b) = exited_root_with_member(65);
        let watcher = preserved(&manager_a, &a, Duration::from_millis(50));
        assert!(finishes(&watcher, Duration::from_secs(2)), "the watcher decided");
        assert_eq!(tree(&a), Tree::Released);
        let kept = preserved(&manager_b, &b, FOREVER);
        let reaping = {
            let manager_b = Arc::clone(&manager_b);
            thread::spawn(move || reap_on_shutdown(&manager_b))
        };
        assert!(finishes(&reaping, Duration::from_secs(2)), "the reap decided");
        assert_eq!(tree(&b), Tree::Released);
        // b's watcher polls under b's state lock until it sees the tree is no longer
        // Preserved; joining it is the event after which no other holder is left, so
        // `try_lock` can only fail if a lock were held on the stuck writer's account.
        kept.join().unwrap();
        assert!(a.state.try_lock().is_ok() && b.state.try_lock().is_ok());
        assert!(alive(&mut member_a) && alive(&mut member_b));
        assert!(stdout.lines.lock().unwrap().is_empty(), "nothing written yet");
        // The client reads again: everything goes out, in order.
        let (open, opened) = &*stdout.open;
        *open.lock().unwrap() = true;
        opened.notify_all();
        assert!(drain_output(Duration::from_secs(5)));
        output::replace_writer(std::io::stdout());
        let written = stdout.lines.lock().unwrap().clone();
        // By content, not by key order: a build that unifies serde_json's `preserve_order`
        // (the monorepo's) writes the same events with their keys in another order.
        let at = |event: &str, id: u64| {
            written
                .lines()
                .position(|line| serde_json::from_str::<serde_json::Value>(line).is_ok_and(|v| v["event"] == event && v["id"] == id))
                .unwrap_or(usize::MAX)
        };
        let probe = at("probe", 64);
        let released_a = at("tree_released", 64);
        let released_b = at("tree_released", 65);
        assert!(probe < released_a && released_a < released_b && released_b < usize::MAX, "{written}");
    }

    // Restoring breakaway fails: the tree is still RELEASED (final, never
    // gone), and the failure is recorded for its event and snapshots.
    #[test]
    fn a_release_whose_breakaway_cannot_be_restored_stays_released_and_says_so() {
        let (manager, managed, mut member) = exited_root_with_member(63);
        managed.control.refuse_release.store(true, Ordering::Release);
        preserved(&manager, &managed, Duration::from_millis(50)).join().unwrap();
        assert_eq!(tree(&managed), Tree::Released);
        assert!(managed.lock_state().breakaway_unrestored);
        let snapshot = managed.snapshot().unwrap();
        assert_eq!(snapshot.tree_outcome.as_deref(), Some("released"));
        assert_eq!(snapshot.breakaway_restored, Some(false));
        assert_ne!(managed.control.limit_flags(), JOB_OBJECT_LIMIT_BREAKAWAY_OK, "breakaway is not restored");
        cancel_request(&manager, 63);
        reap_on_shutdown(&manager);
        assert_eq!(tree(&managed), Tree::Released, "final either way");
        assert!(alive(&mut member), "never killed once let go");
    }

    // A command registered after the reap's walk gets its decision.
    #[test]
    fn a_command_registered_after_the_shutdown_walk_is_decided_on_registration() {
        let (manager, managed, mut member) = exited_root_with_member(60);
        manager.lock_live().remove(&60);
        assert!(manager.close().is_empty());
        assert!(manager.register(60, &managed), "registered after the walk");
        shutdown_held(&managed, &manager, &mut managed.lock_state());
        assert_eq!(tree(&managed), Tree::Killing);
        assert!(exits(&mut member));
    }
}
