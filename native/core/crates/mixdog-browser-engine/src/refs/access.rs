//! Owner: s4-engine-target-points
//! One realm-preserving path to an observed element (`ref-access.ts`): a function is called on the element a snapshot ref
//! names through `host/browser/ref/call`, which resolves the node in the session that minted the ref (an accessibility ref or
//! a page-side DOM ref alike) and returns the page's own exception as data. A ref whose element left the document is stale.
//!
//! Every call here is one attempt. The repeat of a read-only preflight that waits out a temporary refusal belongs to the
//! settle module (`settle::actionability`); a refusal that wait recognises is [`RefError::Refused`] with its
//! [`ActionabilityReason`].

use std::fmt;

use mixdog_app_protocol::v2::browser_engine::HostBrowserRefCallParams;
use mixdog_app_protocol::v2::browser_engine::Precondition;
use mixdog_rt::CancellationToken;
use serde_json::Value;

use crate::error::HostCallError;
use crate::port::BrowserHost;

/// The page-world editability check (`assets/page/editability.js`): a function of the element that answers why it cannot
/// be written to (`"stale"` for a detached node), else nothing.
const EDITABILITY_CHECK: &str = include_str!("../../assets/page/editability.js");

/// Why an element is not ready for a gesture yet (`BrowserActionabilityError.reason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionabilityReason {
    Covered,
    Hidden,
    Disabled,
    Moving,
    NotEditable,
    /// A target that named no element (yet).
    Missing,
}

impl ActionabilityReason {
    /// The word the TypeScript engine used.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Covered => "covered",
            Self::Hidden => "hidden",
            Self::Disabled => "disabled",
            Self::Moving => "moving",
            Self::NotEditable => "not-editable",
            Self::Missing => "missing",
        }
    }
}

/// Why an operation on a ref did not produce its result.
#[derive(Debug, Clone, PartialEq)]
pub enum RefError {
    /// The host call itself failed (a stale snapshot, a gone page, a dialog, the person at the page, a cancel).
    Host(HostCallError),
    /// The element is not ready: the reason says whether waiting can help.
    Refused { reason: ActionabilityReason, message: String },
    /// Anything else: a stale ref, a page-side exception, a refusal no wait changes.
    Failed(String),
}

impl RefError {
    /// The reason of a refusal a wait can outlast; `None` for every other failure.
    pub fn reason(&self) -> Option<ActionabilityReason> {
        match self {
            Self::Refused { reason, .. } => Some(*reason),
            _ => None,
        }
    }
}

impl fmt::Display for RefError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Host(error) => fmt::Display::fmt(error, out),
            Self::Refused { message, .. } | Self::Failed(message) => out.write_str(message),
        }
    }
}

impl std::error::Error for RefError {}

impl From<HostCallError> for RefError {
    fn from(error: HostCallError) -> Self {
        Self::Host(error)
    }
}

/// The element a snapshot ref names, with what every call on it is guarded by.
#[derive(Debug, Clone, Copy)]
pub struct RefTarget<'a> {
    pub page_id: &'a str,
    pub snapshot_id: &'a str,
    pub ref_id: &'a str,
    /// The document, URL and snapshot the call was decided against, when the caller holds them.
    pub expect: Option<&'a Precondition>,
}

/// The refusal of a ref the page no longer lists.
pub fn stale_ref_message(ref_id: &str) -> String {
    format!("ref {ref_id} is stale or unknown; take a fresh snapshot first")
}

/// A ref operation reports its page-side refusal as `error`; only staleness names the ref, because only staleness is
/// answered by a fresh snapshot (`checkedBrowserRefResult`).
pub fn checked_ref_result(result: Value, ref_id: &str) -> Result<Value, RefError> {
    match result.get("error").and_then(Value::as_str) {
        Some("stale") => Err(RefError::Failed(stale_ref_message(ref_id))),
        Some(error) if !error.is_empty() => Err(RefError::Failed(error.to_string())),
        _ => Ok(result),
    }
}

/// `callRef`: `declaration` (a function expression) runs with the element as `this` and `args`; its value comes back, a
/// function that returns nothing answers `null`, and a page-side exception is a [`RefError::Failed`].
pub async fn call_ref(host: &dyn BrowserHost, target: &RefTarget<'_>, declaration: &str, args: Vec<Value>, cancel: &CancellationToken) -> Result<Value, RefError> {
    let params = HostBrowserRefCallParams {
        page_id: target.page_id.to_string(),
        snapshot_id: target.snapshot_id.to_string(),
        ref_id: target.ref_id.to_string(),
        function_declaration: declaration.to_string(),
        args: Some(args),
        return_by_value: Some(true),
        timeout_ms: None,
        expect: target.expect.cloned(),
    };
    let result = host.ref_call(params, cancel).await?;
    if let Some(exception) = result.exception {
        return Err(RefError::Failed(exception.text));
    }
    Ok(result.value.unwrap_or(Value::Null))
}

fn detached_message(ref_id: &str) -> String {
    format!("ref {ref_id} is stale or detached; take a fresh snapshot")
}

