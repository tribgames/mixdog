use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant;

use mixdog_core_api::domain::process::OutputStream;

use super::*;
use crate::manager::OutputFilter;
use crate::manager::ProcessConfig;

struct Quiet;

impl TerminalEvents for Quiet {
    fn activity(&self, _: &str, _: Option<ActivityState>) {}
    fn size_owner(&self, _: &SizeOwnerChange) {}
    fn size_claims_forgotten(&self, _: &str) {}
}

/// F30: with `cursor_floors` held by the test, a dispose and a respawn of one tab id both
/// reach it. The dispose must have left the tab lock by then (a dispose that holds the tab
/// lock while it waits for the floors is the inversion), and once the floors are released
/// both finish.
#[test]
fn a_respawn_and_a_dispose_of_one_tab_id_do_not_deadlock() {
    let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
    let tabs = Arc::new(TerminalTabs::new(manager.clone(), TerminalConfig::new(Arc::new(Quiet))));
    let tab = Arc::new(Tab {
        id: "term_1".to_owned(),
        seq: 1,
        handle: ProcessHandle::from("term_1"),
        shell: "sh".to_owned(),
        cwd: None,
        state: Mutex::new(TabState {
            buffer: ReplayBuffer::new(REPLAY_BUFFER_LIMIT, 0),
            scanner: None,
            decoder: Utf8Decoder::default(),
            activity: ActivityTracker::new(false),
            exited: false,
            paused_by: BTreeSet::new(),
            size: (80, 24),
            emitted: 0,
            order: None,
            held_gen: 0,
            held_timer: None,
            flushing: false,
        }),
        pty_gate: Mutex::new(()),
        flushed: Condvar::new(),
        events: Arc::new(Quiet),
        manager,
    });

    let floors = tabs.cursor_floors.lock().unwrap();
    let (done, finished) = mpsc::channel();
    let dispose = {
        let (tabs, tab, done) = (Arc::clone(&tabs), Arc::clone(&tab), done.clone());
        std::thread::spawn(move || {
            tabs.dispose_tab(&tab);
            done.send("dispose").unwrap();
        })
    };
    let respawn = {
        let (tabs, tab) = (Arc::clone(&tabs), Arc::clone(&tab));
        std::thread::spawn(move || {
            tabs.start_cursor("term_1", Some(&*tab));
            done.send("respawn").unwrap();
        })
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if tab.state.try_lock().is_ok_and(|state| state.exited) {
            break;
        }
        assert!(Instant::now() < deadline, "the dispose holds the tab lock while it waits for the floors");
        std::thread::yield_now();
    }
    drop(floors);
    for _ in 0..2 {
        finished.recv_timeout(Duration::from_secs(10)).expect("respawn and dispose finish");
    }
    dispose.join().unwrap();
    respawn.join().unwrap();
    assert!(tabs.cursor_floors.lock().unwrap().contains_key("term_1"));
}

/// A tab of the table with no process behind it: `paused_by` is what the pause is made of.
fn pausable_tab() -> (Arc<TerminalTabs>, Arc<Tab>) {
    let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
    let tabs = Arc::new(TerminalTabs::new(manager.clone(), TerminalConfig::new(Arc::new(Quiet))));
    let tab = relay_tab(Arc::new(Quiet), manager, "term_1");
    tabs.table().insert("term_1".to_owned(), Slot::Live(Arc::clone(&tab)));
    (tabs, tab)
}

fn holders(tab: &Tab) -> Vec<String> {
    tab.lock().paused_by.iter().cloned().collect()
}

/// One connection's resume does not release another connection's pause.
#[test]
fn a_resume_from_another_connection_leaves_the_pause_held() {
    let (tabs, tab) = pausable_tab();
    tabs.pause_output("term_1", "a");
    tabs.resume_output("term_1", "b");
    assert_eq!(holders(&tab), vec!["a".to_owned()], "b's resume released a's pause");
    tabs.pause_output("term_1", "b");
    tabs.resume_output("term_1", "a");
    assert_eq!(holders(&tab), vec!["b".to_owned()], "the pause stays while b holds it");
    tabs.resume_output("term_1", "b");
    assert!(holders(&tab).is_empty(), "the last holder's resume released it");
}

/// A connection that closes paused releases its pause; another's stays.
#[test]
fn a_closed_connection_releases_its_pause() {
    let (tabs, tab) = pausable_tab();
    tabs.pause_output("term_1", "a");
    tabs.pause_output("term_1", "b");
    tabs.connection_closed("a");
    assert_eq!(holders(&tab), vec!["b".to_owned()]);
    tabs.connection_closed("b");
    assert!(holders(&tab).is_empty(), "no pause is left held by a closed connection");
}

