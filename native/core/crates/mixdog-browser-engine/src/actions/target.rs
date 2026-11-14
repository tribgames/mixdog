//! Owner: s4-engine-actions-pointer
//! How a pointer handler gets what it works on (`actions/target.ts`, `actions/types.ts` and `ref-points.ts` of the desktop engine): the
//! context every handler runs in, the ref a handler acts on (the caller's own, or one resolved right now from a snapshot-free
//! `target`), both ends of a drag, and a screenshot coordinate bound to the visual snapshot it was read from.
//!
//! Resolution takes a fresh observation, so recovery and the effect baseline move to it ([`adopt_resolved_targets`]). Everything the
//! engine keeps per page that a handler reads or writes (the latest ref set, the visual grounding, the interaction generation) is
//! behind [`ActionPage`], which the command runner implements over its page state; the host calls themselves go through
//! [`BrowserHost`], so a handler produces `host/browser/*` requests and never touches a page directly.

use std::fmt;
use std::time::Instant;

use async_trait::async_trait;
use mixdog_app_protocol::v2::browser_engine::BrowserHitGuard;
use mixdog_app_protocol::v2::browser_engine::BrowserInputTiming;
use mixdog_app_protocol::v2::browser_engine::HostBrowserPageEvalParams;
use mixdog_app_protocol::v2::browser_engine::HostBrowserSnapshotResult;
use mixdog_app_protocol::v2::browser_engine::PageFacts;
use mixdog_app_protocol::v2::browser_engine::Precondition;
use mixdog_browser_policy::timing::Phase;
use mixdog_js::to_number_of;
use mixdog_js::value_to_string;
use mixdog_rt::CancelView;
use mixdog_rt::CancellationToken;
use serde::Deserialize;
use serde_json::Value;

use crate::error::HostCallError;
use crate::limits::CDP_REQUEST_TIMEOUT;
use crate::port::BrowserHost;
use crate::refs::access::ActionabilityReason;
use crate::refs::access::RefError;
use crate::refs::grounding::GroundingRefused;
use crate::refs::grounding::VisualGrounding;
use crate::refs::probes::Point;
use crate::refs::ref_set::RefSet;
use crate::refs::reply_recovery::RecoveryFailure;
use crate::refs::reply_recovery::RecoveryHost;
use crate::refs::reply_recovery::RefRecoveryContext;
use crate::refs::target_resolve::ResolvedTarget;
use crate::refs::target_resolve::TargetContext;
use crate::refs::target_resolve::TargetError;
use crate::refs::target_resolve::resolve_targets;
use crate::runner::timing_rows::CommandTimer;
use crate::runner::timing_rows::timed;
use crate::settle::actionability::ACTIONABILITY_TIMEOUT;
use crate::settle::actionability::ActionabilityError;
use crate::settle::actionability::ActionableError;
use crate::settle::actionability::ProbeFailure;
use crate::settle::actionability::wait_for_actionable;
use crate::settle::settle::Cancelled;

/// Why a handler did not produce its output. The runner turns it into the tool's error, a cancelled command or a blocked reply.
#[derive(Debug, Clone, PartialEq)]
pub enum ActionError {
    /// The command's own cancellation.
    Cancelled(Cancelled),
    /// A host call failed in a way the runner knows (a gone page, the person at the page, a dialog, a cancel).
    Host(HostCallError),
    /// A refusal or failure the agent reads, as the text says it.
    Failed(String),
}

impl fmt::Display for ActionError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled(cancelled) => fmt::Display::fmt(cancelled, out),
            Self::Host(error) => fmt::Display::fmt(error, out),
            Self::Failed(message) => out.write_str(message),
        }
    }
}

impl std::error::Error for ActionError {}

impl From<HostCallError> for ActionError {
    fn from(error: HostCallError) -> Self {
        Self::Host(error)
    }
}

impl From<Cancelled> for ActionError {
    fn from(cancelled: Cancelled) -> Self {
        Self::Cancelled(cancelled)
    }
}

