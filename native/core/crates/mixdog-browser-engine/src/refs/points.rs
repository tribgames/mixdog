//! Owner: s4-engine-target-points
//! Where a gesture actually lands (`ref-points.ts`). A ref becomes a point only after the page confirms the element is on
//! top of it, and refuses rather than guesses, because a wrong point clicks the wrong thing.
//!
//! The point is in the viewport of the realm the ref lives in: the page-world probe adds the offset of every same-origin
//! frame itself. An input that must land through a cross-origin frame names the ref instead (`BrowserHitGuard` of
//! `host/browser/input/batch`), and the host places it.
//!
//! Each call is one probe. The wait that repeats a probe while the element is covered, moving or hidden belongs to the settle
//! module (`settle::actionability`) and hands its last refusal to [`with_covered_guidance`].

use mixdog_app_protocol::v2::browser_engine::BrowserSnapshotMode;
use mixdog_app_protocol::v2::browser_engine::HostBrowserSnapshotParams;
use mixdog_app_protocol::v2::browser_engine::HostBrowserSnapshotResult;
use mixdog_rt::CancellationToken;

use super::access::ActionabilityReason;
use super::access::RefError;
use super::access::RefTarget;
use super::access::call_ref;
use super::probes::Point;
use super::probes::Rect;
use super::probes::point_from_report;
use super::probes::rect_from_report;
use super::probes::ref_point_declaration;
use super::probes::ref_rect_declaration;
use crate::error::HostCallError;
use crate::limits::SNAPSHOT_TOOL_MAX_ELEMENTS;
use crate::port::BrowserHost;

/// `resolveRefPoint` for one attempt: the hit-tested point of the ref, or the reason it has none.
pub async fn ref_point(host: &dyn BrowserHost, target: &RefTarget<'_>, cancel: &CancellationToken) -> Result<Point, RefError> {
    let report = call_ref(host, target, &ref_point_declaration(), Vec::new(), cancel).await?;
    point_from_report(target.ref_id, report)
}

/// `resolveRefRect` for one attempt: the box a ref occupies, for a screenshot crop rather than a gesture. A picture
/// dispatches nothing, so no hit test guards it.
pub async fn ref_rect(host: &dyn BrowserHost, target: &RefTarget<'_>, cancel: &CancellationToken) -> Result<Rect, RefError> {
    let report = call_ref(host, target, &ref_rect_declaration(), Vec::new(), cancel).await?;
    rect_from_report(target.ref_id, report)
}

/// What a covered ref's refusal says once the wait is over.
fn covered_message(base: &str, snapshot_text: Option<&str>) -> String {
    format!(
        "{base} Dismiss or scroll past the blocker, or act on a different element; an overlay is rarely named in the fresh snapshot below.\n\n{}",
        snapshot_text.unwrap_or("A fresh snapshot could not be captured.")
    )
}