/// A disposed tab holds nothing.
#[test]
fn a_disposed_tab_holds_no_pause() {
    let (tabs, tab) = pausable_tab();
    tabs.pause_output("term_1", "a");
    tabs.dispose_tab(&tab);
    assert!(holders(&tab).is_empty());
}

struct Recorded(Mutex<Vec<Option<ActivityState>>>);

impl TerminalEvents for Recorded {
    fn activity(&self, _: &str, state: Option<ActivityState>) {
        self.0.lock().unwrap().push(state);
    }
    fn size_owner(&self, _: &SizeOwnerChange) {}
    fn size_claims_forgotten(&self, _: &str) {}
}

/// A tab of a shell with integration whose relay feed pumps (`relay_order`), publishing to `events`.
fn relay_tab(events: Arc<dyn TerminalEvents>, manager: LocalProcessManager, handle: &str) -> Arc<Tab> {
    Arc::new(Tab {
        id: handle.to_owned(),
        seq: 1,
        handle: ProcessHandle::from(handle),
        shell: "pwsh".to_owned(),
        cwd: None,
        state: Mutex::new(TabState {
            buffer: ReplayBuffer::new(REPLAY_BUFFER_LIMIT, 0),
            scanner: Some(MarkerScanner::default()),
            decoder: Utf8Decoder::default(),
            activity: ActivityTracker::new(false),
            exited: false,
            paused_by: BTreeSet::new(),
            size: (80, 24),
            emitted: 0,
            order: Some(RelayOrder::default()),
            held_gen: 0,
            held_timer: None,
            flushing: false,
        }),
        pty_gate: Mutex::new(()),
        flushed: Condvar::new(),
        events,
        manager,
    })
}

/// With the relay feed pumping (`relay_order`), a change a chunk's marker causes goes once the pump has taken that chunk's text, not
/// before (Node emitted the text into its relay buffer and then applied the marker); a change published directly goes after it.
#[test]
fn a_marker_change_waits_for_the_pump_to_take_its_chunk() {
    let events = Arc::new(Recorded(Mutex::new(Vec::new())));
    let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
    let tab = relay_tab(Arc::clone(&events) as Arc<dyn TerminalEvents>, manager, "term_1");
    let seen = || events.0.lock().unwrap().clone();
    let mut filter = TabFilter::new(Arc::clone(&tab));
    let text = filter.filter(b"PS> \x1b]697;P\x07");
    assert_eq!(text, b"PS> ");
    filter.admitted();
    assert_eq!(seen(), Vec::new(), "the prompt's change waits for its text to be taken");
    tab.taken(3);
    assert_eq!(seen(), Vec::new(), "part of the text is not enough");
    tab.taken(4);
    assert_eq!(seen(), vec![Some(ActivityState::Idle)]);
    let _ = filter.filter(b"x\r\n\x1b]697;C\x07");
    filter.admitted();
    tab.publish(&mut tab.lock(), Some(Some(ActivityState::Finished)));
    assert_eq!(
        seen(),
        vec![Some(ActivityState::Idle), Some(ActivityState::Running), Some(ActivityState::Finished)],
        "a direct change goes after the waiting ones"
    );
    tab.taken(u64::MAX);
    assert_eq!(seen().len(), 3, "nothing goes twice");
}

/// Records how many frames the relay lane had published when each activity change went.
struct LaneSeen {
    feeds: std::sync::OnceLock<Arc<crate::service::ProcessFeeds>>,
    changes: Mutex<Vec<u64>>,
}

impl TerminalEvents for LaneSeen {
    fn activity(&self, _: &str, _: Option<ActivityState>) {
        let published = self.feeds.get().expect("the feeds exist before output").lane_seq();
        self.changes.lock().unwrap().push(published);
    }
    fn size_owner(&self, _: &SizeOwnerChange) {}
    fn size_claims_forgotten(&self, _: &str) {}
}

/// Runs the runtime until `done`; the child's output arrives on threads of its own and the clock stays where the test put it.
async fn settle(what: &str, done: impl Fn() -> bool) {
    let started = std::time::Instant::now();
    while !done() {
        assert!(started.elapsed() < Duration::from_secs(60), "never seen: {what}");
        std::thread::sleep(Duration::from_millis(2));
        tokio::task::yield_now().await;
    }
}