impl From<RefError> for ActionError {
    fn from(error: RefError) -> Self {
        match error {
            RefError::Host(error) => Self::Host(error),
            RefError::Refused { message, .. } | RefError::Failed(message) => Self::Failed(message),
        }
    }
}

impl From<TargetError> for ActionError {
    fn from(error: TargetError) -> Self {
        match error {
            TargetError::Host(error) => Self::Host(error),
            other => Self::Failed(other.to_string()),
        }
    }
}

impl From<RecoveryFailure> for ActionError {
    fn from(error: RecoveryFailure) -> Self {
        match error {
            RecoveryFailure::Host(error) => Self::Host(error),
            RecoveryFailure::Message(message) => Self::Failed(message),
        }
    }
}

impl<E: Into<ActionError>> From<ActionableError<E>> for ActionError {
    fn from(error: ActionableError<E>) -> Self {
        match error {
            ActionableError::Cancelled(cancelled) => Self::Cancelled(cancelled),
            ActionableError::NotActionable(blocker) => Self::Failed(blocker.message),
            ActionableError::Failed(error) => error.into(),
        }
    }
}

/// What the engine keeps of the page a handler works on. The runner implements it over the page's state and the lane's facts; every
/// method answers from what the engine already holds, none calls the host.
#[async_trait]
pub trait ActionPage: Send + Sync {
    /// What a stale-ref recovery reads of the page (`with_ref_recovery`).
    fn recovery_host(&self) -> &dyn RecoveryHost;
    /// The page's latest facts.
    fn facts(&self) -> PageFacts;
    /// The state a mutating call is decided against: the page's document, URL, origin and frames, and the snapshot of its latest ref set.
    fn precondition(&self) -> Precondition;
    /// The page's latest ref set.
    fn ref_set(&self) -> Option<RefSet>;
    /// Makes `set` the page's latest ref set again (a sequence keeps the caller's refs across its steps).
    fn restore_ref_set(&self, set: RefSet);
    /// The ref set of the snapshot a target resolution just took (`resolve_targets` observes through the host, so only the runner,
    /// which sees every snapshot result of the page, can name it), stored as the page's latest; `None` when it is not known.
    fn adopt_snapshot(&self, snapshot_id: &str) -> Option<RefSet>;
    /// A gesture is about to change the page: what the last observation said about it is no longer current (`invalidateInteraction`).
    fn invalidate_interaction(&self);
    /// A scroll the agent asked for happened (`documents.recordScroll`): the change judgement counts it.
    fn record_scroll(&self);
    /// The screenshot a coordinate action is expressed in.
    fn visual_grounding(&self) -> Option<VisualGrounding>;
    /// The grounding no longer describes the page.
    fn drop_visual_grounding(&self);
    /// The document revision of the page now (the DOM-change counter the grounding was stamped with); `None` when it cannot be asked.
    async fn document_revision(&self, cancel: &CancellationToken) -> Option<u32>;
    /// The page report of a snapshot, for the refusal of a covered element (`formatSnapshot` with the page's diagnostics).
    fn format_snapshot(&self, snapshot: &HostBrowserSnapshotResult) -> String;
    /// The timing row of the command running on the page: its target and actionability phases are entered on it. `None` where no
    /// command keeps one.
    fn timer(&self) -> Option<&CommandTimer> {
        None
    }
}

/// What a handler runs with: the host, the page, the command, its cancellation, and the two things a target resolution moves.
pub struct ActionContext<'a> {
    pub host: &'a dyn BrowserHost,
    pub page: &'a dyn ActionPage,
    /// The command as the caller sent it (`BrowserCommand`), keys by their wire names.
    pub command: &'a Value,
    pub cancel: &'a CancelView,
    /// Refs this command may address and the ones recovery swapped.
    pub recovery: &'a mut RefRecoveryContext,
    /// The observation the change judgement compares against; moves to a fresh one when a target is resolved.
    pub effect_baseline: &'a mut Option<RefSet>,
}

