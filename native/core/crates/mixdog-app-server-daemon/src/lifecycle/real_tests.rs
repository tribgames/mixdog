#![allow(clippy::disallowed_methods, reason = "tests read and check the discovery file directly")]

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU32;
use std::sync::atomic::Ordering;
use std::sync::mpsc;

use mixdog_app_protocol::limits::Limits;
use mixdog_app_protocol::mgmt::ActivityKind;
use mixdog_app_protocol::v2::host::CoreDrainParams;
use mixdog_app_protocol::v2::host::DrainRunning;
use mixdog_core_api::StatePublisher;
use mixdog_core_api::state::SectionChange;
use mixdog_protocol::DrainReason;
use mixdog_protocol::SectionName;
use tokio_util::sync::CancellationToken;

use super::*;
use crate::discovery::CoreSection;
use crate::discovery::Endpoints;
use crate::discovery::Port;
use crate::discovery::SessionEndpoint;

#[derive(Default)]
struct Sections(Mutex<Vec<(SectionName, serde_json::Value)>>);

impl StatePublisher for Sections {
    fn publish(&self, section: SectionName, key: Option<String>, change: SectionChange) {
        assert_eq!(key, None);
        let SectionChange::Set(bytes) = change else { panic!("lifecycle sections are inline") };
        self.0.lock().unwrap().push((section, serde_json::from_slice(&bytes).unwrap()));
    }
}

fn work(id: u64) -> Running {
    Running {
        id,
        kind: ActivityKind::Turn,
        thread_id: Some("t1".into()),
        turn_id: Some("u1".into()),
        title: "a turn".into(),
    }
}

struct Fixture {
    runtime: tokio::runtime::Runtime,
    sections: Arc<Sections>,
    cancel: Arc<CancelRegistry>,
    barriers: Arc<AtomicU32>,
    data: Arc<AtomicU32>,
    flushes: Arc<AtomicU32>,
    released: Arc<Mutex<Vec<u32>>>,
    ext_host: Arc<mixdog_exthost::ExtHostPool>,
    drains: Arc<Mutex<Vec<CoreDrainParams>>>,
    reasons: Arc<Mutex<Vec<String>>>,
    core: RuntimeCore,
}

fn template() -> Discovery {
    Discovery {
        pid: 1234,
        endpoints: Endpoints {
            session: SessionEndpoint { port: 4001, token: "t".into() },
            model_proxy: None,
        },
        core: CoreSection {
            version: "1.4.6".into(),
            build: "b6".into(),
            instance_id: "inst".into(),
            process_start_time: "99".into(),
            state: CoreState::Booting,
            blocked: None,
            drain: None,
            rpc: None,
            ssh_rpc: None,
            rebuild: None,
            control: Port { port: 4001 },
        },
    }
}

fn read(root: &std::path::Path) -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(discovery::path(root)).unwrap()).unwrap()
}

#[test]
fn discovery_names_the_phase_and_the_rpc_port_only_while_serving() {
    let root = tempfile::tempdir().unwrap();
    let publication = DiscoveryPublication::new(root.path().to_path_buf(), template(), Box::new(|_| {}));
    publication.set_rpc_port(5005);
    let state = |phase, drain_id| DiscoveryState { phase, blocked: None, drain_id };

    publication.publish(&state(DiscoveryPhase::Booting, None));
    publication.flush();
    assert_eq!(read(root.path())["core"]["state"], "booting");
    assert!(read(root.path())["core"].get("rpc").is_none());

    publication.publish(&state(DiscoveryPhase::Serving, None));
    publication.flush();
    assert_eq!(read(root.path())["core"]["state"], "serving");
    assert_eq!(read(root.path())["core"]["rpc"]["port"], 5005);
    assert_eq!(read(root.path())["pid"], 1234);

    publication.publish(&state(DiscoveryPhase::Draining, Some("d1".into())));
    publication.flush();
    let draining = read(root.path());
    assert_eq!(draining["core"]["state"], "draining");
    assert_eq!(draining["core"]["drain"]["drainId"], "d1");
    assert!(draining["core"].get("rpc").is_none(), "rpc goes away while draining");

    publication.publish(&state(DiscoveryPhase::Serving, None));
    publication.flush();
    assert_eq!(read(root.path())["core"]["rpc"]["port"], 5005, "cancelDrain gives rpc back");
    assert!(read(root.path())["core"].get("drain").is_none());

    publication.withdraw();
    assert!(!discovery::path(root.path()).exists());
}