/// The real pump (`ProcessFeeds::pump`) with a phone reading the relay lane: a chunk whose marker changes the tab's activity, arriving
/// `gap` after the last frame the lane sent. At 15 ms the relay buffer holds the text back, so the change reaches the clients before it;
/// at 16 ms the text goes at once and the change follows it. The clock is paused, so the gap is exact.
#[tokio::test(start_paused = true)]
async fn a_marker_change_goes_before_held_output_and_after_output_sent_at_once() {
    use mixdog_core_api::ConnectionSink;
    use mixdog_core_api::ids::ConnectionId;
    use mixdog_core_api::mock::MockConnection;
    use mixdog_core_api::mock::MockLimits;
    for (gap_ms, held) in [(15, true), (16, false)] {
        let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
        let handle = ProcessHandle::from(format!("term_order_{gap_ms}_{}", std::process::id()));
        let seen = Arc::new(LaneSeen { feeds: std::sync::OnceLock::new(), changes: Mutex::new(Vec::new()) });
        let tab = relay_tab(Arc::clone(&seen) as Arc<dyn TerminalEvents>, manager.clone(), handle.as_str());
        manager
            .spawn_with(
                piped(
                    &handle,
                    "$null = [Console]::In.ReadLine(); [Console]::Out.Write('first'); $null = [Console]::In.ReadLine(); \
                         [Console]::Out.Write('PS> ' + [char]27 + ']697;P' + [char]7); $null = [Console]::In.ReadLine()",
                    "read a; printf first; read b; printf 'PS> \\033]697;P\\007'; read c",
                ),
                SpawnOptions { replays_after_exit: true, filter: Some(Box::new(TabFilter::new(Arc::clone(&tab)))), ..SpawnOptions::default() },
            )
            .await
            .unwrap();
        // The child waits for input: a failed assertion must not leave it running.
        let _reap = {
            let (manager, handle) = (manager.clone(), handle.clone());
            KillOnDrop(Some(move || drop(manager.kill(&handle))))
        };
        let feeds = crate::service::ProcessFeeds::new(manager.clone(), Arc::new(mixdog_core_api::mock::MockScopedFeeds::new(MockLimits::default())));
        seen.feeds.set(Arc::clone(&feeds)).ok().unwrap();
        let conn = MockConnection::new(ConnectionId(1), MockLimits::default());
        let attached = mixdog_core_api::feed::subscribe(
            &feeds.lane_source(),
            mixdog_core_api::ids::SubscriptionId::from("s"),
            mixdog_core_api::feed::Window::Fixed,
            None,
            &conn,
        )
        .unwrap();
        conn.send_control_release(bytes::Bytes::from_static(b"ok"), attached.release).unwrap();
        let pumped = Arc::clone(&tab);
        drop(feeds.open_terminal(handle.as_str(), move || Some(Arc::new(move |at: PumpPoint| pumped.pumped(at)) as PumpTell)));

        manager.write_input(&handle, b"1\n".to_vec()).unwrap();
        settle("the first frame", || feeds.lane_seq() >= 1).await;
        let first = feeds.lane_seq();
        tokio::time::advance(Duration::from_millis(gap_ms)).await;
        manager.write_input(&handle, b"2\n".to_vec()).unwrap();
        settle("the marker's change", || !seen.changes.lock().unwrap().is_empty()).await;
        let at_change = seen.changes.lock().unwrap()[0];
        assert_eq!(
            at_change,
            if held { first } else { first + 1 },
            "{gap_ms} ms after the last frame: the lane had sent {at_change} frames when the change went (first frame: {first})"
        );
        // The held text goes out when its 16 ms are up.
        tokio::time::advance(Duration::from_millis(1)).await;
        settle("the chunk's text", || feeds.lane_seq() == first + 1).await;
    }
}

/// Runs its closure when the test leaves the scope, by return or by panic.
struct KillOnDrop<F: FnOnce()>(Option<F>);

impl<F: FnOnce()> Drop for KillOnDrop<F> {
    fn drop(&mut self) {
        if let Some(kill) = self.0.take() {
            kill();
        }
    }
}

/// Events whose publication is asked for: each `published` is counted (the pump waits on what it returns).
struct Publishing(Mutex<(Vec<Option<ActivityState>>, usize)>);

impl TerminalEvents for Publishing {
    fn activity(&self, _: &str, state: Option<ActivityState>) {
        self.0.lock().unwrap().0.push(state);
    }
    fn size_owner(&self, _: &SizeOwnerChange) {}
    fn size_claims_forgotten(&self, _: &str) {}
    fn published(&self) -> Option<Published> {
        self.0.lock().unwrap().1 += 1;
        let (done, published) = tokio::sync::oneshot::channel();
        let _ = done.send(());
        Some(published)
    }
}