impl ActionContext<'_> {
    /// The cancel the host calls take.
    pub fn token(&self) -> &CancellationToken {
        self.cancel.token()
    }

    /// A field of the command, `None` when the caller did not send it (`undefined`).
    pub fn field(&self, key: &str) -> Option<&Value> {
        self.command.get(key)
    }
}

/// What a handler hands back: the runner settles the page, observes it and builds the reply, and puts these around it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ActionOutput {
    /// Text the reply opens with (ends with its own blank line), before the recovery notes.
    pub lead: String,
    /// The reply states the targets the host resolved and the refs recovery swapped (`decorateRecovery`).
    pub decorate_recovery: bool,
    /// What the host counted of the input it dispatched, one entry per batch.
    pub input: Vec<BrowserInputTiming>,
}

/// JavaScript truthiness of a command field.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `String(value || '')`.
pub fn text_of(value: Option<&Value>) -> String {
    if truthy(value) { value.map(value_to_string).unwrap_or_default() } else { String::new() }
}

/// `Number.isFinite(value)`: only a number counts, a numeric string does not.
pub fn finite_number(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|number| number.is_finite())
}

/// The snapshot a ref belongs to: public refs are `<snapshot>-e<n>`, minted ones `<snapshot>-t<n>`.
pub fn snapshot_of_ref(ref_id: &str) -> &str {
    ref_id.rsplit_once('-').map_or(ref_id, |(snapshot, _)| snapshot)
}

/// The page's precondition, bound to the snapshot of `ref_id` when the call acts on one.
pub fn expect_for(page: &dyn ActionPage, ref_id: Option<&str>) -> Precondition {
    let mut expect = page.precondition();
    if let Some(ref_id) = ref_id {
        expect.snapshot_id = Some(snapshot_of_ref(ref_id).to_string());
    }
    expect
}

/// The hit guard of a pointer press on `ref_id`: the host checks the press lands on that element.
pub fn hit_guard(ref_id: &str) -> BrowserHitGuard {
    BrowserHitGuard { snapshot_id: snapshot_of_ref(ref_id).to_string(), ref_id: ref_id.to_string() }
}

/// `adoptResolvedTargets`: resolution took a fresh observation, so recovery and the effect baseline move to it, and the reply says
/// what each target resolved to.
pub fn adopt_resolved_targets(cx: &mut ActionContext<'_>, resolved: &[ResolvedTarget]) {
    let fresh = resolved.first().and_then(|first| cx.page.adopt_snapshot(&first.snapshot_id));
    cx.recovery.source.clone_from(&fresh);
    *cx.effect_baseline = fresh;
    for entry in resolved {
        cx.recovery.resolved_targets.push(format!("{} -> {}", entry.description, entry.ref_id));
    }
}

/// Resolves the raw targets against ONE observation. A target that matched nothing (yet) is retried, as every read-only preflight is;
/// anything else ends it.
async fn resolve_command_targets(cx: &mut ActionContext<'_>, raw: &[Value]) -> Result<Vec<ResolvedTarget>, ActionError> {
    let page_id = cx.page.facts().page_id;
    let expect = cx.page.precondition();
    let (host, cancel) = (cx.host, cx.cancel);
    let (page_id_ref, expect_ref) = (&page_id, &expect);
    let resolved = timed(
        cx.page.timer(),
        Phase::Target,
        wait_for_actionable(
            move || async move {
                let target = TargetContext { host, page_id: page_id_ref, expect: Some(expect_ref), cancel: cancel.token() };
                resolve_targets(&target, raw).await.map_err(|error| match error {
                    TargetError::Missing(message) => ProbeFailure::NotActionable(ActionabilityError::new(message, ActionabilityReason::Missing)),
                    other => ProbeFailure::Other(other),
                })
            },
            cancel,
            ACTIONABILITY_TIMEOUT,
        ),
    )
    .await?;
    adopt_resolved_targets(cx, &resolved);
    Ok(resolved)
}

