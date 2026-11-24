use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::process::CommandSpec;
use mixdog_core_api::domain::process::EnvSpec;
use mixdog_core_api::domain::process::OutputMode;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::process::ProcessOwner;
use mixdog_core_api::domain::process::SpawnRequest;
use mixdog_core_api::feed::ScopedFeed;
use mixdog_core_api::feed::ScopedFeeds;
use mixdog_core_api::mock::FeedTap;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::mock::MockScopedFeeds;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_protocol::FeedId;
use mixdog_protocol::ProcessHandle;

use super::super::feeds::TERMINAL_LANE_FEED;
use super::*;
use crate::manager::ProcessConfig;
#[cfg(windows)]
use crate::terminal::SpawnProfile;

const DEADLINE: Duration = Duration::from_secs(60);

/// `fut`'s value, or a failure naming `what` once [`DEADLINE`] has passed on the wall clock. The deadline waits on the blocking
/// pool, which also keeps a paused clock from moving by itself meanwhile: only the test's `advance` moves it.
async fn within<T>(what: &str, fut: impl std::future::Future<Output = T>) -> T {
    let (_alive, timer) = std::sync::mpsc::channel::<()>();
    let deadline = tokio::task::spawn_blocking(move || {
        let _ = timer.recv_timeout(DEADLINE);
    });
    tokio::select! {
        value = fut => value,
        _ = deadline => panic!("never happened within {DEADLINE:?}: {what}"),
    }
}

/// Holds the next tab-list publication (where a size owner is published) until the test opens the gate, and notes how many frames
/// the phone's relay feed had when it went.
#[derive(Default)]
struct Gated {
    inner: MockStatePublisher,
    gate: Mutex<Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>>,
    relay: Mutex<Option<Arc<dyn ScopedFeed>>>,
    relay_at_owner: Mutex<Option<u64>>,
}

impl StatePublisher for Gated {
    fn publish(&self, section: SectionName, key: Option<String>, change: SectionChange) {
        let gate = (section == SectionName::TerminalTabs).then(|| self.gate.lock().unwrap().take()).flatten();
        let Some((held, open)) = gate else {
            return self.inner.publish(section, key, change);
        };
        held.send(()).unwrap();
        open.recv_timeout(DEADLINE).expect("the test opens the gate");
        let relay = self.relay.lock().unwrap().clone().expect("the relay feed is known");
        *self.relay_at_owner.lock().unwrap() = Some(relay.position().seq);
        self.inner.publish(section, key, change);
        // Told the test the owner is out.
        let _ = held.send(());
    }
}

/// The text of the output frames among `frames`, with each frame's feed sequence number.
fn outputs(frames: &[Value]) -> Vec<(u64, String)> {
    frames
        .iter()
        .filter(|frame| frame["method"] == "process/outputDelta")
        .map(|frame| {
            let bytes = STANDARD.decode(frame["params"]["bytesB64"].as_str().expect("output carries bytes")).unwrap();
            (frame["feed"]["seq"].as_u64().expect("a feed frame has its seq"), String::from_utf8_lossy(&bytes).into_owned())
        })
        .collect()
}

fn sent(frames: &[Value], text: &str) -> Option<u64> {
    outputs(frames).into_iter().find(|(_, output)| output.contains(text)).map(|(seq, _)| seq)
}

