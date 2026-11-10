//! A failed save keeps the turn (`turn-durability.mjs`): the rows a failed barrier carried stay shown and are written
//! again with the next records; the next turn waits for them, and is refused while they cannot be written. The
//! recorded Node behaviour is replayed in `mixdog-core` (`run_host::turn_durability_replay`).

use std::sync::Arc;
use std::sync::Mutex;

use mixdog_core_api::CoreError;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::ids::ItemId;
use mixdog_store::schema::blob::Slot;
use mixdog_store::schema::record::Record;
use serde_json::json;

use super::RunOutcome;
use super::SessionDirectory;
use super::actor::TURN_NOT_DURABLE;
use super::run::ItemCommit;
use super::testing::Rig;
use super::testing::Script;
use super::tests::{idle, request, rows, start_thread, turn};

/// Each run answers `re: <prompt>`; the saves fail from its answer on while `failing` holds a cause.
fn failing_from_the_answer(failing: Arc<Mutex<Option<Arc<str>>>>, arm: Arc<Mutex<Option<Arc<str>>>>) -> Script {
    Arc::new(move |run| {
        let (failing, arm) = (failing.clone(), arm.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let armed = arm.lock().unwrap().take();
            if armed.is_some() {
                *failing.lock().unwrap() = armed;
            }
            let text = match &run.input.prompt {
                mixdog_protocol::PromptContent::Text(text) => text.clone(),
                mixdog_protocol::PromptContent::Parts(_) => String::new(),
            };
            let item = ItemCommit { iid: ItemId::from(format!("a-{}", run.turn)), role: Some("assistant".into()), model: true, visible: true, body: json!({ "text": format!("re: {text}") }), prompt: None };
            run.port.commit_item(item).await.expect("the answer is kept");
            RunOutcome::Completed(Default::default())
        })
    })
}

/// The `text` of every item row the store holds, in order.
fn stored(rig: &Rig, id: &mixdog_core_api::ids::ThreadId) -> Vec<String> {
    rig.store
        .records(id)
        .into_iter()
        .filter_map(|(_, record)| match record {
            Record::Item(item) => match item.body {
                Slot::Inline(body) => Some(body.get("text").or_else(|| body.get("content")).and_then(|t| t.as_str()).unwrap_or_default().to_owned()),
                Slot::Blob(_) => None,
            },
            _ => None,
        })
        .collect()
}

#[tokio::test(start_paused = true)]
async fn a_failed_save_keeps_the_turn_and_holds_the_next_until_it_lands() {
    let rig = Rig::new();
    let arm: Arc<Mutex<Option<Arc<str>>>> = Arc::default();
    rig.set_script(failing_from_the_answer(rig.store.failing.clone(), arm.clone()));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    *arm.lock().unwrap() = Some("EIO: injected".into());
    turn(&handle, "first task", "op-1").await;
    crate::eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && rows(&handle).len() == 2).then_some(())).await;
    let shown = rows(&handle);
    assert_eq!(shown.iter().map(|(_, text)| text.as_str()).collect::<Vec<_>>(), ["first task", "re: first task"], "the answer stays shown");
    assert!(!stored(&rig, &handle.id).contains(&"re: first task".to_owned()), "the answer is not on disk");

    // The next turn retries the save first; it still fails, so the turn is refused and nothing of it is kept.
    let refused = handle
        .request(request("turn/start", json!({ "threadId": handle.id, "opId": "op-2", "input": { "prompt": "second task" } }), "op-2"))
        .await
        .expect_err("refused while the previous turn is not saved");
    let CoreError::DomainError { code, message, .. } = &refused else { panic!("{refused:?}") };
    assert_eq!(code.as_deref(), Some(TURN_NOT_DURABLE));
    let message = message.as_deref().map(str::to_owned).unwrap_or_default();
    assert!(message.starts_with(&format!("Session {}: the previous turn is not saved to disk", handle.id.as_str())), "{message}");
    assert!(message.ends_with("(EIO: injected)"), "{message}");
    assert_eq!(rows(&handle), shown, "the refused turn shows nothing; the first stays");

    // Once the disk takes writes, the next turn saves the first one, then runs; each is on disk once.
    *rig.store.failing.lock().unwrap() = None;
    turn(&handle, "second task", "op-3").await;
    crate::eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && rows(&handle).len() == 4).then_some(())).await;
    let texts: Vec<String> = stored(&rig, &handle.id).into_iter().filter(|text| !text.is_empty()).collect();
    assert_eq!(texts, ["first task", "re: first task", "second task", "re: second task"]);
}
