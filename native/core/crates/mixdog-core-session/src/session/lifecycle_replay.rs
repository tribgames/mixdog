//! Node's recording `fixtures/session-lifecycle/twin.json` (`record-session-lifecycle.mjs`), read when the test runs
//! and decoded with [`Exact`]: one test per recorded case. The barriers (`bumpSessionGenerationAttempt`,
//! `markSessionClosedAttempt`) are driven through the thread directory's own close and detach (`SessionClose::detach`,
//! `SessionClose::close`: the calls the delete, the context switch, the exit and the idle sweep make) over the real
//! thread store, and the whole stored record is compared before and after each step with the generation it resolved.
//! The save fence is driven through `patch_header_fenced` over the directory's `SessionThreads` (the write a late save
//! issued with its expected generation makes, as `agent_send_world.rs` does), comparing the outcome and the whole
//! stored record after it.

use std::sync::Arc;

use mixdog_core_api::ids::ThreadId;
use mixdog_testkit::exact::Exact;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::address_replay::Real;
use super::address_replay::real;
use super::close::SessionClose;

fn twin() -> Exact {
    let text = mixdog_testkit::fixture!("../../fixtures/session-lifecycle/twin.json");
    Exact::decode(&serde_json::from_str(text).expect("the recording is JSON")).expect("the recording decodes")
}

fn record(value: &Exact) -> Map<String, Value> {
    value.to_plain().expect("a plain record").as_object().cloned().expect("an object")
}

/// The thread the recorded record is: created under its id with the record as its header.
async fn stored_as(real: &Real, recorded: &Exact) -> ThreadId {
    let header = record(recorded);
    let id = ThreadId::from(header["id"].as_str().expect("the record's id"));
    real.directory.create_with_id(id.clone(), header, json!({})).await.expect("created");
    id
}

async fn stored(real: &Real, id: &ThreadId) -> Exact {
    Exact::plain(&Value::Object(real.directory.stored_header(id).await.expect("the record is stored")))
}

/// `got` equals `want` whole (field order included); a mismatch names each field that differs and the field order of both.
pub(super) fn same(got: &Exact, want: &Exact, what: &str) {
    let got = &messages_as_recorded(got, want);
    if got == want {
        return;
    }
    let cut = |v: Option<&Exact>| {
        let text = format!("{v:?}");
        if text.len() > 300 { format!("{}…{}", &text[..150], &text[text.len() - 150..]) } else { text }
    };
    let keys = |v: &Exact| v.entries().iter().map(|(k, _)| k.clone()).collect::<Vec<_>>();
    let (got_keys, want_keys) = (keys(got), keys(want));
    let mut lines = Vec::new();
    for key in want_keys.iter().chain(got_keys.iter().filter(|k| !want_keys.contains(k))) {
        if got.try_get(key) != want.try_get(key) {
            lines.push(format!("  {key}: got {} want {}", cut(got.try_get(key)), cut(want.try_get(key))));
        }
    }
    if got_keys != want_keys {
        lines.push(format!("  field order: got {got_keys:?}\n  want {want_keys:?}"));
    }
    panic!("{what} differs:\n{}", lines.join("\n"));
}

pub(super) fn close_of(real: &Real) -> SessionClose {
    let providers = Arc::new(mixdog_ai::registry::providers::ProviderRegistry::new(Arc::new(super::switch_replay::NoProviders)));
    SessionClose::new(real.directory.clone(), providers, Arc::new(super::switch_replay::NoShells), Arc::new(mixdog_tools::fs::ReadState::new(None)))
}