/// A process that writes `before` and then `after`, each once the test sends it a line.
fn two_writes(handle: &ProcessHandle) -> SpawnRequest {
    let command = if cfg!(windows) {
        let script = "$null = [Console]::In.ReadLine(); [Console]::Out.Write('before'); $null = [Console]::In.ReadLine(); \
                          [Console]::Out.Write('after'); $null = [Console]::In.ReadLine()";
        CommandSpec::Argv { program: "powershell".to_owned(), args: vec!["-NoProfile".to_owned(), "-Command".to_owned(), script.to_owned()] }
    } else {
        CommandSpec::Argv { program: "sh".to_owned(), args: vec!["-c".to_owned(), "read a; printf before; read b; printf after; read c".to_owned()] }
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

/// A claim holds back what the shell writes after it (the console's re-render) until the size owner is published, on a clock only
/// the test moves: the phone gets the announcement first, as Node's did (it resized and announced in one call,
/// terminal-manager.ts:485-488). Output already in the feed when the claim came (Node had it in its relay buffer then) is not held.
#[test]
fn a_claim_holds_back_what_the_shell_writes_after_it_until_its_owner_is_published() {
    let paused = tokio::runtime::Builder::new_current_thread().enable_all().start_paused(true).build().unwrap();
    let sections = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
    paused.block_on(async {
        let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
        let scoped = Arc::new(MockScopedFeeds::new(MockLimits::default()));
        let feeds = ProcessFeeds::new(manager.clone(), Arc::clone(&scoped) as Arc<dyn ScopedFeeds>);
        let publisher = Arc::new(Gated::default());
        // The section worker runs on a runtime of its own: a held publication blocks it, not the pump.
        let service = {
            let _sections = sections.enter();
            TerminalService::new(manager.clone(), Arc::clone(&feeds), Arc::clone(&publisher) as Arc<dyn StatePublisher>, TerminalServiceConfig::default())
        };
        let handle = ProcessHandle::from(format!("term_claim_{}", std::process::id()));
        manager.spawn(two_writes(&handle)).await.unwrap();
        let opened = feeds.open_spawned(handle.as_str(), &TerminalId { core: "test".into(), incarnation: 1 }, || None);
        let relay = scoped.find(&FeedId::from(TERMINAL_LANE_FEED)).expect("the terminal lane exists");
        *publisher.relay.lock().unwrap() = Some(Arc::clone(&relay));
        let tap = FeedTap::attach(&relay);
        let mut written = manager.subscribe(&handle, None).unwrap();
        manager.write_input(&handle, b"1\n".to_vec()).unwrap();
        within("the first output entered the feed", written.next()).await;

        let (held, open) = (std::sync::mpsc::channel(), std::sync::mpsc::channel());
        *publisher.gate.lock().unwrap() = Some((held.0, open.1));
        let _ = service.notify(Method("terminal/resize"), json!({ "tabId": handle.as_str(), "cols": 101, "rows": 31, "claim": true }), ConnectionId(1));
        let held = Arc::new(Mutex::new(held.1));
        let next_from_publisher = |what: &'static str| {
            let held = Arc::clone(&held);
            async move { tokio::task::spawn_blocking(move || held.lock().unwrap().recv_timeout(DEADLINE)).await.unwrap().expect(what) }
        };
        next_from_publisher("the owner's publication reached the publisher").await;
        drop(opened);
        within("the output already in the feed went out while the owner was unpublished", tap.notifications_until(|frames| sent(frames, "before").is_some()))
            .await;

        // The hold stands until just before its deadline; the relay's 16 ms are long over, so unheld output would go at once.
        tokio::time::advance(PUBLISH_DEADLINE - Duration::from_millis(1)).await;
        let mut stops = feeds.stops_of(handle.as_str());
        let stopped = *stops.borrow_and_update();
        manager.write_input(&handle, b"2\n".to_vec()).unwrap();
        within("the re-render entered the feed", written.next()).await;
        within("the pump stopped for the hold or sent the re-render", async {
            tokio::select! {
                _ = stops.wait_for(|stops| *stops > stopped) => {}
                _ = tap.notifications_until(|frames| sent(frames, "after").is_some()) => {}
            }
        })
        .await;
        open.0.send(()).unwrap();
        next_from_publisher("the owner was published").await;
        let frames = within("the re-render reached the phone", tap.notifications_until(|frames| sent(frames, "after").is_some())).await;
        let at_owner = publisher.relay_at_owner.lock().unwrap().expect("the owner was published");
        assert_eq!(sent(&frames, "before"), Some(at_owner), "the output from before the claim was the last frame before the owner");
        assert!(sent(&frames, "after").unwrap() > at_owner, "the re-render reached the phone before the owner announcement: {frames:?}");
        let _ = manager.kill(&handle);
    });
}

/// A hold at an output offset keeps back only what the shell writes after it: the relay flush that falls due while it stands sends the
/// output from before it, which an attach holding at its cut waits to see published.
#[test]
fn a_relay_flush_of_the_output_before_a_hold_goes_while_the_hold_stands() {
    let paused = tokio::runtime::Builder::new_current_thread().enable_all().start_paused(true).build().unwrap();
    paused.block_on(async {
        let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
        let scoped = Arc::new(MockScopedFeeds::new(MockLimits::default()));
        let feeds = ProcessFeeds::new(manager.clone(), Arc::clone(&scoped) as Arc<dyn ScopedFeeds>);
        let handle = ProcessHandle::from(format!("term_flush_{}", std::process::id()));
        manager.spawn(two_writes(&handle)).await.unwrap();
        drop(feeds.open_spawned(handle.as_str(), &TerminalId { core: "test".into(), incarnation: 1 }, || None));
        let tap = FeedTap::attach(&scoped.find(&FeedId::from(TERMINAL_LANE_FEED)).expect("the terminal lane exists"));
        let mut written = manager.subscribe(&handle, None).unwrap();
        manager.write_input(&handle, b"1\n".to_vec()).unwrap();
        within("the first output entered the feed", written.next()).await;
        within("the first output reached the phone", tap.notifications_until(|frames| sent(frames, "before").is_some())).await;
        // Inside the relay's window: this output waits in the relay buffer for its flush.
        manager.write_input(&handle, b"2\n".to_vec()).unwrap();
        within("the second output entered the feed", written.next()).await;
        let pushed = manager.output_pushed(&handle).unwrap();
        let mut published = feeds.published_of(handle.as_str());
        within("the pump took the second output", published.wait_for(|at| *at >= pushed)).await.unwrap();
        assert_eq!(sent(&tap.notifications_until(|_| true).await, "after"), None, "the second output waits for its flush");
        let held = feeds.hold_new_output(handle.as_str()).expect("the terminal has a feed");
        tokio::time::advance(Duration::from_secs(1)).await;
        within("the flush went while the hold stood", tap.notifications_until(|frames| sent(frames, "after").is_some())).await;
        drop(held);
        let _ = manager.kill(&handle);
    });
}

/// What ends a claim's hold in [`a_parked_chunk_goes_once_whatever_ends_the_claims_hold`].
#[derive(Clone, Copy, Debug, PartialEq)]
enum Release {
    /// The owner is published.
    Published,
    /// The deadline passes with the publication still blocked.
    Deadline,
    /// The shell ends while the hold stands; the owner is published after.
    TabEnd,
}

/// C3 (b) and C2: the hold goes in while the producer is paused with a chunk at its gate; the chunk enters the feed on resume and
/// waits for the hold. Whatever ends the hold (publication, deadline, or publication after the tab's end, which by itself ends no
/// hold: the exit is what waits), the chunk reaches the phone exactly once and the hold is gone exactly once (its one `FeedHold`,
/// dropped by the claim's task).
fn a_parked_chunk_goes_once_whatever_ends_the_claims_hold(release: Release) {
    let paused = tokio::runtime::Builder::new_current_thread().enable_all().start_paused(true).build().unwrap();
    let sections = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
    paused.block_on(async {
        let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
        let scoped = Arc::new(MockScopedFeeds::new(MockLimits::default()));
        let feeds = ProcessFeeds::new(manager.clone(), Arc::clone(&scoped) as Arc<dyn ScopedFeeds>);
        let publisher = Arc::new(Gated::default());
        let service = {
            let _sections = sections.enter();
            TerminalService::new(manager.clone(), Arc::clone(&feeds), Arc::clone(&publisher) as Arc<dyn StatePublisher>, TerminalServiceConfig::default())
        };
        let handle = ProcessHandle::from(format!("term_parked_{release:?}_{}", std::process::id()));
        manager.spawn(two_writes(&handle)).await.unwrap();
        let opened = feeds.open_spawned(handle.as_str(), &TerminalId { core: "test".into(), incarnation: 1 }, || None);
        let relay = scoped.find(&FeedId::from(TERMINAL_LANE_FEED)).expect("the terminal lane exists");
        *publisher.relay.lock().unwrap() = Some(Arc::clone(&relay));
        let tap = FeedTap::attach(&relay);
        let mut written = manager.subscribe(&handle, None).unwrap();
        manager.write_input(&handle, b"1\n".to_vec()).unwrap();
        within("the first output entered the feed", written.next()).await;
        drop(opened);
        within("the first output reached the phone", tap.notifications_until(|frames| sent(frames, "before").is_some())).await;
        // The relay's window after that frame closes: what comes next goes on its own.
        tokio::time::advance(Duration::from_secs(1)).await;

        manager.set_output_paused(&handle, true).unwrap();
        manager.write_input(&handle, b"2\n".to_vec()).unwrap();
        within("the producer parked the chunk at the gate", manager.output_blocked(&handle)).await.unwrap();
        let (held, open) = (std::sync::mpsc::channel(), std::sync::mpsc::channel());
        *publisher.gate.lock().unwrap() = Some((held.0, open.1));
        let mut holds = feeds.holds_of(handle.as_str());
        let _ = service.notify(Method("terminal/resize"), json!({ "tabId": handle.as_str(), "cols": 101, "rows": 31, "claim": true }), ConnectionId(1));
        assert_eq!(holds.borrow_and_update().len(), 1, "the claim took its hold");
        let held = Arc::new(Mutex::new(held.1));
        let next_from_publisher = |what: &'static str| {
            let held = Arc::clone(&held);
            async move { tokio::task::spawn_blocking(move || held.lock().unwrap().recv_timeout(DEADLINE)).await.unwrap().expect(what) }
        };
        next_from_publisher("the owner's publication reached the publisher").await;

        let mut stops = feeds.stops_of(handle.as_str());
        let stopped = *stops.borrow_and_update();
        manager.set_output_paused(&handle, false).unwrap();
        within("the parked chunk entered the feed", written.next()).await;
        within("the pump stopped for the hold", stops.wait_for(|stops| *stops > stopped)).await.unwrap();
        assert_eq!(sent(&tap.notifications_until(|_| true).await, "after"), None, "the parked chunk went while held");

        match release {
            Release::Published => {
                open.0.send(()).unwrap();
                next_from_publisher("the owner was published").await;
            }
            Release::Deadline => tokio::time::advance(PUBLISH_DEADLINE).await,
            Release::TabEnd => {
                let _ = manager.kill(&handle);
                within("the shell's exit entered the feed", manager.feed_of(&handle).unwrap().ended()).await;
                let frames = tap.notifications_until(|_| true).await;
                assert_eq!(sent(&frames, "after"), None, "the parked chunk went at the tab's end, before the owner");
                assert!(frames.iter().all(|frame| frame["method"] != "process/exited"), "the exit went before the owner");
                open.0.send(()).unwrap();
                next_from_publisher("the owner was published").await;
            }
        }
        within("the hold ended", holds.wait_for(Vec::is_empty)).await.unwrap();
        within("the parked chunk reached the phone", tap.notifications_until(|frames| sent(frames, "after").is_some())).await;
        tokio::time::advance(Duration::from_secs(1)).await;
        let _ = manager.kill(&handle);
        let frames =
            within("the exit reached the phone", tap.notifications_until(|frames| frames.iter().any(|frame| frame["method"] == "process/exited"))).await;
        let text: String = outputs(&frames).into_iter().map(|(_, output)| output).collect();
        assert_eq!(text.matches("after").count(), 1, "the parked chunk reached the phone once: {text:?}");
        assert!(holds.borrow().is_empty(), "the hold came back");
        if release == Release::Deadline {
            open.0.send(()).unwrap();
            next_from_publisher("the owner was published").await;
        }
    });
}