#[test]
fn discovery_names_the_rebuild_while_it_runs_and_not_before_or_once_done() {
    let root = tempfile::tempdir().unwrap();
    let publication = DiscoveryPublication::new(root.path().to_path_buf(), template(), Box::new(|_| {}));
    let progress = publication.rebuild_progress();
    let state = |phase| DiscoveryState { phase, blocked: None, drain_id: None };
    let rebuild = |root: &std::path::Path| read(root)["core"].get("rebuild").cloned();

    publication.publish(&state(DiscoveryPhase::Booting));
    publication.flush();
    assert_eq!(rebuild(root.path()), None, "a start that needs no rebuild names none");

    progress.begin(3);
    publication.flush();
    assert_eq!(rebuild(root.path()), Some(serde_json::json!({ "done": 0, "total": 3 })));
    for done in 1..=3 {
        progress.advance();
        publication.flush();
        assert_eq!(rebuild(root.path()), Some(serde_json::json!({ "done": done, "total": 3 })));
    }

    publication.publish(&state(DiscoveryPhase::Serving));
    publication.flush();
    assert_eq!(rebuild(root.path()), None, "a serving core names no finished work");
    // The owed sensitive rewrites run behind the serving core: their progress is named until they end.
    progress.extend(2);
    publication.flush();
    assert_eq!(rebuild(root.path()), Some(serde_json::json!({ "done": 3, "total": 5 })));
    progress.advance();
    publication.flush();
    assert_eq!(rebuild(root.path()), Some(serde_json::json!({ "done": 4, "total": 5 })));
    progress.advance();
    publication.flush();
    assert_eq!(rebuild(root.path()), None, "work behind the serving core is no longer named once it ends");
    // A session of it that fails is told apart from the done ones, for the rest of the boot.
    progress.extend(1);
    progress.fail();
    publication.flush();
    assert_eq!(rebuild(root.path()), Some(serde_json::json!({ "done": 5, "total": 6, "failed": 1 })));
}

/// Sessions finish on many threads while the lifecycle publishes: what is written never goes backwards, and ends at the total.
#[test]
fn discovery_never_writes_the_rebuild_backwards_under_concurrent_progress_and_publishes() {
    let written: Arc<Mutex<Vec<Option<(u64, u64)>>>> = Arc::default();
    let write: WriteDocument = Box::new({
        let written = written.clone();
        move |_root, document| {
            written.lock().unwrap().push(document.core.rebuild.map(|rebuild| (rebuild.done, rebuild.total)));
            Ok(())
        }
    });
    let root = tempfile::tempdir().unwrap();
    let publication = Arc::new(DiscoveryPublication::with_writer(root.path().to_path_buf(), template(), write, Box::new(|_| {})));
    let progress = publication.rebuild_progress();
    publication.publish(&DiscoveryState { phase: DiscoveryPhase::Booting, blocked: None, drain_id: None });
    progress.begin(1000);
    std::thread::scope(|scope| {
        for _ in 0..4 {
            scope.spawn(|| {
                for _ in 0..250 {
                    progress.advance();
                }
            });
        }
        scope.spawn(|| {
            for _ in 0..50 {
                publication.publish(&DiscoveryState { phase: DiscoveryPhase::Booting, blocked: None, drain_id: None });
            }
        });
    });
    publication.flush();
    let written = written.lock().unwrap();
    let counts: Vec<u64> = written.iter().flatten().map(|(done, _)| *done).collect();
    assert!(counts.windows(2).all(|pair| pair[0] <= pair[1]), "never backwards: {counts:?}");
    assert_eq!(written.last().copied().flatten(), Some((1000, 1000)), "ends at the total");
}

