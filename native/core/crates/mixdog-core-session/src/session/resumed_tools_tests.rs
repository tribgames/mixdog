//! `resumeSession`'s `_refreshResumedTools` (`SessionDeps.resumed_tools`): a stored thread opened
//! for use writes its refreshed tool surface before the open answers; a new thread does not ask.

use mixdog_core_api::call::CallContext;
use mixdog_store::schema::record::HeaderChange;
use serde_json::json;

use super::SessionDirectory;
use super::testing::Rig;
use super::testing::lock;
use crate::eventually_on;
use super::tests::start_thread;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stored_thread_opened_for_use_takes_its_refreshed_tools() {
    let rig = Rig::new();
    let first = SessionDirectory::new(rig.deps());
    let created = start_thread(&first).await;
    let id = created.id.clone();
    assert!(lock(&rig.resumed.asked).is_empty(), "a new thread builds its own surface");
    first.shutdown().await;

    let refreshed = json!({ "toolSpec": "mcp", "tools": [{ "name": "read" }] });
    *lock(&rig.resumed.change) = Some(HeaderChange { set: refreshed.as_object().unwrap().clone(), unset: vec!["toolExposureMode".into()] });
    let second = SessionDirectory::new(rig.deps());
    let opened = second.open_handle(&id, &CallContext::internal("test")).await.expect("open");
    assert_eq!(*lock(&rig.resumed.asked), [id.as_str().to_owned()]);
    eventually_on!(&[&opened.cell.stepped], || (opened.cell.header.load().get("toolSpec") == Some(&json!("mcp"))).then_some(())).await;
    assert_eq!(opened.cell.header.load().get("tools"), Some(&json!([{ "name": "read" }])));
}