#[test]
fn a_parked_chunk_goes_once_when_the_owner_is_published() {
    a_parked_chunk_goes_once_whatever_ends_the_claims_hold(Release::Published);
}

#[test]
fn a_parked_chunk_goes_once_when_the_hold_reaches_its_deadline() {
    a_parked_chunk_goes_once_whatever_ends_the_claims_hold(Release::Deadline);
}

#[test]
fn a_parked_chunk_goes_once_when_the_tab_ends_during_the_hold() {
    a_parked_chunk_goes_once_whatever_ends_the_claims_hold(Release::TabEnd);
}

/// Records every section publication with the relay feed's position when it went.
/// The first publication a gate matches waits (on the section worker) until the test opens the gate.
#[cfg(windows)]
#[derive(Default)]
struct Ordered {
    relay: Mutex<Option<Arc<dyn ScopedFeed>>>,
    log: Mutex<Vec<(bool, Value, u64)>>,
    changed: tokio::sync::Notify,
    #[allow(clippy::type_complexity)]
    gate: Mutex<Option<(Box<dyn Fn(bool, &Value) -> bool + Send>, std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>>,
}

#[cfg(windows)]
impl StatePublisher for Ordered {
    fn publish(&self, section: SectionName, _: Option<String>, change: SectionChange) {
        let SectionChange::Set(bytes) = &change else { return };
        let tabs = section == SectionName::TerminalTabs;
        let value: Value = serde_json::from_slice(bytes).unwrap();
        let gated = {
            let mut gate = self.gate.lock().unwrap();
            if gate.as_ref().is_some_and(|(matches, ..)| matches(tabs, &value)) { gate.take() } else { None }
        };
        if let Some((_, held, open)) = gated {
            held.send(()).unwrap();
            open.recv_timeout(DEADLINE).expect("the test opens the gate within 60 s");
        }
        let at = self.relay.lock().unwrap().as_ref().map_or(0, |relay| relay.position().seq);
        self.log.lock().unwrap().push((tabs, value, at));
        self.changed.notify_waiters();
    }
}

#[cfg(windows)]
impl Ordered {
    /// The relay position at the first publication `found` matches, once there is one.
    async fn at(&self, found: impl Fn(bool, &Value) -> bool) -> u64 {
        loop {
            let changed = self.changed.notified();
            let mut changed = std::pin::pin!(changed);
            changed.as_mut().enable();
            if let Some((_, _, at)) = self.log.lock().unwrap().iter().find(|(tabs, value, _)| found(*tabs, value)) {
                return *at;
            }
            changed.await;
        }
    }

