//! The relay handle's close, which ends every download of the paired phones (`remote-relay.ts` `close` calls
//! `fileDownloads.revokeAll` before the leg goes): the runtime tells it when remote access is switched off, when the identities rotate and
//! when the core stops, and not when the OS suspends or resumes (Node's `suspend` and `resume` keep the handle and its downloads).

use crate::common;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use common::{NoDial, NoEffects, Silent, driven_relay};
use mixdog_remote::access::runtime::{LegLink, RemoteEvents, RemoteRuntime, RuntimeConfig};
use mixdog_remote::access::settings::AccessSettings;
use mixdog_remote::registry::DeviceRegistry;
use mixdog_remote::section::{RemoteSection, RemoteSectionValue};
use serde_json::{Value, json};

#[derive(Default)]
struct Closes(AtomicUsize);

impl RemoteEvents for Closes {
    fn controller_key_delivered(&self, _: &str) {}
    fn owed_access_changed(&self) {}
    fn status(&self, _: Value) {}
    fn relay_closed(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

const WAIT: Duration = Duration::from_secs(10);

#[tokio::test(flavor = "multi_thread")]
async fn the_relay_handle_closes_when_switched_off_rotated_or_stopped_and_not_on_suspend_or_resume() {
    let dir = tempfile::tempdir().unwrap();
    let mut relay = driven_relay(json!([])).await;
    let closes = Arc::new(Closes::default());
    let cfg = RuntimeConfig {
        dir: dir.path().to_path_buf(),
        relay_url: Some(format!("ws://127.0.0.1:{}", relay.port)),
        app_version: None,
        durability: mixdog_rt::testing::tokens().durability_io,
        dialer: Arc::new(NoDial),
        registry: Arc::new(DeviceRegistry::default()),
        section: Arc::new(RemoteSection::new(Arc::new(Silent), RemoteSectionValue::default())),
        settings: Arc::new(AccessSettings::new(dir.path().to_path_buf(), Arc::new(|| "PC".to_owned()))),
        link: LegLink::default(),
        events: closes.clone(),
    };
    let runtime = RemoteRuntime::new(cfg, Box::new(|_| Box::new(NoEffects)));
    let count = || closes.0.load(Ordering::SeqCst);
    let mut up = runtime.watch_connected();
    let mut dialed = async |what: &str| {
        tokio::time::timeout(WAIT, relay.legs.recv()).await.unwrap_or_else(|_| panic!("the core never dialed the relay ({what})")).expect("the relay ended");
    };

    runtime.start(true).await.unwrap();
    dialed("start").await;
    tokio::time::timeout(WAIT, up.wait_for(|up| *up)).await.expect("the leg never came up").unwrap();
    runtime.suspend();
    assert_eq!(count(), 0, "a suspend keeps the handle");
    runtime.resume().await.unwrap();
    dialed("resume").await;
    assert_eq!(count(), 0, "a resume keeps the handle");

    runtime.stop().await.unwrap();
    assert_eq!(count(), 1, "switched off");
    runtime.start(false).await.unwrap();
    dialed("start after the stop").await;
    runtime.rotate().await.unwrap();
    assert_eq!(count(), 2, "rotated");
    runtime.close().await;
    assert_eq!(count(), 3, "the core stops");
}
