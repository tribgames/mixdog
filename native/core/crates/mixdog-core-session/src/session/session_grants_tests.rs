//! "Allow for this session" at the session level: the grant is held in the process-wide registry under the session's id, so
//! it outlives the thread's runtime (an unload and a reopen), answers only that session and only the life it was made for.

use std::sync::Arc;

use mixdog_core_api::call::CallContext;
use mixdog_core_api::domain::approval::ActionKind;
use mixdog_tools::policy::GrantKey;

use super::SessionDirectory;
use super::testing::Rig;
use super::tests::start_thread;

fn comment() -> GrantKey {
    GrantKey::Kind(ActionKind::Comment)
}

/// The last subscriber leaves and the idle deadline comes: the thread unloads.
async fn unload(directory: &SessionDirectory, handle: &super::SessionHandle) {
    super::tests::left_idle(handle).await;
    crate::eventually_on!(&[&handle.cell.stepped, directory.left()], || directory.handle(&handle.id).is_none().then_some(())).await;
}

#[tokio::test(start_paused = true)]
async fn a_session_grant_answers_the_next_ask_after_the_thread_unloads_and_reopens() {
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let handle = start_thread(&directory).await;
    assert!(handle.grants().grant("bot", &comment(), "life-1"));
    let id = handle.id.clone();
    unload(&directory, &handle).await;
    drop(handle);

    let reopened = directory.open_handle(&id, &CallContext::internal("test")).await.expect("the thread opens again");
    assert!(reopened.grants().has("bot", &comment(), "life-1"), "the grant outlives the runtime that was asked");
}

#[tokio::test(start_paused = true)]
async fn a_session_grant_answers_only_its_own_session_agent_and_life() {
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let first = start_thread(&directory).await;
    let second = start_thread(&directory).await;
    assert!(first.grants().grant("bot", &comment(), "life-1"));
    assert!(!second.grants().has("bot", &comment(), "life-1"), "another session is asked again");
    assert!(!first.grants().has("other", &comment(), "life-1"), "another agent is asked again");
    // A grant made under another life of the session (it was reset or closed since) is gone, and does not come back.
    assert!(!first.grants().has("bot", &comment(), "life-2"));
    assert!(!first.grants().has("bot", &comment(), "life-1"));
}

#[tokio::test(start_paused = true)]
async fn payments_and_deletes_are_never_granted_for_a_session() {
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let handle = start_thread(&directory).await;
    for kind in [ActionKind::Payment, ActionKind::Delete] {
        assert!(!handle.grants().grant("bot", &GrantKey::Kind(kind), "life-1"));
        assert!(!handle.grants().has("bot", &GrantKey::Kind(kind), "life-1"));
    }
}