    fn index(&self, found: impl Fn(bool, &Value) -> bool) -> Option<usize> {
        self.log.lock().unwrap().iter().position(|(tabs, value, _)| found(*tabs, value))
    }
}

/// A tab running the integrated Windows PowerShell (its prompt marks the tab idle, so the tab's end is an activity change), its
/// relay feed pumped and read, the section worker on a runtime of its own (a gated publication blocks it, not the pump), the test
/// on a paused clock: the tab's exit comes [`crate::manager::NODE_PTY_FLUSH`] after the shell's end only when the test advances it.
#[cfg(windows)]
struct ShellRig {
    manager: LocalProcessManager,
    feeds: Arc<ProcessFeeds>,
    publisher: Arc<Ordered>,
    service: Arc<TerminalService>,
    id: String,
    terminal: TerminalId,
    handle: ProcessHandle,
    relay: Arc<dyn ScopedFeed>,
    raw: FeedTap,
    tap: FeedTap,
}

#[cfg(windows)]
impl ShellRig {
    async fn start(name: &str, sections: &tokio::runtime::Runtime) -> Self {
        let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
        let scoped = Arc::new(MockScopedFeeds::new(MockLimits::default()));
        let feeds = ProcessFeeds::new(manager.clone(), Arc::clone(&scoped) as Arc<dyn ScopedFeeds>);
        let publisher = Arc::new(Ordered::default());
        let service = {
            let _sections = sections.enter();
            TerminalService::new(manager.clone(), Arc::clone(&feeds), Arc::clone(&publisher) as Arc<dyn StatePublisher>, TerminalServiceConfig::default())
        };
        let id = format!("term_{name}_{}", std::process::id());
        let handle = ProcessHandle::from(id.as_str());
        let profile = SpawnProfile { path: "powershell.exe".to_owned(), ..SpawnProfile::default() };
        let attached = within(
            "the tab started",
            service.tabs.ensure(Some(&id), EnsureRequest { profile: Some(profile), cols: Some(80), rows: Some(24), ..EnsureRequest::default() }),
        )
        .await
        .unwrap();
        drop(feeds.open_terminal(&id, &attached.terminal).expect("the spawn opened the tab's feed"));
        let relay = scoped.find(&FeedId::from(TERMINAL_LANE_FEED)).expect("the terminal lane exists");
        *publisher.relay.lock().unwrap() = Some(Arc::clone(&relay));
        let raw = FeedTap::attach(&scoped.find(&FeedId::from(format!("process:{id}"))).expect("the raw feed exists"));
        let tap = FeedTap::attach(&relay);
        let rig = Self { manager, feeds, publisher, service, id, terminal: attached.terminal, handle, relay, raw, tap };
        within("the prompt's activity was published", rig.publisher.at(|tabs, value| !tabs && value.get(&rig.id).is_some())).await;
        // The relay's window closes: the next output goes as a leading-edge frame.
        tokio::time::advance(Duration::from_secs(1)).await;
        rig
    }

