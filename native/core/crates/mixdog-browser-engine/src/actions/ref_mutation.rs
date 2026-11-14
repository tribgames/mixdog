//! Owner: s4-engine-actions-pointer
//! A mutation of the element a ref names (`actions/ref-mutation.ts`). Recovery owns only the read-only preflight, never the gesture
//! or its verification: a stale ref is found again once, before anything is dispatched, and a failure after the operation started is
//! never retried, because the input may already have executed and a replay could act twice.

use std::future::Future;

use mixdog_rt::CancelView;

use crate::error::HostCallError;
use crate::port::BrowserHost;
use crate::refs::access::RefError;
use crate::refs::access::RefTarget;
use crate::refs::access::prepare_ref;
use crate::refs::reply_recovery::with_ref_recovery;
use crate::settle::actionability::ACTIONABILITY_TIMEOUT;
use crate::settle::actionability::ActionabilityError;
use crate::settle::actionability::ActionableError;
use crate::settle::actionability::ProbeFailure;
use crate::settle::actionability::wait_for_actionable;
use crate::settle::settle::throw_if_cancelled;

use super::target::ActionContext;
use super::target::ActionError;
use super::target::ActionPage;
use super::target::expect_for;
use super::target::snapshot_of_ref;

/// What a failure after dispatch tells the agent.
const NOT_REPLAYED: &str = "input may have executed and was not replayed; take a fresh snapshot before continuing";

/// The read-only preflight of one ref: the element is still in its document and, when `editable`, accepts writing. A refusal the
/// page may outlast (a field that is not editable yet) is waited for; a detached element is not.
async fn prepare(host: &dyn BrowserHost, page: &dyn ActionPage, cancel: &CancelView, ref_id: String, editable: bool) -> Result<String, HostCallError> {
    let page_id = page.facts().page_id;
    let expect = expect_for(page, Some(&ref_id));
    let target = RefTarget { page_id: &page_id, snapshot_id: snapshot_of_ref(&ref_id), ref_id: &ref_id, expect: Some(&expect) };
    let target_ref = &target;
    let waited = wait_for_actionable(
        move || async move {
            prepare_ref(host, target_ref, editable, cancel.token()).await.map_err(|error| match error {
                RefError::Refused { reason, message } => ProbeFailure::NotActionable(ActionabilityError::new(message, reason.as_str())),
                other => ProbeFailure::Other(other),
            })
        },
        cancel,
        ACTIONABILITY_TIMEOUT,
    )
    .await;
    match waited {
        Ok(()) => Ok(ref_id),
        Err(ActionableError::Cancelled(_)) => Err(HostCallError::Cancelled),
        Err(ActionableError::NotActionable(blocker)) => Err(HostCallError::Failed { message: blocker.message }),
        Err(ActionableError::Failed(RefError::Host(error))) => Err(error),
        Err(ActionableError::Failed(RefError::Refused { message, .. } | RefError::Failed(message))) => Err(HostCallError::Failed { message }),
    }
}