/// Both ends of a drag. Targets are resolved in one observation so the two refs describe the same page state; a page that moves
/// between two separate resolutions would otherwise hand back a source and a destination that never existed together.
pub async fn drag_refs(cx: &mut ActionContext<'_>) -> Result<(Option<String>, Option<String>), ActionError> {
    let ref_text = |value: Option<&Value>| truthy(value).then(|| text_of(value));
    let Some(target) = cx.field("target").filter(|target| !target.is_null()).cloned() else {
        return Ok((ref_text(cx.field("ref")), ref_text(cx.field("targetRef"))));
    };
    let drop_target = cx.field("dropTarget").cloned().unwrap_or(Value::Null);
    let resolved = resolve_command_targets(cx, &[target, drop_target]).await?;
    let mut ends = resolved.into_iter().map(|end| end.ref_id);
    Ok((ends.next(), ends.next()))
}

/// The ref a gesture works on: the caller's own, or one resolved right now from a snapshot-free `target`; `None` for a coordinate.
pub async fn action_ref(cx: &mut ActionContext<'_>) -> Result<Option<String>, ActionError> {
    if truthy(cx.field("ref")) {
        return Ok(Some(text_of(cx.field("ref"))));
    }
    let Some(target) = cx.field("target").filter(|target| !target.is_null()).cloned() else { return Ok(None) };
    let resolved = resolve_command_targets(cx, &[target]).await?;
    resolved.into_iter().next().map(|only| Some(only.ref_id)).ok_or_else(|| ActionError::Failed("the target resolved to nothing".to_string()))
}

/// What the page says of its URL and viewport, to check a screenshot still describes it.
#[derive(Deserialize)]
struct PageGeometry {
    url: String,
    width: f64,
    height: f64,
}

const PAGE_GEOMETRY: &str = "(() => ({ url: String(location.href), width: Math.round(window.innerWidth), height: Math.round(window.innerHeight) }))()";

/// A grounding refusal as the error the agent reads; one that says the grounding no longer describes the page also drops it, so the
/// next coordinate action needs a fresh `snapshot(mode=both)`.
fn retire(cx: &ActionContext<'_>, refused: GroundingRefused) -> ActionError {
    if refused.drop_grounding {
        cx.page.drop_visual_grounding();
    }
    ActionError::Failed(refused.message)
}

/// A screenshot coordinate as a CSS point in the current viewport (`visualPoint`): accepted only while the visual snapshot the
/// command names is current (same id, within its lifetime, same document revision, same URL and viewport).
pub async fn visual_point(cx: &ActionContext<'_>, x: Option<&Value>, y: Option<&Value>, label: &str) -> Result<Point, ActionError> {
    timed(cx.page.timer(), Phase::Actionability, visual_point_of(cx, x, y, label)).await
}

async fn visual_point_of(cx: &ActionContext<'_>, x: Option<&Value>, y: Option<&Value>, label: &str) -> Result<Point, ActionError> {
    let command_snapshot = cx.field("snapshotId").and_then(Value::as_str);
    let Some(grounding) = cx.page.visual_grounding() else {
        return Err(ActionError::Failed(format!("{label} requires snapshotId from the latest snapshot(mode=both) or locate result")));
    };
    let revision = cx.page.document_revision(cx.token()).await;
    grounding.check_current(command_snapshot, Instant::now(), revision, label).map_err(|refused| retire(cx, refused))?;
    let (image_x, image_y) = grounding.image_point(to_number_of(x), to_number_of(y), label).map_err(|refused| retire(cx, refused))?;
    let params = HostBrowserPageEvalParams {
        page_id: cx.page.facts().page_id,
        expression: PAGE_GEOMETRY.to_string(),
        frame: None,
        await_promise: None,
        return_by_value: Some(true),
        world: None,
        timeout_ms: u32::try_from(CDP_REQUEST_TIMEOUT.as_millis()).unwrap_or(u32::MAX),
        expect: Some(cx.page.precondition()),
        check_unchanged: None,
    };
    let answer = cx.host.page_eval(params, cx.token()).await?;
    if let Some(exception) = answer.exception {
        return Err(ActionError::Failed(exception.text));
    }
    let geometry: PageGeometry =
        serde_json::from_value(answer.value.unwrap_or(Value::Null)).map_err(|_| ActionError::Failed("the page did not report its viewport".to_string()))?;
    grounding.check_page(&geometry.url, geometry.width, geometry.height, label).map_err(|refused| retire(cx, refused))?;
    let (css_x, css_y) = grounding.css_point(image_x, image_y);
    Ok(Point { x: css_x, y: css_y })
}