/// A covered ref that did not clear: the refusal carries a fresh snapshot, formatted by `format`, so the blocker can be
/// dismissed by ref. Capturing guidance only after the wait expired matters: capturing during each probe would retire the
/// ref the wait is still trying to click. A snapshot that cannot be taken is said so; a cancel ends it as a cancel. Every
/// other error comes back unchanged.
pub async fn with_covered_guidance(
    host: &dyn BrowserHost,
    page_id: &str,
    error: RefError,
    format: &(dyn Fn(&HostBrowserSnapshotResult) -> String + Sync),
    cancel: &CancellationToken,
) -> RefError {
    let RefError::Refused { reason: ActionabilityReason::Covered, message } = &error else { return error };
    let params = HostBrowserSnapshotParams {
        page_id: page_id.to_string(),
        mode: BrowserSnapshotMode::Full,
        query: None,
        max_elements: u32::try_from(SNAPSHOT_TOOL_MAX_ELEMENTS).ok(),
        text_chars: None,
        frame: None,
    };
    match host.snapshot(params, cancel).await {
        Ok(fresh) => RefError::Failed(covered_message(message, Some(&format(&fresh)))),
        Err(HostCallError::Cancelled) => RefError::Host(HostCallError::Cancelled),
        Err(_) => RefError::Failed(covered_message(message, None)),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;
    use serde_json::json;

    use super::*;
    use crate::fake::Expect;
    use crate::fake::FakeHost;
    use crate::fake::page_facts;
    use crate::refs::ref_set::tests::element;
    use crate::refs::ref_set::tests::payload;

    fn target() -> RefTarget<'static> {
        RefTarget { page_id: "p1", snapshot_id: "p1-s2", ref_id: "p1-s2-e1", expect: None }
    }

    fn call(value: Value) -> Expect {
        Expect::ok("host/browser/ref/call", json!({"value": value, "facts": page_facts("p1", 4)}))
    }

    #[tokio::test]
    async fn a_point_is_probed_on_the_ref_through_one_call() {
        let host = FakeHost::scripted(vec![call(json!({"x": 40, "y": 22.5, "via": "control"})).with_params(json!({"pageId": "p1", "snapshotId": "p1-s2", "ref": "p1-s2-e1"}))]);
        assert_eq!(ref_point(&host, &target(), &CancellationToken::new()).await, Ok(Point { x: 40.0, y: 22.5 }));
        let calls = host.calls();
        let declaration = calls[0].params["functionDeclaration"].as_str().expect("a declaration");
        assert!(declaration.contains("elementFromPoint") && !declaration.contains("__MIXDOG_"));
        host.finish().expect("one call");
    }

    #[tokio::test]
    async fn a_covered_or_moving_point_is_refused_with_its_reason() {
        let host = FakeHost::scripted(vec![call(json!({"error": "covered", "covering": "div \"x\""})), call(json!({"error": "moving"}))]);
        let cancel = CancellationToken::new();
        assert_eq!(ref_point(&host, &target(), &cancel).await.expect_err("covered").reason(), Some(ActionabilityReason::Covered));
        assert_eq!(ref_point(&host, &target(), &cancel).await.expect_err("moving").reason(), Some(ActionabilityReason::Moving));
    }

    #[tokio::test]
    async fn a_rect_is_measured_without_a_hit_test() {
        let host = FakeHost::scripted(vec![call(json!({"x": 210, "y": 120, "width": 80, "height": 24}))]);
        assert_eq!(ref_rect(&host, &target(), &CancellationToken::new()).await, Ok(Rect { x: 210.0, y: 120.0, width: 80.0, height: 24.0 }));
        let calls = host.calls();
        let declaration = calls[0].params["functionDeclaration"].as_str().expect("a declaration");
        assert!(!declaration.contains("elementFromPoint"));
    }

    #[tokio::test]
    async fn a_host_failure_is_passed_through() {
        let host = FakeHost::scripted(vec![Expect::err("host/browser/ref/call", HostCallError::StaleSnapshot)]);
        assert_eq!(ref_point(&host, &target(), &CancellationToken::new()).await, Err(RefError::Host(HostCallError::StaleSnapshot)));
    }

    fn snapshot_answer() -> Expect {
        let payload = payload("p1-s3", vec![element("p1-s3-e1", "button", "Close")], "https://a.test/");
        Expect::ok(
            "host/browser/snapshot",
            json!({"snapshotId": "p1-s3", "documentId": "p1:1", "revision": 1, "payload": payload, "warnings": [], "facts": page_facts("p1", 5)}),
        )
    }

    #[tokio::test]
    async fn a_covered_refusal_carries_a_fresh_snapshot() {
        let host = FakeHost::scripted(vec![snapshot_answer().with_params(json!({"pageId": "p1", "mode": "full", "maxElements": 500}))]);
        let covered = RefError::Refused { reason: ActionabilityReason::Covered, message: "ref r is covered by div; input was not dispatched.".into() };
        let format = |fresh: &HostBrowserSnapshotResult| format!("snapshot {}", fresh.snapshot_id);
        let error = with_covered_guidance(&host, "p1", covered, &format, &CancellationToken::new()).await;
        assert_eq!(
            error,
            RefError::Failed(
                "ref r is covered by div; input was not dispatched. Dismiss or scroll past the blocker, or act on a different element; an overlay is rarely named in the fresh snapshot below.\n\nsnapshot p1-s3".into()
            )
        );
        host.finish().expect("one snapshot");
    }

    #[tokio::test]
    async fn a_snapshot_that_cannot_be_taken_is_said_so_and_other_refusals_are_untouched() {
        let host = FakeHost::scripted(vec![Expect::err("host/browser/snapshot", HostCallError::Failed { message: "boom".into() })]);
        let covered = RefError::Refused { reason: ActionabilityReason::Covered, message: "covered.".into() };
        let format = |_: &HostBrowserSnapshotResult| String::new();
        let error = with_covered_guidance(&host, "p1", covered, &format, &CancellationToken::new()).await;
        assert!(error.to_string().ends_with("A fresh snapshot could not be captured."), "{error}");
        let moving = RefError::Refused { reason: ActionabilityReason::Moving, message: "moving".into() };
        assert_eq!(with_covered_guidance(&host, "p1", moving.clone(), &format, &CancellationToken::new()).await, moving);
        host.finish().expect("one snapshot call, none for the moving ref");
    }

    #[tokio::test]
    async fn a_cancel_while_taking_the_snapshot_is_a_cancel() {
        let host = FakeHost::scripted(Vec::new());
        let cancel = CancellationToken::new();
        cancel.cancel();
        let covered = RefError::Refused { reason: ActionabilityReason::Covered, message: "covered.".into() };
        let format = |_: &HostBrowserSnapshotResult| String::new();
        assert_eq!(with_covered_guidance(&host, "p1", covered, &format, &cancel).await, RefError::Host(HostCallError::Cancelled));
    }
}
