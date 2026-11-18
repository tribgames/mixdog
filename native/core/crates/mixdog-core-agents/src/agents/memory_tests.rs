//! An agent's memory as the desktop lists and deletes it: the list is read page by page until the
//! runtime reports no further page, and a delete carries the list version it was chosen from.

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use serde_json::Value;
use serde_json::json;

use super::*;

fn message(error: &CoreError) -> String {
    match error {
        CoreError::DomainError { message, .. } => message.as_deref().unwrap_or("").to_owned(),
        other => panic!("not a domain error: {other:?}"),
    }
}

/// The memory runtime scripted with its replies, in order; every request it received is kept.
struct Scripted {
    replies: Mutex<Vec<Result<String, String>>>,
    asked: Mutex<Vec<Value>>,
}

#[async_trait]
impl MemoryRuntime for Scripted {
    async fn memory_control(&self, args: Value) -> Result<String, String> {
        self.asked.lock().unwrap().push(args);
        self.replies.lock().unwrap().remove(0)
    }
}

fn host(replies: Vec<Result<String, String>>) -> (AgentMemoryHost, Arc<Scripted>) {
    let runtime = Arc::new(Scripted { replies: Mutex::new(replies), asked: Mutex::default() });
    (AgentMemoryHost::new(runtime.clone()), runtime)
}

fn page(entries: Value, next: Option<u64>) -> Result<String, String> {
    let mut page = json!({ "entries": entries });
    if let Some(next) = next {
        page["nextOffset"] = json!(next);
    }
    Ok(page.to_string())
}

#[tokio::test]
async fn the_list_reads_every_page_in_order_until_there_is_no_next_offset() {
    let (memory, runtime) = host(vec![
        page(json!([{ "id": 7, "index_revision": "r1", "summary": "first" }, { "id": 3, "index_revision": "r1" }]), Some(100)),
        page(json!([{ "id": 9, "index_revision": "r2", "summary": "third" }]), None),
    ]);
    let entries = memory.list("ann").await.unwrap();
    assert_eq!(
        entries,
        json!([
            { "id": 7, "indexRevision": "r1", "summary": "first" },
            { "id": 3, "indexRevision": "r1", "summary": "" },
            { "id": 9, "indexRevision": "r2", "summary": "third" },
        ]),
        "list order is kept and a missing summary is empty"
    );
    let asked = runtime.asked.lock().unwrap().clone();
    let base = json!({ "op": "list", "agent_id": "ann", "format": "json", "limit": 100 });
    let mut first = base.clone();
    first["offset"] = json!(0);
    let mut second = base;
    second["offset"] = json!(100);
    assert_eq!(asked, [first, second]);
}

#[tokio::test]
async fn a_next_offset_that_does_not_advance_ends_the_list() {
    let (memory, runtime) = host(vec![page(json!([{ "id": 1, "index_revision": "r" }]), Some(0))]);
    assert_eq!(memory.list("ann").await.unwrap().as_array().unwrap().len(), 1);
    assert_eq!(runtime.asked.lock().unwrap().len(), 1, "no second read of the same page");
}

#[tokio::test]
async fn a_list_that_cannot_be_read_says_why() {
    let (memory, _) = host(vec![Ok("memory store is locked".into())]);
    assert_eq!(message(&memory.list("ann").await.unwrap_err()), "memory store is locked", "text that is no page is the reason");
    let (memory, _) = host(vec![Ok(String::new())]);
    assert_eq!(message(&memory.list("ann").await.unwrap_err()), "The agent memory could not be read.");
    let (memory, _) = host(vec![Err("runtime stopped".into())]);
    assert_eq!(message(&memory.list("ann").await.unwrap_err()), "runtime stopped");
    let (memory, runtime) = host(Vec::new());
    assert_eq!(message(&memory.list("").await.unwrap_err()), "agent id is invalid.");
    assert!(runtime.asked.lock().unwrap().is_empty(), "an agent without a home id is refused before the runtime is asked");
}

#[tokio::test]
async fn a_delete_names_the_entry_and_the_list_version_and_succeeds_on_a_core_deleted_reply() {
    let (memory, runtime) = host(vec![Ok("core deleted 7".into())]);
    memory.delete("ann", &json!(7), &json!("r1")).await.unwrap();
    assert_eq!(runtime.asked.lock().unwrap()[0], json!({ "op": "delete", "agent_id": "ann", "id": 7, "index_revision": "r1" }));
}

#[tokio::test]
async fn a_delete_the_runtime_does_not_confirm_fails_with_its_reply() {
    let (memory, _) = host(vec![Ok("stale index revision; list again".into())]);
    assert_eq!(message(&memory.delete("ann", &json!(7), &json!("old")).await.unwrap_err()), "stale index revision; list again");
    let (memory, _) = host(vec![Ok(String::new())]);
    assert_eq!(message(&memory.delete("ann", &json!(7), &json!("r1")).await.unwrap_err()), "The agent memory entry could not be deleted.");
}

#[tokio::test]
async fn a_delete_with_an_unusable_entry_or_list_version_never_reaches_the_runtime() {
    let long = "x".repeat(201);
    let cases = [
        (json!(0), json!("r"), "memory id is invalid."),
        (json!(-4), json!("r"), "memory id is invalid."),
        (json!(1.5), json!("r"), "memory id is invalid."),
        (json!("7"), json!("r"), "memory id is invalid."),
        (json!(7), json!(""), "memory indexRevision is invalid."),
        (json!(7), json!(long), "memory indexRevision is invalid."),
        (json!(7), json!(12), "memory indexRevision is invalid."),
        (json!(7), Value::Null, "memory indexRevision is invalid."),
    ];
    for (id, revision, expected) in cases {
        let (memory, runtime) = host(Vec::new());
        assert_eq!(message(&memory.delete("ann", &id, &revision).await.unwrap_err()), expected, "{id} {revision}");
        assert!(runtime.asked.lock().unwrap().is_empty());
    }
    // The longest accepted version is 200 characters.
    let (memory, _) = host(vec![Ok("core deleted 7".into())]);
    memory.delete("ann", &json!(7), &json!("x".repeat(200))).await.unwrap();
}
