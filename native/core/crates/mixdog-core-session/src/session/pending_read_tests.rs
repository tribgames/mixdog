//! The pending-queue reads against Node's real functions (`fixtures/pending-queue/golden.json`,
//! recorded by `record-pending-queue.mjs`), over a real session actor with a turn running so
//! the entries stay queued. Prompt ids are opaque in both worlds (Node: 24 random hex; here: the
//! queue id the client was handed), so each Rust prompt id stands in for Node's at the same
//! position; completion ids are content-addressed and compared as they are.

use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use mixdog_core_api::Reply;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_rt::CancellationToken;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::SessionHandle;
use super::delivered::DeliveredCompletions;
use super::pending_read::PendingQueue;
use super::seams::RunOutcome;
use super::testing::Rig;
use super::tests::eventually;
use super::tests::start_thread;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/pending-queue/golden.json")).unwrap()
}

static OPS: AtomicUsize = AtomicUsize::new(0);

async fn queue_prompt(handle: &SessionHandle, prompt: &Value, options: Option<Value>) {
    let op = format!("pq-{}", OPS.fetch_add(1, Ordering::SeqCst));
    let mut input = json!({ "prompt": prompt });
    if let Some(options) = options {
        input["options"] = options;
    }
    let reply = handle
        .request(CoreRequest {
            method: Method("turn/start"),
            params: json!({ "threadId": handle.id, "opId": op, "input": input }),
            op: Some(OpId::from(op.as_str())),
            ctx: CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, CancellationToken::new()),
        })
        .await
        .expect("turn/start");
    assert!(matches!(reply, Reply::Value(_)));
}

/// A thread whose first turn never ends, so every later input is queued.
async fn busy_thread(rig: &Rig) -> (Arc<SessionDirectory>, Arc<SessionHandle>) {
    rig.set_script(Arc::new(|run| {
        Box::pin(async move {
            run.cancel.cancelled().await;
            RunOutcome::Interrupted
        })
    }));
    rig.clock.0.store(1_700_000_000_000, Ordering::SeqCst);
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let handle = start_thread(&directory).await;
    queue_prompt(&handle, &json!("running"), None).await;
    eventually(|| handle.cell.run.load().is_some().then_some(())).await;
    (directory, handle)
}

fn queue_reads(rig: &Rig, directory: &Arc<SessionDirectory>) -> PendingQueue {
    PendingQueue::new(directory.clone(), Arc::new(DeliveredCompletions::new(rig.clock.clone())))
}