/// The barrier case `name`: each step's record before, the step through the directory's close or detach at the
/// recorded clock, the record after and the generation it resolved.
async fn barriers(name: &str) {
    let twin = twin();
    let case = twin.get("barriers").as_array().iter().find(|case| case.get("name").as_str() == name).cloned().unwrap_or_else(|| panic!("no barrier case {name}"));
    let steps = case.get("steps").as_array();
    let real = real().await;
    real.rig.clock.0.store(1000, std::sync::atomic::Ordering::SeqCst);
    let id = stored_as(&real, steps[0].get("before")).await;
    let close = close_of(&real);
    for (index, step) in steps.iter().enumerate() {
        same(&stored(&real, &id).await, step.get("before"), &format!("{name} step {index}: the record the step starts from"));
        real.rig.clock.0.store(step.get("clock").as_f64() as u64, std::sync::atomic::Ordering::SeqCst);
        let reason = step.get("reason").as_str();
        let done = match step.get("op").as_str() {
            "detach" => close.detach(id.as_str(), reason, step.try_get("ownerClose") == Some(&Exact::Bool(true))).await,
            _ => close.close(id.as_str(), reason).await,
        };
        assert!(done, "{name} step {index}: the barrier landed");
        let after = stored(&real, &id).await;
        same(&after, step.get("after"), &format!("{name} step {index}: the record after"));
        assert_eq!(after.get("generation"), step.get("generation"), "{name} step {index}: the generation the barrier resolved");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn barrier_detach() {
    barriers("detach").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn barrier_detach_twice() {
    barriers("detach-twice").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn barrier_owner_close() {
    barriers("owner-close").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn barrier_close() {
    barriers("close").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn barrier_detach_then_close() {
    barriers("detach-then-close").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn barrier_re_close() {
    barriers("re-close").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn barrier_cancel_close() {
    barriers("cancel-close").await;
}

/// The fence case `index` (in recorded order): the stored record, the late save's change (the fields where the late
/// record differs from it) written with the expected generation, its outcome and the whole record stored after.
async fn fence(index: usize) {
    let twin = twin();
    let case = twin.get("fence").as_array()[index].clone();
    let real = real().await;
    let id = stored_as(&real, case.get("recorded")).await;
    let (recorded, late) = (record(case.get("recorded")), record(case.get("late")));
    let change: Map<String, Value> = late.into_iter().filter(|(key, value)| recorded.get(key) != Some(value)).collect();
    let unset: Vec<String> = recorded.keys().filter(|key| !case.get("late").entries().iter().any(|(k, _)| k == *key)).cloned().collect();
    let expected = match case.try_get("expected") {
        None | Some(Exact::Undefined | Exact::Null) => None,
        Some(value) => Some(value.as_f64()),
    };
    let threads = super::thread_state::SessionThreads::new(real.directory.clone());
    let saved = super::close::patch_header_fenced(&threads, &id, expected, change, unset).await.expect("the save");
    let outcome = match saved {
        super::close::Saved::Written => "saved",
        super::close::Saved::Dropped => "dropped",
    };
    let state = case.get("state").as_str();
    assert_eq!(Exact::String(outcome.into()), *case.get("outcome"), "{state} expected {expected:?}: the outcome");
    let after = stored(&real, &id).await;
    // storedAfter is the saving process's live snapshot, which holds a dropped copy too (manifest): compared for a save that landed.
    if outcome == "saved" {
        same(&after, case.get("storedAfter"), &format!("{state} expected {expected:?}: the record after (storedAfter)"));
    }
    same(&after, case.get("durableAfter"), &format!("{state} expected {expected:?}: the record another process reads (durableAfter)"));
}

/// `record` with its `messages` field at the place `recorded` holds it (manifest: Node's live record keeps it where the
/// session was made, its loader puts it after the header fields; the thread here holds the recorded messages as a header
/// field). Every other field keeps the core's order.
pub(super) fn messages_as_recorded(record: &Exact, recorded: &Exact) -> Exact {
    let (messages, mut fields): (Vec<_>, Vec<_>) = record.entries().iter().cloned().partition(|(key, _)| key == "messages");
    let at = recorded.entries().iter().position(|(key, _)| key == "messages").unwrap_or(fields.len()).min(fields.len());
    for (offset, field) in messages.into_iter().enumerate() {
        fields.insert(at + offset, field);
    }
    Exact::Object(fields)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fence_open_fresh_unguarded() {
    fence(0).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fence_open_fresh_expected_0() {
    fence(1).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fence_open_fresh_expected_1() {
    fence(2).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fence_open_fresh_expected_2() {
    fence(3).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fence_detached_once_unguarded() {
    fence(4).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fence_detached_once_expected_0() {
    fence(5).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fence_detached_once_expected_1() {
    fence(6).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fence_detached_once_expected_2() {
    fence(7).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fence_detached_twice_unguarded() {
    fence(8).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fence_detached_twice_expected_0() {
    fence(9).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fence_detached_twice_expected_1() {
    fence(10).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fence_detached_twice_expected_2() {
    fence(11).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fence_closed_unguarded() {
    fence(12).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fence_closed_expected_0() {
    fence(13).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fence_closed_expected_1() {
    fence(14).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fence_closed_expected_2() {
    fence(15).await;
}