#[test]
fn a_dropped_boot_ends_its_writer_and_its_reporter_cannot_reach_it() {
    let root = tempfile::tempdir().unwrap();
    let publication = DiscoveryPublication::new(root.path().to_path_buf(), template(), Box::new(|_| {}));
    let progress = publication.rebuild_progress();
    drop(publication);
    progress.begin(2);
    progress.advance();
    assert_eq!(progress.snapshot(), Some((1, 2)), "the reporter still counts, and telling a gone publication is a no-op");
}

#[test]
fn withdraw_leaves_a_file_another_core_published() {
    let root = tempfile::tempdir().unwrap();
    let mut other = template();
    other.core.instance_id = "someone-else".into();
    discovery::publish(root.path(), &other).unwrap();
    DiscoveryPublication::new(root.path().to_path_buf(), template(), Box::new(|_| {})).withdraw();
    assert_eq!(read(root.path())["core"]["instanceId"], "someone-else");
}

/// A publication whose every write fails with the error the discovery file's reader causes on Windows.
fn failing_publication(fatal: mpsc::Sender<String>) -> (DiscoveryPublication, tempfile::TempDir) {
    let root = tempfile::tempdir().unwrap();
    let write: WriteDocument = Box::new(|_root, _document| Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied)));
    let on_fatal: OnFatal = Box::new(move |error| fatal.send(error.to_string()).unwrap());
    (DiscoveryPublication::with_writer(root.path().to_path_buf(), template(), write, on_fatal), root)
}

#[test]
fn a_boot_state_that_cannot_be_published_is_fatal_and_a_draining_one_is_only_logged() {
    let (fatal, failures) = mpsc::channel();
    let (publication, _root) = failing_publication(fatal);
    let state = |phase| DiscoveryState { phase, blocked: None, drain_id: None };

    publication.publish(&state(DiscoveryPhase::Draining));
    publication.flush();
    assert!(failures.try_recv().is_err(), "a failed draining publication is not fatal");

    publication.publish(&state(DiscoveryPhase::Serving));
    publication.flush();
    assert!(failures.try_recv().is_ok(), "a failed serving publication is fatal");
}


