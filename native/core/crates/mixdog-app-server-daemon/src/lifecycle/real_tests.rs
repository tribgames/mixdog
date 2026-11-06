#![allow(clippy::disallowed_methods, reason = "tests read and check the discovery file directly")]

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU32;
use std::sync::atomic::Ordering;

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
    released: Arc<Mutex<Vec<u32>>>,
    ext_host: Arc<ExtHostPool>,
    drains: Arc<Mutex<Vec<CoreDrainParams>>>,
    core: RuntimeCore,
}

fn fixture() -> Fixture {
    // A worker thread drives the spawned pool tasks while the test thread blocks on the handle, as
    // the release thread does in production.
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(1).build().unwrap();
    let sections = Arc::new(Sections::default());
    let cancel = Arc::new(CancelRegistry::default());
    let barriers = Arc::new(AtomicU32::new(0));
    let data = Arc::new(AtomicU32::new(0));
    let released = Arc::new(Mutex::new(Vec::new()));
    let drains = Arc::new(Mutex::new(Vec::new()));
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
            ExtHostPool::new(mixdog_exthost::ExtHostConfig {
                program: js.program.clone(),
                args: vec![js.package_root.join("src").join("ext-host").join("worker.mjs").into_os_string()],
                electron: js.electron,
                workers: 1,
                pending_cap: mixdog_exthost::DEFAULT_PENDING_CAP,
                spawn_io: mixdog_rt::testing::tokens().spawn_io,
                render_browser: mixdog_exthost::RenderBrowserConfig {
                    command: None,
                    profile_root: install.path().join("render-browser"),
                    no_sandbox: false,
                },
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
        final_barriers: counter(&barriers),
        release_decision: {
            let released = Arc::clone(&released);
            Arc::new(move |pid| released.lock().unwrap().push(pid))
        },
        close_data_handles: counter(&data),
        drain_feed: {
            let drains = Arc::clone(&drains);
            Arc::new(move |params| drains.lock().unwrap().push(params))
        },
    });
    Fixture { runtime, sections, cancel, barriers, data, released, ext_host, drains, core }
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

#[test]
fn the_release_steps_reach_what_the_composition_supplied() {
    let f = fixture();
    f.core.final_barriers();
    f.core.close_connections();
    f.core.close_ext_host();
    f.core.close_data_handles();
    f.core.release_decision(4242);
    assert_eq!(f.barriers.load(Ordering::SeqCst), 1);
    assert_eq!(f.data.load(Ordering::SeqCst), 1);
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
    let publication = DiscoveryPublication::new(root.path().to_path_buf(), template());
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
        })
    };
    let root = tempfile::tempdir().unwrap();
    let publication = DiscoveryPublication::with_writer(root.path().to_path_buf(), template(), write);
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
fn withdraw_leaves_a_file_another_core_published() {
    let root = tempfile::tempdir().unwrap();
    let mut other = template();
    other.core.instance_id = "someone-else".into();
    discovery::publish(root.path(), &other).unwrap();
    DiscoveryPublication::new(root.path().to_path_buf(), template()).withdraw();
    assert_eq!(read(root.path())["core"]["instanceId"], "someone-else");
}