#[cfg(test)]
pub(crate) mod testing {
    //! A page of the runner for the tests of the handlers: a scripted state behind [`ActionPage`], whose recovery host answers from it.

    use std::sync::Mutex;

    use async_trait::async_trait;
    use mixdog_rt::CancelSource;

    use super::*;
    use crate::fake::page_facts;
    use crate::refs::reply_recovery::FreshSnapshot;

    #[derive(Default)]
    pub struct State {
        pub ref_set: Option<RefSet>,
        pub adopted: Option<RefSet>,
        pub grounding: Option<VisualGrounding>,
        pub revision: Option<u32>,
        pub facts: Option<PageFacts>,
        pub invalidated: usize,
        pub scrolls: usize,
        pub dropped_grounding: usize,
        pub fresh: Option<RefSet>,
        pub fresh_snapshots: usize,
        pub url: String,
        pub dialog: Option<String>,
    }

    pub struct TestPage {
        pub state: Mutex<State>,
    }

    impl TestPage {
        pub fn new() -> Self {
            Self { state: Mutex::new(State { url: "https://a.test/".into(), ..State::default() }) }
        }

        pub fn with(change: impl FnOnce(&mut State)) -> Self {
            let page = Self::new();
            change(&mut page.state.lock().expect("state"));
            page
        }

        pub fn get<T>(&self, read: impl FnOnce(&State) -> T) -> T {
            read(&self.state.lock().expect("state"))
        }

        pub fn set(&self, change: impl FnOnce(&mut State)) {
            change(&mut self.state.lock().expect("state"));
        }
    }

    #[async_trait]
    impl RecoveryHost for TestPage {
        async fn page_url(&self) -> Result<String, HostCallError> {
            Ok(self.get(|state| state.url.clone()))
        }

        fn dialog_text(&self) -> Option<String> {
            self.get(|state| state.dialog.clone())
        }

        async fn fresh_snapshot(&self) -> Result<FreshSnapshot, HostCallError> {
            let mut state = self.state.lock().expect("state");
            state.fresh_snapshots += 1;
            let refs = state.fresh.clone().ok_or_else(|| HostCallError::Failed { message: "no fresh snapshot scripted".into() })?;
            state.ref_set = Some(refs.clone());
            Ok(FreshSnapshot { refs, report: "REPORT".into() })
        }
    }

    #[async_trait]
    impl ActionPage for TestPage {
        fn recovery_host(&self) -> &dyn RecoveryHost {
            self
        }

        fn facts(&self) -> PageFacts {
            self.get(|state| state.facts.clone()).unwrap_or_else(|| serde_json::from_value(page_facts("p1", 1)).expect("facts"))
        }

        fn precondition(&self) -> Precondition {
            let facts = self.facts();
            Precondition {
                document_id: facts.document_id,
                origin: None,
                url: Some(facts.url),
                child_sessions: None,
                receiver_key: None,
                snapshot_id: self.get(|state| state.ref_set.as_ref().map(|set| set.snapshot_id.clone())),
            }
        }

        fn ref_set(&self) -> Option<RefSet> {
            self.get(|state| state.ref_set.clone())
        }