    /// The shell has ended and its exit wait has seen every byte it wrote (the clock has not moved since its end).
    async fn ended_quietly(&self) {
        let mut wait = self.manager.exit_wait(&self.handle).unwrap();
        let manager = &self.manager;
        within(
            "the shell ended and its output was seen",
            wait.wait_for(|wait| wait.waiting && wait.quiet_from == manager.output_pushed(&self.handle).unwrap()),
        )
        .await
        .unwrap();
    }

    /// The pump has taken every byte the shell wrote.
    async fn all_taken(&self) {
        let pushed = self.manager.output_pushed(&self.handle).unwrap() as usize;
        let total = |frames: &[Value]| outputs(frames).iter().map(|(_, text)| text.len()).sum::<usize>();
        within("the pump took the shell's output", self.raw.notifications_until(|frames| total(frames) >= pushed)).await;
    }

    fn ended(&self) -> impl Fn(bool, &Value) -> bool + '_ {
        |tabs, value| !tabs && value.get(&self.id).is_none()
    }

    fn owned(&self) -> impl Fn(bool, &Value) -> bool + '_ {
        |tabs, value| tabs && value.as_array().is_some_and(|rows| rows.iter().any(|row| row["id"] == json!(self.id) && !row["sizeOwner"].is_null()))
    }
}

/// Blocks on `rx` for at most [`DEADLINE`], off the paused runtime.
async fn received(rx: &Arc<Mutex<std::sync::mpsc::Receiver<()>>>, what: &'static str) {
    let rx = Arc::clone(rx);
    tokio::task::spawn_blocking(move || rx.lock().unwrap().recv_timeout(DEADLINE)).await.unwrap().expect(what);
}