/// `mutateRef`: the preflight of `source_ref` runs under stale-ref recovery (a swapped ref is noted in the reply), then `operation`
/// runs once on the ref that came out of it. Whatever fails inside `operation` leaves the page unobserved (what the last observation
/// said no longer holds) and says the input may have executed; it never re-enters recovery.
pub async fn mutate_ref<T, F, Fut>(cx: &mut ActionContext<'_>, source_ref: &str, editable: bool, operation: F) -> Result<T, ActionError>
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = Result<T, RefError>>,
{
    let (host, page, cancel) = (cx.host, cx.page, cx.cancel);
    let ref_id = with_ref_recovery(page.recovery_host(), cx.recovery, source_ref, |candidate| prepare(host, page, cancel, candidate, editable)).await?;
    throw_if_cancelled(cancel)?;
    match operation(ref_id).await {
        Ok(value) => Ok(value),
        Err(RefError::Host(HostCallError::Cancelled)) => Err(ActionError::Host(HostCallError::Cancelled)),
        Err(error) => {
            page.invalidate_interaction();
            Err(ActionError::Failed(format!("{error}; {NOT_REPLAYED}")))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use serde_json::Value;
    use serde_json::json;

    use super::super::target::testing::Rig;
    use super::super::target::testing::TestPage;
    use super::*;
    use crate::fake::Expect;
    use crate::fake::FakeHost;
    use crate::fake::page_facts;
    use crate::refs::ref_set::RefSet;
    use crate::refs::ref_set::tests::element;
    use crate::refs::ref_set::tests::payload;

    const URL: &str = "https://a.test/";

    fn set(snapshot_id: &str) -> RefSet {
        RefSet::from_payload(snapshot_id, &payload(snapshot_id, vec![element(&format!("{snapshot_id}-e1"), "checkbox", "Fixture")], URL))
    }

    fn connected() -> Expect {
        Expect::ok("host/browser/ref/call", json!({"value": true, "facts": page_facts("p1", 2)}))
    }

    fn stale() -> Expect {
        Expect::ok("host/browser/ref/call", json!({"exception": {"text": "Node with given id not found"}, "facts": page_facts("p1", 2)}))
    }

    fn page_with_snapshots() -> TestPage {
        TestPage::with(|state| {
            state.ref_set = Some(set("p1-s1"));
            state.fresh = Some(set("p1-s2"));
        })
    }

    #[tokio::test]
    async fn a_ref_that_went_stale_before_input_is_found_again_and_the_input_runs_once() {
        let host = FakeHost::scripted(vec![stale().with_params(json!({"snapshotId": "p1-s1", "ref": "p1-s1-e1"})), connected().with_params(json!({"snapshotId": "p1-s2", "ref": "p1-s2-e1"}))]);
        let page = page_with_snapshots();
        let mut rig = Rig::new(Some(set("p1-s1")));
        let command = Value::Null;
        let mut cx = ActionContext { host: &host, page: &page, command: &command, cancel: &rig.source.view(), recovery: &mut rig.recovery, effect_baseline: &mut rig.baseline };
        let ran = AtomicUsize::new(0);
        let seen = mutate_ref(&mut cx, "p1-s1-e1", false, |ref_id| async {
            ran.fetch_add(1, Ordering::SeqCst);
            Ok(ref_id)
        })
        .await;
        assert_eq!(seen, Ok("p1-s2-e1".to_string()));
        assert_eq!(ran.load(Ordering::SeqCst), 1);
        assert_eq!(rig.recovery.notes, ["p1-s1-e1 -> p1-s2-e1".to_string()]);
        assert_eq!(page.get(|state| state.fresh_snapshots), 1);
        host.finish().expect("two preflight calls");
    }

    #[tokio::test]
    async fn a_failure_after_the_input_started_is_not_recovered_or_replayed() {
        let host = FakeHost::scripted(vec![connected()]);
        let page = page_with_snapshots();
        let mut rig = Rig::new(Some(set("p1-s1")));
        let command = Value::Null;
        let mut cx = ActionContext { host: &host, page: &page, command: &command, cancel: &rig.source.view(), recovery: &mut rig.recovery, effect_baseline: &mut rig.baseline };
        let attempts = AtomicUsize::new(0);
        let outcome: Result<(), ActionError> = mutate_ref(&mut cx, "p1-s1-e1", false, |_| async {
            attempts.fetch_add(1, Ordering::SeqCst);
            Err(RefError::Failed("node detached after input".into()))
        })
        .await;
        let message = outcome.expect_err("failed").to_string();
        assert_eq!(message, "node detached after input; input may have executed and was not replayed; take a fresh snapshot before continuing");
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        assert_eq!(page.get(|state| (state.fresh_snapshots, state.invalidated, state.ref_set.is_none())), (0, 1, true), "no observation, the old one retired");
        host.finish().expect("one preflight call");
    }

    #[tokio::test]
    async fn a_ref_that_is_not_from_the_latest_snapshot_is_refused_before_any_call() {
        let host = FakeHost::scripted(Vec::new());
        let page = TestPage::new();
        let mut rig = Rig::new(Some(set("p1-s1")));
        let command = Value::Null;
        let mut cx = ActionContext { host: &host, page: &page, command: &command, cancel: &rig.source.view(), recovery: &mut rig.recovery, effect_baseline: &mut rig.baseline };
        let outcome: Result<(), ActionError> = mutate_ref(&mut cx, "p9-s1-e1", false, |_| async { Ok(()) }).await;
        assert_eq!(outcome.expect_err("unknown").to_string(), "ref p9-s1-e1 is not from the latest snapshot; take a fresh snapshot first");
        host.finish().expect("no host call");
    }

    #[tokio::test]
    async fn a_cancelled_command_dispatches_nothing() {
        let host = FakeHost::scripted(Vec::new());
        let page = TestPage::new();
        let mut rig = Rig::new(Some(set("p1-s1")));
        let command = Value::Null;
        let view = rig.source.view();
        rig.source.cancel("stopped by the caller");
        let mut cx = ActionContext { host: &host, page: &page, command: &command, cancel: &view, recovery: &mut rig.recovery, effect_baseline: &mut rig.baseline };
        let ran = AtomicUsize::new(0);
        let outcome: Result<(), ActionError> = mutate_ref(&mut cx, "p1-s1-e1", false, |_| async {
            ran.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .await;
        assert!(outcome.is_err());
        assert_eq!(ran.load(Ordering::SeqCst), 0);
        host.finish().expect("no host call");
    }
}