        fn restore_ref_set(&self, set: RefSet) {
            self.set(|state| state.ref_set = Some(set));
        }

        fn adopt_snapshot(&self, _snapshot_id: &str) -> Option<RefSet> {
            let mut state = self.state.lock().expect("state");
            let adopted = state.adopted.clone();
            state.ref_set.clone_from(&adopted);
            adopted
        }

        fn invalidate_interaction(&self) {
            self.set(|state| {
                state.invalidated += 1;
                state.ref_set = None;
            });
        }

        fn record_scroll(&self) {
            self.set(|state| state.scrolls += 1);
        }

        fn visual_grounding(&self) -> Option<VisualGrounding> {
            self.get(|state| state.grounding.clone())
        }

        fn drop_visual_grounding(&self) {
            self.set(|state| {
                state.grounding = None;
                state.dropped_grounding += 1;
            });
        }

        async fn document_revision(&self, _cancel: &CancellationToken) -> Option<u32> {
            self.get(|state| state.revision)
        }

        fn format_snapshot(&self, snapshot: &HostBrowserSnapshotResult) -> String {
            format!("snapshot {}", snapshot.snapshot_id)
        }
    }

    /// What an [`ActionContext`] borrows besides the host and the page: a live cancel, an empty recovery and no baseline.
    pub struct Rig {
        pub source: CancelSource,
        pub recovery: RefRecoveryContext,
        pub baseline: Option<RefSet>,
    }

    impl Rig {
        pub fn new(source_refs: Option<RefSet>) -> Self {
            Self { source: CancelSource::new(), recovery: RefRecoveryContext::new(source_refs), baseline: None }
        }
    }
}

#[cfg(test)]
mod tests {
    use mixdog_app_protocol::v2::browser_engine::BrowserSnapshotElement;
    use serde_json::json;

    use super::testing::Rig;
    use super::testing::TestPage;
    use super::*;
    use crate::fake::Expect;
    use crate::fake::FakeHost;
    use crate::fake::page_facts;
    use crate::refs::ref_set::tests::element;
    use crate::refs::ref_set::tests::payload;

    fn snapshot_answer(snapshot_id: &str, elements: Vec<BrowserSnapshotElement>) -> Expect {
        let payload = payload(snapshot_id, elements, "https://a.test/");
        Expect::ok("host/browser/snapshot", json!({"snapshotId": snapshot_id, "documentId": "p1:1", "revision": 3, "payload": payload, "warnings": [], "facts": page_facts("p1", 4)}))
    }

    #[test]
    fn a_ref_names_its_snapshot_and_truthiness_follows_javascript() {
        assert_eq!(snapshot_of_ref("p1-s2-e14"), "p1-s2");
        assert_eq!(snapshot_of_ref("p1-s2-t9"), "p1-s2");
        assert_eq!(snapshot_of_ref("plain"), "plain");
        assert!(!truthy(None) && !truthy(Some(&json!(""))) && !truthy(Some(&json!(0))) && !truthy(Some(&Value::Null)));
        assert!(truthy(Some(&json!("x"))) && truthy(Some(&json!({}))) && truthy(Some(&json!(2))));
        assert_eq!(text_of(Some(&json!(5))), "5");
        assert_eq!(text_of(Some(&json!(0))), "");
        assert_eq!(finite_number(Some(&json!(4))), Some(4.0));
        assert_eq!(finite_number(Some(&json!("4"))), None);
    }

    #[tokio::test]
    async fn the_callers_own_ref_is_used_without_an_observation() {
        let host = FakeHost::scripted(Vec::new());
        let page = TestPage::new();
        let mut rig = Rig::new(None);
        let command = json!({"ref": "p1-s1-e1", "target": {"name": "Save"}});
        let mut cx = ActionContext { host: &host, page: &page, command: &command, cancel: &rig.source.view(), recovery: &mut rig.recovery, effect_baseline: &mut rig.baseline };
        assert_eq!(action_ref(&mut cx).await, Ok(Some("p1-s1-e1".to_string())));
        let none = json!({"x": 3});
        let mut cx = ActionContext { host: &host, page: &page, command: &none, cancel: &rig.source.view(), recovery: &mut rig.recovery, effect_baseline: &mut rig.baseline };
        assert_eq!(action_ref(&mut cx).await, Ok(None));
        host.finish().expect("no host call");
    }