/// G1: the shell's end and its exit line reach a client in Node's order (terminal-manager.ts:378-384: the text, `activity.exit()`,
/// the exit line). The tab's end is held at the publisher; the pump waits for it and does not send the exit line meanwhile.
#[cfg(windows)]
#[test]
fn the_exit_line_waits_until_the_tabs_end_has_reached_the_clients() {
    let paused = tokio::runtime::Builder::new_current_thread().enable_all().start_paused(true).build().unwrap();
    let sections = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
    paused.block_on(async {
        let rig = ShellRig::start("exit_order", &sections).await;
        assert!(rig.service.tabs.write(&rig.id, "exit\r").is_none(), "the line was queued");
        rig.ended_quietly().await;
        let (held, open) = (std::sync::mpsc::channel(), std::sync::mpsc::channel());
        let id = rig.id.clone();
        *rig.publisher.gate.lock().unwrap() = Some((Box::new(move |tabs, value: &Value| !tabs && value.get(&id).is_none()), held.0, open.1));
        let held = Arc::new(Mutex::new(held.1));
        let mut orderings = rig.feeds.orderings_of(&rig.id);
        let ordered = *orderings.borrow_and_update();
        tokio::time::advance(crate::manager::NODE_PTY_FLUSH).await;
        received(&held, "the tab's end reached the publisher").await;
        // The raw feed carries the pump's output at once (the relay feed may buffer it for its 16 ms).
        let exit_line = |frames: &[Value]| sent(frames, "[process exited").is_some();
        within("the pump waited for the tab's end or sent the exit line", async {
            tokio::select! {
                _ = orderings.wait_for(|waits| *waits > ordered) => {}
                _ = rig.raw.notifications_until(exit_line) => {}
            }
        })
        .await;
        assert!(!exit_line(&rig.raw.notifications_until(|_| true).await), "the exit line went while the tab's end was held at the publisher");
        assert!(!exit_line(&rig.tap.notifications_until(|_| true).await), "the exit line went while the tab's end was held at the publisher");
        open.0.send(()).unwrap();
        let at_end = within("the tab's end was published", rig.publisher.at(rig.ended())).await;
        tokio::time::advance(Duration::from_secs(1)).await;
        let frames = within("the exit line went", rig.tap.notifications_until(exit_line)).await;
        assert!(sent(&frames, "[process exited").unwrap() > at_end, "the exit line went before the tab's end");
    });
}

/// G2 and C1, through the service: a claim takes its hold and its resize stops at the claim gate, before the announcement; the
/// shell's end comes meanwhile (`paused`: its echo of `exit` waiting unread at the paused gate; otherwise with all its output
/// taken); the resize is let go. A client gets the owner, then (`paused`) the parked output as a leading-edge frame, then the tab's
/// end, then the exit line, and no activity change before the owner: Node ran no exit handler inside its resize-and-announce call
/// (terminal-manager.ts:485-488).
#[cfg(windows)]
fn the_owner_goes_before_the_exit_of_a_shell_that_ends_during_a_claim(paused: bool) {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().start_paused(true).build().unwrap();
    let sections = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
    runtime.block_on(async {
        let rig = ShellRig::start(if paused { "claimed_parked" } else { "claimed_taken" }, &sections).await;
        if paused {
            rig.manager.set_output_paused(&rig.handle, true).unwrap();
        }
        // Paused: the line without its Enter, so the shell is still there when the claim comes; its echo waits at the gate.
        assert!(rig.service.tabs.write(&rig.id, if paused { "exit" } else { "exit\r" }).is_none(), "the line was queued");
        if paused {
            within("the producer parked the shell's echo at the gate", rig.manager.output_blocked(&rig.handle)).await.unwrap();
        } else {
            rig.ended_quietly().await;
            rig.all_taken().await;
        }
        let claimed = rig.publisher.log.lock().unwrap().len();
        let gate = rig.service.tabs.hold_claim_gate(&rig.id);
        let mut holds = rig.feeds.holds_of(&rig.id);
        let (claimed_tx, claimed_rx) = std::sync::mpsc::channel();
        {
            let (service, runtime, id) = (Arc::clone(&rig.service), tokio::runtime::Handle::current(), rig.id.clone());
            std::thread::spawn(move || {
                let _runtime = runtime.enter();
                let _ = service.notify(Method("terminal/resize"), json!({ "tabId": id, "cols": 101, "rows": 31, "claim": true }), ConnectionId(1));
                let _ = claimed_tx.send(());
            });
        }
        within("the claim took its hold", holds.wait_for(|holds| holds.len() == 1)).await.unwrap();
        if paused {
            assert!(rig.service.tabs.write(&rig.id, "\r").is_none(), "the Enter was queued");
        }
        // Paused: the shell's end lets the parked echo in, after the end, which starts the exit wait again.
        rig.ended_quietly().await;
        tokio::time::advance(crate::manager::NODE_PTY_FLUSH).await;
        within("the shell's exit entered the feed", rig.manager.feed_of(&rig.handle).unwrap().ended()).await;
        let before = rig.relay.position().seq;
        drop(gate);
        received(&Arc::new(Mutex::new(claimed_rx)), "the claim's resize returned once its gate was let go").await;

        let at_owner = within("the owner was published", rig.publisher.at(rig.owned())).await;
        let at_end = within("the tab's end was published", rig.publisher.at(rig.ended())).await;
        assert_eq!(at_owner, before, "output went while the claim held the feed, or after the owner was published");
        let owner = rig.publisher.index(rig.owned()).unwrap();
        let log = rig.publisher.log.lock().unwrap().clone();
        let changes: Vec<usize> = (claimed..log.len()).filter(|at| !log[*at].0).collect();
        assert!(changes.iter().all(|at| *at > owner), "an activity change went before the owner: {log:?}");
        let frames = if paused {
            within("the parked output went as a leading-edge frame", rig.tap.notifications_until(|frames| outputs(frames).iter().any(|(seq, _)| *seq > before)))
                .await
        } else {
            Vec::new()
        };
        tokio::time::advance(Duration::from_secs(1)).await;
        let frames = [frames, within("the exit line went", rig.tap.notifications_until(|frames| sent(frames, "[process exited").is_some())).await].concat();
        let exit_line = sent(&frames, "[process exited").unwrap();
        if paused {
            let parked = outputs(&frames).into_iter().find(|(seq, _)| *seq > before).unwrap();
            assert!(
                parked.0 != exit_line && parked.0 <= at_end,
                "the parked output is not between the owner ({at_owner}) and the tab's end ({at_end}): {parked:?}"
            );
        }
        assert!(exit_line > at_end, "the exit line went before the tab's end");
    });
}