/// A change the pump releases by taking its chunk is one the pump waits to see published before it goes on (and so before the relay
/// buffer sends that chunk's text, as Node's flush came after its synchronous broadcast); a take that releases nothing gives no wait.
#[test]
fn the_pump_waits_for_the_change_its_take_released() {
    let events = Arc::new(Publishing(Mutex::new((Vec::new(), 0))));
    let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
    let tab = relay_tab(Arc::clone(&events) as Arc<dyn TerminalEvents>, manager, "term_wait");
    let mut filter = TabFilter::new(Arc::clone(&tab));
    let prompt = filter.filter(b"PS> \x1b]697;P\x07").len() as u64;
    filter.admitted();
    assert!(tab.pumped(PumpPoint::Taken(prompt - 1)).is_none(), "nothing went, nothing to wait for");
    assert!(tab.pumped(PumpPoint::Taken(prompt)).is_some(), "the prompt's change went: the pump waits for its publication");
    assert_eq!(*events.0.lock().unwrap(), (vec![Some(ActivityState::Idle)], 1));
    let more = filter.filter(b"x").len() as u64;
    filter.admitted();
    assert!(tab.pumped(PumpPoint::Taken(prompt + more)).is_none(), "output without a change gives no wait");
}

/// A chunk holding only a marker changes the tab at once (no output of it to follow); the output read after it waits, before it enters
/// the relay buffer, until that change is published: Node broadcast the change synchronously, so its later output never went first.
#[test]
fn output_after_a_change_that_went_at_once_waits_for_its_publication() {
    let events = Arc::new(Publishing(Mutex::new((Vec::new(), 0))));
    let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
    let tab = relay_tab(Arc::clone(&events) as Arc<dyn TerminalEvents>, manager, "term_direct");
    let mut filter = TabFilter::new(Arc::clone(&tab));
    assert_eq!(filter.filter(b"\x1b]697;C\x07").len(), 0, "the start marker's chunk carries no output");
    filter.admitted();
    assert_eq!(*events.0.lock().unwrap(), (vec![Some(ActivityState::Running)], 0), "the change went at once");
    let text = filter.filter(b"lane-cmd-1\r\n").len() as u64;
    filter.admitted();
    assert!(tab.pumped(PumpPoint::Reaching(0)).is_some(), "the output after it waits for its publication");
    assert_eq!(events.0.lock().unwrap().1, 1);
    assert!(tab.pumped(PumpPoint::Taken(text)).is_none(), "taking the output releases nothing more");
    assert!(tab.pumped(PumpPoint::Reaching(text)).is_none(), "a change waits for its publication once");
}

/// The shell's end follows the output before it, as Node's exit handler ordered it (terminal-manager.ts:378-384: held text out,
/// `activity.exit()` broadcast, then the exit line emitted): the tab's end waits until the pump has taken the output admitted before
/// the exit, and the exit line comes after it.
#[test]
fn the_tabs_end_follows_the_output_before_the_exit() {
    let events = Arc::new(Recorded(Mutex::new(Vec::new())));
    let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
    let tab = relay_tab(Arc::clone(&events) as Arc<dyn TerminalEvents>, manager, "term_end");
    let seen = || events.0.lock().unwrap().clone();
    let mut filter = TabFilter::new(Arc::clone(&tab));
    let prompt = filter.filter(b"PS> \x1b]697;P\x07").len() as u64;
    filter.admitted();
    tab.taken(prompt);
    assert_eq!(seen(), vec![Some(ActivityState::Idle)]);
    let last = filter.filter(b"bye\r\n").len() as u64;
    filter.admitted();
    let line = tab.exited(&ProcessExit { status: ExitStatus::Code(0), killed: None });
    assert_eq!(seen(), vec![Some(ActivityState::Idle)], "the tab's end waits for the output written before the exit");
    tab.taken(prompt + last);
    assert_eq!(seen(), vec![Some(ActivityState::Idle)], "the tab's end waits for the pump to reach the exit line, not only for the output before it");
    tab.pumped(PumpPoint::Reaching(prompt + last));
    assert_eq!(seen(), vec![Some(ActivityState::Idle), None], "the tab's end goes when the pump reaches the exit line, before the line");
    assert_eq!(tab.lock().emitted, prompt + last + line.len() as u64, "the exit line is the last output");
}

/// What the reader took from the pseudo-terminal and the pump, one log in order.
#[derive(Debug, Clone, PartialEq)]
enum Seen {
    Change(Option<ActivityState>),
    /// The pump told the tab it has taken the output up to this offset.
    Taken(u64),
}

struct Logged {
    log: Mutex<Vec<Seen>>,
    changed: std::sync::Condvar,
}

impl Logged {
    fn new() -> Arc<Self> {
        Arc::new(Self { log: Mutex::new(Vec::new()), changed: std::sync::Condvar::new() })
    }

    fn push(&self, seen: Seen) {
        self.log.lock().unwrap().push(seen);
        self.changed.notify_all();
    }

    /// The log once `done` holds of it; the deadline only names what never came.
    fn until(&self, what: &str, done: impl Fn(&[Seen]) -> bool) -> Vec<Seen> {
        let log = self.log.lock().unwrap();
        let (log, waited) = self.changed.wait_timeout_while(log, Duration::from_secs(60), |log| !done(log)).unwrap();
        assert!(!waited.timed_out(), "never seen: {what}; seen {:?}", *log);
        log.clone()
    }
}