    #[tokio::test]
    async fn a_target_is_resolved_and_recovery_and_the_baseline_move_to_the_observation() {
        let listed = element("p1-s2-e1", "button", "Save");
        let fresh = RefSet::from_payload("p1-s2", &payload("p1-s2", vec![listed.clone()], "https://a.test/"));
        let host = FakeHost::scripted(vec![snapshot_answer("p1-s2", vec![listed]).with_params(json!({"pageId": "p1", "mode": "query", "query": "Save"}))]);
        let page = TestPage::with(|state| state.adopted = Some(fresh.clone()));
        let mut rig = Rig::new(None);
        let command = json!({"target": {"name": "Save"}});
        let mut cx = ActionContext { host: &host, page: &page, command: &command, cancel: &rig.source.view(), recovery: &mut rig.recovery, effect_baseline: &mut rig.baseline };
        assert_eq!(action_ref(&mut cx).await, Ok(Some("p1-s2-e1".to_string())));
        assert_eq!(rig.recovery.source.as_ref().map(|set| set.snapshot_id.as_str()), Some("p1-s2"));
        assert_eq!(rig.baseline.as_ref().map(|set| set.snapshot_id.as_str()), Some("p1-s2"));
        assert_eq!(rig.recovery.resolved_targets, ["\"Save\" -> p1-s2-e1".to_string()]);
        host.finish().expect("one snapshot");
    }

    #[tokio::test]
    async fn both_ends_of_a_drag_come_from_one_observation() {
        let source = element("p1-s2-e1", "listitem", "Card");
        let destination = element("p1-s2-e2", "region", "Done");
        let host = FakeHost::scripted(vec![snapshot_answer("p1-s2", vec![source, destination])]);
        let page = TestPage::new();
        let mut rig = Rig::new(None);
        let command = json!({"target": {"name": "Card"}, "dropTarget": {"name": "Done"}});
        let mut cx = ActionContext { host: &host, page: &page, command: &command, cancel: &rig.source.view(), recovery: &mut rig.recovery, effect_baseline: &mut rig.baseline };
        assert_eq!(drag_refs(&mut cx).await, Ok((Some("p1-s2-e1".to_string()), Some("p1-s2-e2".to_string()))));
        assert_eq!(rig.recovery.resolved_targets.len(), 2);
        host.finish().expect("one snapshot for both ends");
        let plain = json!({"ref": "a", "targetRef": "b"});
        let quiet = FakeHost::scripted(Vec::new());
        let mut cx = ActionContext { host: &quiet, page: &page, command: &plain, cancel: &rig.source.view(), recovery: &mut rig.recovery, effect_baseline: &mut rig.baseline };
        assert_eq!(drag_refs(&mut cx).await, Ok((Some("a".to_string()), Some("b".to_string()))));
    }

    fn grounded(page: &TestPage) {
        let set = RefSet::from_payload("p1-s2", &payload("p1-s2", vec![], "https://a.test/")).with_document("p1:1", 7);
        page.set(|state| {
            state.grounding = Some(VisualGrounding::bind(&set, 640.0, 450.0, Instant::now()));
            state.revision = Some(7);
        });
    }

    fn geometry(width: u32, height: u32) -> Expect {
        Expect::ok("host/browser/page/eval", json!({"value": {"url": "https://a.test/", "width": width, "height": height}, "facts": page_facts("p1", 5)}))
    }