#[cfg(windows)]
#[test]
fn the_owner_goes_before_the_exit_and_the_parked_output_of_a_shell_that_ends_during_a_claim() {
    the_owner_goes_before_the_exit_of_a_shell_that_ends_during_a_claim(true);
}

#[cfg(windows)]
#[test]
fn the_owner_goes_before_the_exit_of_a_shell_that_ends_with_its_output_taken_during_a_claim() {
    the_owner_goes_before_the_exit_of_a_shell_that_ends_during_a_claim(false);
}

/// A claim's hold has its deadline from when it is taken: a resize that blocks (here at the id's claim gate) holds the feed no longer.
#[tokio::test(start_paused = true)]
async fn a_claims_hold_ends_at_its_deadline_while_the_resize_is_blocked() {
    let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
    let feeds = ProcessFeeds::new(manager.clone(), Arc::new(MockScopedFeeds::new(MockLimits::default())));
    let service = TerminalService::new(manager, Arc::clone(&feeds), Arc::new(MockStatePublisher::default()), TerminalServiceConfig::default());
    feeds.terminal_opened("term_blocked", TerminalId { core: "test".into(), incarnation: 1 }, crate::feed::Feed::new(1 << 20), Box::new(|| None));
    let gate = service.tabs.hold_claim_gate("term_blocked");
    let mut holds = feeds.holds_of("term_blocked");
    let (claimed_tx, claimed_rx) = std::sync::mpsc::channel();
    {
        let (service, runtime) = (Arc::clone(&service), tokio::runtime::Handle::current());
        std::thread::spawn(move || {
            let _runtime = runtime.enter();
            let _ = service.notify(Method("terminal/resize"), json!({ "tabId": "term_blocked", "cols": 101, "rows": 31, "claim": true }), ConnectionId(1));
            let _ = claimed_tx.send(());
        });
    }
    within("the claim took its hold", holds.wait_for(|holds| holds.len() == 1)).await.unwrap();
    tokio::time::advance(PUBLISH_DEADLINE - Duration::from_millis(1)).await;
    assert_eq!(holds.borrow().len(), 1, "the hold ended before its deadline");
    tokio::time::advance(Duration::from_millis(1)).await;
    within("the hold of a claim whose resize is blocked ended at its deadline", holds.wait_for(Vec::is_empty)).await.unwrap();
    drop(gate);
    received(&Arc::new(Mutex::new(claimed_rx)), "the claim's resize returned once its gate was let go").await;
}

/// A dispose is not answered before the tab's end it caused is published (Node: terminal-manager.ts:541, `activity.exit()` before
/// the answer): with that publication held at the publisher, the call waits through the barrier's whole deadline, and when the
/// deadline passes it fails (`PUBLISH_TIMEOUT`) instead of answering ahead of the tab's end.
#[cfg(windows)]
#[test]
fn a_dispose_whose_tabs_end_is_held_is_not_answered_first() {
    let paused = tokio::runtime::Builder::new_current_thread().enable_all().start_paused(true).build().unwrap();
    let sections = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
    paused.block_on(async {
        let rig = ShellRig::start("dispose_held", &sections).await;
        let (held, open) = (std::sync::mpsc::channel(), std::sync::mpsc::channel());
        let id = rig.id.clone();
        *rig.publisher.gate.lock().unwrap() = Some((Box::new(move |tabs, value: &Value| !tabs && value.get(&id).is_none()), held.0, open.1));
        let request = CoreRequest {
            method: Method("terminal/dispose"),
            params: json!({ "tabId": rig.id, "opId": "op-dispose" }),
            op: None,
            ctx: mixdog_core_api::call::CallContext::internal("test"),
        };
        let mut reply = std::pin::pin!(rig.service.call(request));
        assert!(still_pending(reply.as_mut()).await, "the dispose was answered while the tab's end was held at the publisher");
        received(&Arc::new(Mutex::new(held.1)), "the tab's end reached the publisher").await;
        tokio::time::advance(PUBLISH_DEADLINE - Duration::from_millis(1)).await;
        assert!(still_pending(reply.as_mut()).await, "the dispose was answered before the barrier's deadline with the tab's end still held");
        tokio::time::advance(Duration::from_millis(1)).await;
        let answer = within("the dispose ended at the barrier's deadline", reply).await;
        match answer {
            Err(CoreError::DomainError { code: Some(code), .. }) if &*code == "PUBLISH_TIMEOUT" => {}
            other => panic!("a dispose whose tab's end was never published was answered as {other:?}, not a PUBLISH_TIMEOUT error"),
        }
        open.0.send(()).unwrap();
        within("the tab's end was published once the gate opened", rig.publisher.at(rig.ended())).await;
    });
}