impl TerminalEvents for Logged {
    fn activity(&self, _: &str, state: Option<ActivityState>) {
        self.push(Seen::Change(state));
    }
    fn size_owner(&self, _: &SizeOwnerChange) {}
    fn size_claims_forgotten(&self, _: &str) {}
}

fn piped(handle: &ProcessHandle, script: &str, posix: &str) -> SpawnRequest {
    let command = if cfg!(windows) {
        CommandSpec::Argv { program: "powershell".to_owned(), args: vec!["-NoProfile".to_owned(), "-Command".to_owned(), script.to_owned()] }
    } else {
        CommandSpec::Argv { program: "sh".to_owned(), args: vec!["-c".to_owned(), posix.to_owned()] }
    };
    SpawnRequest {
        handle: handle.clone(),
        command,
        cwd: AbsPath::new(std::env::temp_dir()).unwrap(),
        env: EnvSpec { inherit: true, ..EnvSpec::default() },
        pty: None,
        stdin_piped: true,
        output: OutputMode::Merged,
        owner: ProcessOwner::Internal,
        time_limit: None,
    }
}

fn pump(manager: &LocalProcessManager, tab: &Arc<Tab>, logged: &Arc<Logged>) -> Arc<crate::service::ProcessFeeds> {
    let feeds =
        crate::service::ProcessFeeds::new(manager.clone(), Arc::new(mixdog_core_api::mock::MockScopedFeeds::new(mixdog_core_api::mock::MockLimits::default())));
    let (tab, logged) = (Arc::clone(tab), Arc::clone(logged));
    let held = feeds.open_terminal(&tab.id.clone(), move || {
        Some(Arc::new(move |at: PumpPoint| {
            if let PumpPoint::Taken(taken) = at {
                logged.push(Seen::Taken(taken));
            }
            tab.pumped(at)
        }) as PumpTell)
    });
    drop(held);
    feeds
}

