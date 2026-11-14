//! Owner: s4-engine-actions-forms
//! Every gesture that addresses one element by ref (`ref-actions.ts`): filling and typing (`text_entry`), both kinds of
//! dropdown (`select`), checkbox state and the options a select offers (`control_state`). Each runs the same two-step contract:
//! reach the element through `host/browser/ref/call`, then report what the element actually holds afterwards. The host keeps
//! the tab graph; this keeps the gestures.
//!
//! [`RefActions`] is what one command holds to act on its page: it owns its handles, so a mutation closure can carry it. The
//! upload gestures of `ref-upload.ts` belong to the upload module.

use std::sync::Arc;
use std::time::Duration;

use mixdog_app_protocol::v2::browser_engine::BrowserHitGuard;
use mixdog_app_protocol::v2::browser_engine::BrowserInputOutcome;
use mixdog_app_protocol::v2::browser_engine::BrowserInsertTextStep;
use mixdog_app_protocol::v2::browser_engine::BrowserPointerButton;
use mixdog_app_protocol::v2::browser_engine::BrowserPointerKind;
use mixdog_app_protocol::v2::browser_engine::BrowserPointerStep;
use mixdog_app_protocol::v2::browser_engine::BrowserPressStep;
use mixdog_app_protocol::v2::browser_engine::BrowserTypeStep;
use mixdog_app_protocol::v2::browser_engine::HostBrowserInputBatchParams;
use mixdog_app_protocol::v2::browser_engine::HostBrowserSnapshotResult;
use mixdog_app_protocol::v2::browser_engine::InputStep;
use mixdog_app_protocol::v2::browser_engine::Precondition;
use mixdog_rt::CancelView;
use serde_json::Value;

use super::access::RefError;
use super::access::RefTarget;
use super::access::call_ref;
use super::access::prepare_ref;
use crate::error::HostCallError;
use crate::limits::COMMAND_TIMEOUT;
use crate::port::BrowserHost;
use crate::runner::timing_rows::CommandTimer;

/// The page-world editability check (`assets/page/editability.js`), spliced into the functions that write to an element.
pub(super) const EDITABILITY_CHECK: &str = include_str!("../../assets/page/editability.js");
/// Where the editability check goes in a page-world function written here.
pub(super) const EDITABILITY_PLACEHOLDER: &str = "__MIXDOG_EDITABILITY__";

/// The handles one command acts on its page with.
#[derive(Clone)]
pub struct RefActions {
    pub host: Arc<dyn BrowserHost>,
    pub page_id: String,
    /// What every call is decided against: a mutation is refused when the page no longer matches it.
    pub expect: Precondition,
    pub cancel: CancelView,
    /// The page's redaction (`redactBrowserText`, then the page's stored credentials): a value read back is shown through it.
    pub redact: Arc<dyn Fn(&str) -> String + Send + Sync>,
    /// Registers a secret before the page sees it, so no later reply of the session repeats it (`rememberSecret`).
    pub remember_secret: Arc<dyn Fn(&str) + Send + Sync>,
    /// The snapshot as a reply shows it, for the guidance a covered target's refusal carries.
    pub format_snapshot: Arc<dyn Fn(&HostBrowserSnapshotResult) -> String + Send + Sync>,
    /// How long a custom dropdown may take to render its options, and how often it is looked at meanwhile.
    pub dropdown_timeout: Duration,
    pub dropdown_poll: Duration,
    /// The command's timing row, which the actionability wait of a ref's point is entered on; `None` where no command keeps one.
    pub timer: Option<Arc<CommandTimer>>,
}

/// The snapshot a ref belongs to: a ref is `<snapshot id>-e<n>`.
fn snapshot_of(ref_id: &str) -> &str {
    ref_id.rfind("-e").map_or(ref_id, |at| &ref_id[..at])
}

impl RefActions {
    /// `callRef` on this page: `declaration` runs with the element as `this`.
    pub(super) async fn call(&self, ref_id: &str, declaration: &str, args: Vec<Value>) -> Result<Value, RefError> {
        let target = self.target(ref_id);
        call_ref(&*self.host, &target, declaration, args, self.cancel.token()).await
    }

    pub(super) fn target<'a>(&'a self, ref_id: &'a str) -> RefTarget<'a> {
        RefTarget { page_id: &self.page_id, snapshot_id: snapshot_of(ref_id), ref_id, expect: Some(&self.expect) }
    }

    /// `prepareRef`: the read-only preflight (the element is still in its document and, when `editable`, accepts writing).
    pub async fn prepare_ref(&self, ref_id: &str, editable: bool) -> Result<(), RefError> {
        prepare_ref(&*self.host, &self.target(ref_id), editable, self.cancel.token()).await
    }

    /// One `input/batch`: the steps run in order and the batch stops at a dialog (the reply reports it from the page's facts).
    pub(super) async fn input(&self, steps: Vec<InputStep>) -> Result<(), RefError> {
        let params = HostBrowserInputBatchParams {
            page_id: self.page_id.clone(),
            steps,
            stop_on_dialog: true,
            timeout_ms: u32::try_from(COMMAND_TIMEOUT.as_millis()).unwrap_or(u32::MAX),
            expect: self.expect.clone(),
        };
        match self.host.input_batch(params, self.cancel.token()).await?.outcome {
            BrowserInputOutcome::Completed | BrowserInputOutcome::Dialog => Ok(()),
            BrowserInputOutcome::Cancelled => Err(HostCallError::Cancelled.into()),
            BrowserInputOutcome::UserInput => Err(HostCallError::UserInput { until: None }.into()),
            BrowserInputOutcome::HitGuard => Err(RefError::Failed("the element under the pointer changed before the click; take a fresh snapshot first".into())),
        }
    }

