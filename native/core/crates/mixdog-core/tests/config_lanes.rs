//! The config service runs its own file work on the io lanes: reads on interactive, writes on
//! durability. A recording backend sees which lane every job was submitted to. This is its own
//! test binary because the executor backend is installed once per process.

use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use mixdog_core::config::Config;
use mixdog_core::config::ConfigLanes;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_protocol::ConfigWriteMode;
use mixdog_rt::Backend;
use mixdog_rt::LaneFull;
use mixdog_rt::LaneKind;
use mixdog_rt::QueuedJob;
use mixdog_rt::TaskClass;
use mixdog_rt::ThreadKind;
use serde_json::json;

#[derive(Default)]
struct Recording {
    lanes: Mutex<Vec<LaneKind>>,
}

impl Recording {
    fn take(&self) -> Vec<LaneKind> {
        std::mem::take(&mut *self.lanes.lock().unwrap())
    }
}

/// Newtype so the test keeps a handle on the recorder after the backend is installed.
struct Backing(Arc<Recording>);

impl Backend for Backing {
    fn handle(&self, _class: TaskClass) -> tokio::runtime::Handle {
        tokio::runtime::Handle::current()
    }

    fn record_poll(&self, _task: &'static str, _class: TaskClass, _elapsed: Duration) {}

    fn submit(&self, job: QueuedJob) -> Result<(), LaneFull> {
        self.0.lanes.lock().unwrap().push(job.lane());
        job.run();
        Ok(())
    }

    fn enter_thread(&self, _kind: ThreadKind) {}
}

#[tokio::test]
async fn reads_run_on_the_interactive_lane_and_writes_on_the_durability_lane() {
    let recording = Arc::new(Recording::default());
    let tokens = mixdog_rt::install(Arc::new(Backing(recording.clone()))).unwrap();
    let lanes = ConfigLanes {
        read: tokens.interactive_io,
        write: tokens.durability_io,
    };
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mixdog-config.json");

    let (config, _) = Config::open(&path, Arc::new(MockStatePublisher::default()), lanes)
        .await
        .unwrap();
    assert_eq!(recording.take(), [LaneKind::InteractiveIo], "open reads");

    config
        .write("desktop.keepAwake", json!(false), ConfigWriteMode::Replace)
        .await
        .unwrap();
    assert_eq!(recording.take(), [LaneKind::DurabilityIo], "a write persists");

    // A write that changes nothing still takes the writer, so it is a durability job too.
    config
        .write("desktop.keepAwake", json!(false), ConfigWriteMode::Replace)
        .await
        .unwrap();
    assert_eq!(recording.take(), [LaneKind::DurabilityIo]);

    // A reload reads on interactive, then installs on durability.
    config.reload().await.unwrap();
    assert_eq!(recording.take(), [LaneKind::InteractiveIo, LaneKind::DurabilityIo]);

    // Reads of the loaded document are memory loads and submit nothing.
    assert!(!config.desktop_settings().keep_awake);
    assert!(recording.take().is_empty());
}