#[tokio::test(start_paused = true)]
async fn the_queue_reads_answer_as_nodes_in_memory_queue_does() {
    let rig = Rig::new();
    let (directory, handle) = busy_thread(&rig).await;
    let gold = golden();
    let queue = &gold["queue"];
    let mut fed = 0;
    for (input, returned) in queue["inputs"].as_array().unwrap().iter().zip(queue["returned"].as_array().unwrap()) {
        if returned.get("threw").is_some() {
            // Node cannot queue a completion with no execution id (it overflows the stack); the
            // Rust queue holds it (decisions.md "Pending-queue reads"), so it is not replayed.
            assert_eq!(input["kind"], "completion");
            assert_eq!(input["taskId"], "");
            continue;
        }
        match input["kind"].as_str().unwrap() {
            "prompt" => queue_prompt(&handle, &input["value"], None).await,
            _ => {
                let s = |k: &str| input[k].as_str().unwrap();
                directory.queue_completion(&handle.id, s("surface"), s("taskId"), s("status"), s("text").to_owned()).await;
            }
        }
        fed += 1;
    }
    assert_eq!(fed, 7);
    // Four prompts (one blank) and two completions are queued; the repeated completion is one entry.
    eventually(|| (handle.cell.queue.load().len() == 6).then_some(())).await;

    let delivered = Arc::new(DeliveredCompletions::new(rig.clock.clone()));
    let reads = PendingQueue::new(directory.clone(), delivered.clone());
    let session = handle.id.as_str().to_owned();
    let got = reads.pending_messages(&session).await;
    // Node's list holds each entry as it sits in memory, then again as the spool holds it. The first half is the in-memory queue, taken by position: the spool's copy of an array-content prompt also carries `content`.
    let node_list = queue["beforeFlush"].as_array().unwrap();
    assert_eq!(node_list.len() % 2, 0);
    let in_memory: Vec<Value> = node_list[..node_list.len() / 2].to_vec();
    assert_eq!(got.len(), in_memory.len());
    let want: Vec<Value> = got
        .iter()
        .zip(in_memory)
        .map(|(got, mut want)| {
            if !want["id"].as_str().unwrap().starts_with("completion_") {
                assert_eq!(want["id"].as_str().unwrap().len(), 24);
                want["id"] = got["id"].clone();
            }
            want
        })
        .collect();
    assert_eq!(got, want);

    let owed = reads.owed_results(&session).await;
    let want_owed: Vec<(String, Value)> = queue["owedBeforeFlush"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| {
            let mut meta = o["meta"].clone();
            meta["caller_session_id"] = json!(session);
            (o["text"].as_str().unwrap().to_owned(), meta)
        })
        .collect();
    assert_eq!(owed.iter().map(|o| (o.text.clone(), o.meta.clone())).collect::<Vec<_>>(), want_owed);

    // A completion that already reached the model is no longer owed.
    assert!(delivered.record(Some("task_agent_1"), None));
    let owed = reads.owed_results(&session).await;
    assert_eq!(owed.len(), 1);
    assert_eq!(owed[0].meta["execution_id"], json!("job-7"));

    assert_eq!(json!(reads.pending_messages("bad id!").await), queue["invalidSession"]);
    assert_eq!(json!(reads.pending_messages("sess_none").await), queue["unknownSession"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_delivered_registry_answers_as_nodes_does() {
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let delivered = Arc::new(DeliveredCompletions::new(rig.clock.clone()));
    let reads = PendingQueue::new(directory, delivered.clone());
    let gold = golden();
    let frozen = gold["frozenNow"].as_i64().unwrap();
    let mut threw = 0;
    for step in gold["delivered"]["steps"].as_array().unwrap() {
        rig.clock.0.store((frozen + step["at"].as_i64().unwrap()) as u64, Ordering::SeqCst);
        if step["op"] == "record" {
            let got = delivered.record(step["executionId"].as_str(), step["text"].as_str());
            assert_eq!(json!(got), step["recorded"], "{step}");
        } else if step.get("threw").is_some() {
            // Node overflows its stack on a completion with no execution id; here its id is the
            // one its text names (decisions.md "Pending-queue reads").
            threw += 1;
            let _ = reads.completion_is_delivered(&step["entry"]);
        } else {
            assert_eq!(json!(reads.completion_is_delivered(&step["entry"])), step["delivered"], "{step}");
        }
    }
    assert_eq!(threw, 2);
}

#[tokio::test(start_paused = true)]
async fn the_steering_read_returns_the_queued_submission_ids_as_nodes_persist_does() {
    let rig = Rig::new();
    let (directory, handle) = busy_thread(&rig).await;
    let reads = queue_reads(&rig, &directory);
    let gold = golden();
    let frozen = gold["frozenNow"].as_i64().unwrap();
    let mut queued = 1;
    for step in gold["steering"]["steps"].as_array().unwrap() {
        rig.clock.0.store((frozen + step["at"].as_i64().unwrap()) as u64, Ordering::SeqCst);
        if step["op"] == "append" {
            let entry = &step["entry"];
            let options = entry["id"].as_str().map(|id| json!({ "clientSubmissionId": id }));
            queue_prompt(&handle, &entry["text"], options).await;
            queued += 1;
            // The next op runs after this entry is projected.
            eventually(|| (handle.cell.queue.load().len() == queued - 1).then_some(())).await;
        } else {
            let session = if step["session"] == gold["steering"]["session"] { handle.id.as_str() } else { step["session"].as_str().unwrap() };
            let want: Vec<String> = step["submissionIds"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect();
            assert_eq!(reads.queued_submission_ids(session).await, want, "{step}");
        }
    }
}