/// `prepareRef`: the read-only preflight that may be repeated to recover a stale ref. The element must still be in its
/// document, and when `editable` it must accept writing: a reason the page gives is a [`ActionabilityReason::NotEditable`]
/// refusal (the caller's wait may repeat it), a detached node a plain failure.
pub async fn prepare_ref(host: &dyn BrowserHost, target: &RefTarget<'_>, editable: bool, cancel: &CancellationToken) -> Result<(), RefError> {
    let connected = call_ref(host, target, "function() { return Boolean(this && this.isConnected); }", Vec::new(), cancel).await?;
    if connected != Value::Bool(true) {
        return Err(RefError::Failed(detached_message(target.ref_id)));
    }
    if editable {
        let declaration = format!("function() {{ return ({EDITABILITY_CHECK})(this); }}");
        match call_ref(host, target, &declaration, Vec::new(), cancel).await? {
            Value::String(error) if error == "stale" => return Err(RefError::Failed(detached_message(target.ref_id))),
            Value::String(error) if !error.is_empty() => return Err(RefError::Refused { reason: ActionabilityReason::NotEditable, message: error }),
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::fake::Expect;
    use crate::fake::FakeHost;
    use crate::fake::page_facts;

    fn target() -> RefTarget<'static> {
        RefTarget { page_id: "p1", snapshot_id: "p1-s2", ref_id: "p1-s2-e3", expect: None }
    }

    fn answer(value: Value) -> Expect {
        Expect::ok("host/browser/ref/call", json!({"value": value, "facts": page_facts("p1", 4)}))
    }

    #[tokio::test]
    async fn a_call_carries_the_ref_the_function_and_its_arguments() {
        let host = FakeHost::scripted(vec![answer(json!(7)).with_params(json!({
            "pageId": "p1", "snapshotId": "p1-s2", "ref": "p1-s2-e3", "functionDeclaration": "function(a) { return a; }", "args": [7], "returnByValue": true
        }))]);
        let value = call_ref(&host, &target(), "function(a) { return a; }", vec![json!(7)], &CancellationToken::new()).await;
        assert_eq!(value, Ok(json!(7)));
        host.finish().expect("one call");
    }

    #[tokio::test]
    async fn an_exception_is_a_failure_and_a_missing_value_is_null() {
        let host = FakeHost::scripted(vec![
            Expect::ok("host/browser/ref/call", json!({"exception": {"text": "boom"}, "facts": page_facts("p1", 4)})),
            Expect::ok("host/browser/ref/call", json!({"facts": page_facts("p1", 4)})),
            Expect::err("host/browser/ref/call", HostCallError::StaleSnapshot),
        ]);
        let cancel = CancellationToken::new();
        assert_eq!(call_ref(&host, &target(), "function() {}", Vec::new(), &cancel).await, Err(RefError::Failed("boom".into())));
        assert_eq!(call_ref(&host, &target(), "function() {}", Vec::new(), &cancel).await, Ok(Value::Null));
        assert_eq!(call_ref(&host, &target(), "function() {}", Vec::new(), &cancel).await, Err(RefError::Host(HostCallError::StaleSnapshot)));
    }

    #[test]
    fn only_staleness_names_the_ref() {
        assert_eq!(checked_ref_result(json!({"ok": true}), "r"), Ok(json!({"ok": true})));
        assert_eq!(checked_ref_result(json!({"error": ""}), "r"), Ok(json!({"error": ""})));
        assert_eq!(checked_ref_result(json!({"error": "stale"}), "r"), Err(RefError::Failed("ref r is stale or unknown; take a fresh snapshot first".into())));
        assert_eq!(checked_ref_result(json!({"error": "not a select"}), "r"), Err(RefError::Failed("not a select".into())));
        assert_eq!(checked_ref_result(Value::Null, "r"), Ok(Value::Null));
    }

    #[tokio::test]
    async fn a_detached_element_fails_the_preflight() {
        let host = FakeHost::scripted(vec![answer(json!(false))]);
        let error = prepare_ref(&host, &target(), false, &CancellationToken::new()).await.expect_err("detached");
        assert_eq!(error, RefError::Failed("ref p1-s2-e3 is stale or detached; take a fresh snapshot".into()));
        assert_eq!(error.reason(), None);
    }

    #[tokio::test]
    async fn an_editable_preflight_reports_why_the_element_cannot_be_written() {
        let cancel = CancellationToken::new();
        let ready = FakeHost::scripted(vec![answer(json!(true)), answer(Value::Null)]);
        assert_eq!(prepare_ref(&ready, &target(), true, &cancel).await, Ok(()));
        let readonly = FakeHost::scripted(vec![answer(json!(true)), answer(json!("element is readonly"))]);
        let error = prepare_ref(&readonly, &target(), true, &cancel).await.expect_err("read-only");
        assert_eq!(error.reason(), Some(ActionabilityReason::NotEditable));
        assert_eq!(error.to_string(), "element is readonly");
        let gone = FakeHost::scripted(vec![answer(json!(true)), answer(json!("stale"))]);
        let error = prepare_ref(&gone, &target(), true, &cancel).await.expect_err("detached");
        assert_eq!(error.reason(), None);
        let plain = FakeHost::scripted(vec![answer(json!(true))]);
        assert_eq!(prepare_ref(&plain, &target(), false, &cancel).await, Ok(()), "no editability call when not asked");
        plain.finish().expect("one call");
    }

    #[test]
    fn the_reasons_keep_their_words() {
        assert_eq!(
            [
                ActionabilityReason::Covered,
                ActionabilityReason::Hidden,
                ActionabilityReason::Disabled,
                ActionabilityReason::Moving,
                ActionabilityReason::NotEditable,
                ActionabilityReason::Missing
            ]
            .map(ActionabilityReason::as_str),
            ["covered", "hidden", "disabled", "moving", "not-editable", "missing"]
        );
    }
}