fn fixture() -> Fixture {
    // A worker thread drives the spawned pool tasks while the test thread blocks on the handle, as
    // the release thread does in production.
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(1).build().unwrap();
    let sections = Arc::new(Sections::default());
    let cancel = Arc::new(CancelRegistry::default());
    let barriers = Arc::new(AtomicU32::new(0));
    let data = Arc::new(AtomicU32::new(0));
    let flushes = Arc::new(AtomicU32::new(0));
    let released = Arc::new(Mutex::new(Vec::new()));
    let drains = Arc::new(Mutex::new(Vec::new()));
    let reasons = Arc::new(Mutex::new(Vec::new()));
    let counter = |count: &Arc<AtomicU32>| -> Hook {
        let count = Arc::clone(count);
        Arc::new(move || {
            count.fetch_add(1, Ordering::SeqCst);
        })
    };
    let install = tempfile::tempdir().unwrap();
    let js = crate::js_runtime::fixture(install.path());
    let ext_host = {
        let _enter = runtime.enter();
        Arc::new(
            mixdog_exthost::ExtHostPool::new(mixdog_exthost::ExtHostConfig {
                workers: 1,
                ..crate::compose::ext_host_config(&js, install.path(), &mixdog_rt::testing::tokens())
            })
            .unwrap(),
        )
    };
    let core = RuntimeCore::new(CoreWiring {
        state: sections.clone(),
        connections: Arc::new(ConnectionHub::new(Limits::default()).unwrap()),
        ext_host: ext_host.clone(),
        runtime: runtime.handle().clone(),
        cancel: cancel.clone(),
        cut_new_tasks: Arc::new(|| {}),
        final_barriers: counter(&barriers),
        release_decision: {
            let released = Arc::clone(&released);
            Arc::new(move |pid| released.lock().unwrap().push(pid))
        },
        close_data_handles: {
            let count = counter(&data);
            Arc::new(move |_| count())
        },
        release_started: {
            let reasons = Arc::clone(&reasons);
            Arc::new(move |reason| reasons.lock().unwrap().push(reason.to_owned()))
        },
        flush_log: counter(&flushes),
        drain_feed: {
            let drains = Arc::clone(&drains);
            Arc::new(move |params| drains.lock().unwrap().push(params))
        },
    });
    Fixture { runtime, sections, cancel, barriers, data, flushes, released, ext_host, drains, reasons, core }
}
#[test]
fn the_release_hands_the_core_the_reason_node_would_carry() {
    use crate::lifecycle::CorePort;
    let f = fixture();
    f.core.release_started("SIGTERM");
    f.core.release_started("no live session clients");
    assert_eq!(*f.reasons.lock().unwrap(), ["SIGTERM", "no live session clients"]);
}
#[test]
fn health_and_the_drain_reach_the_app_feed_sections() {
    let f = fixture();
    f.core.health(2500);
    f.core.health(0);
    f.core.drain_notice(&DrainNotice {
        drain_id: "d1".into(),
        reason: DrainReason::Update,
        running: vec![work(7)],
        confirm_token: "tok".into(),
    });
    let sections = f.sections.0.lock().unwrap();
    assert_eq!(sections[0], (SectionName::CoreHealth, serde_json::json!({ "stalledMs": 2500 })));
    assert_eq!(sections[1], (SectionName::CoreHealth, serde_json::json!({ "stalledMs": 0 })));
    let (section, drain) = &sections[2];
    assert_eq!(*section, SectionName::Core);
    let state: mixdog_app_protocol::v1::CoreState = serde_json::from_value(drain.clone()).unwrap();
    assert_eq!(state, mixdog_app_protocol::v1::CoreState::Draining { reason: DrainReason::Update });

    let drains = f.drains.lock().unwrap();
    assert_eq!(
        *drains,
        [CoreDrainParams {
            drain_id: "d1".into(),
            running: vec![DrainRunning {
                thread_id: Some("t1".into()),
                turn_id: Some("u1".into()),
                kind: ActivityKind::Turn,
                title: "a turn".into(),
            }],
            confirm_token: "tok".into(),
        }]
    );
}
#[test]
fn serving_replaces_a_draining_core_section_with_the_serving_state() {
    use crate::lifecycle::CorePort;
    let f = fixture();
    f.core.drain_notice(&DrainNotice {
        drain_id: "d1".into(),
        reason: DrainReason::Quit,
        running: Vec::new(),
        confirm_token: "tok".into(),
    });
    f.core.serving();
    let sections = f.sections.0.lock().unwrap();
    let states: Vec<mixdog_app_protocol::v1::CoreState> = sections
        .iter()
        .map(|(section, value)| {
            assert_eq!(*section, SectionName::Core);
            serde_json::from_value(value.clone()).unwrap()
        })
        .collect();
    assert_eq!(
        states,
        [mixdog_app_protocol::v1::CoreState::Draining { reason: DrainReason::Quit }, mixdog_app_protocol::v1::CoreState::Serving]
    );
}
#[test]
fn work_without_a_thread_is_listed_with_null_ids() {
    let f = fixture();
    let mut shell = work(9);
    shell.kind = ActivityKind::BackgroundShell;
    shell.thread_id = None;
    shell.turn_id = None;
    f.core.drain_notice(&DrainNotice {
        drain_id: "d2".into(),
        reason: DrainReason::Quit,
        running: vec![shell],
        confirm_token: "t".into(),
    });
    let wire = serde_json::to_value(&f.drains.lock().unwrap()[0]).unwrap();
    assert!(wire["running"][0]["threadId"].is_null());
    assert!(wire["running"][0]["turnId"].is_null());
}
#[test]
fn cancel_running_cancels_only_the_named_work_and_a_finished_one_is_forgotten() {
    let f = fixture();
    let (a, b, c) = (CancellationToken::new(), CancellationToken::new(), CancellationToken::new());
    let _ta = f.cancel.track(1, a.clone());
    let _tb = f.cancel.track(2, b.clone());
    let tc = f.cancel.track(3, c.clone());
    drop(tc);
    f.core.cancel_running(&[work(1), work(3)]);
    assert!(a.is_cancelled());
    assert!(!b.is_cancelled());
    assert!(!c.is_cancelled(), "a unit of work that finished is no longer tracked");
}
/// A busy session's turn and the manual compaction beside it are one activity: the one that ends first leaves the other tracked.
#[test]
fn work_tracked_under_one_activity_leaves_on_its_own() {
    let f = fixture();
    let (turn, compaction) = (CancellationToken::new(), CancellationToken::new());
    let _turn = f.cancel.track(1, turn.clone());
    drop(f.cancel.track(1, compaction.clone()));
    f.core.cancel_running(&[work(1)]);
    assert!(turn.is_cancelled(), "the turn is still tracked after the compaction ended");
    assert!(!compaction.is_cancelled());
}
#[test]
fn the_release_steps_reach_what_the_composition_supplied() {
    let f = fixture();
    f.core.final_barriers();
    f.core.close_connections();
    f.core.close_ext_host();
    f.core.close_data_handles(&ManagedDrain::new());
    f.core.flush_log();
    f.core.release_decision(4242);
    assert_eq!(f.barriers.load(Ordering::SeqCst), 1);
    assert_eq!(f.data.load(Ordering::SeqCst), 1);
    assert_eq!(f.flushes.load(Ordering::SeqCst), 1);
    assert_eq!(*f.released.lock().unwrap(), vec![4242]);
    drop(f.runtime);
}
#[test]
fn close_ext_host_closes_the_fixture_pool_and_returns() {
    let f = fixture();
    // Release steps run off the runtime; the test thread stands in for the release thread.
    f.core.close_ext_host();
    // A closed host refuses later work: the shared render browser stops answering.
    let endpoint = f.runtime.block_on(f.ext_host.render_browser().endpoint());
    assert!(endpoint.is_err(), "the pool was closed: {endpoint:?}");
}
#[test]
fn work_that_registers_after_an_abort_began_is_cancelled_at_once() {
    let f = fixture();
    // The abort listed activity 5 before its owner got to `track`.
    f.core.cancel_running(&[work(5)]);
    let late = CancellationToken::new();
    let _tracked = f.cancel.track(5, late.clone());
    assert!(late.is_cancelled());
}
#[test]
fn publishing_never_writes_on_the_calling_thread_and_the_last_state_wins() {
    let written = Arc::new(Mutex::new(Vec::<(std::thread::ThreadId, String)>::new()));
    let write: WriteDocument = {
        let written = Arc::clone(&written);
        Box::new(move |_root, document| {
            std::thread::sleep(std::time::Duration::from_millis(2));
            let phase = serde_json::to_value(document.core.state).unwrap().as_str().unwrap().to_owned();
            written.lock().unwrap().push((std::thread::current().id(), phase));
            Ok(())
        })
    };
    let root = tempfile::tempdir().unwrap();
    let publication = DiscoveryPublication::with_writer(root.path().to_path_buf(), template(), write, Box::new(|_| {}));
    let state = |phase| DiscoveryState { phase, blocked: None, drain_id: None };
    for phase in [DiscoveryPhase::Booting, DiscoveryPhase::Serving, DiscoveryPhase::Draining, DiscoveryPhase::Serving] {
        publication.publish(&state(phase));
    }
    assert!(written.lock().unwrap().len() < 4, "publish returned before the slow writes finished");
    publication.flush();
    let written = written.lock().unwrap();
    assert!(written.iter().all(|(thread, _)| *thread != std::thread::current().id()));
    let phases: Vec<&str> = written.iter().map(|(_, phase)| phase.as_str()).collect();
    assert_eq!(phases, ["booting", "serving", "draining", "serving"]);
}
#[test]
fn a_deleted_discovery_file_comes_back_until_the_core_withdraws_it() {
    let root = tempfile::tempdir().unwrap();
    let publication = DiscoveryPublication::new(root.path().to_path_buf(), template(), Box::new(|_| {}));
    publication.publish(&DiscoveryState { phase: DiscoveryPhase::Serving, blocked: None, drain_id: None });
    publication.flush();
    let file = discovery::path(root.path());
    std::fs::remove_file(&file).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !file.is_file() {
        assert!(std::time::Instant::now() < deadline, "discovery was not restored");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    publication.withdraw();
    std::thread::sleep(std::time::Duration::from_millis(100));
    assert!(!file.exists());
}