    /// One named key (`pressKey`), for example the Enter that submits a form.
    pub async fn press_key(&self, key: &str) -> Result<(), RefError> {
        self.input(vec![press(key, &[])]).await
    }

    /// A left click at a viewport point, guarded so it lands only while `ref_id` is still what is under it.
    pub(super) async fn click_guarded(&self, ref_id: &str, x: f64, y: f64) -> Result<(), RefError> {
        let step = BrowserPointerStep {
            kind: BrowserPointerKind::Click,
            x,
            y,
            button: Some(BrowserPointerButton::Left),
            modifiers: None,
            delta_x: None,
            delta_y: None,
            to_x: None,
            to_y: None,
            hit_guard: Some(BrowserHitGuard { snapshot_id: snapshot_of(ref_id).to_string(), ref_id: ref_id.to_string() }),
        };
        self.input(vec![InputStep::Pointer(step)]).await
    }
}

/// A key press step: the key and the modifiers held with it.
pub(super) fn press(key: &str, modifiers: &[&str]) -> InputStep {
    InputStep::Press(BrowserPressStep {
        key: key.to_string(),
        modifiers: (!modifiers.is_empty()).then(|| modifiers.iter().map(|modifier| (*modifier).to_string()).collect()),
        repeat: None,
    })
}

/// Text as keystrokes, one key event per character (`typeText`).
pub(super) fn type_text(text: &str) -> InputStep {
    InputStep::Type(BrowserTypeStep { text: text.to_string(), delay_ms: None })
}

/// Text inserted at the selection as one input (CDP `Input.insertText`).
pub(super) fn insert_text(text: &str) -> InputStep {
    InputStep::InsertText(BrowserInsertTextStep { text: text.to_string() })
}

/// The `RefActions` the tests of this module tree run on a scripted host.
#[cfg(test)]
pub(crate) mod tests {
    use mixdog_rt::CancellationToken;
    use serde_json::json;

    use super::*;
    use crate::fake::Expect;
    use crate::fake::FakeHost;
    use crate::fake::page_facts;

    pub const REF: &str = "p1-s2-e3";

    pub fn actions(host: Arc<FakeHost>) -> RefActions {
        RefActions {
            host,
            page_id: "p1".into(),
            expect: Precondition { document_id: "p1:1".into(), origin: None, url: None, child_sessions: None, receiver_key: None, snapshot_id: Some("p1-s2".into()) },
            cancel: CancellationToken::new().into(),
            redact: Arc::new(|text: &str| text.replace("hunter2", "[REDACTED]")),
            remember_secret: Arc::new(|_: &str| {}),
            format_snapshot: Arc::new(|_: &HostBrowserSnapshotResult| "fresh snapshot".to_string()),
            dropdown_timeout: Duration::from_millis(30),
            dropdown_poll: Duration::from_millis(1),
            timer: None,
        }
    }

    /// A `ref/call` answer carrying `value`.
    pub fn call(value: Value) -> Expect {
        Expect::ok("host/browser/ref/call", json!({"value": value, "facts": page_facts("p1", 4)}))
    }

    /// An `input/batch` answer that completed.
    pub fn batch_done() -> Expect {
        Expect::ok(
            "host/browser/input/batch",
            json!({"outcome": "completed", "completedSteps": 1, "timing": {"inputMs": 1.0, "keyEvents": 1, "mouseEvents": 0}, "facts": page_facts("p1", 5)}),
        )
    }

    #[test]
    fn a_ref_names_its_snapshot() {
        assert_eq!(snapshot_of("p1-s2-e3"), "p1-s2");
        assert_eq!(snapshot_of("odd"), "odd");
    }

    #[tokio::test]
    async fn a_dialog_stops_the_batch_without_failing_the_gesture_and_a_hit_guard_does() {
        let dialog = Expect::ok(
            "host/browser/input/batch",
            json!({"outcome": "dialog", "completedSteps": 0, "timing": {"inputMs": 1.0, "keyEvents": 0, "mouseEvents": 0}, "facts": page_facts("p1", 5)}),
        );
        let guard = Expect::ok(
            "host/browser/input/batch",
            json!({"outcome": "hitGuard", "completedSteps": 0, "timing": {"inputMs": 1.0, "keyEvents": 0, "mouseEvents": 1}, "facts": page_facts("p1", 5)}),
        );
        let host = Arc::new(FakeHost::scripted(vec![dialog, guard]));
        let actions = actions(host.clone());
        assert_eq!(actions.press_key("Enter").await, Ok(()));
        let error = actions.click_guarded(REF, 1.0, 2.0).await.expect_err("guard");
        assert!(error.to_string().contains("changed before the click"));
        host.finish().expect("both calls");
    }

    #[tokio::test]
    async fn a_press_carries_the_key_and_its_page_and_expectation() {
        let host = Arc::new(FakeHost::scripted(vec![
            batch_done().with_params(json!({"pageId": "p1", "stopOnDialog": true, "steps": [{"op": "press", "key": "Enter"}], "expect": {"documentId": "p1:1", "snapshotId": "p1-s2"}})),
        ]));
        actions(host.clone()).press_key("Enter").await.expect("pressed");
        host.finish().expect("one call");
    }
}