/// C3 (a): the pump subscribed on an empty ring (`evicted` false) or after the ring dropped the start (true); then a paused producer
/// holds a chunk at the gate, a claim's hold goes in, and the producer resumes while the hold stands. The chunk enters the feed but
/// the pump stops for the hold: its change does not go. Once the hold ends the pump takes the chunk at its absolute offset (the
/// feed's own count, the tab's `emitted`), and the change goes then.
async fn a_claim_holds_a_resumed_producers_chunk(evicted: bool) {
    let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
    let handle = ProcessHandle::from(format!("term_resumed_{evicted}_{}", std::process::id()));
    let logged = Logged::new();
    let tab = relay_tab(Arc::clone(&logged) as Arc<dyn TerminalEvents>, manager.clone(), handle.as_str());
    manager
        .spawn_with(
            piped(
                &handle,
                "$null = [Console]::In.ReadLine(); [Console]::Out.Write(('x' * 70000) + [char]27 + ']697;P' + [char]7); \
                     $null = [Console]::In.ReadLine(); [Console]::Out.Write('z' + [char]27 + ']697;C' + [char]7); $null = [Console]::In.ReadLine()",
                "read a; printf '%070000d\\033]697;P\\007' 0; read b; printf 'z\\033]697;C\\007'; read c",
            ),
            SpawnOptions {
                ring_bytes: Some(1024),
                replays_after_exit: true,
                filter: Some(Box::new(TabFilter::new(Arc::clone(&tab)))),
                ..SpawnOptions::default()
            },
        )
        .await
        .unwrap();
    let feeds = if evicted {
        let mut watch = manager.subscribe(&handle, None).unwrap();
        manager.write_input(&handle, b"1\n".to_vec()).unwrap();
        let mut read = 0;
        while read < 70000 {
            match tokio::time::timeout(Duration::from_secs(60), watch.next()).await.expect("the first write arrives within 60 s") {
                Some(ProcessEvent::Output { bytes, .. }) => read += bytes.len(),
                other => panic!("the first write, not {other:?}"),
            }
        }
        drop(watch);
        assert!(matches!(manager.subscribe(&handle, Some(0)), Err(ProcessError::ReplayUnavailable { .. })), "the ring dropped the start");
        let feeds = pump(&manager, &tab, &logged);
        logged.until("the first write's change", |log| log.contains(&Seen::Change(Some(ActivityState::Idle))));
        feeds
    } else {
        assert_eq!(manager.output_pushed(&handle).unwrap(), 0, "the ring is empty when the pump subscribes");
        let feeds = pump(&manager, &tab, &logged);
        // The first write goes unread here: its marker's change is not what this checks.
        manager.write_input(&handle, b"1\n".to_vec()).unwrap();
        logged.until("the first write's change", |log| log.contains(&Seen::Change(Some(ActivityState::Idle))));
        feeds
    };
    let before = manager.output_pushed(&handle).unwrap();
    manager.set_output_paused(&handle, true).unwrap();
    manager.write_input(&handle, b"2\n".to_vec()).unwrap();
    tokio::time::timeout(Duration::from_secs(60), manager.output_blocked(&handle)).await.expect("the producer parked the chunk at the gate").unwrap();
    let held = feeds.hold_new_output(handle.as_str()).expect("the feed exists");
    let mut stops = feeds.stops_of(handle.as_str());
    let stopped = *stops.borrow_and_update();
    manager.set_output_paused(&handle, false).unwrap();
    tokio::time::timeout(Duration::from_secs(60), stops.wait_for(|stops| *stops > stopped)).await.expect("the pump stopped for the hold").unwrap();
    let total = manager.output_pushed(&handle).unwrap();
    assert!(total > before, "the resumed chunk entered the feed");
    let log = logged.log.lock().unwrap().clone();
    assert!(!log.contains(&Seen::Change(Some(ActivityState::Running))), "the held chunk's change went: {log:?}");
    assert!(log.iter().all(|seen| !matches!(seen, Seen::Taken(taken) if *taken > before)), "the pump took held output: {log:?}");
    drop(held);
    let log = logged.until("the resumed chunk's change", |log| log.contains(&Seen::Change(Some(ActivityState::Running))));
    let at = log.iter().position(|seen| *seen == Seen::Change(Some(ActivityState::Running))).unwrap();
    assert_eq!(log[..at].last(), Some(&Seen::Taken(total)), "the change goes when the pump takes the chunk, at the feed's offset: {log:?}");
    let _ = manager.kill(&handle);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_claim_holds_a_resumed_producers_chunk_after_an_empty_ring() {
    a_claim_holds_a_resumed_producers_chunk(false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_claim_holds_a_resumed_producers_chunk_after_an_eviction() {
    a_claim_holds_a_resumed_producers_chunk(true).await;
}

/// The pump starts after the ring dropped the start of the output (more than one event's worth went by before anyone read): it
/// counts from its first event's offset, the feed's own offset the tab counted too, so the last marker's change goes when the pump
/// takes the chunk it came in, not only when the pump ends.
#[tokio::test(flavor = "multi_thread")]
async fn the_pump_counts_from_its_first_event_after_an_evicted_prefix() {
    let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
    let handle = ProcessHandle::from(format!("term_evicted_{}", std::process::id()));
    let logged = Logged::new();
    let tab = relay_tab(Arc::clone(&logged) as Arc<dyn TerminalEvents>, manager.clone(), handle.as_str());
    let (exited, exit) = std::sync::mpsc::channel();
    manager
        .spawn_with(
            piped(&handle, "[Console]::Out.Write(('x' * 70000) + [char]27 + ']697;P' + [char]7)", "printf '%070000d\\033]697;P\\007' 0"),
            SpawnOptions {
                ring_bytes: Some(1024),
                replays_after_exit: true,
                filter: Some(Box::new(TabFilter::new(Arc::clone(&tab)))),
                on_exit: Some(Box::new(move |_| {
                    let _ = exited.send(());
                    Vec::new()
                })),
                ..SpawnOptions::default()
            },
        )
        .await
        .unwrap();
    exit.recv_timeout(Duration::from_secs(60)).expect("the process printed and ended");
    assert!(matches!(manager.subscribe(&handle, Some(0)), Err(ProcessError::ReplayUnavailable { .. })), "the ring dropped the start");
    let total = manager.output_pushed(&handle).unwrap();
    pump(&manager, &tab, &logged);
    let log = logged.until("the pump's end", |log| log.contains(&Seen::Taken(u64::MAX)));
    let change = log.iter().position(|seen| *seen == Seen::Change(Some(ActivityState::Idle))).expect("the prompt's change went");
    assert_eq!(log[..change].last(), Some(&Seen::Taken(total)), "the change goes when the pump has taken the whole output: {log:?}");
}

/// The ring drops the oldest event the pump would start at between finding it and subscribing there (the producer, unsubscribed,
/// evicts it: the feed's refusal seam pushes output at exactly that point). The pump finds and subscribes in one step, so it keeps
/// pumping: a later chunk's change goes when the pump takes that chunk, not at a pump's end.
#[tokio::test(flavor = "multi_thread")]
async fn an_eviction_while_the_pump_subscribes_does_not_end_it() {
    let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
    let handle = ProcessHandle::from(format!("term_evicting_{}", std::process::id()));
    let logged = Logged::new();
    let tab = relay_tab(Arc::clone(&logged) as Arc<dyn TerminalEvents>, manager.clone(), handle.as_str());
    manager
        .spawn_with(
            piped(
                &handle,
                "$null = [Console]::In.ReadLine(); [Console]::Out.Write(('x' * 70000) + [char]27 + ']697;P' + [char]7); \
                     $null = [Console]::In.ReadLine(); [Console]::Out.Write('z' + [char]27 + ']697;C' + [char]7); $null = [Console]::In.ReadLine()",
                "read a; printf '%070000d\\033]697;P\\007' 0; read b; printf 'z\\033]697;C\\007'; read c",
            ),
            SpawnOptions {
                ring_bytes: Some(1024),
                replays_after_exit: true,
                filter: Some(Box::new(TabFilter::new(Arc::clone(&tab)))),
                ..SpawnOptions::default()
            },
        )
        .await
        .unwrap();
    // The first write, all in the feed (read as it comes, so the reader never waits on this reader).
    let mut watch = manager.subscribe(&handle, None).unwrap();
    manager.write_input(&handle, b"1\n".to_vec()).unwrap();
    let mut read = 0;
    while read < 70000 {
        match tokio::time::timeout(Duration::from_secs(60), watch.next()).await.expect("the first write arrives within 60 s") {
            Some(ProcessEvent::Output { bytes, .. }) => read += bytes.len(),
            other => panic!("the first write, not {other:?}"),
        }
    }
    drop(watch);
    assert!(matches!(manager.subscribe(&handle, Some(0)), Err(ProcessError::ReplayUnavailable { .. })), "the ring dropped the start");
    let feed = manager.feed_of(&handle).unwrap();
    let (seam_feed, mut producer) = (Arc::clone(&feed), TabFilter::new(Arc::clone(&tab)));
    feed.on_refused(move || {
        let bytes = producer.filter(&[b'y'; 2048]);
        seam_feed.admit(OutputStream::Stdout, &bytes, || producer.admitted());
    });
    pump(&manager, &tab, &logged);
    logged.until("the first write's change", |log| log.contains(&Seen::Change(Some(ActivityState::Idle))));
    manager.write_input(&handle, b"2\n".to_vec()).unwrap();
    let log = logged.until("the later chunk's change", |log| log.contains(&Seen::Change(Some(ActivityState::Running))));
    let at = log.iter().position(|seen| *seen == Seen::Change(Some(ActivityState::Running))).unwrap();
    let total = manager.output_pushed(&handle).unwrap();
    assert_eq!(log[..at].last(), Some(&Seen::Taken(total)), "the later chunk's change goes when the pump takes it: {log:?}");
    let _ = manager.kill(&handle);
}

/// The exit line is an event of its own: with the output before the exit unread when the shell ends (the pump not yet running), the
/// tab's end goes once the pump has taken that output and before it takes the exit line (Node: the text, `activity.exit()`, then the
/// exit line, terminal-manager.ts:378-384), however the feed merged the output before it.
#[tokio::test(flavor = "multi_thread")]
async fn the_tabs_end_goes_between_the_output_before_the_exit_and_the_exit_line() {
    let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
    let handle = ProcessHandle::from(format!("term_exit_line_{}", std::process::id()));
    let logged = Logged::new();
    let tab = relay_tab(Arc::clone(&logged) as Arc<dyn TerminalEvents>, manager.clone(), handle.as_str());
    let mut request = piped(&handle, "[Console]::Out.Write('x' + [char]27 + ']697;P' + [char]7)", "printf 'x\\033]697;P\\007'");
    request.pty = Some(PtySize { cols: 80, rows: 24 });
    let ending = Arc::clone(&tab);
    manager
        .spawn_with(
            request,
            SpawnOptions {
                replays_after_exit: true,
                filter: Some(Box::new(TabFilter::new(Arc::clone(&tab)))),
                on_exit: Some(Box::new(move |exit| ending.exited(exit))),
                ..SpawnOptions::default()
            },
        )
        .await
        .unwrap();
    let feed = manager.feed_of(&handle).unwrap();
    tokio::time::timeout(Duration::from_secs(60), feed.ended()).await.expect("the shell ended within 60 s");
    let total = manager.output_pushed(&handle).unwrap();
    let line = match manager.info(&handle).unwrap().exit.expect("the shell ended").status {
        ExitStatus::Code(code) => format!("\r\n[process exited with code {code}]\r\n").len() as u64,
        ExitStatus::Signal(signal) => format!("\r\n[process exited with code {}]\r\n", 128 + signal).len() as u64,
    };
    pump(&manager, &tab, &logged);
    let log = logged.until("the pump's end", |log| log.contains(&Seen::Taken(u64::MAX)));
    let end = log.iter().position(|seen| *seen == Seen::Change(None)).expect("the tab's end went");
    let taken = log[..end].iter().rev().find(|seen| matches!(seen, Seen::Taken(_)));
    assert_eq!(taken, Some(&Seen::Taken(total - line)), "the tab's end goes once the output before the exit is taken: {log:?}");
    assert_eq!(log.get(end + 1), Some(&Seen::Taken(total)), "the exit line is taken after the tab's end: {log:?}");
}

/// Three reads enter the feed before the pump takes any (a loaded machine: run 9 of the terminal replay, term_ph2_i2's screen clear and
/// prompt sent as one frame before its `idle`): the screen clear, the prompt's marker with the prompt, and more output. Node took each
/// read on its own (its text, then its markers), so the pump takes the read before the marker's, then the marker's read, publishes
/// its change, and only then takes the output after it.
#[tokio::test(flavor = "multi_thread")]
async fn the_pump_takes_a_markers_read_apart_from_the_reads_around_it() {
    let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
    let handle = ProcessHandle::from(format!("term_reads_{}", std::process::id()));
    let logged = Logged::new();
    let tab = relay_tab(Arc::clone(&logged) as Arc<dyn TerminalEvents>, manager.clone(), handle.as_str());
    manager
        .spawn_with(
            piped(&handle, "$null = [Console]::In.ReadLine()", "read a"),
            SpawnOptions { replays_after_exit: true, filter: Some(Box::new(TabFilter::new(Arc::clone(&tab)))), ..SpawnOptions::default() },
        )
        .await
        .unwrap();
    let feed = manager.feed_of(&handle).unwrap();
    let mut producer = TabFilter::new(Arc::clone(&tab));
    let mut read = |bytes: &[u8]| {
        let text = producer.filter(bytes);
        feed.admit(OutputStream::Stdout, &text, || producer.admitted());
        text.len() as u64
    };
    let clear = read(b"\x1b[2J\x1b[H");
    let prompt = read(b"\x1b]697;P\x07PS> ");
    let after = read(b"x");
    pump(&manager, &tab, &logged);
    let log = logged.until("the pump took every read", |log| log.contains(&Seen::Taken(clear + prompt + after)));
    assert_eq!(
        log,
        vec![Seen::Taken(clear), Seen::Taken(clear + prompt), Seen::Change(Some(ActivityState::Idle)), Seen::Taken(clear + prompt + after)],
        "each read is taken on its own, the marker's change right after its read"
    );
    let _ = manager.kill(&handle);
}

/// A chunk the paused producer holds at the feed's gate has not been read (Node's paused PTY read nothing): its marker is not applied,
/// so a change published meanwhile goes alone; once resumed, the chunk enters the feed and its change follows when the pump takes it.
#[tokio::test(flavor = "multi_thread")]
async fn a_paused_producers_chunk_changes_nothing_until_it_enters_the_feed() {
    let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
    let handle = ProcessHandle::from(format!("term_paused_{}", std::process::id()));
    let logged = Logged::new();
    let tab = relay_tab(Arc::clone(&logged) as Arc<dyn TerminalEvents>, manager.clone(), handle.as_str());
    manager
        .spawn_with(
            piped(
                &handle,
                "$null = [Console]::In.ReadLine(); [Console]::Out.Write('x' + [char]27 + ']697;P' + [char]7); $null = [Console]::In.ReadLine()",
                "read a; printf 'x\\033]697;P\\007'; read b",
            ),
            SpawnOptions { replays_after_exit: true, filter: Some(Box::new(TabFilter::new(Arc::clone(&tab)))), ..SpawnOptions::default() },
        )
        .await
        .unwrap();
    pump(&manager, &tab, &logged);
    manager.set_output_paused(&handle, true).unwrap();
    manager.write_input(&handle, b"go\n".to_vec()).unwrap();
    tokio::time::timeout(Duration::from_secs(60), manager.output_blocked(&handle)).await.expect("the reader reached the paused gate with the chunk").unwrap();
    tab.publish(&mut tab.lock(), Some(Some(ActivityState::Finished)));
    let changes = |log: &[Seen]| log.iter().filter(|seen| matches!(seen, Seen::Change(_))).cloned().collect::<Vec<_>>();
    assert_eq!(
        changes(&logged.until("the direct change", |log| !changes(log).is_empty())),
        vec![Seen::Change(Some(ActivityState::Finished))],
        "the held chunk's marker was applied before the chunk was read"
    );
    manager.set_output_paused(&handle, false).unwrap();
    let log = logged.until("the chunk's change", |log| changes(log).len() == 2);
    assert_eq!(changes(&log), vec![Seen::Change(Some(ActivityState::Finished)), Seen::Change(Some(ActivityState::Idle))]);
    let at = log.iter().position(|seen| *seen == Seen::Change(Some(ActivityState::Idle))).unwrap();
    assert!(matches!(log[..at].last(), Some(Seen::Taken(taken)) if *taken != u64::MAX), "the change went when the pump took its chunk: {log:?}");
    let _ = manager.kill(&handle);
}