    #[tokio::test]
    async fn a_screenshot_coordinate_becomes_a_css_point() {
        let host = FakeHost::scripted(vec![geometry(1280, 900)]);
        let page = TestPage::new();
        grounded(&page);
        let (mut recovery, mut baseline) = (RefRecoveryContext::default(), None);
        let source = mixdog_rt::CancelSource::new();
        let command = json!({"snapshotId": "p1-s2", "x": 320, "y": 225});
        let cx = ActionContext { host: &host, page: &page, command: &command, cancel: &source.view(), recovery: &mut recovery, effect_baseline: &mut baseline };
        let point = visual_point(&cx, cx.field("x"), cx.field("y"), "click").await.expect("a point");
        assert_eq!(point, Point { x: 640.0, y: 450.0 });
        assert_eq!(page.get(|state| state.dropped_grounding), 0);
    }

    #[tokio::test]
    async fn a_coordinate_without_current_grounding_is_refused_and_a_stale_one_is_dropped() {
        let (mut recovery, mut baseline) = (RefRecoveryContext::default(), None);
        let source = mixdog_rt::CancelSource::new();
        let page = TestPage::new();
        let host = FakeHost::scripted(Vec::new());
        let command = json!({"snapshotId": "p1-s2", "x": 1, "y": 1});
        let cx = ActionContext { host: &host, page: &page, command: &command, cancel: &source.view(), recovery: &mut recovery, effect_baseline: &mut baseline };
        let error = visual_point(&cx, cx.field("x"), cx.field("y"), "click").await.expect_err("no grounding");
        assert_eq!(error.to_string(), "click requires snapshotId from the latest snapshot(mode=both) or locate result");

        grounded(&page);
        let wrong = json!({"snapshotId": "p1-s9", "x": 1, "y": 1});
        let cx = ActionContext { host: &host, page: &page, command: &wrong, cancel: &source.view(), recovery: &mut recovery, effect_baseline: &mut baseline };
        assert!(visual_point(&cx, cx.field("x"), cx.field("y"), "click").await.expect_err("other snapshot").to_string().contains("requires snapshotId"));
        assert_eq!(page.get(|state| state.dropped_grounding), 0, "naming another snapshot does not retire this one");

        page.set(|state| state.revision = Some(8));
        let cx = ActionContext { host: &host, page: &page, command: &command, cancel: &source.view(), recovery: &mut recovery, effect_baseline: &mut baseline };
        assert!(visual_point(&cx, cx.field("x"), cx.field("y"), "click").await.expect_err("revision moved").to_string().contains("visual grounding is stale"));
        assert_eq!(page.get(|state| state.dropped_grounding), 1);
    }

    #[tokio::test]
    async fn a_coordinate_outside_the_screenshot_or_on_a_resized_page_is_refused() {
        let (mut recovery, mut baseline) = (RefRecoveryContext::default(), None);
        let source = mixdog_rt::CancelSource::new();
        let page = TestPage::new();
        grounded(&page);
        let host = FakeHost::scripted(Vec::new());
        let outside = json!({"snapshotId": "p1-s2", "x": 640, "y": 1});
        let cx = ActionContext { host: &host, page: &page, command: &outside, cancel: &source.view(), recovery: &mut recovery, effect_baseline: &mut baseline };
        let error = visual_point(&cx, cx.field("x"), cx.field("y"), "hover").await.expect_err("outside");
        assert_eq!(error.to_string(), "hover coordinates must be inside the 640x450 screenshot");
        let host = FakeHost::scripted(vec![geometry(1000, 900)]);
        let inside = json!({"snapshotId": "p1-s2", "x": "10", "y": 10});
        let cx = ActionContext { host: &host, page: &page, command: &inside, cancel: &source.view(), recovery: &mut recovery, effect_baseline: &mut baseline };
        let error = visual_point(&cx, cx.field("x"), cx.field("y"), "hover").await.expect_err("resized");
        assert!(error.to_string().contains("page or viewport changed"), "{error}");
        assert_eq!(page.get(|state| state.dropped_grounding), 1);
    }
}