/// A local attach answers with a subscription to the feed its cut was taken on: a dispose and the id's next terminal that come while it
/// waits for that feed to publish the output its replay holds do not put another feed in its place.
#[cfg(windows)]
#[test]
fn an_attach_subscribes_the_feed_it_cut_when_the_ids_feed_is_replaced_meanwhile() {
    let paused = tokio::runtime::Builder::new_current_thread().enable_all().start_paused(true).build().unwrap();
    let sections = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
    paused.block_on(async {
        let rig = ShellRig::start("attach_feed", &sections).await;
        let cut_on = rig.feeds.position_of(&rig.id).epoch;
        // Nothing the shell writes from here is published until the hold goes: the attach waits for its replay's output.
        let held = rig.feeds.hold(&rig.id, &rig.terminal).expect("the tab has a feed");
        let mut written = rig.manager.subscribe(&rig.handle, None).unwrap();
        assert!(rig.service.tabs.write(&rig.id, "x").is_none(), "the key was queued");
        within("the shell echoed the key", written.next()).await;
        let mut holds = rig.feeds.holds_of(&rig.id);
        let (service, id) = (Arc::clone(&rig.service), rig.id.clone());
        let attach = tokio::spawn(async move {
            let ctx = mixdog_core_api::call::CallContext::internal("test");
            service.call(CoreRequest { method: Method("terminal/attach"), params: json!({ "tabId": id }), op: None, ctx }).await
        });
        within("the attach took its cut", holds.wait_for(|holds| holds.len() == 2)).await.unwrap();
        // A dispose and the id's next terminal, as far as the feeds go.
        rig.feeds.close(&rig.id, &rig.terminal);
        let next = TerminalId { core: rig.terminal.core.clone(), incarnation: rig.terminal.incarnation + 1 };
        rig.feeds.terminal_opened(&rig.id, next, crate::feed::Feed::new(1 << 20), Box::new(|| None));
        let replaced = rig.feeds.position_of(&rig.id).epoch;
        drop(held);
        let Ok(Reply::Subscribe(sub)) = within("the attach answered", attach).await.unwrap() else {
            panic!("a local attach answers with a subscription");
        };
        assert_eq!(sub.feed.position().epoch, cut_on, "the subscription is of the feed the attach cut");
        assert_ne!(sub.feed.position().epoch, replaced, "the subscription is not of the id's next feed");
    });
}

/// A tab no client ever attached (as the in-process `terminal` tool's) has the feed its spawn made; a disposal by the tab layer itself
/// (a removed worktree's) retires that feed with the tab.
#[cfg(windows)]
#[test]
fn a_tab_no_client_attached_leaves_no_feed_once_the_tab_layer_disposes_it() {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
        let scoped = Arc::new(MockScopedFeeds::new(MockLimits::default()));
        let feeds = ProcessFeeds::new(manager.clone(), Arc::clone(&scoped) as Arc<dyn ScopedFeeds>);
        let publisher: Arc<dyn StatePublisher> = Arc::new(Ordered::default());
        let service = TerminalService::new(manager, Arc::clone(&feeds), publisher, TerminalServiceConfig::default());
        let id = format!("term_unattached_{}", std::process::id());
        let profile = SpawnProfile { path: "powershell.exe".to_owned(), ..SpawnProfile::default() };
        within("the tab started", service.tabs.ensure(Some(&id), EnsureRequest { profile: Some(profile), ..EnsureRequest::default() })).await.unwrap();
        assert!(feeds.has_feed(&id), "the spawn made the tab's feed");
        service.tabs.dispose(&id);
        assert!(!feeds.has_feed(&id), "the disposal retired the feed with its tab");
    });
}

/// Polls `future` once: whether it is still pending.
#[cfg(windows)]
async fn still_pending<F: std::future::Future + ?Sized>(mut future: std::pin::Pin<&mut F>) -> bool {
    std::future::poll_fn(|cx| std::task::Poll::Ready(future.as_mut().poll(cx).is_pending())).await
}
